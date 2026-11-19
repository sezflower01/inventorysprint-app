// Live Sales — Period Snapshot Reader (Phase 1)
//
// Loads compact closed-period totals from `live_sales_period_cache` and
// merges today's live delta on top so switching Month / Last Month / YTD
// becomes near-instant without losing freshness.
//
// IMPORTANT: this helper is currently NOT wired into `LiveSales.tsx` or
// `MobileLiveSales.tsx`. The plan is to validate that the writer
// (`refresh-live-sales-period-cache`) is populating rows correctly first,
// then swap the KPI fetch paths in a follow-up PR.
//
// See:
//   - .lovable/plan.md
//   - supabase/functions/refresh-live-sales-period-cache/index.ts

import { supabase } from "@/integrations/supabase/client";

export interface PeriodTotals {
  revenue: number;
  units: number;
  orders: number;
  refunds_amount: number;
  refunds_count: number;
  promo: number;
  fees: number;
  cost: number;
  pending_revenue: number;
  pending_orders: number;
}

export interface PeriodSnapshotResult {
  totals: PeriodTotals;
  /** "snapshot+today" when DB row was found, "live" if we had to fall back. */
  source: "snapshot+today" | "snapshot-only" | "live" | "empty";
  /** ISO timestamp of when the closed snapshot was computed. */
  computed_at: string | null;
  /** Closed snapshot value before today's delta was merged. */
  closed_totals: PeriodTotals | null;
  today_totals: PeriodTotals;
  period_start: string;
  period_end_closed: string;
  /** YYYY-MM-DD in user's sales business TZ. */
  today_ymd: string;
}

const SALES_TZ = "America/Los_Angeles";

function emptyTotals(): PeriodTotals {
  return {
    revenue: 0,
    units: 0,
    orders: 0,
    refunds_amount: 0,
    refunds_count: 0,
    promo: 0,
    fees: 0,
    cost: 0,
    pending_revenue: 0,
    pending_orders: 0,
  };
}

