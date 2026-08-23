// Strategy memory builder — runs daily.
// Computes per-ASIN learned outcome metrics from price actions + sales + acks history.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { requireInternalCall } from "../_shared/require-internal.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-internal-secret",
};
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function buildForUser(
  admin: ReturnType<typeof createClient>,
  userId: string,
): Promise<number> {
  const since60d = new Date(
    Date.now() - 60 * 24 * 3600 * 1000,
  ).toISOString();

  const [{ data: actions }, { data: acks }, { data: sales }, { data: outcomes }] =
    await Promise.all([
      admin
        .from("repricer_price_actions")
        .select("asin,marketplace,old_price,new_price,created_at")
        .eq("user_id", userId)
        .gte("created_at", since60d)
        .limit(50000),
      // acked_at, NOT created_at. repricer_eval_acks has never had a
      // created_at column -- see its CREATE TABLE in 20260318064706. The
      // column above it on repricer_price_actions IS created_at, which is
      // probably how the two got confused.
      //
      // This did not crash anything, which is why it survived. supabase-js
      // returns { data: null, error } instead of throwing, so `acks` was
      // always null, the loop below always skipped, and oscEvents was
      // permanently 0 -- oscillation and instability events have never been
      // counted in strategy memory. The only outward sign was
      // "column repricer_eval_acks.created_at does not exist" in the Postgres
      // log at 02:30 each night, when cron jobid 64
      // (repricer-strategy-memory-daily, "30 2 * * *") fires.
      //
      // The identical bug was found and fixed in repricer-executive-summary
      // earlier this week; its header still documents it. This sibling was
      // missed. Worth grepping for `repricer_eval_acks` + `created_at`
      // together before assuming these were the only two.
      admin
        .from("repricer_eval_acks")
        .select("asin,reason,acked_at")
        .eq("user_id", userId)
        .gte("acked_at", since60d)
        .limit(50000),
      admin
        .from("sales_orders")
        .select("asin,quantity,order_date")
        .eq("user_id", userId)
        .gte("order_date", since60d)
        .limit(50000),
      admin
        .from("repricer_action_outcomes")
        .select("asin,marketplace,outcome_label,evaluated_at")
        .eq("user_id", userId)
        .gte("evaluated_at", since60d)
        .limit(50000),
    ]);

  // Aggregate outcome score per asin+marketplace
  const outcomeAgg = new Map<string, { good: number; bad: number; total: number }>();
  for (const o of outcomes ?? []) {
    const k = `${o.asin}|${o.marketplace}`;
    if (!outcomeAgg.has(k))
      outcomeAgg.set(k, { good: 0, bad: 0, total: 0 });
    const a = outcomeAgg.get(k)!;
    a.total += 1;
    if (o.outcome_label === "successful" || o.outcome_label === "partial")
      a.good += 1;
    if (o.outcome_label === "failed" || o.outcome_label === "reversed")
      a.bad += 1;
  }

  // Group by asin+marketplace
  const groups = new Map<string, any>();
  for (const r of actions ?? []) {
    const k = `${r.asin}|${r.marketplace}`;
    if (!groups.has(k))
      groups.set(k, {
        asin: r.asin,
        marketplace: r.marketplace,
        actions: [],
        oscEvents: 0,
        sales: 0,
      });
    groups.get(k).actions.push(r);
  }
  for (const r of acks ?? []) {
    const reason = (r.reason || "").toUpperCase();
    if (reason.includes("OSCILLATION") || reason.includes("INSTABILITY")) {
      // Add to all marketplaces for this asin (approx)
      for (const [k, g] of groups.entries())
        if (g.asin === r.asin) g.oscEvents += 1;
    }
  }
  for (const s of sales ?? []) {
    for (const [k, g] of groups.entries())
      if (g.asin === s.asin) g.sales += Number(s.quantity ?? 1);
  }

  const rows: any[] = [];
  for (const g of groups.values()) {
    const acts = g.actions.sort((a: any, b: any) =>
      a.created_at.localeCompare(b.created_at),
    );
    let reductions = 0;
    let reductionWins = 0;
    let increases = 0;
    let increaseHolds = 0;
    let priceVariance = 0;
    let mean = 0;
    if (acts.length) {
      const prices = acts.map((a: any) => Number(a.new_price ?? 0)).filter(Boolean);
      mean = prices.reduce((s: number, n: number) => s + n, 0) / prices.length;
      priceVariance =
        prices.reduce(
          (s: number, n: number) => s + Math.pow(n - mean, 2),
          0,
        ) / prices.length;
    }
    for (let i = 0; i < acts.length; i++) {
      const a = acts[i];
      const old = Number(a.old_price ?? 0);
      const nw = Number(a.new_price ?? 0);
      if (old <= 0 || nw <= 0) continue;
      if (nw < old) {
        reductions += 1;
        // win = had a sale within 48h after this action
        const tCut = new Date(
          new Date(a.created_at).getTime() + 48 * 3600 * 1000,
        );
        const had = (sales ?? []).some(
          (s: any) =>
            s.asin === g.asin &&
            new Date(s.order_date) > new Date(a.created_at) &&
            new Date(s.order_date) <= tCut,
        );
        if (had) reductionWins += 1;
      } else if (nw > old) {
        increases += 1;
        // hold = no further reduction within 48h after this raise
        const next = acts[i + 1];
        if (
          !next ||
          new Date(next.created_at).getTime() -
            new Date(a.created_at).getTime() >
            48 * 3600 * 1000
        )
          increaseHolds += 1;
      }
    }
    const stability = mean > 0 ? Math.max(0, 1 - Math.sqrt(priceVariance) / mean) : 0;
    const winRate = reductions > 0 ? reductionWins / reductions : null;
    const retention = increases > 0 ? increaseHolds / increases : null;
    const osc = Math.min(1, g.oscEvents / Math.max(1, acts.length));
    const oa = outcomeAgg.get(`${g.asin}|${g.marketplace}`);
    const recentOutcomeScore = oa && oa.total > 0 ? oa.good / oa.total : null;

    // Personality profile
    let personality = "unknown";
    if (osc > 0.4) personality = "race_to_bottom";
    else if (acts.length >= 5 && stability > 0.85 && (retention ?? 0) > 0.7)
      personality = "stable_premium";
    else if ((winRate ?? 0) > 0.7 && reductions >= 3)
      personality = "highly_elastic";
    else if (acts.length >= 10 && stability < 0.6)
      personality = "highly_competitive";
    else if (
      reductions >= 3 &&
      (winRate ?? 0) < 0.3
    )
      personality = "slow_recovery";
    else if (acts.length <= 2 && g.sales > 0) personality = "protected_niche";

    rows.push({
      user_id: userId,
      asin: g.asin,
      marketplace: g.marketplace,
      win_rate_after_reduction: winRate != null ? Math.round(winRate * 100) / 100 : null,
      bb_retention_after_increase:
        retention != null ? Math.round(retention * 100) / 100 : null,
      avg_recovery_time_hours: null,
      oscillation_tendency: Math.round(osc * 100) / 100,
      profit_stability_score: Math.round(stability * 100) / 100,
      elasticity_class:
        reductions >= 3 && (winRate ?? 0) > 0.6
          ? "high"
          : reductions >= 3
            ? "medium"
            : "unknown",
      personality_profile: personality,
      recent_outcome_score:
        recentOutcomeScore != null
          ? Math.round(recentOutcomeScore * 100) / 100
          : null,
      sample_size: acts.length,
      last_built_at: new Date().toISOString(),
    });
  }

  for (let i = 0; i < rows.length; i += 500) {
    await admin
      .from("repricer_asin_strategy_memory")
      .upsert(rows.slice(i, i + 500), {
        onConflict: "user_id,asin,marketplace",
      });
  }
  return rows.length;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS")
    return new Response("ok", { headers: corsHeaders });
  try {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
      auth: { persistSession: false },
    });
    let body: any = {};
    if (req.method !== "GET") {
      try {
        body = await req.json();
      } catch {
        /* */
      }
    }
    if (body?.all_users === true) {
      const forbidden = requireInternalCall(req);
      if (forbidden) return forbidden;
      const { withCronLock } = await import("../_shared/cron-lock.ts");
      const outcome = await withCronLock(admin as any, "repricer-strategy-memory-daily", 3000, async () => {
        const { data: users } = await admin
          .from("repricer_assignments")
          .select("user_id")
          .eq("is_enabled", true);
        const uniq = Array.from(new Set((users ?? []).map((u: any) => u.user_id)));
        let total = 0;
        for (const uid of uniq) {
          try {
            total += await buildForUser(admin, uid);
            await new Promise((r) => setTimeout(r, 400));
          } catch (e) {
            console.error("memory build fail", uid, e);
          }
        }
        return { items_processed: total, detail: { total_users: uniq.length } };
      });
      return new Response(JSON.stringify({ rows: outcome.items_processed, ...outcome }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const authHeader = req.headers.get("authorization");
    if (!authHeader)
      return new Response(JSON.stringify({ error: "auth required" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    const userClient = createClient(
      SUPABASE_URL,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const {
      data: { user },
    } = await userClient.auth.getUser();
    if (!user)
      return new Response(JSON.stringify({ error: "invalid user" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    const rows = await buildForUser(admin, user.id);
    return new Response(JSON.stringify({ rows }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
