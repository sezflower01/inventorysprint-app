// Auto-detects each seller's real primary marketplace from actual sales
// volume (trailing 90 days, converted to USD), rather than relying on a
// manual dropdown that's easy to leave wrong and materially changes how
// the repricer dispatch engine behaves (which marketplace gets the
// always-on, protected evaluation slot vs. which ones share the smaller
// capped pool). Runs as a weekly cron fan-out across all users.
//
// POST { all_users: true } (service role) → fan-out for all users (cron)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { requireInternalCall } from "../_shared/require-internal.ts";
import { MARKETPLACE_META, marketplaceCurrency } from "../_shared/marketplace-map.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Below this many total orders across all marketplaces in the trailing
// window, there isn't enough signal to trust — leave the setting as-is
// rather than risk flipping it on noise (e.g. a brand-new account).
const MIN_ORDERS_FOR_SIGNAL = 10;
const TRAILING_DAYS = 90;

interface DetectResult {
  user_id: string;
  previous: string | null;
  detected: string | null;
  changed: boolean;
  currency_changed: boolean;
  method: "sales_volume" | "listing_count" | "none";
  totals_usd: Record<string, number>;
  reason?: string;
}

// Applies whatever marketplace was decided (new detection, fallback, or
// simply the existing value) and keeps home_currency in lockstep with it.
// This is also how existing rows get backfilled — home_currency has never
// been written anywhere else in the app (was NULL/defaulting to 'USD' for
// everyone), so the first run after this ships corrects it for every
// account, not just ones whose primary_marketplace happens to change.
async function applyMarketplaceAndCurrency(
  admin: ReturnType<typeof createClient>,
  userId: string,
  finalMarketplace: string,
  marketplaceChanged: boolean,
  method: "sales_volume" | "listing_count",
  currentHomeCurrency: string | null,
): Promise<boolean> {
  const expectedCurrency = marketplaceCurrency(finalMarketplace);
  const currencyChanged = currentHomeCurrency !== expectedCurrency;

  if (!marketplaceChanged && !currencyChanged) return false;

  const update: Record<string, unknown> = { user_id: userId, home_currency: expectedCurrency };
  if (marketplaceChanged) {
    update.primary_marketplace = finalMarketplace;
    update.primary_marketplace_detected_at = new Date().toISOString();
    update.primary_marketplace_detection_method = method;
  }
  // Upsert, not update — a brand-new signup has no repricer_settings row yet
  // (nothing creates one automatically), so a plain UPDATE would silently
  // affect zero rows and leave home_currency/primary_marketplace unset.
  await admin.from("repricer_settings").upsert(update as any, { onConflict: "user_id" });
  return true;
}

// Cold-start fallback: brand-new accounts have zero sales history, so the
// sales-volume signal never has enough to work with — without this, they'd
// silently fall back to the code-level 'US' default regardless of where
// they actually operate (e.g. a Canada-based seller mid-onboarding). Active
// listings/assignments exist from the moment a seller connects and syncs,
// well before any sale happens, so use whichever marketplace has the most
// as an interim signal until real sales volume takes over.
async function detectFromListingCount(
  admin: ReturnType<typeof createClient>,
  userId: string,
): Promise<string | null> {
  const counts: Record<string, number> = {};
  const PAGE = 1000;
  for (let from = 0; from < 20000; from += PAGE) {
    const { data: page, error } = await admin
      .from("repricer_assignments")
      .select("marketplace")
      .eq("user_id", userId)
      .eq("is_enabled", true)
      .not("rule_id", "is", null)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!page || page.length === 0) break;
    for (const row of page as any[]) {
      const mp = String(row.marketplace || "").toUpperCase();
      if (!mp || !(mp in MARKETPLACE_META)) continue;
      counts[mp] = (counts[mp] || 0) + 1;
    }
    if (page.length < PAGE) break;
  }

  const marketplaces = Object.keys(counts);
  if (marketplaces.length === 0) return null;
  let best = marketplaces[0];
  for (const mp of marketplaces) {
    if (counts[mp] > counts[best]) best = mp;
  }
  return best;
}

