// verify-live-sales-cache-parity
//
// TEMPORARY parity tool. Compares `live_sales_period_cache` totals against a
// fresh canonical aggregation (`computeLiveSalesSummary` — the same shared
// Deno aggregator that backs `refresh-live-sales-summary` and mirrors the
// Live Sales UI line-by-line: cancellations excluded, replacements excluded,
// zero-price pending handled via the fallback ladder, refunds netted, promo
// rebates subtracted, FX→USD per marketplace, fee/COGS resolver, Phase 1+2
// dedupe).
//
// Periods compared (per call, in user's sales TZ):
//   - last-month        (full calendar month, closed)
//   - this-month-to-yesterday
//   - ytd-to-yesterday
//
// Marketplaces compared per period: ALL, US, CA, MX, BR.
//
// Output per (period, marketplace):
//   metrics: { revenue, units, refunds_amount, fees, cost, promo, profit, roi }
//   cached / live / diff / pct_diff
//
// SAFE: read-only. Does not write to the cache or to sales_orders.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { computeLiveSalesSummary, SALES_BUSINESS_TZ } from "../_shared/live-sales-core.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-internal-secret",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const TARGET_MARKETPLACES = ["ALL", "US", "CA", "MX", "BR"];
const METRICS = [
  "revenue",
  "units",
  "refunds_amount",
  "fees",
  "cost",
  "promo",
  "profit",
  "roi",
] as const;
type Metric = typeof METRICS[number];

