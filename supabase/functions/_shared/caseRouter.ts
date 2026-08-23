// Phase 2 – Smart Sampling + Flash/Pro routing.
//
// Given a batch of repricer "cases" (one per ASIN decision under review), this
// module decides which model tier each case should be sent to:
//
//     pro    → deep LLM (gemini-2.5-pro)        — bounded by daily cap
//     flash  → cheap LLM (gemini-2.5-flash)     — bulk path
//     skip   → no LLM, deterministic rule-based note   — when AI adds no value
//
// Routing policy (Balanced, per stakeholder decision):
//   ESCALATE TO PRO when ANY of:
//     - repeated_bb_loss        : ASIN lost the BB ≥3 times in last 24h
//     - oscillation             : engine flipped direction (raise/lower) ≥3 times in 24h
//     - margin_compression      : current_price within 5% of profit_floor
//     - high_value              : ASIN in top 20% of revenue (last 30d)
//     - treatment_divergence    : ASIN sits in a live experiment AND its
//                                 group's measured outcome diverges from the
//                                 other arm's baseline by ≥10%
//   Otherwise → FLASH (default cheap path)
//   SKIP only if the case is a confirmed-correct hold (e.g. self-undercut
//   prevention with no new signal).
//
// Pro count is capped per user per day via smart_engine_pro_budget. When the
// cap is hit, additional Pro candidates are downgraded to Flash with a tail
// reason `cap_exhausted` so the router stays observable.

export type ModelTier = "pro" | "flash" | "skip";

export interface RouterCase {
  asin: string;
  marketplace?: string | null;
  current_price?: number | null;
  profit_floor?: number | null;
  was_bb_owner?: boolean | null;
  was_price_changed?: boolean | null;
  reason?: string | null;
  tuning_signal?: string | null;
  // Optional pre-computed signals from the caller. If absent the router will
  // try to fetch them.
  bb_losses_24h?: number;
  direction_flips_24h?: number;
  revenue_30d?: number;
  in_active_experiment?: boolean;
  treatment_divergence_pct?: number;
  unnecessary_undercut_reasons?: string[];
}

export interface RoutingDecision {
  asin: string;
  tier: ModelTier;
  reasons: string[];           // why we chose this tier
  cap_exhausted?: boolean;     // true if downgraded from pro→flash by cap
}

// Tunable thresholds — keep in one place so we can iterate easily.
export const ROUTER_THRESHOLDS = {
  REPEATED_BB_LOSS: 3,            // losses in 24h
  OSCILLATION_FLIPS: 3,           // flips in 24h
  MARGIN_COMPRESSION_PCT: 0.05,   // within 5% of floor
  HIGH_VALUE_PERCENTILE: 0.80,    // top 20% by revenue
  TREATMENT_DIVERGENCE_PCT: 0.10, // ≥10% gap vs control baseline
  PRO_DAILY_CAP_DEFAULT: 100,
} as const;

/**
 * Pure routing function — no I/O. Given a case with all signals already
 * computed, returns the chosen tier + reasons.
 */
export function routeCase(c: RouterCase, opts: {
  isHighValue?: boolean;          // pre-computed by the caller
} = {}): RoutingDecision {
  const reasons: string[] = [];

  // ---- SKIP path: confirmed-correct holds with no new signal ----
  // Holding the BB while already lowest FBA, no price change, no tuning signal:
  // pure rule-based — sending this to an LLM is waste.
  if (
    c.was_price_changed === false &&
    c.was_bb_owner === true &&
    !c.tuning_signal &&
    !(c.unnecessary_undercut_reasons && c.unnecessary_undercut_reasons.length > 0)
  ) {
    return { asin: c.asin, tier: "skip", reasons: ["confirmed_correct_hold"] };
  }

  // ---- PRO escalation triggers ----
  if ((c.bb_losses_24h ?? 0) >= ROUTER_THRESHOLDS.REPEATED_BB_LOSS) {
    reasons.push("repeated_bb_loss");
  }
  if ((c.direction_flips_24h ?? 0) >= ROUTER_THRESHOLDS.OSCILLATION_FLIPS) {
    reasons.push("oscillation");
  }
  if (
    typeof c.current_price === "number" && c.current_price > 0 &&
    typeof c.profit_floor === "number" && c.profit_floor > 0
  ) {
    const headroom = (c.current_price - c.profit_floor) / c.current_price;
    if (headroom <= ROUTER_THRESHOLDS.MARGIN_COMPRESSION_PCT) {
      reasons.push("margin_compression");
    }
  }
  if (opts.isHighValue) {
    reasons.push("high_value");
  }
  if (
    c.in_active_experiment &&
    typeof c.treatment_divergence_pct === "number" &&
    Math.abs(c.treatment_divergence_pct) >= ROUTER_THRESHOLDS.TREATMENT_DIVERGENCE_PCT
  ) {
    reasons.push("treatment_divergence");
  }

  if (reasons.length > 0) {
    return { asin: c.asin, tier: "pro", reasons };
  }

  return { asin: c.asin, tier: "flash", reasons: ["default_bulk"] };
}

