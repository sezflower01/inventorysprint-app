// repricer-auto-lower-min — per-rule floor-drop worker.
//
// ── PER-RULE SCHEDULE (2026-09-18) ──────────────────────────────────────────
// Seller request: the VA does not check daily, so the automation must carry
// it, switched on INSIDE each rule with an interval the seller picks.
//   * A rule is covered in a marketplace when that marketplace is in
//     repricer_rules.auto_lower_min_marketplaces. EVERY enabled, active
//     assignment on the rule is covered -- including listings added later.
//     (The old per-assignment auto_lower_min_price flag was set once and never
//     for new listings, so coverage decayed; it is no longer read here.)
//   * The cron fires every 5 minutes; a rule is processed only when its own
//     auto_lower_min_interval_minutes has passed since auto_lower_min_last_run_at.
//   * The lifetime "5 drops per listing" limit is replaced by the rule's
//     auto_lower_min_max_drops_per_day (UTC day). At a 5-minute interval five
//     lifetime drops would be spent in 25 minutes and the listing then stuck
//     for good -- 126 in-stock listings already were.
//   * US only for now (ALLOWED_MARKETPLACES), whatever a rule or caller asks.
// Every other safety rule below is unchanged.
//
// PURPOSE
// Sellers hit a state where the repricer wants to compete but cannot, because
// the seller's own min price sits above the competition. The table labels this
// "Not competitive — blocked by your minimum price". Until now the only fix was
// a human editing each row by hand.
//
// The `auto_lower_min_price` flag and `auto_floor_drop_count` column have
// existed since migration 20260323152317 and were switched on for Momentum
// Builder US assignments — but NOTHING EVER READ THEM. This is the worker that
// was scaffolded and never built.
//
// ── WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────────────────
// It does not call Amazon, SP-API, Keepa, or any metered API. It writes
// `min_price_override` and stops. `repricer-scheduler` already runs 24/7,
// respects min/max, and pushes prices — it picks the new floor up on its next
// pass. That separation is what makes this safe to run hourly: it cannot starve
// the shared Keepa / SP-API gates described in CLAUDE.md, because it never
// touches them.
//
// ── SAFETY RULES ENCODED ────────────────────────────────────────────────────
// Every one of these was learned during a manual run on 2026-08-18 that lowered
// 23 US floors by hand.
//
//  1. EXHAUSTED   drop_count >= 5, or cumulative drop from manual_min_price
//                 >= 30%. Ports MonitorTabLayout.tsx:167 verbatim — the app
//                 already shows this rule to the user, so the worker must obey
//                 the same one. During the manual run B00E6O5JV6 was lowered
//                 while already at drop_count=5, precisely because the check
//                 lived only in the UI's aggregate counter and nowhere a
//                 per-ASIN caller could see it.
//  2. 30% CAP     TWO guards, both required. Cumulative: never more than 30%
//                 below manual_min_price (the ORIGINAL floor) — clamping against
//                 the current value would let successive runs walk past 30%
//                 cumulatively (0.7^n), the ratchet the cap exists to prevent.
//                 Per-run: never more than 30% below the CURRENT floor in one
//                 step — needed because when the seller has RAISED the floor
//                 above manual_min_price the cumulative guard sits far below and
//                 stops bounding the single cut. Dry run #1 caught B0FC2HXZYZ
//                 about to take 23 -> 15.98, a 30.52% step, on exactly that shape.
//  3. ONE PER RUN Each assignment is visited once per invocation, and
//                 withCronLock() prevents overlapping invocations. In the manual
//                 run B0F226Y3W8 asked for a second cut within the same hour
//                 after competition moved.
//  4. ROI FLOOR   Per-marketplace policy floor, raised by the rule's own floor
//                 when the rule sets a higher one. US is 0% (break-even), NOT
//                 "no floor": an unbounded rule can walk a price to $0.99 on its
//                 own, and clearing stale stock at a real loss is a deliberate
//                 human decision, not an automated one.
//  5. ALREADY WON Buy Box owned, or we are already the lowest. Undercutting
//                 yourself buys nothing and costs margin. A seller can own the
//                 BB while a lower price exists, so BB ownership alone suffices.
//  6. NO DATA     No competitor price means nothing to undercut. Third of the
//                 three stop conditions the UI banner already documents.
//  7. NEVER RAISE Writes only when the new floor is strictly lower.
//
// ── THE FX BUG THIS AVOIDS ──────────────────────────────────────────────────
// The browser's ROI readout is FX-dependent via a client-cached rate. On MX the
// same saved min of 400 rendered as 73.2% and later 99.8% — a 26-point swing
// with no price change. Automation trusting that number will set floors it
// believes are compliant when they are not. Here the rate is resolved ONCE per
// run per currency and returned with every decision, so any number can be
// explained after the fact. See _shared/roi-floor.ts.
//
// ── INVOCATION ──────────────────────────────────────────────────────────────
//   { dry_run: true }        decide everything, write nothing
//   { marketplaces: [...] }  defaults to ["US"]
//   { user_id: "..." }       single seller, for debugging
//   { limit: 50 }            cap rows considered
//
// Cron-invoked, so verify_jwt = false in config.toml and requireInternalCall()
// does the real auth. Without that flag pg_cron's call is rejected by the
// gateway before this file runs — no log, no error. See CLAUDE.md.