function ymdInTz(d: Date, tz = SALES_BUSINESS_TZ): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}
function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}
function firstOfMonth(ymd: string): string {
  const [y, m] = ymd.split("-").map(Number);
  return `${y}-${String(m).padStart(2, "0")}-01`;
}
function lastOfMonth(ymd: string): string {
  const [y, m] = ymd.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${String(m).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
}
function shiftMonth(ymd: string, deltaMonths: number): string {
  const [y, m] = ymd.split("-").map(Number);
  const total = y * 12 + (m - 1) + deltaMonths;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, "0")}-01`;
}

interface PeriodSpec {
  label: string;
  cache_period_key: string | null; // null => compare against a live re-aggregation only
  start: string;
  end: string;
}

function buildPeriods(today: string): PeriodSpec[] {
  const yesterday = addDays(today, -1);
  const [curY] = today.split("-").map(Number);
  const thisMonthStart = firstOfMonth(today);
  const lastMonthStart = shiftMonth(thisMonthStart, -1);
  const lastMonthEnd = lastOfMonth(lastMonthStart);

  const periods: PeriodSpec[] = [
    {
      label: "last-month",
      cache_period_key: "last-month",
      start: lastMonthStart,
      end: lastMonthEnd,
    },
  ];

  if (yesterday >= thisMonthStart) {
    periods.push({
      label: "this-month-to-yesterday",
      cache_period_key: null, // open period — cache doesn't store it directly
      start: thisMonthStart,
      end: yesterday,
    });
  }

  if (yesterday >= `${curY}-01-01`) {
    periods.push({
      label: "ytd-to-yesterday",
      cache_period_key: `ytd-closed-${curY}`,
      start: `${curY}-01-01`,
      end: yesterday,
    });
  }

  return periods;
}

interface MetricBag { [k: string]: number }

function zeroBag(): MetricBag {
  const b: MetricBag = {};
  for (const m of METRICS) b[m] = 0;
  return b;
}

function pctDiff(cached: number, live: number): number | null {
  if (live === 0 && cached === 0) return 0;
  if (live === 0) return null; // undefined denominator
  return Math.round(((cached - live) / live) * 10000) / 100; // % to 2dp
}

// Reduce computeLiveSalesSummary daily rows into per-marketplace metric bags
// using the SAME columns Live Sales UI reads:
//   revenue = revenue_with_fallback         (matches KPI revenue)
//   units   = units_with_fallback
//   fees    = fees_with_fallback
//   cost    = cost_with_fallback
//   refunds = refund_amount                  (already net of cancellations)
//   profit  = profit_with_fallback - promo   (promo already subtracted upstream
//                                            inside revenue_with_fallback)
// promo is reported from sales_orders.promotion_discount converted to USD by
// re-running a tiny aggregator below (so we can show the user the magnitude).
async function aggregateLive(
  admin: any,
  userId: string,
  startISO: string,
  endISO: string,
): Promise<Record<string, MetricBag>> {
  const { daily } = await computeLiveSalesSummary({
    admin, userId, startISO, endISO,
  });

  const byMkt: Record<string, MetricBag> = { ALL: zeroBag() };
  for (const m of TARGET_MARKETPLACES) byMkt[m] = byMkt[m] || zeroBag();

  for (const d of daily) {
    const mp = (d.marketplace_id || "US").toUpperCase();
    const bag = byMkt[mp] || (byMkt[mp] = zeroBag());
    const all = byMkt["ALL"];

    bag.revenue += d.revenue_with_fallback;
    bag.units += d.units_with_fallback;
    bag.refunds_amount += d.refund_amount;
    bag.fees += d.fees_with_fallback;
    bag.cost += d.cost_with_fallback;
    bag.profit += d.profit_with_fallback;

    all.revenue += d.revenue_with_fallback;
    all.units += d.units_with_fallback;
    all.refunds_amount += d.refund_amount;
    all.fees += d.fees_with_fallback;
    all.cost += d.cost_with_fallback;
    all.profit += d.profit_with_fallback;
  }

  // Promo isn't returned by computeLiveSalesSummary as its own column — pull
  // it directly from sales_orders for display. (Live KPI already subtracts it
  // inside revenue_with_fallback.)
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await admin
      .from("sales_orders")
      .select("marketplace, promotion_discount, order_status, is_cancelled, order_type")
      .eq("user_id", userId)
      .gte("order_date", startISO)
      .lte("order_date", endISO)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`promo query failed: ${error.message}`);
    const rows = data ?? [];
    if (rows.length === 0) break;
    for (const r of rows) {
      if (r.is_cancelled) continue;
      const s = String(r.order_status || "").toLowerCase();
      if (s === "canceled" || s === "cancelled") continue;
      const t = String(r.order_type || "").toLowerCase();
      if (t.includes("replacement")) continue;
      const mp = String(r.marketplace || "US").toUpperCase();
      const p = Math.abs(Number(r.promotion_discount ?? 0)) || 0;
      if (p === 0) continue;
      (byMkt[mp] || (byMkt[mp] = zeroBag())).promo += p;
      byMkt["ALL"].promo += p;
    }
    if (rows.length < PAGE) break;
    from += PAGE;
    if (from > 250_000) break;
  }

  // Finalize ROI
  for (const mp of Object.keys(byMkt)) {
    const b = byMkt[mp];
    b.roi = b.cost > 0 ? Math.round((b.profit / b.cost) * 10000) / 100 : 0;
    for (const k of Object.keys(b)) b[k] = Math.round(b[k] * 100) / 100;
  }
  return byMkt;
}

async function loadCachedBag(
  admin: any,
  userId: string,
  periodKey: string,
  marketplace: string,
): Promise<MetricBag | null> {
  const { data, error } = await admin
    .from("live_sales_period_cache")
    .select("totals, period_start, period_end, computed_at, sales_sync_version")
    .eq("user_id", userId)
    .eq("marketplace", marketplace)
    .eq("period_key", periodKey)
    .maybeSingle();
  if (error) throw new Error(`cache read failed: ${error.message}`);
  if (!data?.totals) return null;
  const t: any = data.totals;
  const revenue = Number(t.revenue ?? 0);
  const refunds = Number(t.refunds_amount ?? 0);
  const fees = Number(t.fees ?? 0);
  const cost = Number(t.cost ?? 0);
  const promo = Number(t.promo ?? 0);
  // Cache writer doesn't store profit/roi — derive same way the UI would
  const profit = revenue - refunds - fees - cost - promo;
  const bag: MetricBag = {
    revenue: Math.round(revenue * 100) / 100,
    units: Number(t.units ?? 0),
    refunds_amount: Math.round(refunds * 100) / 100,
    fees: Math.round(fees * 100) / 100,
    cost: Math.round(cost * 100) / 100,
    promo: Math.round(promo * 100) / 100,
    profit: Math.round(profit * 100) / 100,
    roi: cost > 0 ? Math.round((profit / cost) * 10000) / 100 : 0,
  };
  // attach meta in a non-metric key
  (bag as any)._meta = {
    period_start: data.period_start,
    period_end: data.period_end,
    computed_at: data.computed_at,
    sales_sync_version: data.sales_sync_version,
  };
  return bag;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supa = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

  let body: any = {};
  try { body = req.method === "POST" ? await req.json() : {}; } catch { body = {}; }

  // Auth: user JWT (compare own data) or service-role with explicit user_id
  let userId: string | null = null;
  const auth = req.headers.get("authorization") || "";
  if (auth.includes(SERVICE_ROLE) && body?.user_id) {
    userId = body.user_id;
  } else {
    const token = auth.replace(/^Bearer\s+/i, "");
    if (!token) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { data: u, error: ue } = await supa.auth.getUser(token);
    if (ue || !u?.user?.id) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    userId = u.user.id;
  }

  try {
    const today = ymdInTz(new Date());
    const periods = buildPeriods(today);
    const report: any[] = [];

    for (const p of periods) {
      const liveByMkt = await aggregateLive(supa, userId!, p.start, p.end);

      for (const mkt of TARGET_MARKETPLACES) {
        const live = liveByMkt[mkt] || zeroBag();
        const cached = p.cache_period_key
          ? await loadCachedBag(supa, userId!, p.cache_period_key, mkt)
          : null;

        const metrics: Record<string, any> = {};
        for (const m of METRICS) {
          const c = cached ? cached[m] : null;
          const l = live[m];
          metrics[m] = {
            cached: c,
            live: l,
            diff: c == null ? null : Math.round((c - l) * 100) / 100,
            pct_diff: c == null ? null : pctDiff(c, l),
          };
        }

        report.push({
          period: p.label,
          period_start: p.start,
          period_end: p.end,
          marketplace: mkt,
          cache_period_key: p.cache_period_key,
          cache_present: cached !== null,
          cache_meta: cached ? (cached as any)._meta : null,
          metrics,
        });
      }
    }

    // Summary verdict: any non-zero diff on a closed-period metric is a fail.
    const failures = report.filter(r =>
      r.cache_present &&
      Object.values(r.metrics).some((m: any) =>
        m.cached != null && Math.abs(m.diff ?? 0) > 0.01
      )
    );

    return new Response(JSON.stringify({
      ok: true,
      user_id: userId,
      generated_at: new Date().toISOString(),
      sales_tz: SALES_BUSINESS_TZ,
      today,
      exclusions_applied: {
        canceled_orders: "excluded (is_cancelled OR order_status in canceled/cancelled)",
        replacement_orders: "excluded (order_type contains 'replacement')",
        zero_price_pending: "handled via estimated_price → fallback USD unit ladder",
        refunds: "netted from profit via refund_amount",
        promo_rebates: "subtracted from revenue inside revenue_with_fallback (and broken out as its own column for visibility)",
        marketplace_currency: "FX→USD per marketplace via fx_rates (same as UI)",
      },
      verdict: {
        cached_periods_checked: report.filter(r => r.cache_present).length,
        failing_period_marketplaces: failures.length,
        pass: failures.length === 0,
      },
      report,
    }, null, 2), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e?.message || String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