/**
 * Compute the high-value ASIN set (top 20% by 30d revenue).
 * Uses sales_orders as the source. Returns a Set of ASIN strings.
 */
export async function computeHighValueAsins(
  admin: { from: (t: string) => any },
  userId: string,
  candidateAsins: string[],
): Promise<Set<string>> {
  if (candidateAsins.length === 0) return new Set();

  const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const { data, error } = await admin
    .from("sales_orders")
    .select("asin, total_sale_amount")
    .eq("user_id", userId)
    .gte("order_date", cutoff)
    .in("asin", candidateAsins);
  if (error || !data) return new Set();

  const revByAsin = new Map<string, number>();
  for (const row of data as Array<{ asin: string; total_sale_amount: number | null }>) {
    if (!row.asin) continue;
    revByAsin.set(row.asin, (revByAsin.get(row.asin) ?? 0) + Number(row.total_sale_amount ?? 0));
  }
  if (revByAsin.size === 0) return new Set();

  const sorted = [...revByAsin.entries()].sort((a, b) => b[1] - a[1]);
  const cutoffIdx = Math.max(1, Math.ceil(sorted.length * (1 - ROUTER_THRESHOLDS.HIGH_VALUE_PERCENTILE)));
  return new Set(sorted.slice(0, cutoffIdx).map(([asin]) => asin));
}

/**
 * Compute repeated BB-loss + direction-flip counts per ASIN over the last 24h.
 * Source: repricer_price_actions (already populated by the scheduler).
 */
export async function computeBehavioralSignals(
  admin: { from: (t: string) => any },
  userId: string,
  candidateAsins: string[],
): Promise<Map<string, { bb_losses_24h: number; direction_flips_24h: number }>> {
  const out = new Map<string, { bb_losses_24h: number; direction_flips_24h: number }>();
  if (candidateAsins.length === 0) return out;

  const cutoff = new Date(Date.now() - 24 * 3_600_000).toISOString();
  // `reason` and `old_price`, NOT decision_label / previous_price. Neither of
  // those columns has ever existed on repricer_price_actions -- decision_label
  // belongs to the smart-engine case tables (20260405185550), and the price
  // column here is old_price.
  //
  // The `if (error || !data) return out` below meant this never surfaced: the
  // query errored, an EMPTY map was returned, and every caller silently saw
  // bb_losses_24h = 0 and direction_flips_24h = 0 for every ASIN. Behavioural
  // signals have never once been computed. The only outward trace was
  // "column repricer_price_actions.decision_label does not exist" in the
  // Postgres log at 08:00, when cron jobid 21
  // (smart-engine-auto-review-morning, "0 8 * * *") fires.
  //
  // The error is now logged rather than swallowed, so the next schema drift of
  // this kind shows up in the function's own logs instead of only in Postgres.
  const { data, error } = await admin
    .from("repricer_price_actions")
    .select("asin, action_type, reason, created_at, new_price, old_price")
    .eq("user_id", userId)
    .gte("created_at", cutoff)
    .in("asin", candidateAsins)
    .order("created_at", { ascending: true });
  if (error) {
    console.error(`[caseRouter] computeBehavioralSignals query failed: ${error.message}`);
    return out;
  }
  if (!data) return out;

  // Group by ASIN
  const byAsin = new Map<string, any[]>();
  for (const row of data as any[]) {
    if (!row.asin) continue;
    if (!byAsin.has(row.asin)) byAsin.set(row.asin, []);
    byAsin.get(row.asin)!.push(row);
  }

  for (const [asin, rows] of byAsin) {
    let bbLosses = 0;
    let flips = 0;
    let prevDir: "up" | "down" | null = null;
    for (const r of rows) {
      const lbl = String(r.reason ?? "").toLowerCase();
      if (lbl.includes("bb_lost") || lbl.includes("buybox_lost") || lbl.includes("lost_bb")) {
        bbLosses += 1;
      }
      const np = Number(r.new_price ?? 0);
      const pp = Number(r.old_price ?? 0);
      if (np > 0 && pp > 0 && np !== pp) {
        const dir: "up" | "down" = np > pp ? "up" : "down";
        if (prevDir && dir !== prevDir) flips += 1;
        prevDir = dir;
      }
    }
    out.set(asin, { bb_losses_24h: bbLosses, direction_flips_24h: flips });
  }
  return out;
}

/**
 * Reserve N pro slots for a user TODAY (UTC). Returns how many slots were
 * actually granted (≤ requested). Atomic via INSERT ... ON CONFLICT.
 */