import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { requireInternalCall } from "../_shared/require-internal.ts";
import { withCronLock } from "../_shared/cron-lock.ts";
import { getUsdToRate } from "../_shared/fx-utils.ts";
import { marketplaceCurrency } from "../_shared/marketplace-map.ts";
import { roiAtPrice, priceForRoi, mergeFeeSources } from "../_shared/roi-floor.ts";
import { loadRepricerCostMap, repricerCostKey } from "../_shared/cog-for-repricer.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-internal-secret",
};

/** Hard policy floors. US 0% = break-even, never "no floor". */
const POLICY_ROI_FLOOR: Record<string, number> = { US: 0, CA: 70, MX: 70, BR: 70 };
const DEFAULT_POLICY_ROI_FLOOR = 70;

/** Only marketplaces the worker may act in, whatever a rule or caller asks. */
const ALLOWED_MARKETPLACES = ["US"];
/** Scheduled-run slack: the cron fires on 5-minute ticks, a few seconds apart. */
const DUE_SLACK_MS = 60_000;
/**
 * Never undercut a competitor price older than this. Snapshots refresh ~every
 * 19 min per ASIN (median, measured 2026-09-18); 3 h allows for gaps. Needed
 * once the worker started reading each ASIN's LATEST snapshot: the old capped
 * read only ever saw ~30 minutes of snapshots, and without this guard a
 * days-old lowest price could have set a floor.
 */
const MAX_SNAPSHOT_AGE_MS = 3 * 60 * 60 * 1000;
/**
 * Never trust a Buy Box status older than this. repricer-scheduler writes
 * last_buybox_status and last_sp_api_check_at in the same UPDATE, so the
 * latter is the status's age. Measured 2026-09-19 over the 679 covered US
 * listings: 233 "losing" statuses were over a day old, 239 in-stock listings
 * had a "losing" status older than 3 h -- some ~132 days. A stale "losing"
 * would let the worker lower the floor of a listing that has long since won
 * the Buy Box, so the skip-if-winning rule must not rest on it.
 */
const MAX_BB_STATUS_AGE_MS = 3 * 60 * 60 * 1000;
const MAX_CUMULATIVE_DROP_PCT = 30;
const UNDERCUT_STEP = 0.01;
/** Tolerance when re-verifying ROI after cent-rounding. */
const ROI_VERIFY_TOLERANCE = 0.05;

/**
 * Explicit row shape. supabase-js infers `select()` from a STRING LITERAL; the
 * select below is concatenated across two lines for readability, which defeats
 * that inference and degrades every field to GenericStringError. Typing the
 * rows here is the fix — keep this in sync with the select string.
 */
