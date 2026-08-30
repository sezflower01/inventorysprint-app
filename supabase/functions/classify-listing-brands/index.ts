/**
 * Classify newly detected seller-watch listings against the brands the user
 * carries, and send a digest of the matches.
 *
 * ── WHY A SEPARATE WORKER ─────────────────────────────────────────────────
 *
 * Detection happens in check-seller-watchlist, which is Keepa-gated and
 * rate-sensitive. Bolting SP-API catalog calls into it would slow the seller
 * sweep and couple two unrelated quotas -- the exact failure the shared Keepa
 * gate exists to prevent. A separate worker on its own cron classifies a
 * listing within a few minutes of detection, which for a sourcing decision
 * acted on within hours is indistinguishable from instant.
 *
 * ── WHY A DIGEST AND NOT ONE EMAIL PER MATCH ──────────────────────────────
 *
 * A watched seller can bulk-list 50 items at once. Fifty emails would train
 * the recipient to ignore the alert, which is worse than no alert. So matches
 * accumulate and go out together, and brand_notified_at records what has been
 * sent so a later digest never repeats itself.
 *
 * ── UNKNOWN IS NOT "NOT MINE" ─────────────────────────────────────────────
 *
 * getCatalogItem returns a brand about 78% of the time; for the rest Amazon
 * genuinely has none. Those are marked `unknown`, never `not_mine`. Folding
 * them together would hide listings behind a filter on the strength of missing
 * data -- the same reasoning that made bulk deletion unsafe when 6,161 of
 * 8,181 rows had no brand.
 *
 * An ignored brand resolves to not_mine rather than disappearing, at the
 * user's request: the rule should be visible, not silent.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { fetchAmazonDetailsBatch } from "../verify-store-scan-match/_amazon-catalog.ts";
import { requireInternalCall } from "../_shared/require-internal.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-secret",
};

// Per invocation. Detection adds listings in bursts, not floods, so this is
// sized to clear a burst in one run while staying far inside the timeout.
const BATCH_SIZE = 100;
// A digest goes out only when the oldest unsent match is at least this old,
// so a seller mid-bulk-listing produces one email rather than three.
const DIGEST_SETTLE_MINUTES = 45;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  try {
    const denied = requireInternalCall(req);
    if (denied) return denied;

    const body = await req.json().catch(() => ({}));
    const dryRun = body?.dryRun === true;
    const skipDigest = body?.skipDigest === true;

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );

    // ── 1. classify anything pending ──────────────────────────────────────
    const { data: pending, error: pErr } = await supabase
      .from("seller_watch_new_listings")
      .select("id, user_id, asin, brand, brand_checked_at")
      .eq("brand_match_state", "pending")
      .order("detected_at", { ascending: false })
      .limit(BATCH_SIZE);
    if (pErr) return json({ error: pErr.message }, 500);

    const rows = pending ?? [];
    let classified = 0, matched = 0, unknown = 0, notMine = 0;

    if (rows.length > 0 && !dryRun) {
      // Look up only rows that have never been checked. A row that already
      // carries a brand needs no SP-API call at all.
      const needLookup = Array.from(new Set(
        rows.filter((r: any) => !r.brand_checked_at && r.asin).map((r: any) => r.asin),
      ));
      const details = needLookup.length > 0
        ? await fetchAmazonDetailsBatch(needLookup)
        : new Map();

      // One brand list per user, fetched once rather than per row.
      const userIds = Array.from(new Set(rows.map((r: any) => r.user_id).filter(Boolean)));
      // Two structures per user: exact names, and the subset opted in to
      // prefix matching. Prefix is deliberately NOT the default -- on this
      // catalogue it would have POP catching POPCORN and CAT / WB / 2K / Ford
      // colliding with unrelated brands. It is per-brand because "Milwaukee"
      // wants it and "POP" must not.
      const brandsByUser = new Map<string, { exact: Set<string>; prefixes: string[] }>();
      for (const uid of userIds) {
        const { data: ub } = await supabase
          .from("user_brands")
          .select("brand, status, match_mode")
          .eq("user_id", uid);
        // Ignored brands are dropped HERE, which lands the listing in not_mine
        // rather than removing it -- visible, not silent.
        const live = (ub ?? []).filter((b: any) => (b.status ?? "") !== "ignore");
        brandsByUser.set(uid, {
          exact: new Set(live.map((b: any) => String(b.brand ?? "").trim().toLowerCase()).filter(Boolean)),
          prefixes: live
            .filter((b: any) => b.match_mode === "prefix")
            .map((b: any) => String(b.brand ?? "").trim().toLowerCase())
            // A one- or two-character prefix would match most of the
            // catalogue; refuse it here rather than trusting every row.
            .filter((v: string) => v.length >= 3),
        });
      }

      const now = new Date().toISOString();
      for (const r of rows as any[]) {
        const fetched = r.asin ? details.get(r.asin) : null;
        const brand = (r.brand && String(r.brand).trim()) || fetched?.brand || null;

        let state: "matched" | "not_mine" | "unknown";
        if (!brand) {
          state = "unknown";
          unknown++;
        } else if ((() => {
          const set = brandsByUser.get(r.user_id);
          if (!set) return false;
          const b = brand.trim().toLowerCase();
          return set.exact.has(b) || set.prefixes.some((p) => b.startsWith(p));
        })()) {
          state = "matched";
          matched++;
        } else {
          state = "not_mine";
          notMine++;
        }

        const patch: Record<string, unknown> = { brand_match_state: state, brand_checked_at: now };
        if (brand && !r.brand) patch.brand = brand;

        const { error: uErr } = await supabase
          .from("seller_watch_new_listings")
          .update(patch)
          .eq("id", r.id);
        if (uErr) { console.warn(`[classify] ${r.asin}:`, uErr.message); continue; }
        classified++;
      }
    }

    // ── 2. digest of matches not yet sent ─────────────────────────────────
    let digests: Array<Record<string, unknown>> = [];
    if (!dryRun && !skipDigest) {
      const cutoff = new Date(Date.now() - DIGEST_SETTLE_MINUTES * 60_000).toISOString();

      const { data: due } = await supabase
        .from("seller_watch_new_listings")
        .select("id, user_id, asin, title, brand, marketplace, amazon_price_cents, detected_at")
        .eq("brand_match_state", "matched")
        .is("brand_notified_at", null)
        .lte("detected_at", cutoff)
        .order("detected_at", { ascending: true })
        .limit(500);

      const byUser = new Map<string, any[]>();
      for (const r of (due ?? []) as any[]) {
        if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
        byUser.get(r.user_id)!.push(r);
      }

      for (const [uid, items] of byUser) {
        // Where to send. The seller-analyzer override wins; otherwise the
        // account address. If neither resolves the matches stay unsent rather
        // than being marked notified -- losing an alert silently is worse than
        // sending it late.
        const { data: cfg } = await supabase
          .from("auto_source_config")
          .select("notify_email")
          .eq("user_id", uid)
          .maybeSingle();
        let to = cfg?.notify_email ?? null;
        if (!to) {
          const { data: au } = await supabase.auth.admin.getUserById(uid);
          to = au?.user?.email ?? null;
        }
        if (!to) { console.warn(`[classify] no address for ${uid}, ${items.length} match(es) held`); continue; }

        const { error: mailErr } = await supabase.functions.invoke("send-email", {
          body: {
            to,
            name: "there",
            emailType: "seller-watch-new-listings",
            sellerWatch: {
              sellerId: "brand-match",
              sellerName: `${items.length} new listing${items.length === 1 ? "" : "s"} in your brands`,
              marketplace: items[0]?.marketplace ?? "US",
              newAsins: items.slice(0, 25).map((i: any) => i.asin),
              totalNew: items.length,
            },
          },
        });
        if (mailErr) { console.warn(`[classify] digest send failed for ${uid}:`, mailErr.message); continue; }

        // Stamped only after the send succeeds, so a failed email is retried
        // on the next run instead of being silently swallowed.
        await supabase
          .from("seller_watch_new_listings")
          .update({ brand_notified_at: new Date().toISOString() })
          .in("id", items.map((i: any) => i.id));

        digests.push({ user_id: uid, sent: items.length, to: to.replace(/(.{2}).*(@.*)/, "$1***$2") });
      }
    }

    return json({ classified, matched, notMine, unknown, pendingSeen: rows.length, digests, dryRun });
  } catch (err) {
    console.error("[classify-listing-brands]", err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