function ymdInTz(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function mergeTotals(a: PeriodTotals, b: PeriodTotals): PeriodTotals {
  return {
    revenue: a.revenue + b.revenue,
    units: a.units + b.units,
    orders: a.orders + b.orders,
    refunds_amount: a.refunds_amount + b.refunds_amount,
    refunds_count: a.refunds_count + b.refunds_count,
    promo: a.promo + b.promo,
    fees: a.fees + b.fees,
    cost: a.cost + b.cost,
    pending_revenue: a.pending_revenue + b.pending_revenue,
    pending_orders: a.pending_orders + b.pending_orders,
  };
}

/** Resolve the snapshot period_key for a UI time range. */
export function resolvePeriodKey(
  timeRange: "today" | "yesterday" | "week" | "month" | "last_month" | "year",
  todayYmd: string,
): { period_key: string | null; period_start: string; period_end_closed: string } | null {
  const [y, m] = todayYmd.split("-").map(Number);
  const yesterday = addDays(todayYmd, -1);

  if (timeRange === "year") {
    return {
      period_key: `ytd-closed-${y}`,
      period_start: `${y}-01-01`,
      period_end_closed: yesterday >= `${y}-01-01` ? yesterday : `${y}-01-01`,
    };
  }
  if (timeRange === "month") {
    const start = `${y}-${String(m).padStart(2, "0")}-01`;
    return {
      period_key: `month-${y}-${String(m).padStart(2, "0")}`,
      period_start: start,
      // Current month: only previous days are "closed"
      period_end_closed: yesterday >= start ? yesterday : start,
    };
  }
  if (timeRange === "last_month") {
    const lmY = m === 1 ? y - 1 : y;
    const lmM = m === 1 ? 12 : m - 1;
    const start = `${lmY}-${String(lmM).padStart(2, "0")}-01`;
    const lastDay = new Date(Date.UTC(lmY, lmM, 0)).getUTCDate();
    const end = `${lmY}-${String(lmM).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
    return { period_key: "last-month", period_start: start, period_end_closed: end };
  }
  // today / yesterday / week — no snapshot; caller should keep its existing live path.
  return null;
}

/**
 * Live-aggregate sales_orders for an inclusive date range. Used both for
 * "today delta" and as the snapshot-miss fallback. Uses the same shape as
 * the writer to keep parity.
 */
export async function aggregateLive(
  userId: string,
  marketplace: string,
  startYmd: string,
  endYmd: string,
): Promise<PeriodTotals> {
  const out = emptyTotals();
  const orderIds = new Set<string>();
  const pendingOrderIds = new Set<string>();
  const PAGE = 1000;
  let from = 0;
  let total = 0;

  // If endYmd < startYmd, return empty (e.g. YTD on Jan 1).
  if (endYmd < startYmd) return out;

  while (true) {
    let q = supabase
      .from("sales_orders")
      .select(
        "order_id, marketplace, order_status, quantity, sold_price, estimated_price, refund_amount, refund_quantity, promotion_discount, total_fees, total_cost, fees_invalid",
      )
      .eq("user_id", userId)
      .gte("order_date", startYmd)
      .lte("order_date", endYmd)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);

    if (marketplace && marketplace !== "ALL") {
      q = q.eq("marketplace", marketplace);
    }

    const { data, error } = await q;
    if (error) throw error;
    const rows = (data ?? []) as any[];
    if (rows.length === 0) break;
    total += rows.length;

    for (const r of rows) {
      const qty = Number(r.quantity ?? 0) || 0;
      const sold = Number(r.sold_price ?? 0) || 0;
      const est = Number(r.estimated_price ?? 0) || 0;
      const refundAmt = Number(r.refund_amount ?? 0) || 0;
      const refundQty = Number(r.refund_quantity ?? 0) || 0;
      const promo = Number(r.promotion_discount ?? 0) || 0;
      const fees = Number(r.total_fees ?? 0) || 0;
      const cost = Number(r.total_cost ?? 0) || 0;
      const status = (r.order_status || "").toString().toUpperCase();
      const orderId = r.order_id ? String(r.order_id) : null;

      const isConfirmed = sold > 0;
      const isPending = !isConfirmed && est > 0 && status !== "CANCELED" && status !== "CANCELLED";

      if (isConfirmed) {
        out.revenue += sold;
        out.units += qty;
      } else if (isPending) {
        out.pending_revenue += est;
        if (orderId && !pendingOrderIds.has(orderId)) {
          pendingOrderIds.add(orderId);
          out.pending_orders++;
        }
      }

      if (refundAmt > 0 || refundQty > 0) {
        out.refunds_amount += refundAmt;
        out.refunds_count += refundQty || 1;
      }
      out.promo += promo;
      if (!r.fees_invalid) out.fees += fees;
      out.cost += cost;

      if (orderId && !orderIds.has(orderId)) {
        orderIds.add(orderId);
        out.orders++;
      }
    }

    if (rows.length < PAGE) break;
    from += PAGE;
    if (total > 250_000) break;
  }

  return out;
}

/**
 * Load totals for a Live Sales period using the snapshot+today-delta strategy.
 * Falls back to a full live aggregate if no snapshot row exists or if its
 * period bounds don't match what we expect.
 */
export async function loadPeriodSnapshot(
  userId: string,
  marketplace: string,
  timeRange: "month" | "last_month" | "year",
): Promise<PeriodSnapshotResult> {
  const todayYmd = ymdInTz(new Date(), SALES_TZ);
  const spec = resolvePeriodKey(timeRange, todayYmd);
  if (!spec || !spec.period_key) {
    // Not cacheable — fall back to live aggregate of the full visible range.
    const full = await aggregateLive(userId, marketplace, spec?.period_start || todayYmd, todayYmd);
    return {
      totals: full,
      source: "live",
      computed_at: null,
      closed_totals: null,
      today_totals: emptyTotals(),
      period_start: spec?.period_start || todayYmd,
      period_end_closed: spec?.period_end_closed || todayYmd,
      today_ymd: todayYmd,
    };
  }

  const { data: snap } = await supabase
    .from("live_sales_period_cache")
    .select("totals, computed_at, period_start, period_end")
    .eq("user_id", userId)
    .eq("marketplace", marketplace || "ALL")
    .eq("period_key", spec.period_key)
    .maybeSingle();

  const closed = (snap?.totals as unknown as PeriodTotals | undefined) ?? null;
  const closedMatchesExpected =
    !!snap &&
    snap.period_start === spec.period_start &&
    snap.period_end === spec.period_end_closed;

  // For last_month / past year_X the closed period IS the whole period — no today delta.
  const needsTodayDelta =
    timeRange === "month" || (timeRange === "year" && spec.period_end_closed < todayYmd);

  let today = emptyTotals();
  if (needsTodayDelta) {
    try {
      today = await aggregateLive(userId, marketplace, todayYmd, todayYmd);
    } catch (e) {
      console.warn("[periodSnapshot] today delta failed:", e);
    }
  }

  if (closed && closedMatchesExpected) {
    const merged = mergeTotals(closed, today);
    return {
      totals: merged,
      source: needsTodayDelta ? "snapshot+today" : "snapshot-only",
      computed_at: snap!.computed_at,
      closed_totals: closed,
      today_totals: today,
      period_start: spec.period_start,
      period_end_closed: spec.period_end_closed,
      today_ymd: todayYmd,
    };
  }

  // Snapshot missing or bounds drifted — fall back to live aggregate of the
  // full visible range so the UI never blocks. Also fire a background refresh
  // so subsequent loads are fast.
  const liveTotals = await aggregateLive(userId, marketplace, spec.period_start, todayYmd);

  // Best-effort background refresh trigger (does not await).
  try {
    void supabase.functions.invoke("refresh-live-sales-period-cache", {
      body: { force: true },
    });
  } catch {
    /* ignore */
  }

  return {
    totals: liveTotals,
    source: "live",
    computed_at: null,
    closed_totals: null,
    today_totals: emptyTotals(),
    period_start: spec.period_start,
    period_end_closed: spec.period_end_closed,
    today_ymd: todayYmd,
  };
}