interface AssignmentRow {
  id: string;
  user_id: string;
  asin: string;
  sku: string | null;
  marketplace: string;
  rule_id: string | null;
  min_price_override: number | null;
  manual_min_price: number | null;
  auto_floor_drop_count: number | null;
  auto_floor_drop_day: string | null;
  auto_floor_drops_on_day: number | null;
  last_buybox_status: string | null;
  /** When last_buybox_status was written (same UPDATE in repricer-scheduler). */
  last_sp_api_check_at: string | null;
  /**
   * Marketplace-correct current price. Deliberately NOT inventory.my_price:
   * that column holds the US price, so comparing it against an MX/CA/BR
   * `lowest` compares across currencies and would silently mark rows as
   * "already lowest" that are nothing of the sort.
   */
  last_applied_price: number | null;
}

interface Decision {
  assignment_id: string;
  asin: string;
  marketplace: string;
  action: "lower" | "skip";
  reason: string;
  current_min?: number | null;
  new_min?: number | null;
  lowest?: number | null;
  roi_at_new_min?: number | null;
  roi_floor?: number;
  drop_pct?: number | null;
  drop_count?: number;
  /** Drops already made today (UTC) and the rule's daily allowance. */
  drops_today?: number;
  max_drops_per_day?: number;
  rule_id?: string | null;
  /** Age of the competitor snapshot the decision used, in minutes. */
  snapshot_age_min?: number | null;
  /** Age of the Buy Box status the decision relied on, in minutes. */
  bb_status_age_min?: number | null;
  /** Which price was beaten: lowest, buybox, or lowest_fallback (no BB price). */
  anchor?: "lowest" | "buybox" | "lowest_fallback";
  cumulative_drop_pct?: number | null;
  fx_rate?: number;
  /** Which fee source backed the ROI maths: asin_fee_cache or inventory. */
  fee_source?: string;
  /** Unit cost the ROI floor was computed from, and where it came from. */
  unit_cost?: number;
  cost_source?: "cost_override" | "cog_on_record" | "inventory";
}

