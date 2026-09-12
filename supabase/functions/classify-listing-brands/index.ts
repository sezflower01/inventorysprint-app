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
// DIGEST_SETTLE_MINUTES (45) lived here to hold a digest until the oldest
// unsent match had settled, so a seller mid-bulk-listing produced one email
// rather than three. Removed 2026-09-12 with the email itself -- the navbar
// panel groups by seller on read, so nothing has to wait for a burst to end.

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  try {
    const denied = requireInternalCall(req);
    if (denied) return denied;

    const body = await req.json().catch(() => ({}));
    const dryRun = body?.dryRun === true;
    // `skipDigest` is still accepted in the body and deliberately not read:
    // existing callers pass it, and there is no longer a digest to skip.

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
        // Own brands PLUS the shared catalogue, minus anything muted. Reading
        // user_brands directly would classify against a narrower set than the
        // panel shows, so a listing the user was told matches would come back
        // not_mine.
        //
        // The function already drops rows whose status is 'ignore', so the
        // filter that used to live here is gone rather than duplicated -- two
        // copies of that rule would eventually disagree.
        const { data: ub } = await supabase
          .rpc("get_effective_brands_for", { p_user: uid });
        const live = (ub ?? []) as Array<{ brand: string; match_mode: string }>;
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

    // ── 2. THE EMAIL DIGEST IS GONE ───────────────────────────────────────
    //
    // This block used to gather matched-but-unnotified listings per user and
    // send them as one Resend message, stamping brand_notified_at on success.
    //
    // Removed 2026-09-12. Resend's team quota is 100 messages a day and it is
    // SHARED with auth-email-hook, which sends password resets and signup
    // confirmations -- so detection mail was competing with account mail for
    // the same 100. check-seller-watchlist's per-watch send was the bulk of it
    // and went at the same time; this digest goes too, so the quota is not
    // quietly re-consumed from the other side.
    //
    // brand_notified_at is deliberately NO LONGER STAMPED HERE. With no email
    // to record, NULL now means "not yet seen by the user", which is what the
    // navbar panel (src/components/navbar/SellerListingAlerts.tsx) reads and
    // what it stamps when opened. Same column, one layer up, no migration.
    //
    // `digests` stays in the response, always empty. The shape is what the
    // cron's observability rows and any dashboard read; removing the key would
    // break them to say nothing new.
    const digests: Array<Record<string, unknown>> = [];

    return json({ classified, matched, notMine, unknown, pendingSeen: rows.length, digests, dryRun });
  } catch (err) {
    console.error("[classify-listing-brands]", err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
