import { Helmet } from "react-helmet-async";
import { Link } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  Boxes,
  DollarSign,
  Package,
  Power,
  RefreshCw,
  Search,
  Sparkles,
  Tags,
  TrendingUp,
  Truck,
  Warehouse,
  type LucideIcon,
} from "lucide-react";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useSalesSync } from "@/contexts/SalesSyncContext";
import { addDaysISO, getBusinessDateISO, SALES_BUSINESS_TZ } from "@/lib/sales/dateRange";
import { getInventoryValuationTotals } from "@/lib/inventory-valuation";
import { getOrderPromoUsd } from "@/lib/salesCalculations";

// ---------- Types ----------
type Loadable<T> = { loading: boolean; data: T | null; error?: string | null };

interface ProfitSnapshot {
  mtd_sales_reconciled: number;   // FEC (shipment)
  mtd_sales_estimated: number;    // sales_orders by order_date
  mtd_units_estimated: number;
  mtd_net_profit: number;         // FEC sales+shipping−promo−refunds−fees − COGS(SO)
  mtd_amazon_fees: number;        // FEC referral+FBA+other Amazon-charged fees
  mtd_amazon_payout: number;      // FEC sales+shipping−promo−refunds−fees (excl. COGS)
  mtd_cogs: number;
  today_revenue: number;
  today_units: number;
  today_orders: number;
  today_status: "ready" | "not_synced";
  today_debug: {
    start_date: string;
    end_date: string;
    rows_found: number;
    source: string;
    latest_order_date: string | null;
  };
  settled_through: string | null; // max FEC event_date this month
  currency: string;
}

interface InventoryHealth {
  total_value: number;
  available: number;
  reserved: number;
  inbound: number;
  unfulfilled: number;
  available_value: number;
  reserved_value: number;
  inbound_value: number;
  unfulfilled_value: number;
  low_stock: number;
  total_rows: number;
  rows_stale_24h: number;
  most_recent_sync: string | null;
}

interface RepricerActivity {
  changes_today: number;
  winning: number;
  losing: number;
  total_enabled: number;
  last_run: string | null;
}

interface ShipmentsActivity {
  active: number;
  inbound_units: number;
  needs_attention: number;
}

interface SourcingActivity {
  approved_products: number;
  recent_scans: number;
  recent_supplier_runs: number;
}

interface AlertsCounts {
  inventory_drift: number;
  zero_stock_blocked: number;
  missing_costs: number;
  spapi_alerts: number;
  bb_price_alerts: number;
}

type SalesOrderTodayRow = {
  order_id?: string | null;
  asin?: string | null;
  quantity?: number | null;
  sold_price?: number | null;
  total_sale_amount?: number | null;
  estimated_price?: number | null;
  is_cancelled?: boolean | null;
  order_status?: string | null;
  order_type?: string | null;
  marketplace?: string | null;
};

type FxRateRow = { quote?: string | null; rate?: number | string | null };
type LatestOrderDateRow = { order_date?: string | null };

// ---------- Helpers ----------
const fmtMoney = (n: number, ccy = "USD") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: ccy, maximumFractionDigits: 2 }).format(n);
const fmtInt = (n: number) => new Intl.NumberFormat("en-US").format(n);
const MARKETPLACE_CURRENCY: Record<string, string> = {
  US: "USD", CA: "CAD", MX: "MXN", BR: "BRL",
  UK: "GBP", DE: "EUR", FR: "EUR", IT: "EUR", ES: "EUR",
  JP: "JPY", AU: "AUD", IN: "INR", SG: "SGD", AE: "AED",
  SA: "SAR", NL: "EUR", SE: "SEK", PL: "PLN", BE: "EUR", TR: "TRY",
};
const normalizeOrderId = (orderId: string | null | undefined) => String(orderId || "").trim();
const isPendingPlaceholderRow = (row: { asin?: string | null; title?: string | null }) => {
  const asin = String(row.asin || "").trim().toUpperCase();
  const title = String(row.title || "").trim().toLowerCase();
  return asin === "PENDING" || title.startsWith("order processing");
};
const getLineRevenue = (row: { quantity?: number | null; sold_price?: number | null; total_sale_amount?: number | null; estimated_price?: number | null; promotion_discount?: number | null; promotion_discount_currency?: string | null; marketplace?: string | null }) => {
  const qty = Math.max(1, Number(row.quantity || 0));
  const totalSale = Number(row.total_sale_amount || 0);
  const soldPrice = Number(row.sold_price || 0);
  const estimated = Number(row.estimated_price || 0);
  let gross = 0;
  if (totalSale > 0) gross = totalSale;
  else if (soldPrice > 0) gross = soldPrice * qty;
  else if (estimated > 0) gross = estimated * qty;
  // Net Amazon-funded coupons (USD-safe; non-US handled via FEC promo path)
  return Math.max(0, gross - getOrderPromoUsd(row));
};
const getUnitPriceForAverage = (row: { quantity?: number | null; sold_price?: number | null; total_sale_amount?: number | null; estimated_price?: number | null }) => {
  const qty = Math.max(1, Number(row.quantity || 0));
  const totalSale = Number(row.total_sale_amount || 0);
  const soldPrice = Number(row.sold_price || 0);
  const estimated = Number(row.estimated_price || 0);
  if (totalSale > 0) return totalSale / qty;
  if (soldPrice > 0) return soldPrice;
  if (estimated > 0) return estimated;
  return 0;
};
const relTime = (iso: string | null) => {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};

// ---------- Card primitives ----------
function GlassCard({
  children,
  className = "",
  featured = false,
}: {
  children: React.ReactNode;
  className?: string;
  featured?: boolean;
}) {
  return (
    <div
      className={`relative rounded-2xl border backdrop-blur-md transition-all duration-300 hover:-translate-y-1 hover:shadow-2xl ${
        featured
          ? "border-primary/30 bg-gradient-to-br from-primary/10 via-white/5 to-fuchsia-500/10 shadow-lg shadow-primary/10"
          : "border-white/10 bg-white/5 shadow-lg shadow-black/20"
      } ${className}`}
    >
      {children}
    </div>
  );
}