const round2 = (n: number) => Math.round(n * 100) / 100;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const forbidden = requireInternalCall(req);
  if (forbidden) return forbidden;

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    // pg_cron may POST an empty body — defaults apply.
  }

  const dryRun = body.dry_run === true;
  const requested = Array.isArray(body.marketplaces) && body.marketplaces.length
    ? (body.marketplaces as string[]).map((m) => String(m).toUpperCase())
    : ALLOWED_MARKETPLACES;
  const marketplaces = requested.filter((m) => ALLOWED_MARKETPLACES.includes(m));
  const onlyUserId = typeof body.user_id === "string" ? body.user_id : null;
  // Dry runs look at every switched-on rule unless asked to honour the
  // intervals; real runs always honour them.
  const respectSchedule = dryRun ? body.respect_schedule === true : true;
  const runStartedAt = new Date();
  const today = runStartedAt.toISOString().slice(0, 10); // UTC day for the daily limit

  const run = async () => {
    const decisions: Decision[] = [];
    if (!marketplaces.length) {
      return { items_processed: 0, detail: { decisions: [], note: "no allowed marketplace requested" } };
    }

    // ── 1a. Rules switched on, and due ──────────────────────────────────────
    let rq = admin
      .from("repricer_rules")
      .select("id, user_id, min_roi_percent, min_roi_marketplace_overrides, auto_lower_min_marketplaces, " +
        "auto_lower_min_interval_minutes, auto_lower_min_max_drops_per_day, auto_lower_min_last_run_at, " +
        "auto_lower_min_undercut, auto_lower_min_anchor")
      .overlaps("auto_lower_min_marketplaces", marketplaces);
    if (onlyUserId) rq = rq.eq("user_id", onlyUserId);
    const { data: ruleRowsRaw, error: rErr } = await rq;
    if (rErr) throw new Error(`rules: ${rErr.message}`);
    const allOnRules = (ruleRowsRaw ?? []) as unknown as Array<Record<string, any>>;
    const dueRules = allOnRules.filter((r) => {
      if (!respectSchedule) return true;
      const last = r.auto_lower_min_last_run_at ? new Date(r.auto_lower_min_last_run_at).getTime() : 0;
      const intervalMs = Number(r.auto_lower_min_interval_minutes ?? 60) * 60_000;
      return runStartedAt.getTime() - last >= intervalMs - DUE_SLACK_MS;
    });
    const ruleBy = new Map<string, Record<string, any>>();
    for (const r of dueRules) ruleBy.set(r.id, r);
    if (!dueRules.length) {
      return {
        items_processed: 0,
        detail: { decisions: [], note: allOnRules.length ? "no rule due yet" : "no rule has auto-lower on", rules_on: allOnRules.length },
      };
    }

    // ── 1b. Every enabled, active assignment on a due rule ──────────────────
    // Paginated: PostgREST returns at most 1,000 rows per request.
    const assignments: AssignmentRow[] = [];
    const ruleIdsDue = dueRules.map((r) => r.id as string);
    for (let from = 0; ; from += 1000) {
      const { data, error } = await admin
        .from("repricer_assignments")
        .select(
          "id, user_id, asin, sku, marketplace, rule_id, min_price_override, manual_min_price, " +
            "auto_floor_drop_count, auto_floor_drop_day, auto_floor_drops_on_day, last_buybox_status, last_sp_api_check_at, " +
            "last_applied_price",
        )
        .in("rule_id", ruleIdsDue)
        .eq("is_enabled", true)
        .eq("status", "active")
        .in("marketplace", marketplaces)
        .order("id")
        .range(from, from + 999);
      if (error) throw new Error(`assignments: ${error.message}`);
      assignments.push(...((data ?? []) as unknown as AssignmentRow[]));
      if (!data || data.length < 1000) break;
    }
    // A rule is on for specific marketplaces only.
    const covered = assignments.filter((a) =>
      ((ruleBy.get(a.rule_id ?? "")?.auto_lower_min_marketplaces ?? []) as string[]).includes(a.marketplace));
    assignments.length = 0;
    assignments.push(...covered);
    if (!assignments.length) {
      return { items_processed: 0, detail: { decisions: [], note: "due rules have no eligible assignments", rules_due: dueRules.length } };
    }

    const userIds = [...new Set(assignments.map((a) => a.user_id))];
    const skus = [...new Set(assignments.map((a) => a.sku).filter(Boolean))] as string[];
    const asins = [...new Set(assignments.map((a) => a.asin))];

    // ── 2. Cost + fees live on inventory, keyed by (user_id, sku) ──────────
    // Chunked + paginated: PostgREST returns at most 1,000 rows per request.
    const invBy = new Map<string, Record<string, unknown>>();
    for (let i = 0; i < skus.length; i += 200) {
      const chunk = skus.slice(i, i + 200);
      for (let from = 0; ; from += 1000) {
        const { data, error } = await admin
          .from("inventory")
          .select("id, user_id, sku, cost, fees_json, my_price, price, min_price")
          .in("user_id", userIds)
          .in("sku", chunk)
          .order("id")
          .range(from, from + 999);
        if (error) throw new Error(`inventory: ${error.message}`);
        for (const r of data ?? []) invBy.set(`${r.user_id}::${r.sku}`, r);
        if (!data || data.length < 1000) break;
      }
    }

    // ── 2b. Unit cost: cost override -> COG on record -> inventory.cost ────
    //
    // Changed 2026-09-16. This worker used to read inventory.cost only, which
    // was empty on 233 of its 650 US rows (all skipped as no_cost) and wrong on
    // others -- B09R8YZX39 at $237.49 (a lot total; COG $5.94), B07VXRVZHH at
    // $0.11, which made break-even look like ~$1 and would have let a floor
    // fall far below the real cost. The ROI floor is the one thing standing
    // between this worker and a loss-making min, so it now uses the seller's
    // COG on record, same precedence as Inventory Valuation.
    //
    // Placeholder COGs ($1.00 import lots, unreviewed) are excluded by the
    // asin_cog_for_repricer view: those rows fall through to inventory.cost
    // and, when that is empty too, are skipped exactly as before.
    // A failed cost read throws: deciding floors on a partial cost map would
    // silently revert some ASINs to inventory.cost.
    const costBy = await loadRepricerCostMap(admin, userIds, asins);

    // ── 3. Latest competitor snapshot per (user, asin, marketplace) ────────
    // Via latest_competitor_snapshots() (20260918070000), one row per ASIN on
    // the (user_id, asin, marketplace, fetched_at DESC) index. It replaced a
    // single newest-first read of ALL snapshots with no seller filter: capped
    // at 1,000 rows (~half an hour of snapshots), it reported older-but-valid
    // data as "no_competitor_data", and it could read another seller's
    // snapshot of the same ASIN.
    const snapBy = new Map<string, Record<string, unknown>>();
    for (const uid of userIds) {
      const userAsins = [...new Set(assignments.filter((a) => a.user_id === uid).map((a) => a.asin))];
      for (const mp of marketplaces) {
        for (let i = 0; i < userAsins.length; i += 300) {
          const { data, error } = await admin.rpc("latest_competitor_snapshots", {
            p_user_id: uid, p_asins: userAsins.slice(i, i + 300), p_marketplace: mp,
          });
          if (error) throw new Error(`snapshots: ${error.message}`);
          for (const s of (data ?? []) as Array<Record<string, unknown>>) snapBy.set(`${uid}::${s.asin}::${mp}`, s);
        }
      }
    }

    // ── 3b. Per-ASIN fee cache ─────────────────────────────────────────────
    // fees_json alone is not a sufficient fee source: dry run #2 refused all 18
    // remaining candidates as `fees_unresolvable` without this. See
    // mergeFeeSources() for why guessing the gap is not an option.
    // Chunked: one row per (user, asin, marketplace) is under 1,000 today, but
    // PostgREST would silently cap a bigger catalogue at 1,000.
    const feeBy = new Map<string, Record<string, unknown>>();
    for (let i = 0; i < asins.length; i += 300) {
      const { data: feeRows, error: fErr } = await admin
        .from("asin_fee_cache")
        .select("user_id, asin, marketplace, referral_rate, fba_fee_fixed, fee_source")
        .in("user_id", userIds)
        .in("asin", asins.slice(i, i + 300))
        .in("marketplace", marketplaces);
      if (fErr) throw new Error(`fee cache: ${fErr.message}`);
      for (const f of feeRows ?? []) feeBy.set(`${f.user_id}::${f.asin}::${f.marketplace}`, f);
    }

    // ── 4. Rule-level ROI floors: already loaded with the due rules (1a). ──

    // ── 5. Pin FX once per currency for the whole run ──────────────────────
    const fxByMarketplace = new Map<string, number>();
    for (const mp of marketplaces) {
      const cur = marketplaceCurrency(mp);
      fxByMarketplace.set(mp, cur === "USD" ? 1 : await getUsdToRate(admin, cur));
    }

    // ── 6. Decide ──────────────────────────────────────────────────────────
    const writes: { id: string; newMin: number; nextCount: number; nextToday: number; invId?: string; baseline?: number }[] = [];

    for (const a of assignments) {
      const mp = a.marketplace;
      const fx = fxByMarketplace.get(mp) ?? 1;
      const inv = invBy.get(`${a.user_id}::${a.sku}`) as Record<string, any> | undefined;
      const snap = snapBy.get(`${a.user_id}::${a.asin}::${mp}`) as Record<string, any> | undefined;

      const d: Decision = {
        assignment_id: a.id,
        asin: a.asin,
        marketplace: mp,
        action: "skip",
        reason: "",
        fx_rate: fx,
      };
      const push = (reason: string) => {
        d.reason = reason;
        decisions.push(d);
      };

      const currentMin = a.min_price_override ?? inv?.min_price ?? null;
      d.current_min = currentMin;

      if (currentMin == null || !(Number(currentMin) > 0)) { push("no_min_set"); continue; }
      if (!inv) { push("no_inventory_row"); continue; }
      const resolvedCost = costBy.get(repricerCostKey(a.user_id, a.asin));
      const unitCost = resolvedCost
        ? resolvedCost.unitCost
        : (inv.cost != null && Number(inv.cost) > 0 ? Number(inv.cost) : null);
      if (unitCost == null) { push("no_cost"); continue; }
      d.unit_cost = unitCost;
      d.cost_source = resolvedCost ? resolvedCost.source : "inventory";

      // RULE 1 — daily drop allowance (was: 5 drops per listing, ever).
      // The rule sets the allowance; the count resets on a new UTC day.
      const drops = Number(a.auto_floor_drop_count ?? 0);
      d.drop_count = drops;
      d.rule_id = a.rule_id;
      const rule = a.rule_id ? ruleBy.get(a.rule_id) as Record<string, any> | undefined : undefined;
      const maxPerDay = Number(rule?.auto_lower_min_max_drops_per_day ?? 3);
      const dropsToday = a.auto_floor_drop_day === today ? Number(a.auto_floor_drops_on_day ?? 0) : 0;
      d.drops_today = dropsToday;
      d.max_drops_per_day = maxPerDay;
      // Reason keys are BUCKETS, never interpolated values: the skip_reasons
      // tally is the only feedback an unattended job gives, and embedding the
      // number made every cumulative skip its own key
      // (exhausted_cumulative_36.06pct, _38.46pct, ...) — unreadable. The value
      // lives on the decision row, where it can be queried.
      if (dropsToday >= maxPerDay) { push("daily_drop_limit"); continue; }

      // RULE 1 — exhausted by cumulative %. Baseline is the ORIGINAL floor.
      // SELF-HEALING BASELINE.
      //
      // manual_min_price is the anchor for the cumulative cap. It was only ever
      // populated by a one-time backfill in migration 20260323123515 — there is
      // no trigger, so ANY route that turns auto_lower_min_price on (the UI, a
      // hand-written UPDATE, a future feature) leaves it NULL and silently
      // disables the cumulative guard. The per-run cap alone still permits
      // 0.7^5 ≈ 17% of the original price across five drops — an 83% fall where
      // the rule intends to stop at 30%.
      //
      // So the worker anchors it itself rather than trusting callers to
      // remember. The value snapshotted is the floor as it stands BEFORE this
      // run's drop, which is exactly what the original migration captured, and
      // it is persisted with the write so it holds for every later run.
      const manualMin = a.manual_min_price != null
        ? Number(a.manual_min_price)
        : (Number(currentMin) > 0 ? Number(currentMin) : null);
      const baselineWasMissing = a.manual_min_price == null;
      if (manualMin != null && manualMin > 0) {
        const cumulativePct = ((manualMin - Number(currentMin)) / manualMin) * 100;
        d.cumulative_drop_pct = round2(cumulativePct);
        if (cumulativePct >= MAX_CUMULATIVE_DROP_PCT) {
          push("exhausted_cumulative");
          continue;
        }
      }

      // RULE 5 — already winning. Only on a FRESH status: a stale "losing"
      // cannot prove we are not winning now (see MAX_BB_STATUS_AGE_MS).
      const bb = String(a.last_buybox_status ?? "").toLowerCase();
      if (bb === "winning" || bb === "owned") { push("already_owns_buybox"); continue; }
      const bbAgeMs = a.last_sp_api_check_at ? runStartedAt.getTime() - new Date(a.last_sp_api_check_at).getTime() : Infinity;
      d.bb_status_age_min = Number.isFinite(bbAgeMs) ? Math.round(bbAgeMs / 60_000) : null;
      if (!(bbAgeMs <= MAX_BB_STATUS_AGE_MS)) { push("stale_buybox_status"); continue; }

      // RULE 6 — competitor data present.
      // The price to beat: the rule's anchor (per rule since 2026-09-18).
      // 'buybox' uses the Buy Box price and falls back to the lowest when the
      // snapshot has none; 'lowest' is the original behaviour.
      const lowestCompetitor = snap?.lowest_fba_price ?? snap?.lowest_overall_price ?? null;
      const wantBuybox = rule?.auto_lower_min_anchor === "buybox";
      const bbPrice = snap?.buybox_price != null && Number(snap.buybox_price) > 0 ? Number(snap.buybox_price) : null;
      const lowest = wantBuybox && bbPrice != null ? bbPrice : lowestCompetitor;
      d.anchor = wantBuybox ? (bbPrice != null ? "buybox" : "lowest_fallback") : "lowest";
      d.lowest = lowest;
      if (lowest == null || !(Number(lowest) > 0)) { push("no_competitor_data"); continue; }
      const snapAgeMs = snap?.fetched_at ? runStartedAt.getTime() - new Date(snap.fetched_at).getTime() : Infinity;
      d.snapshot_age_min = Number.isFinite(snapAgeMs) ? Math.round(snapAgeMs / 60_000) : null;
      if (!(snapAgeMs <= MAX_SNAPSHOT_AGE_MS)) { push("stale_competitor_data"); continue; }

      // Marketplace-correct price only. On US we may fall back to inventory,
      // which is denominated in USD; on any other marketplace we must not —
      // comparing a USD price to an MXN/CAD/BRL `lowest` is meaningless and
      // would skip rows as "already lowest" that are far from it.
      const myPrice = a.last_applied_price ?? (mp === "US" ? (inv.my_price ?? inv.price ?? null) : null);
      if (myPrice != null && Number(myPrice) <= Number(lowest) + 0.005) {
        push("already_lowest");
        continue;
      }

      // RULE 4 — ROI floor: policy, raised by the rule's own floor.
      const overrides = (rule?.min_roi_marketplace_overrides ?? {}) as Record<string, unknown>;
      const ruleFloorRaw = overrides?.[mp] ?? rule?.min_roi_percent ?? null;
      const ruleFloor = ruleFloorRaw == null ? null : Number(ruleFloorRaw);
      const policyFloor = POLICY_ROI_FLOOR[mp] ?? DEFAULT_POLICY_ROI_FLOOR;
      const roiFloor = ruleFloor == null ? policyFloor : Math.max(policyFloor, ruleFloor);
      d.roi_floor = roiFloor;

      // Merge the row's fees with the per-ASIN cache before any ROI maths.
      const feeCache = feeBy.get(`${a.user_id}::${a.asin}::${mp}`) as
        | { referral_rate?: number | null; fba_fee_fixed?: number | null; fee_source?: string | null }
        | undefined;
      const fees = mergeFeeSources(inv.fees_json, feeCache, mp);
      d.fee_source = feeCache ? String(feeCache.fee_source ?? "asin_fee_cache") : "inventory";

      const floorPrice = priceForRoi(unitCost, fees, roiFloor, fx, mp);
      if (floorPrice == null) { push("fees_unresolvable"); continue; }

      // Target: the rule's "lower by" amount below the lowest (default $0.01,
      // 0 = match). Per rule since 2026-09-18; was a fixed UNDERCUT_STEP.
      const undercutRaw = Number(rule?.auto_lower_min_undercut);
      const undercut = Number.isFinite(undercutRaw) && undercutRaw >= 0 ? undercutRaw : UNDERCUT_STEP;
      const target = round2(Number(lowest) - undercut);

      // RULE 2 — the 30% cap is TWO guards, and both are needed:
      //
      //   cumulative: never more than 30% below the ORIGINAL floor
      //   per-run:    never more than 30% below the CURRENT floor in one step
      //
      // Clamping only on the cumulative floor is not enough. When
      // manual_min_price sits BELOW the current min (the seller raised the floor
      // after it was first set, so cumulative_drop_pct is negative) the
      // cumulative floor is far under the current price and stops bounding the
      // single step. The first dry run caught exactly that: B0FC2HXZYZ was set
      // to drop 23 -> 15.98, a 30.52% single cut, on a row whose cumulative
      // reading was -27.78%.
      const perRunFloor = Number(currentMin) * (1 - MAX_CUMULATIVE_DROP_PCT / 100);
      const cumulativeFloor = manualMin != null && manualMin > 0
        ? manualMin * (1 - MAX_CUMULATIVE_DROP_PCT / 100)
        : perRunFloor;

      // Never below the ROI floor, never below either cap.
      const candidateRaw = Math.max(target, floorPrice, cumulativeFloor, perRunFloor);
      // Round UP to the cent — this number IS a floor, so rounding down breaches it.
      const newMin = Math.ceil(candidateRaw * 100) / 100;

      // RULE 7 — never raise.
      if (newMin >= Number(currentMin)) {
        push(target >= Number(currentMin) ? "not_a_drop" : "blocked_by_roi_or_cap");
        continue;
      }

      // Independent re-verification after rounding. The entire point of this
      // worker is that a floor is never set below its ROI limit — so prove it
      // from the final number rather than trusting the algebra that produced it.
      const verifyRoi = roiAtPrice(unitCost, fees, newMin, fx, mp);
      if (verifyRoi == null) { push("roi_verify_unavailable"); continue; }
      if (verifyRoi < roiFloor - ROI_VERIFY_TOLERANCE) {
        d.roi_at_new_min = verifyRoi;
        push("roi_verify_failed");
        continue;
      }

      d.action = "lower";
      d.new_min = newMin;
      d.roi_at_new_min = verifyRoi;
      d.drop_pct = round2(((Number(currentMin) - newMin) / Number(currentMin)) * 100);
      d.reason = "ok";
      decisions.push(d);

      writes.push({
        id: a.id,
        newMin,
        nextCount: drops + 1,
        nextToday: dropsToday + 1,
        invId: mp === "US" ? (inv.id as string) : undefined,
        // Persist the anchor on the very first drop, so the cumulative guard is
        // live from run two onward regardless of how the flag was enabled.
        baseline: baselineWasMissing && manualMin != null ? manualMin : undefined,
      });
    }

    // ── 7. Write ───────────────────────────────────────────────────────────
    let written = 0;
    if (!dryRun) {
      for (const w of writes) {
        const { error: uErr } = await admin
          .from("repricer_assignments")
          .update({
            min_price_override: w.newMin,
            auto_floor_drop_count: w.nextCount, // lifetime total, no longer a limit
            auto_floor_drop_day: today,
            auto_floor_drops_on_day: w.nextToday,
            updated_at: new Date().toISOString(),
            // Only ever written when it was NULL — the anchor must never move
            // once set, or the cumulative cap would follow the price down.
            ...(w.baseline != null ? { manual_min_price: w.baseline } : {}),
          })
          .eq("id", w.id);
        if (uErr) {
          console.error(`[auto-lower-min] write failed ${w.id}: ${uErr.message}`);
          continue;
        }
        // Mirror onto inventory for US only — same as the table's own save path.
        if (w.invId) {
          await admin.from("inventory").update({ min_price: w.newMin }).eq("id", w.invId);
        }
        written++;
      }
    }

    // Stamp every due rule, lowered or not, so its interval counts from this
    // run. Dry runs never stamp: they must not delay the real schedule.
    if (!dryRun && ruleIdsDue.length) {
      const { error: stampErr } = await admin
        .from("repricer_rules")
        .update({ auto_lower_min_last_run_at: runStartedAt.toISOString() })
        .in("id", ruleIdsDue);
      if (stampErr) console.error(`[auto-lower-min] rule stamp failed: ${stampErr.message}`);
    }

    const wouldLower = decisions.filter((x) => x.action === "lower").length;
    const skipReasons: Record<string, number> = {};
    for (const x of decisions) {
      if (x.action === "skip") skipReasons[x.reason] = (skipReasons[x.reason] ?? 0) + 1;
    }
    console.log(
      `[auto-lower-min] ${dryRun ? "DRY RUN " : ""}considered=${assignments.length} ` +
        `would_lower=${wouldLower} written=${written} skips=${JSON.stringify(skipReasons)}`,
    );

    return {
      items_processed: dryRun ? wouldLower : written,
      detail: {
        dry_run: dryRun,
        marketplaces,
        rules_on: allOnRules.length,
        rules_due: dueRules.length,
        considered: assignments.length,
        would_lower: wouldLower,
        written,
        skip_reasons: skipReasons,
        fx: Object.fromEntries(fxByMarketplace),
        decisions,
      },
    };
  };

  try {
    // Dry runs take no lock: they write nothing, and must stay runnable while a
    // real pass is in flight.
    if (dryRun) {
      const result = await run();
      return new Response(JSON.stringify({ success: true, ...result }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const outcome = await withCronLock(admin, "repricer-auto-lower-min", 900, run);
    return new Response(JSON.stringify({ success: !outcome.error, ...outcome }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[auto-lower-min] fatal: ${msg}`);
    return new Response(JSON.stringify({ success: false, error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