async function detectForUser(
  admin: ReturnType<typeof createClient>,
  userId: string,
  fxRates: Record<string, number>,
): Promise<DetectResult> {
  const since = new Date(Date.now() - TRAILING_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const { data: settings } = await admin
    .from("repricer_settings")
    .select("primary_marketplace, home_currency, primary_marketplace_manual_override")
    .eq("user_id", userId)
    .maybeSingle();
  const previous = (settings as any)?.primary_marketplace || null;
  const currentHomeCurrency = (settings as any)?.home_currency ?? null;

  // Manually pinned (e.g. an admin simulating a CA/MX/BR-primary seller) —
  // leave it alone. Otherwise this weekly/self-service detection would
  // silently revert it back to the real sales-volume-derived marketplace.
  if ((settings as any)?.primary_marketplace_manual_override === true) {
    return {
      user_id: userId, previous, detected: previous, changed: false,
      currency_changed: false, method: "none", totals_usd: {},
      reason: "manual_override",
    };
  }

  const orders: { marketplace: string | null; total_sale_amount: number | null }[] = [];
  const PAGE = 1000;
  for (let from = 0; from < 20000; from += PAGE) {
    const { data: page, error } = await admin
      .from("sales_orders")
      .select("marketplace, total_sale_amount")
      .eq("user_id", userId)
      .eq("is_cancelled", false)
      .gte("order_date", since)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!page || page.length === 0) break;
    orders.push(...page);
    if (page.length < PAGE) break;
  }

  const toUsd = (amount: number, mp: string) => {
    const currency = marketplaceCurrency(mp);
    if (currency === "USD") return amount;
    const rate = fxRates[currency];
    return rate && rate > 0 ? amount / rate : amount;
  };

  const totalsUsd: Record<string, number> = {};
  const counts: Record<string, number> = {};
  let totalOrders = 0;
  for (const o of orders) {
    const mp = String(o.marketplace || "").toUpperCase();
    if (!mp || !(mp in MARKETPLACE_META)) continue;
    const usd = toUsd(Number(o.total_sale_amount) || 0, mp);
    totalsUsd[mp] = (totalsUsd[mp] || 0) + usd;
    counts[mp] = (counts[mp] || 0) + 1;
    totalOrders++;
  }

  if (totalOrders < MIN_ORDERS_FOR_SIGNAL) {
    const fallback = await detectFromListingCount(admin, userId);
    if (!fallback) {
      // No sales AND no listings yet. Nothing to detect, but home_currency
      // should still track whatever marketplace is already effectively
      // active (or the code-level 'US' default) rather than sitting NULL.
      const effective = previous || "US";
      const currencyChanged = await applyMarketplaceAndCurrency(admin, userId, effective, false, "listing_count", currentHomeCurrency);
      return { user_id: userId, previous, detected: previous, changed: false, currency_changed: currencyChanged, method: "none", totals_usd: totalsUsd, reason: "insufficient_signal" };
    }
    const changed = fallback !== previous;
    const currencyChanged = await applyMarketplaceAndCurrency(admin, userId, fallback, changed, "listing_count", currentHomeCurrency);
    return { user_id: userId, previous, detected: fallback, changed, currency_changed: currencyChanged, method: "listing_count", totals_usd: totalsUsd, reason: "insufficient_sales_signal" };
  }

  const marketplaces = Object.keys(totalsUsd);
  let best = marketplaces[0];
  for (const mp of marketplaces) {
    if (totalsUsd[mp] > totalsUsd[best]) best = mp;
    // Tie (or effectively tied): prefer whatever's already set, to avoid
    // flip-flopping on noise between two close marketplaces.
    else if (Math.abs(totalsUsd[mp] - totalsUsd[best]) < 0.01 && mp === previous) best = mp;
  }

  const changed = best !== previous;
  const currencyChanged = await applyMarketplaceAndCurrency(admin, userId, best, changed, "sales_volume", currentHomeCurrency);

  return { user_id: userId, previous, detected: best, changed, currency_changed: currencyChanged, method: "sales_volume", totals_usd: totalsUsd };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

    let body: any = {};
    try { body = await req.json(); } catch { body = {}; }

    if (body?.all_users !== true && typeof body?.user_id === "string" && body.user_id) {
      // Internal single-user path: e.g. amazon-oauth-callback's background
      // sync, which needs to run detection for a brand-new user without a
      // real user JWT available server-side. Requires internal auth (never
      // trust a client-supplied user_id without it).
      const forbiddenInternal = requireInternalCall(req);
      if (forbiddenInternal) return forbiddenInternal;

      const { data: fxRows } = await admin.from("fx_rates").select("quote, rate");
      const fxRates: Record<string, number> = {};
      for (const row of (fxRows as any[]) || []) fxRates[String(row.quote || "")] = Number(row.rate) || 1;

      const result = await detectForUser(admin, body.user_id, fxRates);
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (body?.all_users !== true) {
      // Self-service path: run detection immediately for the calling user —
      // e.g. right after they connect a new marketplace — instead of waiting
      // for the weekly all_users cron fan-out below. Always operates on the
      // JWT's own user, never a client-supplied id.
      const authHeader = req.headers.get("Authorization");
      if (!authHeader) {
        return new Response(JSON.stringify({ error: "Missing auth" }), {
          status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const token = authHeader.replace("Bearer ", "");
      const { data: { user }, error: authErr } = await admin.auth.getUser(token);
      if (authErr || !user) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { data: fxRows } = await admin.from("fx_rates").select("quote, rate");
      const fxRates: Record<string, number> = {};
      for (const row of (fxRows as any[]) || []) fxRates[String(row.quote || "")] = Number(row.rate) || 1;

      const result = await detectForUser(admin, user.id, fxRates);
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const forbidden = requireInternalCall(req);
    if (forbidden) return forbidden;

    const { withCronLock } = await import("../_shared/cron-lock.ts");
    const outcome = await withCronLock(admin as any, "repricer-detect-primary-marketplace", 900, async () => {
      const { data: fxRows } = await admin.from("fx_rates").select("quote, rate");
      const fxRates: Record<string, number> = {};
      for (const row of (fxRows as any[]) || []) fxRates[String(row.quote || "")] = Number(row.rate) || 1;

      const { data: settingsRows } = await admin.from("repricer_settings").select("user_id");
      const userIds = Array.from(new Set((settingsRows ?? []).map((r: any) => r.user_id)));

      const results: DetectResult[] = [];
      let changedCount = 0;
      let currencyChangedCount = 0;
      for (const uid of userIds) {
        try {
          const r = await detectForUser(admin, uid, fxRates);
          results.push(r);
          if (r.changed) changedCount++;
          if (r.currency_changed) currencyChangedCount++;
        } catch (e) {
          console.error("[detect-primary-marketplace] user failed", uid, e);
        }
      }

      return {
        items_processed: userIds.length,
        detail: { changed: changedCount, currency_changed: currencyChangedCount, unchanged: userIds.length - changedCount },
      };
    });

    return new Response(JSON.stringify(outcome), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message || String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