// ---------- Today TV-style card ----------
function TodayTvCard({
  ccy,
  loading,
  todayStatus,
  revenue,
  units,
  orders,
  isSyncing,
  onPowerOn,
}: {
  ccy: string;
  loading: boolean;
  todayStatus?: "ready" | "not_synced";
  revenue: number;
  units: number;
  orders: number;
  isSyncing: boolean;
  onPowerOn: () => void;
}) {
  // Default OFF on mount; user must press the power button.
  const [on, setOn] = useState(false);
  // Track animation state so we can play power-off without unmounting screen instantly.
  const [animating, setAnimating] = useState<"on" | "off" | null>(null);
  const offTimerRef = useRef<number | null>(null);

  useEffect(() => () => { if (offTimerRef.current) window.clearTimeout(offTimerRef.current); }, []);

  const handleToggle = () => {
    if (on) {
      // Power off: play CRT shutdown, then hide screen content
      setAnimating("off");
      if (offTimerRef.current) window.clearTimeout(offTimerRef.current);
      offTimerRef.current = window.setTimeout(() => {
        setOn(false);
        setAnimating(null);
      }, 480);
    } else {
      // Power on: trigger background sync + play CRT power-on
      setOn(true);
      setAnimating("on");
      onPowerOn();
      if (offTimerRef.current) window.clearTimeout(offTimerRef.current);
      offTimerRef.current = window.setTimeout(() => setAnimating(null), 520);
    }
  };

  const screenAnimClass =
    animating === "on" ? "tv-screen-on" : animating === "off" ? "tv-screen-off" : "";

  return (
    <GlassCard className="p-0 overflow-hidden">
      {/* TV bezel */}
      <div className="relative p-3 bg-gradient-to-br from-zinc-900 via-zinc-800 to-zinc-950">
        {/* Header strip */}
        <div className="flex items-center justify-between px-1 pb-2">
          <div className="text-[10px] font-bold uppercase tracking-wider text-white/50">Today</div>
          <div className="flex items-center gap-1">
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                on ? (isSyncing ? "bg-amber-400 animate-pulse" : "bg-emerald-400") : "bg-zinc-600"
              }`}
              aria-hidden
            />
            <span className="text-[9px] uppercase tracking-wider text-white/40">
              {on ? (isSyncing ? "Live" : "On") : "Standby"}
            </span>
          </div>
        </div>

        {/* Screen */}
        <div className="relative rounded-md border border-black/60 bg-black shadow-inner overflow-hidden aspect-[16/8] flex items-center justify-center">
          {/* Off state: dark screen */}
          {!on && animating !== "off" && (
            <div className="text-[11px] uppercase tracking-[0.2em] text-white/20">— Off —</div>
          )}

          {/* On (or animating off): show numbers with CRT effect */}
          {(on || animating === "off") && (
            <div className={`absolute inset-0 origin-center ${screenAnimClass}`}>
              <div className="relative h-full w-full bg-gradient-to-b from-emerald-950/40 via-black to-black flex flex-col items-center justify-center px-3">
                {/* Scanlines overlay */}
                <div className="pointer-events-none absolute inset-0 tv-scanlines opacity-60" />
                {(() => {
                  const hasNumbers = revenue > 0 || units > 0 || orders > 0;
                  // Only block with "Updating…" if we truly have nothing to show.
                  if (!hasNumbers && (loading || todayStatus === "not_synced" || isSyncing)) {
                    return (
                      <div className="text-emerald-300 text-sm font-medium flex items-center gap-2 drop-shadow-[0_0_6px_rgba(16,185,129,0.7)]">
                        <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                        Updating…
                      </div>
                    );
                  }
                  return (
                    <>
                      <div className="text-2xl font-bold tabular-nums text-emerald-300 drop-shadow-[0_0_6px_rgba(16,185,129,0.6)]">
                        {revenue > 0 ? fmtMoney(revenue, ccy) : `${fmtInt(units)} units`}
                      </div>
                      <div className="text-[10px] text-emerald-200/70 mt-0.5 text-center">
                        {units > 0
                          ? `${fmtInt(units)} units · ${fmtInt(orders)} orders · PT`
                          : "PT business day · Repricer live"}
                      </div>
                      {isSyncing && (
                        <div className="absolute top-1.5 right-2 flex items-center gap-1 text-[9px] uppercase tracking-wider text-emerald-300/80">
                          <RefreshCw className="h-2.5 w-2.5 animate-spin" />
                          Refreshing
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>
            </div>
          )}
        </div>

        {/* TV "chassis" bottom bar with power button */}
        <div className="mt-2 flex items-center justify-between px-1">
          <div className="text-[9px] uppercase tracking-wider text-white/30">Live Sales TV</div>
          <button
            type="button"
            onClick={handleToggle}
            aria-label={on ? "Turn off" : "Turn on"}
            title={on ? "Turn off" : "Turn on (sync now)"}
            className={`group relative h-7 w-7 rounded-full border flex items-center justify-center transition-all ${
              on
                ? "border-emerald-400/60 bg-emerald-500/20 shadow-[0_0_8px_rgba(16,185,129,0.6)]"
                : "border-white/15 bg-white/5 hover:bg-white/10"
            }`}
          >
            <Power
              className={`h-3.5 w-3.5 transition-colors ${on ? "text-emerald-300" : "text-white/50 group-hover:text-white/80"}`}
            />
          </button>
        </div>
      </div>
    </GlassCard>
  );
}

function SectionHeader({
  icon: Icon,
  title,
  subtitle,
  accent = "from-slate-500 to-slate-700",
  rightSlot,
}: {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  accent?: string;
  rightSlot?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 mb-3">
      <div className="flex items-center gap-3">
        <div className={`p-2 rounded-xl bg-gradient-to-br ${accent} shadow-md shadow-black/30`}>
          <Icon className="h-5 w-5 text-white" />
        </div>
        <div>
          <h3 className="text-base font-semibold text-white">{title}</h3>
          {subtitle ? <p className="text-xs text-white/60">{subtitle}</p> : null}
        </div>
      </div>
      {rightSlot}
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  loading,
  empty,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  loading?: boolean;
  empty?: boolean;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-black/20 p-3">
      <div className="text-[10px] font-bold uppercase tracking-wider text-white/50">{label}</div>
      {loading ? (
        <Skeleton className="h-6 w-20 mt-1 bg-white/10" />
      ) : empty ? (
        <div className="text-sm font-medium text-white/40 mt-1">Not connected yet</div>
      ) : (
        <div className="text-xl font-bold text-white mt-0.5 tabular-nums">{value}</div>
      )}
      {hint ? <div className="text-[10px] text-white/40 mt-1">{hint}</div> : null}
    </div>
  );
}

function QuickAction({ to, label, icon: Icon }: { to: string; label: string; icon: LucideIcon }) {
  return (
    <Link
      to={to}
      className="group flex items-center justify-between gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-sm font-medium text-white/90 hover:border-primary/40 hover:bg-primary/10 hover:-translate-y-0.5 transition-all"
    >
      <span className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-white/70 group-hover:text-primary" />
        {label}
      </span>
      <ArrowRight className="h-3.5 w-3.5 text-white/40 group-hover:text-primary group-hover:translate-x-0.5 transition-all" />
    </Link>
  );
}

// ---------- Page ----------
export default function Dashboard() {
  const { user } = useAuth();
  const { startBackgroundSync, syncState, isSyncing } = useSalesSync();
  const [profit, setProfit] = useState<Loadable<ProfitSnapshot>>({ loading: true, data: null });
  const [inv, setInv] = useState<Loadable<InventoryHealth>>({ loading: true, data: null });
  const [rep, setRep] = useState<Loadable<RepricerActivity>>({ loading: true, data: null });
  const [ship, setShip] = useState<Loadable<ShipmentsActivity>>({ loading: true, data: null });
  const [src, setSrc] = useState<Loadable<SourcingActivity>>({ loading: true, data: null });
  const [alerts, setAlerts] = useState<Loadable<AlertsCounts>>({ loading: true, data: null });
  const [invReview, setInvReview] = useState<Loadable<{ pending: number }>>({ loading: true, data: null });
  const [isAdmin, setIsAdmin] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const didKickSalesSyncRef = useRef(false);

  useEffect(() => {
    if (!user) { setIsAdmin(false); return; }
    (async () => {
      const { data } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", user.id)
        .eq("role", "admin")
        .maybeSingle();
      setIsAdmin(!!data);
    })();
  }, [user]);

  useEffect(() => {
    if (!user?.id || didKickSalesSyncRef.current) return;
    didKickSalesSyncRef.current = true;
    void startBackgroundSync({ force: false, silent: true }).catch((err) => {
      console.warn("[Dashboard Today] background sales sync skipped/failed:", err);
    });
  }, [user?.id, startBackgroundSync]);

  // Track sync state in a ref so it can be read inside the polling loop
  // without forcing the effect to re-mount on every sync state transition.
  const syncStateRef = useRef(syncState);
  useEffect(() => { syncStateRef.current = syncState; }, [syncState]);

  // ---- Today snapshot (fast, isolated, polled every 30s) ----
  useEffect(() => {
    if (!user) return;
    let cancel = false;

    const loadToday = async () => {
      const todayDate = getBusinessDateISO(new Date(), SALES_BUSINESS_TZ);
      const tomorrowDate = addDaysISO(todayDate, 1);
      try {
        const [{ data: latestOrder }, { data: fxRows }] = await Promise.all([
          supabase
            .from("sales_orders")
            .select("order_date")
            .eq("user_id", user.id)
            .order("order_date", { ascending: false })
            .limit(1)
            .maybeSingle(),
          supabase.from("fx_rates").select("quote, rate"),
        ]);

        const orderRows: SalesOrderTodayRow[] = [];
        const PAGE = 1000;
        for (let from = 0; from < 10000; from += PAGE) {
          const { data: page, error: pageError } = await supabase
            .from("sales_orders")
            .select("order_id, asin, quantity, sold_price, total_sale_amount, estimated_price, is_cancelled, order_status, order_type, marketplace, promotion_discount, promotion_discount_currency")
            .eq("user_id", user.id)
            .gte("order_date", todayDate)
            .lte("order_date", todayDate)
            .not("order_id", "like", "%-REFUND")
            .order("purchase_timestamp_utc", { ascending: false })
            // purchase_timestamp_utc is not unique, so it cannot order pages on its own:
            // a tie spanning a page boundary repeats or skips rows. id breaks it.
            .order("id", { ascending: true })
            .range(from, from + PAGE - 1);
          if (pageError) throw pageError;
          if (!page || page.length === 0) break;
          orderRows.push(...(page as SalesOrderTodayRow[]));
          if (page.length < PAGE) break;
        }

        const resolvedOrderIds = new Set(
          orderRows
            .filter((row) => !isPendingPlaceholderRow(row))
            .map((row) => normalizeOrderId(row.order_id))
            .filter(Boolean),
        );
        const dedupedTodayOrders = orderRows
          .filter((row) => {
            if (row.is_cancelled === true) return false;
            const status = String(row.order_status || "").toLowerCase();
            if (status === "canceled" || status === "cancelled") return false;
            const orderType = String(row.order_type || "").toLowerCase();
            if (orderType.includes("replacement")) return false;
            if (isPendingPlaceholderRow(row) && resolvedOrderIds.has(normalizeOrderId(row.order_id))) return false;
            return true;
          })
          .filter((row, index, source) => {
            const key = `${normalizeOrderId(row.order_id)}::${String(row.asin || "").trim()}`;
            return source.findIndex((candidate) => `${normalizeOrderId(candidate.order_id)}::${String(candidate.asin || "").trim()}` === key) === index;
          })
          .filter((row) => !isPendingPlaceholderRow(row));

        const fxRates: Record<string, number> = { USD: 1 };
        for (const row of (fxRows as FxRateRow[]) || []) fxRates[String(row.quote || "")] = Number(row.rate) || 1;
        const toUsd = (amount: number, mp: string | null | undefined) => {
          const currency = MARKETPLACE_CURRENCY[String(mp || "US").trim()] || "USD";
          if (currency === "USD") return amount;
          const rate = fxRates[currency];
          return rate && rate > 0 ? amount / rate : amount;
        };

        const pricesForAvg = dedupedTodayOrders.map((row) => getUnitPriceForAverage(row)).filter((price) => price > 0);
        const avgUnitPrice = pricesForAvg.length > 0 ? pricesForAvg.reduce((sum, price) => sum + price, 0) / pricesForAvg.length : 0;
        const orderIds = new Set<string>();
        let todayRevenue = 0;
        let todayUnits = 0;
        for (const row of dedupedTodayOrders) {
          const asin = String(row.asin || "").trim();
          if (!asin) continue;
          const qty = Math.max(1, Number(row.quantity || 0));
          const explicit = getLineRevenue(row);
          const rawRevenue = explicit > 0 ? explicit : avgUnitPrice > 0 ? avgUnitPrice * qty : 0;
          todayUnits += qty;
          todayRevenue += toUsd(rawRevenue, row.marketplace);
          const oid = normalizeOrderId(row.order_id);
          if (oid) orderIds.add(oid);
        }
        const todayOrders = orderIds.size;
        todayRevenue = Math.round(todayRevenue * 100) / 100;
        const todayRowsFound = dedupedTodayOrders.length;
        const latestOrderDate = (latestOrder as LatestOrderDateRow | null)?.order_date || null;
        const ss = syncStateRef.current;
        const syncRanToday =
          ss.status === "success" &&
          ss.lastSyncAt &&
          getBusinessDateISO(ss.lastSyncAt, SALES_BUSINESS_TZ) === todayDate;
        const todayStatus: ProfitSnapshot["today_status"] = todayRowsFound > 0
          ? "ready"
          : ss.ordersCount > 0
            ? "not_synced"
            : syncRanToday
              ? "ready"
              : latestOrderDate && latestOrderDate < todayDate
                ? "not_synced"
                : "ready";

        if (cancel) return;
        setProfit((prev) => ({
          loading: false,
          data: {
            mtd_sales_reconciled: prev.data?.mtd_sales_reconciled ?? 0,
            mtd_sales_estimated: prev.data?.mtd_sales_estimated ?? 0,
            mtd_units_estimated: prev.data?.mtd_units_estimated ?? 0,
            mtd_net_profit: prev.data?.mtd_net_profit ?? 0,
            mtd_amazon_fees: prev.data?.mtd_amazon_fees ?? 0,
            mtd_amazon_payout: prev.data?.mtd_amazon_payout ?? 0,
            mtd_cogs: prev.data?.mtd_cogs ?? 0,
            settled_through: prev.data?.settled_through ?? null,
            today_revenue: todayRevenue,
            today_units: todayUnits,
            today_orders: todayOrders,
            today_status: todayStatus,
            today_debug: {
              start_date: todayDate,
              end_date: tomorrowDate,
              rows_found: todayRowsFound,
              source: "Live Sales exact · sales_orders.order_date + estimated_price fallback",
              latest_order_date: latestOrderDate,
            },
            currency: "USD",
          },
        }));
      } catch (e: any) {
        console.warn("[Dashboard Today] load failed:", e?.message);
      }
    };

    void loadToday();
    // 30s → 180s + visibility-gated. FEC today scan is expensive (~90ms × many users).
    const interval = window.setInterval(() => {
      if (document.hidden) return;
      void loadToday();
    }, 180_000);
    const onVisible = () => { if (document.visibilityState === "visible") void loadToday(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancel = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [user, refreshKey]);

  // Re-fetch Today immediately when a sales sync just completed (without remounting the timer).
  useEffect(() => {
    if (!user) return;
    if (syncState.status !== "success") return;
    // Bump refreshKey-equivalent by triggering a one-shot fetch via a microtask.
    // We piggyback on the existing loader by dispatching a custom event the effect listens to.
    const todayDate = getBusinessDateISO(new Date(), SALES_BUSINESS_TZ);
    void supabase
      .from("asin_sales_daily")
      .select("asin, units, revenue")
      .eq("user_id", user.id)
      .eq("date", todayDate)
      .then(({ data }) => {
        if (!data) return;
        let units = 0, revenue = 0;
        for (const r of data as any[]) { units += Number(r.units || 0); revenue += Number(r.revenue || 0); }
        if (units === 0 && revenue === 0) return;
        setProfit((prev) => prev.data ? ({
          loading: false,
          data: {
            ...prev.data,
            today_revenue: Math.max(prev.data.today_revenue || 0, revenue),
            today_units: Math.max(prev.data.today_units || 0, units),
            today_status: "ready",
          },
        }) : prev);
      });
  }, [user, syncState.status, syncState.lastSyncAt]);

  useEffect(() => {
    if (!user) return;
    let cancel = false;

    const todayDate = getBusinessDateISO(new Date(), SALES_BUSINESS_TZ);
    const monthStartDate = `${todayDate.slice(0, 7)}-01`;
    const todayStartTs = new Date(`${todayDate}T00:00:00-08:00`).toISOString();

    // ---- MTD Profit / Sales (heavy aggregation, runs once per refresh) ----
    (async () => {
      try {
        let fecSales = 0;
        let fecShipping = 0;
        let fecPromo = 0;
        let fecRefunds = 0;
        let fecFees = 0;
        let settledThrough: string | null = null;
        let from = 0;
        const PAGE = 1000;
        while (true) {
          const { data, error } = await supabase
            .from("financial_events_cache")
            .select(
              "sales,shipping_credits,promotional_rebates,refunds,fba_fees,referral_fees,variable_closing_fees,fixed_closing_fees,fba_inbound_fees,fba_storage_fees,fba_removal_fees,fba_disposal_fees,fba_long_term_storage_fees,other_fees,event_date",
            )
            .eq("user_id", user.id)
            .eq("event_type", "shipment")
            .gte("event_date", monthStartDate)
            // Stable order is REQUIRED for .range() paging: two pages are two
            // independent queries with no promised row order between them, so
            // a row can be summed twice or missed. Measured on this page:
            // sales_orders below reaches offset 3000, so this is four real
            // pages, not a theoretical risk.
            .order("id", { ascending: true })
            .range(from, from + PAGE - 1);
          // Was a bare `break`, which summed a partial month and showed it as
          // the month. The catch around this block renders an error state, so
          // failing is visible rather than silently wrong.
          if (error) throw error;
          if (!data || data.length === 0) break;
          for (const r of data as any[]) {
            fecSales += Number(r.sales || 0);
            fecShipping += Number(r.shipping_credits || 0);
            fecPromo += Number(r.promotional_rebates || 0);
            fecRefunds += Number(r.refunds || 0);
            fecFees +=
              Number(r.fba_fees || 0) +
              Number(r.referral_fees || 0) +
              Number(r.variable_closing_fees || 0) +
              Number(r.fixed_closing_fees || 0) +
              Number(r.fba_inbound_fees || 0) +
              Number(r.fba_storage_fees || 0) +
              Number(r.fba_removal_fees || 0) +
              Number(r.fba_disposal_fees || 0) +
              Number(r.fba_long_term_storage_fees || 0) +
              Number(r.other_fees || 0);
            if (!settledThrough || r.event_date > settledThrough) settledThrough = r.event_date;
          }
          if (data.length < PAGE) break;
          from += PAGE;
        }

        let soSales = 0;
        let soUnits = 0;
        let soCogs = 0;
        from = 0;
        while (true) {
          const { data, error } = await supabase
            .from("sales_orders")
            .select("total_sale_amount,sold_price,quantity,unit_cost,order_status,is_cancelled")
            .eq("user_id", user.id)
            .gte("order_date", monthStartDate)
            .order("id", { ascending: true })
            .range(from, from + PAGE - 1);
          if (error) throw error;
          if (!data || data.length === 0) break;
          for (const r of data as any[]) {
            const status = String(r.order_status || "");
            if (status === "Canceled" || status === "Cancelled" || r.is_cancelled === true) continue;
            const qty = Number(r.quantity || 0) || 1;
            const totalSale = Number(r.total_sale_amount) || 0;
            const line = totalSale > 0 ? totalSale : Number(r.sold_price || 0) * qty;
            soSales += line;
            soUnits += Number(r.quantity || 0);
            soCogs += Number(r.unit_cost || 0) * qty;
          }
          if (data.length < PAGE) break;
          from += PAGE;
        }

        const amazonPayout = fecSales + fecShipping - fecPromo - fecRefunds - fecFees;
        const netProfit = amazonPayout - soCogs;

        if (cancel) return;
        setProfit((prev) => ({
          loading: false,
          data: {
            mtd_sales_reconciled: fecSales,
            mtd_sales_estimated: soSales,
            mtd_units_estimated: soUnits,
            mtd_net_profit: netProfit,
            mtd_amazon_fees: fecFees,
            mtd_amazon_payout: amazonPayout,
            mtd_cogs: soCogs,
            settled_through: settledThrough,
            today_revenue: prev.data?.today_revenue ?? 0,
            today_units: prev.data?.today_units ?? 0,
            today_orders: prev.data?.today_orders ?? 0,
            today_status: prev.data?.today_status ?? "ready",
            today_debug: prev.data?.today_debug ?? {
              start_date: todayDate,
              end_date: addDaysISO(todayDate, 1),
              rows_found: 0,
              source: "Live Sales exact · sales_orders.order_date + estimated_price fallback",
              latest_order_date: null,
            },
            currency: "USD",
          },
        }));
      } catch (e: any) {
        if (!cancel) setProfit((prev) => prev.data ? prev : { loading: false, data: null, error: e.message });
      }
    })();

    // ---- Inventory ----
    (async () => {
      try {
        const totals = await getInventoryValuationTotals(user.id);
        if (totals.totalRows === 0) {
          if (!cancel) setInv({ loading: false, data: null });
          return;
        }
        if (!cancel)
          setInv({
            loading: false,
            data: {
              total_value: totals.value,
              available: totals.available,
              reserved: totals.reserved,
              inbound: totals.inbound,
              unfulfilled: totals.unfulfilled,
              available_value: totals.availableValue,
              reserved_value: totals.reservedValue,
              inbound_value: totals.inboundValue,
              unfulfilled_value: totals.unfulfilledValue,
              low_stock: totals.lowStock,
              total_rows: totals.totalRows,
              rows_stale_24h: totals.rowsStale24h,
              most_recent_sync: totals.mostRecentSync,
            },
          });
      } catch (e: any) {
        if (!cancel) setInv({ loading: false, data: null, error: e.message });
      }
    })();

    // ---- Repricer ----
    (async () => {
      try {
        const [{ count: changesToday }, { count: enabledCount }, { data: lastAction }] = await Promise.all([
          supabase
            .from("repricer_price_actions")
            .select("id", { count: "exact", head: true })
            .eq("user_id", user.id)
            .eq("action_type", "price_changed")
            .eq("success", true)
            .gte("created_at", todayStartTs),
          supabase
            .from("repricer_assignments")
            .select("id", { count: "exact", head: true })
            .eq("user_id", user.id)
            .eq("is_enabled", true)
            .not("rule_id", "is", null),
          supabase
            .from("repricer_price_actions")
            .select("created_at")
            .eq("user_id", user.id)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle(),
        ]);

        // Buy-box winning/losing counts via server-side counts (avoid 1000-row cap).
        const [{ count: winningCount }, { count: losingCount }] = await Promise.all([
          supabase
            .from("repricer_assignments")
            .select("id", { count: "exact", head: true })
            .eq("user_id", user.id)
            .eq("is_enabled", true)
            .not("rule_id", "is", null)
            .in("last_buybox_status", ["winning", "owned"]),
          supabase
            .from("repricer_assignments")
            .select("id", { count: "exact", head: true })
            .eq("user_id", user.id)
            .eq("is_enabled", true)
            .not("rule_id", "is", null)
            .eq("last_buybox_status", "losing"),
        ]);

        if (!cancel)
          setRep({
            loading: false,
            data: {
              changes_today: changesToday || 0,
              winning: winningCount || 0,
              losing: losingCount || 0,
              total_enabled: enabledCount || 0,
              last_run: (lastAction as any)?.created_at || null,
            },
          });
      } catch (e: any) {
        if (!cancel) setRep({ loading: false, data: null, error: e.message });
      }
    })();

    // ---- Shipments ----
    (async () => {
      try {
        const { data } = await supabase
          .from("fba_shipments")
          .select("shipment_status")
          .eq("user_id", user.id);
        const { data: items } = await supabase
          .from("fba_shipment_items")
          .select("quantity_shipped,quantity_received,shipment_id")
          .eq("user_id", user.id);
        const activeStatuses = ["WORKING", "READY_TO_SHIP", "SHIPPED", "IN_TRANSIT", "DELIVERED", "CHECKED_IN", "RECEIVING"];
        const active = (data || []).filter((s: any) => activeStatuses.includes(s.shipment_status)).length;
        let inbound_units = 0;
        let needs_attention = 0;
        for (const it of (items as any[]) || []) {
          const sh = Number(it.quantity_shipped || 0);
          const rc = Number(it.quantity_received || 0);
          if (sh > rc) inbound_units += sh - rc;
        }
        for (const s of (data as any[]) || []) {
          if (["RECEIVING", "CHECKED_IN", "DELIVERED"].includes(s.shipment_status)) needs_attention += 1;
        }
        if (!cancel) setShip({ loading: false, data: { active, inbound_units, needs_attention } });
      } catch (e: any) {
        if (!cancel) setShip({ loading: false, data: null, error: e.message });
      }
    })();

    // ---- Inventory Review Queue (suspicious inventory pending review) ----
    (async () => {
      try {
        const { count } = await supabase
          .from("inventory_missing_review")
          .select("id", { count: "exact", head: true })
          .eq("user_id", user.id)
          .eq("status", "needs_review");
        if (!cancel) setInvReview({ loading: false, data: { pending: count || 0 } });
      } catch (e: any) {
        if (!cancel) setInvReview({ loading: false, data: null, error: e.message });
      }
    })();

    // ---- Sourcing ----
    (async () => {
      try {
        const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
        const [{ count: approved }, { count: scans }, { count: supplierRuns }] = await Promise.all([
          supabase.from("user_approved_products").select("id", { count: "exact", head: true }).eq("user_id", user.id),
          supabase.from("store_scan_runs").select("id", { count: "exact", head: true }).eq("user_id", user.id).gte("created_at", sevenDaysAgo),
          supabase.from("product_finder_runs").select("id", { count: "exact", head: true }).eq("user_id", user.id).gte("created_at", sevenDaysAgo),
        ]);
        if (!cancel)
          setSrc({
            loading: false,
            data: { approved_products: approved || 0, recent_scans: scans || 0, recent_supplier_runs: supplierRuns || 0 },
          });
      } catch (e: any) {
        if (!cancel) setSrc({ loading: false, data: null, error: e.message });
      }
    })();

    // ---- Alerts ----
    (async () => {
      try {
        const [{ data: invForAlerts }, { count: spapi }, { count: bbAlerts }] = await Promise.all([
          supabase.from("inventory").select("available,reserved,cost,last_summaries_at").eq("user_id", user.id),
          supabase
            .from("spapi_health_alerts")
            .select("id", { count: "exact", head: true })
            .eq("user_id", user.id)
            .is("resolved_at", null),
          supabase
            .from("bb_price_alerts")
            .select("id", { count: "exact", head: true })
            .eq("user_id", user.id)
            .gte("created_at", new Date(Date.now() - 86400000).toISOString()),
        ]);
        const stale24h = Date.now() - 24 * 3600 * 1000;
        let drift = 0;
        let missingCosts = 0;
        for (const r of (invForAlerts as any[]) || []) {
          if (r.last_summaries_at && new Date(r.last_summaries_at).getTime() < stale24h) drift += 1;
          const hasStock = Number(r.available || 0) + Number(r.reserved || 0) > 0;
          if (hasStock && (!r.cost || Number(r.cost) === 0)) missingCosts += 1;
        }
        if (!cancel)
          setAlerts({
            loading: false,
            data: {
              inventory_drift: drift,
              zero_stock_blocked: 0,
              missing_costs: missingCosts,
              spapi_alerts: spapi || 0,
              bb_price_alerts: bbAlerts || 0,
            },
          });
      } catch (e: any) {
        if (!cancel) setAlerts({ loading: false, data: null, error: e.message });
      }
    })();

    return () => {
      cancel = true;
    };
  }, [user, refreshKey, syncState.syncVersion]);

  const ccy = profit.data?.currency || "USD";
  // Drift uses Inventory Health's count (single source of truth, not the duplicate alerts.inventory_drift)
  const driftCount = inv.data?.rows_stale_24h || 0;
  const totalAlerts = alerts.data
    ? driftCount + alerts.data.missing_costs + alerts.data.spapi_alerts + alerts.data.bb_price_alerts
    : driftCount;

  return (
    <div className="min-h-screen bg-[#0f1c3f]">
      <Helmet>
        <title>Dashboard · InventorySprint</title>
        <meta name="description" content="Your InventorySprint command center: profit, inventory, repricing, shipments and alerts in one glance." />
      </Helmet>
      <Navbar />

      <main className="max-w-7xl mx-auto px-4 py-8 space-y-6">
        {/* Header */}
        <div className="flex items-end justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-3xl font-bold text-white flex items-center gap-2">
              <Sparkles className="h-7 w-7 text-primary" />
              Dashboard
            </h1>
            <p className="text-sm text-white/60 mt-1">
              Your business at a glance — live data from your Amazon connection.
            </p>
          </div>
          <button
            onClick={() => {
              void startBackgroundSync({ force: true, silent: true }).finally(() => setRefreshKey((k) => k + 1));
            }}
            className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm font-medium text-white hover:bg-white/10 transition"
          >
            <RefreshCw className={`h-4 w-4 ${isSyncing ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>

        {/* Top KPI row */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <GlassCard className="p-4">
            <div className="text-[10px] font-bold uppercase tracking-wider text-white/50">Reconciled MTD Sales</div>
            {profit.loading ? (
              <Skeleton className="h-8 w-28 mt-2 bg-white/10" />
            ) : (
              <div className="text-2xl font-bold text-white mt-1 tabular-nums">
                {fmtMoney(profit.data?.mtd_sales_reconciled || 0, ccy)}
              </div>
            )}
            <div className="text-[10px] text-white/40 mt-1">
              {profit.data?.settled_through
                ? `Settled through ${profit.data.settled_through} · FEC`
                : "From financial_events_cache"}
            </div>
          </GlassCard>
          <GlassCard className="p-4" featured>
            <div className="text-[10px] font-bold uppercase tracking-wider text-emerald-300">Reconciled Net Profit</div>
            {profit.loading ? (
              <Skeleton className="h-8 w-28 mt-2 bg-white/10" />
            ) : (
              <div className={`text-2xl font-bold mt-1 tabular-nums ${(profit.data?.mtd_net_profit || 0) >= 0 ? "text-emerald-300" : "text-rose-400"}`}>
                {fmtMoney(profit.data?.mtd_net_profit || 0, ccy)}
              </div>
            )}
            <div className="text-[10px] text-white/40 mt-1" title="Sales + Shipping − Promo − Refunds − Fees − COGS">
              {profit.data?.settled_through
                ? `Through ${profit.data.settled_through} · incl. COGS`
                : "FEC inflows − fees − COGS"}
            </div>
          </GlassCard>
          <GlassCard className="p-4">
            <div className="text-[10px] font-bold uppercase tracking-wider text-sky-300">Est. Amazon Payout</div>
            {profit.loading ? (
              <Skeleton className="h-8 w-28 mt-2 bg-white/10" />
            ) : (
              <>
                <div
                  className="text-2xl font-bold text-sky-300 mt-1 tabular-nums"
                  title="Reconciled Sales − Amazon Fees − Refunds. What Amazon deposits to your bank (excludes your COGS)."
                >
                  {fmtMoney(profit.data?.mtd_amazon_payout || 0, ccy)}
                </div>
                <div className="mt-2 space-y-0.5 text-[10px] tabular-nums">
                  <div className="flex justify-between text-white/50">
                    <span>− COGS</span>
                    <span>{fmtMoney(profit.data?.mtd_cogs || 0, ccy)}</span>
                  </div>
                  <div className="flex justify-between border-t border-white/10 pt-0.5">
                    <span className="text-white/70 font-semibold">True Profit</span>
                    <span className={`font-bold ${(profit.data?.mtd_net_profit || 0) >= 0 ? "text-emerald-300" : "text-rose-400"}`}>
                      {fmtMoney(profit.data?.mtd_net_profit || 0, ccy)}
                    </span>
                  </div>
                </div>
              </>
            )}
          </GlassCard>
          <TodayTvCard
            ccy={ccy}
            loading={profit.loading}
            todayStatus={profit.data?.today_status}
            revenue={profit.data?.today_revenue || 0}
            units={profit.data?.today_units || 0}
            orders={profit.data?.today_orders || 0}
            isSyncing={isSyncing}
            onPowerOn={() => {
              void startBackgroundSync({ force: true, silent: true })
                .finally(() => setRefreshKey((k) => k + 1));
            }}
          />

          <GlassCard className="p-4">
            <div className="text-[10px] font-bold uppercase tracking-wider text-white/50">Inventory Value</div>
            {inv.loading ? (
              <Skeleton className="h-8 w-28 mt-2 bg-white/10" />
            ) : (
              <div className="text-2xl font-bold text-white mt-1 tabular-nums">
                {fmtMoney(inv.data?.total_value || 0, ccy)}
              </div>
            )}
            <div className="text-[10px] text-white/40 mt-1">(available + reserved + inbound + unfulfilled) × unit cost</div>
          </GlassCard>
          <GlassCard className="p-4">
            <div className="flex items-start justify-between">
              <div className="text-[10px] font-bold uppercase tracking-wider text-white/50">Active Alerts</div>
              <a href="#alerts" className="text-[10px] text-primary hover:underline">view ↓</a>
            </div>
            {alerts.loading ? (
              <Skeleton className="h-8 w-12 mt-2 bg-white/10" />
            ) : (
              <div className={`text-2xl font-bold mt-1 tabular-nums ${totalAlerts > 0 ? "text-amber-400" : "text-emerald-400"}`}>
                {fmtInt(totalAlerts)}
              </div>
            )}
            <div className="text-[10px] text-white/40 mt-1">
              {alerts.data
                ? `${driftCount} drift · ${alerts.data.missing_costs} cost · ${alerts.data.spapi_alerts + alerts.data.bb_price_alerts} sync`
                : "across all systems"}
            </div>
          </GlassCard>
        </div>

        {/* Main grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Profit Snapshot */}
          <GlassCard className="p-4 lg:col-span-1">
            <SectionHeader
              icon={DollarSign}
              title="Profit Snapshot"
              subtitle="Month to date"
              accent="from-emerald-500 to-green-600"
              rightSlot={
                <Link to="/tools/profit-loss" className="text-xs text-primary hover:underline flex items-center gap-1">
                  Open P&L <ArrowRight className="h-3 w-3" />
                </Link>
              }
            />
            <div className="grid grid-cols-2 gap-2">
              <Stat
                label="Net Profit (MTD)"
                value={
                  <span className={(profit.data?.mtd_net_profit || 0) >= 0 ? "text-emerald-400" : "text-rose-400"}>
                    {fmtMoney(profit.data?.mtd_net_profit || 0, ccy)}
                  </span>
                }
                loading={profit.loading}
                hint="Sales+Ship−Promo−Refunds−Fees−COGS"
              />
              <Stat
                label="Profit Margin"
                value={
                  (() => {
                    const sales = profit.data?.mtd_sales_reconciled || 0;
                    const np = profit.data?.mtd_net_profit || 0;
                    if (sales <= 0) return <span className="text-white/40 text-sm">—</span>;
                    const m = (np / sales) * 100;
                    const cls = m >= 20 ? "text-emerald-400" : m >= 10 ? "text-amber-400" : "text-rose-400";
                    return <span className={cls}>{m.toFixed(1)}%</span>;
                  })()
                }
                loading={profit.loading}
                hint="Net Profit / Reconciled Sales"
              />
              <Stat label="COGS (MTD)" value={fmtMoney(profit.data?.mtd_cogs || 0, ccy)} loading={profit.loading} hint="from sales_orders" />
              <Stat label="Reconciled Sales" value={fmtMoney(profit.data?.mtd_sales_reconciled || 0, ccy)} loading={profit.loading} hint="FEC · matches P&L" />
              <Stat label="Estimated Sales" value={fmtMoney(profit.data?.mtd_sales_estimated || 0, ccy)} loading={profit.loading} hint="SO · matches Live Sales" />
              <Stat
                label="Today"
                value={
                  (profit.data?.today_units || 0) === 0 && (profit.data?.today_orders || 0) === 0
                    ? <span className="text-white/50 text-sm">No activity yet</span>
                    : `${fmtInt(profit.data?.today_units || 0)} u · ${fmtInt(profit.data?.today_orders || 0)} ord`
                }
                loading={profit.loading}
              />
            </div>
            <div className="mt-2 text-[10px] text-white/40">
              {profit.data?.settled_through
                ? `Net Profit reconciled through ${profit.data.settled_through}. Full breakdown in P&L.`
                : "Net Profit shown in full P&L (requires settlement reconciliation)."}
            </div>
          </GlassCard>

          {/* Inventory Health */}
          <GlassCard className="p-4 lg:col-span-1">
            <SectionHeader
              icon={Warehouse}
              title="Inventory Health"
              subtitle={
                inv.data
                  ? inv.data.rows_stale_24h > 0
                    ? `${fmtInt(inv.data.rows_stale_24h)} rows need reconcile`
                    : "All rows fresh"
                  : "—"
              }
              accent="from-orange-500 to-amber-600"
              rightSlot={
                <Link to="/tools/synced-inventory" className="text-xs text-primary hover:underline flex items-center gap-1">
                  Open <ArrowRight className="h-3 w-3" />
                </Link>
              }
            />
            <div className="grid grid-cols-2 gap-2">
              <Stat label="Available" value={fmtInt(inv.data?.available || 0)} loading={inv.loading} />
              <Stat label="Reserved" value={fmtInt(inv.data?.reserved || 0)} loading={inv.loading} />
              <Stat label="Inbound" value={fmtInt(inv.data?.inbound || 0)} loading={inv.loading} />
              <Stat
                label="Low Stock (≤3)"
                value={<span className={inv.data && inv.data.low_stock > 0 ? "text-amber-400" : ""}>{fmtInt(inv.data?.low_stock || 0)}</span>}
                loading={inv.loading}
              />
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 text-[10px]">
              <div className="rounded-lg border border-white/10 bg-black/20 px-2 py-1.5">
                <span className="text-white/40">Most recent sync: </span>
                <span className="text-white/80">{relTime(inv.data?.most_recent_sync || null)}</span>
              </div>
              <div className="rounded-lg border border-white/10 bg-black/20 px-2 py-1.5">
                <span className="text-white/40">Stale &gt;24h: </span>
                <span className={inv.data && inv.data.rows_stale_24h > 0 ? "text-amber-400 font-semibold" : "text-white/80"}>
                  {fmtInt(inv.data?.rows_stale_24h || 0)} / {fmtInt(inv.data?.total_rows || 0)}
                </span>
              </div>
            </div>
          </GlassCard>

          {/* Repricer */}
          <GlassCard className="p-4 lg:col-span-1">
            <SectionHeader
              icon={Tags}
              title="Repricer Activity"
              subtitle={`Last action ${relTime(rep.data?.last_run || null)}`}
              accent="from-rose-500 to-red-600"
              rightSlot={
                <Link to="/tools/repricer" className="text-xs text-primary hover:underline flex items-center gap-1">
                  Open <ArrowRight className="h-3 w-3" />
                </Link>
              }
            />
            <div className="grid grid-cols-2 gap-2">
              <Stat label="Changes Today" value={fmtInt(rep.data?.changes_today || 0)} loading={rep.loading} />
              <Stat label="Enabled" value={fmtInt(rep.data?.total_enabled || 0)} loading={rep.loading} />
              <Stat
                label="Winning BB"
                value={
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                    {fmtInt(rep.data?.winning || 0)}
                  </span>
                }
                loading={rep.loading}
              />
              <Stat
                label="Losing BB"
                value={
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border ${
                    rep.data && rep.data.losing > 0
                      ? "bg-rose-500/15 text-rose-300 border-rose-500/30"
                      : "bg-white/5 text-white/60 border-white/10"
                  }`}>
                    {fmtInt(rep.data?.losing || 0)}
                  </span>
                }
                loading={rep.loading}
              />
            </div>
          </GlassCard>

          {/* Shipments */}
          <GlassCard className="p-4 lg:col-span-1">
            <SectionHeader
              icon={Truck}
              title="Shipments"
              subtitle="Inbound & in-transit"
              accent="from-sky-500 to-blue-600"
              rightSlot={
                <Link to="/tools/shipment-tracking" className="text-xs text-primary hover:underline flex items-center gap-1">
                  Track <ArrowRight className="h-3 w-3" />
                </Link>
              }
            />
            <div className="grid grid-cols-3 gap-2">
              <Stat label="Active" value={fmtInt(ship.data?.active || 0)} loading={ship.loading} />
              <Stat label="Inbound Units" value={fmtInt(ship.data?.inbound_units || 0)} loading={ship.loading} />
              <Link
                to="/tools/shipment-tracking?filter=needs_attention"
                className="block rounded-xl border border-white/10 bg-black/20 p-3 hover:border-amber-400/40 hover:bg-amber-500/5 transition"
                title="View shipments that need attention (Receiving / Checked-in / Delivered)"
              >
                <div className="text-[10px] font-bold uppercase tracking-wider text-white/50">Needs Attention</div>
                {ship.loading ? (
                  <Skeleton className="h-6 w-12 mt-1 bg-white/10" />
                ) : (
                  <div className={`text-xl font-bold mt-0.5 tabular-nums ${ship.data && ship.data.needs_attention > 0 ? "text-amber-400" : "text-white"}`}>
                    {fmtInt(ship.data?.needs_attention || 0)}
                  </div>
                )}
                <div className="text-[10px] text-primary mt-1">View →</div>
              </Link>
            </div>
            <div className="grid grid-cols-2 gap-2 mt-2">
              <Link to="/tools/shipment-builder" className="text-xs text-center rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-white/80 hover:bg-white/10">
                Build Shipment
              </Link>
              <Link to="/tools/shipment-tracking" className="text-xs text-center rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-white/80 hover:bg-white/10">
                Tracking
              </Link>
            </div>
          </GlassCard>

          {isAdmin && (
            <GlassCard className="p-4 lg:col-span-1">
              <SectionHeader
                icon={AlertTriangle}
                title="Inventory Review"
                subtitle="Suspicious stock flagged for review"
                accent="from-amber-500 to-orange-600"
                rightSlot={
                  <Link to="/tools/inventory-review" className="text-xs text-primary hover:underline flex items-center gap-1">
                    Review <ArrowRight className="h-3 w-3" />
                  </Link>
                }
              />
              <Link
                to="/tools/inventory-review"
                className="block rounded-xl border border-white/10 bg-black/20 p-3 hover:border-amber-400/40 hover:bg-amber-500/5 transition"
                title="SKUs with suspicious stock (inactive listings with leftover stock, stale snapshots) pending manual review"
              >
                <div className="text-[10px] font-bold uppercase tracking-wider text-white/50">Pending Review</div>
                {invReview.loading ? (
                  <Skeleton className="h-6 w-12 mt-1 bg-white/10" />
                ) : (
                  <div className={`text-xl font-bold mt-0.5 tabular-nums ${invReview.data && invReview.data.pending > 0 ? "text-amber-400" : "text-white"}`}>
                    {fmtInt(invReview.data?.pending || 0)}
                  </div>
                )}
                <div className="text-[10px] text-primary mt-1">View →</div>
              </Link>
            </GlassCard>
          )}

          {/* Alerts */}
          <GlassCard className="p-4 lg:col-span-2" >
            <div id="alerts" />
            <SectionHeader
              icon={AlertTriangle}
              title="Action Needed"
              subtitle="Issues that may impact revenue"
              accent="from-amber-500 to-orange-600"
            />
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <Stat
                label="Inventory Drift"
                value={
                  <span
                    className={inv.data && inv.data.rows_stale_24h > 0 ? "text-amber-400" : ""}
                    title="Rows with stock whose Summaries-API sync is missing or older than 24h. Same metric as 'Stale >24h' in Inventory Health."
                  >
                    {fmtInt(inv.data?.rows_stale_24h || 0)}
                  </span>
                }
                hint="stocked rows · sync >24h"
                loading={inv.loading}
              />
              <Stat
                label="Missing Costs"
                value={<span className={alerts.data && alerts.data.missing_costs > 0 ? "text-rose-400" : ""}>{fmtInt(alerts.data?.missing_costs || 0)}</span>}
                hint="stocked, no COGS"
                loading={alerts.loading}
              />
              <Stat
                label="SP-API Alerts"
                value={<span className={alerts.data && alerts.data.spapi_alerts > 0 ? "text-rose-400" : ""}>{fmtInt(alerts.data?.spapi_alerts || 0)}</span>}
                hint="unresolved"
                loading={alerts.loading}
              />
              <Stat
                label="BB Price Alerts"
                value={<span className={alerts.data && alerts.data.bb_price_alerts > 0 ? "text-amber-400" : ""}>{fmtInt(alerts.data?.bb_price_alerts || 0)}</span>}
                hint="last 24h"
                loading={alerts.loading}
              />
            </div>
            <div className="mt-3 grid grid-cols-2 md:grid-cols-3 gap-2">
              <Link to="/tools/inventory-restoration" className="text-xs text-center rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-white/80 hover:bg-white/10">
                Reconcile Inventory
              </Link>
              <Link to="/tools/reimbursements" className="text-xs text-center rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-white/80 hover:bg-white/10">
                Reimbursements
              </Link>
              <Link to="/tools/error-log" className="text-xs text-center rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-white/80 hover:bg-white/10">
                Error Log
              </Link>
            </div>
          </GlassCard>

          {/* Quick Actions */}
          <GlassCard className="p-4 lg:col-span-1">
            <SectionHeader icon={Boxes} title="Quick Actions" accent="from-violet-500 to-indigo-600" />
            <div className="grid grid-cols-1 gap-2">
              <QuickAction to="/tools/synced-inventory" label="Inventory Live Update" icon={RefreshCw} />
              <QuickAction to="/tools/created-listings" label="Product Library" icon={Package} />
              <QuickAction to="/tools/repricer" label="Repricer" icon={Tags} />
              <QuickAction to="/tools/profit-loss" label="Profit & Loss" icon={BarChart3} />
              <QuickAction to="/tools/shipment-builder" label="Shipment Builder" icon={Truck} />
            </div>
          </GlassCard>
        </div>

        {/* Sourcing — featured */}
        <GlassCard featured className="p-5">
          <SectionHeader
            icon={Search}
            title="Sourcing & Growth"
            subtitle="Where the money is made"
            accent="from-violet-500 to-fuchsia-600"
            rightSlot={
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border bg-primary/20 text-primary border-primary/30">
                <Sparkles className="h-3 w-3" /> Featured
              </span>
            }
          />
          {src.data && src.data.recent_scans === 0 && src.data.recent_supplier_runs === 0 ? (
            <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 text-sm text-white/80">
              <div className="font-semibold mb-1 flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-primary" /> Get started — this is where the money is made
              </div>
              <ul className="text-xs text-white/70 space-y-1 list-disc pl-5">
                <li>Run your first <Link to="/tools/product-finder" className="text-primary hover:underline">Product Finder</Link> search to surface profitable ASINs.</li>
                <li>Start a <Link to="/tools/user-store-scan" className="text-primary hover:underline">Store Scan</Link> to discover supplier-to-Amazon matches.</li>
                <li>Look up suppliers for any ASIN with <Link to="/tools/user-supplier-discovery" className="text-primary hover:underline">Supplier Discovery</Link>.</li>
              </ul>
              <div className="mt-2 text-[11px] text-white/50">
                You currently have <span className="text-white font-semibold">{fmtInt(src.data.approved_products)}</span> approved products in your library.
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <Stat label="Approved Products" value={fmtInt(src.data?.approved_products || 0)} loading={src.loading} hint="lifetime" />
              <Stat label="Store Scans (7d)" value={fmtInt(src.data?.recent_scans || 0)} loading={src.loading} hint="recent activity" />
              <Stat label="Product Finder Runs (7d)" value={fmtInt(src.data?.recent_supplier_runs || 0)} loading={src.loading} hint="recent activity" />
            </div>
          )}
          <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-2">
            <QuickAction to="/tools/product-finder" label="Product Finder" icon={Search} />
            <QuickAction to="/tools/sourcer" label="Sourcer" icon={TrendingUp} />
            <QuickAction to="/tools/user-supplier-discovery" label="Supplier Discovery" icon={Search} />
            <QuickAction to="/tools/user-store-scan" label="Store Scan" icon={Package} />
          </div>
        </GlassCard>
      </main>

      <Footer />
    </div>
  );
}