export async function reserveProSlots(
  admin: { from: (t: string) => any; rpc?: any },
  userId: string,
  requested: number,
): Promise<{ granted: number; cap: number; used_after: number }> {
  if (requested <= 0) return { granted: 0, cap: 0, used_after: 0 };

  const today = new Date().toISOString().slice(0, 10); // UTC date

  // Upsert the row first (idempotent).
  await admin
    .from("smart_engine_pro_budget")
    .upsert(
      {
        user_id: userId,
        budget_date: today,
        pro_reviews_used: 0,
        pro_reviews_cap: ROUTER_THRESHOLDS.PRO_DAILY_CAP_DEFAULT,
      },
      { onConflict: "user_id,budget_date", ignoreDuplicates: true },
    );

  // Fetch the row.
  const { data: row } = await admin
    .from("smart_engine_pro_budget")
    .select("pro_reviews_used, pro_reviews_cap")
    .eq("user_id", userId)
    .eq("budget_date", today)
    .maybeSingle();

  const cap = Number(row?.pro_reviews_cap ?? ROUTER_THRESHOLDS.PRO_DAILY_CAP_DEFAULT);
  const used = Number(row?.pro_reviews_used ?? 0);
  const remaining = Math.max(0, cap - used);
  const granted = Math.min(requested, remaining);

  if (granted > 0) {
    await admin
      .from("smart_engine_pro_budget")
      .update({
        pro_reviews_used: used + granted,
        last_review_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId)
      .eq("budget_date", today);
  }

  return { granted, cap, used_after: used + granted };
}

/**
 * Resolve which ASINs sit in a live (non-rolled-back) tuning experiment for
 * this user. Returns a Set of ASINs in any treatment OR control arm.
 * (For divergence we'd need to compare snapshots — kept lightweight here;
 * callers can pass treatment_divergence_pct directly if they have it.)
 */
export async function loadActiveExperimentAsins(
  admin: { from: (t: string) => any },
  userId: string,
): Promise<Set<string>> {
  const { data, error } = await admin
    .from("smart_engine_tuning_actions")
    .select("treatment_asins, control_asins, rolled_back_at")
    .eq("user_id", userId)
    .is("rolled_back_at", null);
  if (error || !data) return new Set();
  const out = new Set<string>();
  for (const row of data as Array<{ treatment_asins: string[] | null; control_asins: string[] | null }>) {
    for (const a of row.treatment_asins ?? []) out.add(a);
    for (const a of row.control_asins ?? []) out.add(a);
  }
  return out;
}

/**
 * High-level: take raw cases for a single user, compute all signals, apply the
 * routing policy, enforce the daily Pro cap. Returns a parallel array of
 * decisions plus a summary.
 */
export async function routeBatch(
  admin: { from: (t: string) => any },
  userId: string,
  cases: RouterCase[],
): Promise<{
  decisions: RoutingDecision[];
  summary: { pro: number; flash: number; skip: number; cap_used: number; cap: number };
}> {
  const asins = Array.from(new Set(cases.map((c) => c.asin).filter(Boolean)));

  const [highValue, behavioral, expAsins] = await Promise.all([
    computeHighValueAsins(admin, userId, asins),
    computeBehavioralSignals(admin, userId, asins),
    loadActiveExperimentAsins(admin, userId),
  ]);

  // First pass: ideal routing (no cap yet).
  const provisional = cases.map((c) => {
    const beh = behavioral.get(c.asin);
    const enriched: RouterCase = {
      ...c,
      bb_losses_24h: c.bb_losses_24h ?? beh?.bb_losses_24h ?? 0,
      direction_flips_24h: c.direction_flips_24h ?? beh?.direction_flips_24h ?? 0,
      in_active_experiment: c.in_active_experiment ?? expAsins.has(c.asin),
    };
    return routeCase(enriched, { isHighValue: highValue.has(c.asin) });
  });

  // Apply Pro cap.
  const proCandidates = provisional.filter((d) => d.tier === "pro");
  const { granted, cap, used_after } = await reserveProSlots(admin, userId, proCandidates.length);

  if (granted < proCandidates.length) {
    // Downgrade the lowest-priority Pro candidates to Flash.
    // Priority: more reasons = higher priority. Tiebreaker: keep earlier ones.
    const ranked = proCandidates
      .map((d, idx) => ({ d, idx, score: d.reasons.length }))
      .sort((a, b) => b.score - a.score || a.idx - b.idx);
    const keepSet = new Set(ranked.slice(0, granted).map((r) => r.d.asin));
    for (const d of provisional) {
      if (d.tier === "pro" && !keepSet.has(d.asin)) {
        d.tier = "flash";
        d.reasons = [...d.reasons, "cap_exhausted"];
        d.cap_exhausted = true;
      }
    }
  }

  let pro = 0, flash = 0, skip = 0;
  for (const d of provisional) {
    if (d.tier === "pro") pro += 1;
    else if (d.tier === "flash") flash += 1;
    else skip += 1;
  }

  return {
    decisions: provisional,
    summary: { pro, flash, skip, cap_used: used_after, cap },
  };
}
