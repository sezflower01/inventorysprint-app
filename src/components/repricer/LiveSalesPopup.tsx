import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { getBusinessDateISO, SALES_BUSINESS_TZ } from "@/lib/sales/dateRange";
import { getMarketplaceFromId } from "@/lib/marketplaceCurrency";
import { useAuth } from "@/contexts/AuthContext";
import { useSalesSync } from "@/contexts/SalesSyncContext";
import { useHomeMarketplace } from "@/hooks/use-home-marketplace";
import { getOrderPromoUsd } from "@/lib/salesCalculations";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, ShoppingCart, RefreshCw, ExternalLink, AlertTriangle, Clock } from "lucide-react";
import {
  Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  ComposedChart, Area, CartesianGrid,
} from "recharts";

interface SalesRow {
  asin: string;
  title: string | null;
  image_url: string | null;
  units: number;
  revenue: number;
}

type TimeWindow = "today" | "month";

const WINDOW_LABELS: Record<TimeWindow, string> = { today: "Today", month: "This Month" };
const WINDOW_SOURCES: Record<TimeWindow, string> = { today: "Live Orders", month: "Sales Orders" };

// Marketplace → currency code mapping
const MARKETPLACE_CURRENCY: Record<string, string> = {
  US: "USD", CA: "CAD", MX: "MXN", BR: "BRL",
  UK: "GBP", DE: "EUR", FR: "EUR", IT: "EUR", ES: "EUR",
  JP: "JPY", AU: "AUD", IN: "INR", SG: "SGD", AE: "AED",
  SA: "SAR", NL: "EUR", SE: "SEK", PL: "PLN", BE: "EUR", TR: "TRY",
};

const MARKETPLACE_FLAGS: Record<string, string> = {
  US: "🇺🇸", CA: "🇨🇦", MX: "🇲🇽", BR: "🇧🇷",
  UK: "🇬🇧", DE: "🇩🇪", FR: "🇫🇷", IT: "🇮🇹", ES: "🇪🇸",
  JP: "🇯🇵", AU: "🇦🇺", IN: "🇮🇳", SG: "🇸🇬", AE: "🇦🇪",
  SA: "🇸🇦", NL: "🇳🇱", SE: "🇸🇪", PL: "🇵🇱", BE: "🇧🇪", TR: "🇹🇷",
  ALL: "🌐",
};

const inferFinancialEventMarketplace = (
  row: { marketplace?: string | null; marketplace_id?: string | null },
) => {
  const marketplaceId = String(row.marketplace_id || "").trim();
  if (marketplaceId) return getMarketplaceFromId(marketplaceId);
  const marketplace = String(row.marketplace || "").trim().toUpperCase();
  if (marketplace && marketplace !== "UNKNOWN" && marketplace in MARKETPLACE_CURRENCY) return marketplace;
  return null;
};

const resolveFinancialEventMarketplace = (
  row: { marketplace?: string | null; marketplace_id?: string | null },
  selectedMp: string,
) => {
  const explicit = inferFinancialEventMarketplace(row);
  if (selectedMp === "ALL") return explicit || "US";
  if (selectedMp === "US") return explicit ? (explicit === "US" ? "US" : null) : "US";
  return explicit === selectedMp ? selectedMp : null;
};

interface LiveSalesPopupProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  marketplace?: string;
}

/* ── helpers ── */

const normalizeOrderId = (orderId: string | null | undefined) =>
  String(orderId || "").trim();

const isPendingPlaceholderRow = (row: { asin?: string | null; title?: string | null }) => {
  const asin = String(row.asin || "").trim().toUpperCase();
  const title = String(row.title || "").trim().toLowerCase();
  return asin === "PENDING" || title.startsWith("order processing");
};

/** Price sources that reflect the actual transaction amount (not current listing price) */
const RELIABLE_PRICE_SOURCES = new Set([
  "orders_api",
  "financial_events",
  "actual",
  "settled",
  "fees_api",
  "order_total_pending",
]);

const isReliablePriceSource = (priceSource: string | null | undefined): boolean => {
  if (!priceSource) return false;
  return RELIABLE_PRICE_SOURCES.has(priceSource);
};

// estimated_price is stored in USD (unlike sold_price/total_sale_amount/
// locked_est_price, which are the native-currency Amazon order amount).
// Convert it back to native currency here so it can flow through the same
// toUsd() conversion the caller applies to every other signal — otherwise
// an already-USD estimate gets divided by the FX rate a second time,
// shrinking non-US estimates by the FX factor (e.g. ~17x for MXN).
const estimatedPriceToNative = (
  estimatedUsd: number,
  marketplace: string | null | undefined,
  fxRates: Record<string, number>,
) => {
  const currency = MARKETPLACE_CURRENCY[String(marketplace || "US").trim()] || "USD";
  if (currency === "USD") return estimatedUsd;
  const rate = fxRates?.[currency];
  return rate && rate > 0 ? estimatedUsd * rate : estimatedUsd;
};

const getLineRevenue = (row: {
  quantity?: number | null;
  sold_price?: number | null;
  total_sale_amount?: number | null;
  estimated_price?: number | null;
  locked_est_price?: number | null;
  promotion_discount?: number | null;
  promotion_discount_currency?: string | null;
  marketplace?: string | null;
}, fxRates: Record<string, number>) => {
  const qty = Math.max(1, Number(row.quantity || 0));
  const soldPrice = Number(row.sold_price || 0);
  const totalSale = Number(row.total_sale_amount || 0);
  // locked_est_price is a frozen, native-currency snapshot (e.g. a real
  // pricing-API hint) — prefer it over the weaker estimated_price fallback
  // when both exist, since it more often reflects the actual order price.
  const lockedEst = Number(row.locked_est_price || 0);
  const estimatedUsd = Number(row.estimated_price || 0);
  let gross = 0;
  if (totalSale > 0) gross = totalSale;
  else if (soldPrice > 0) gross = soldPrice * qty;
  else if (lockedEst > 0) gross = lockedEst * qty;
  else if (estimatedUsd > 0) gross = estimatedPriceToNative(estimatedUsd, row.marketplace, fxRates) * qty;
  if (gross <= 0) return 0;
  // Net Amazon-funded coupon (USD-safe; non-US handled via FEC promo path)
  return Math.max(0, gross - getOrderPromoUsd(row));
};

const getUnitPriceForAverage = (row: {
  quantity?: number | null;
  sold_price?: number | null;
  total_sale_amount?: number | null;
  estimated_price?: number | null;
  locked_est_price?: number | null;
  marketplace?: string | null;
}, fxRates: Record<string, number>) => {
  const qty = Math.max(1, Number(row.quantity || 0));
  const soldPrice = Number(row.sold_price || 0);
  const totalSale = Number(row.total_sale_amount || 0);
  const lockedEst = Number(row.locked_est_price || 0);
  const estimatedUsd = Number(row.estimated_price || 0);
  if (totalSale > 0) return totalSale / qty;
  if (soldPrice > 0) return soldPrice;
  if (lockedEst > 0) return lockedEst;
  if (estimatedUsd > 0) return estimatedPriceToNative(estimatedUsd, row.marketplace, fxRates);
  return 0;
};

// Amazon stores order_date in Pacific Time — match that for day boundaries
const LIVE_SALES_TZ = SALES_BUSINESS_TZ;
const getLocalDateStr = (d: Date = new Date()) => getBusinessDateISO(d, LIVE_SALES_TZ);

const getRowBusinessDate = (
  purchaseTs: string | null | undefined,
  orderDate: string | null | undefined,
) => {
  const rowDateStr = String(orderDate || "").trim().slice(0, 10);
  if (rowDateStr.length >= 10) return rowDateStr;

  const tsStr = String(purchaseTs || "").trim();
  if (tsStr) {
    const tsDate = new Date(tsStr);
    if (!Number.isNaN(tsDate.getTime())) {
      return getBusinessDateISO(tsDate, LIVE_SALES_TZ);
    }
  }

  return "";
};

const isRowWithinWindow = (
  purchaseTs: string | null | undefined,
  orderDate: string | null | undefined,
  win: TimeWindow,
) => {
  const now = new Date();
  const todayStr = getLocalDateStr(now);
  const rowDateStr = getRowBusinessDate(purchaseTs, orderDate);
  if (!rowDateStr) return false;

  if (win === "today") {
    return rowDateStr === todayStr;
  }

  const [ptY, ptM] = todayStr.split('-').map(Number);
  const monthStart = `${ptY}-${String(ptM).padStart(2, '0')}-01`;
  return rowDateStr >= monthStart && rowDateStr <= todayStr;
};

/* ── component ── */

const LiveSalesPopup = ({ open, onOpenChange, marketplace: initialMarketplace = "ALL" }: LiveSalesPopupProps) => {
  const { user } = useAuth();
  const { homeCurrencySymbol } = useHomeMarketplace();
  const { startBackgroundSync, syncState, isSyncing } = useSalesSync();
  const [window] = useState<TimeWindow>("month");
  const [selectedMarketplace, setSelectedMarketplace] = useState<string>("ALL");
  const [availableMarketplaces, setAvailableMarketplaces] = useState<string[]>([]);
  const [isAmazonConnected, setIsAmazonConnected] = useState<boolean | null>(null);
  const [rows, setRows] = useState<SalesRow[]>([]);
  const [dailySales, setDailySales] = useState<{ day: string; label: string; units: number; revenue: number }[]>([]);
  const [monthSummary, setMonthSummary] = useState<{ units: number; revenue: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState({ units: 0, revenue: 0 });
  const [todaySummary, setTodaySummary] = useState({ units: 0, revenue: 0 });
  const [chartSource, setChartSource] = useState<"sales_orders" | "error" | null>(null);
  const [fxRates, setFxRates] = useState<Record<string, number>>({ USD: 1 });
  // Fetch FX rates for currency conversion
  useEffect(() => {
    const fetchFx = async () => {
      const { data } = await supabase.from("fx_rates").select("quote, rate");
      if (data) {
        const map: Record<string, number> = { USD: 1 };
        for (const r of data) map[r.quote] = Number(r.rate) || 1;
        setFxRates(map);
      }
    };
    if (open) fetchFx();
  }, [open]);

  // Detect available marketplaces from seller_authorizations (source of truth for Amazon connection)
  useEffect(() => {
    if (!user?.id || !open) return;
    const detectMarketplaces = async () => {
      const { data } = await supabase
        .from("seller_authorizations")
        .select("marketplace_id")
        .eq("user_id", user.id);
      if (data && data.length > 0) {
        setIsAmazonConnected(true);
        const codes = [...new Set(data.map((r: any) => getMarketplaceFromId(r.marketplace_id)).filter(Boolean))];
        codes.sort((a, b) => (a === "US" ? -1 : b === "US" ? 1 : a.localeCompare(b)));
        if (codes.length > 1) codes.unshift("ALL");
        setAvailableMarketplaces(codes);
        if (codes.length > 0 && !codes.includes(selectedMarketplace)) {
          setSelectedMarketplace(codes.find(c => c !== "ALL") || "US");
        }
      } else {
        setIsAmazonConnected(false);
        setAvailableMarketplaces([]);
      }
    };
    detectMarketplaces();
  }, [user?.id, open]);

  const fetchSales = useCallback(async () => {
    if (!user?.id || !open || isAmazonConnected === null) return;
    setLoading(true);
    try {
      const todayPT = getLocalDateStr(new Date());
      const [ptY, ptM] = todayPT.split('-').map(Number);
      const monthStart = `${ptY}-${String(ptM).padStart(2, '0')}-01`;
      const cutoffDate = window === "month" ? monthStart : new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

      // ─── PRODUCT LIST + CHART: Single paginated query, same authority ───
      const allData: any[] = [];
      const PAGE = 1000;
      for (let from = 0; from < 20000; from += PAGE) {
        let pageQuery = supabase
          .from("sales_orders")
          .select(
            "order_id, asin, title, image_url, quantity, sold_price, total_sale_amount, estimated_price, locked_est_price, order_date, purchase_timestamp_utc, is_cancelled, order_status, order_type, marketplace, price_source, promotion_discount, promotion_discount_currency",
          )
          .eq("user_id", user.id)
          .gte("order_date", cutoffDate)
          .not("order_id", "like", "%-REFUND")
          .order("order_date", { ascending: true })
          .order("order_id", { ascending: true })
          .range(from, from + PAGE - 1);

        if (selectedMarketplace && selectedMarketplace !== "ALL") {
          if (selectedMarketplace === "US") {
            pageQuery = pageQuery.or("marketplace.eq.US,marketplace.is.null");
          } else {
            pageQuery = pageQuery.eq("marketplace", selectedMarketplace);
          }
        }

        const { data: page, error: pageErr } = await pageQuery;
        if (pageErr) throw pageErr;
        if (!page || page.length === 0) break;
        allData.push(...page);
        if (page.length < PAGE) break;
      }
      const data = allData;

      const validRows = (data || []).filter((row: any) => {
        if (row.is_cancelled === true) return false;
        const status = String(row.order_status || "").toLowerCase();
        if (status === "canceled" || status === "cancelled") return false;
        // Exclude orphan restored rows that have NULL status and no business date.
        if (!status && !String(row.order_date || "").trim()) return false;
        const orderType = String(row.order_type || "").toLowerCase();
        if (orderType.includes("replacement")) return false;
        return isRowWithinWindow(row.purchase_timestamp_utc, row.order_date, window);
      });

      const resolvedOrderIds = new Set(
        validRows
          .filter((row: any) => !isPendingPlaceholderRow(row))
          .map((row: any) => normalizeOrderId(row.order_id))
          .filter(Boolean),
      );

      const dedupedRows = validRows
        .filter((row: any) => {
          if (isPendingPlaceholderRow(row) && resolvedOrderIds.has(normalizeOrderId(row.order_id)))
            return false;
          return true;
        })
        .filter((row: any, index: number, source: any[]) => {
          const key = `${normalizeOrderId(row.order_id)}::${String(row.asin || "").trim()}`;
          return (
            source.findIndex(
              (c: any) =>
                `${normalizeOrderId(c.order_id)}::${String(c.asin || "").trim()}` === key,
            ) === index
          );
        });

      const pricesForAvg = dedupedRows
        .map((r: any) => getUnitPriceForAverage(r, fxRates))
        .filter((p: number) => p > 0);
      const avgUnitPrice =
        pricesForAvg.length > 0 ? pricesForAvg.reduce((s, p) => s + p, 0) / pricesForAvg.length : 0;

      // FX conversion: convert local currency to USD
      const toUsd = (amount: number, mp: string | null | undefined) => {
        const currency = MARKETPLACE_CURRENCY[String(mp || "US").trim()] || "USD";
        if (currency === "USD") return amount;
        const rate = fxRates[currency];
        return rate && rate > 0 ? amount / rate : amount;
      };

      // Aggregate by ASIN for product list — TODAY ONLY (matches top summary)
      const todayStr = getLocalDateStr(new Date());
      const todayRows = dedupedRows.filter((row: any) => {
        const rowDate = getRowBusinessDate(row.purchase_timestamp_utc, row.order_date);
        return rowDate === todayStr;
      });

      const asinMap = new Map<string, SalesRow>();
      let totalUnits = 0;
      let totalRevenue = 0;

      for (const row of todayRows) {
        const placeholder = isPendingPlaceholderRow(row);
        // Use order_id as key for pending rows so each shows individually
        const asin = placeholder
          ? `PENDING::${normalizeOrderId((row as any).order_id) || Math.random()}`
          : (row.asin || "").trim();
        if (!asin) continue;

        const qty = Math.max(1, Number(row.quantity || 0));
        const explicit = getLineRevenue(row, fxRates);
        const rawRevenue = explicit > 0 ? explicit : avgUnitPrice > 0 ? avgUnitPrice * qty : 0;
        const lineRevenue = toUsd(rawRevenue, (row as any).marketplace);

        totalUnits += qty;
        totalRevenue += lineRevenue;

        const existing = asinMap.get(asin);
        if (existing) {
          existing.units += qty;
          existing.revenue += lineRevenue;
          if (!existing.title && row.title) existing.title = row.title;
          if (!existing.image_url && row.image_url) existing.image_url = row.image_url;
        } else {
          asinMap.set(asin, {
            asin: placeholder ? "PENDING" : asin,
            title: row.title || (placeholder ? "Pending Order" : null),
            image_url: row.image_url || null,
            units: qty,
            revenue: lineRevenue,
          });
        }
      }

      // ─── CHART: Uses SAME dedupedRows as product list (single authority) ───
      // Groups by order_date for consistency with Sales Report.
      // Pads empty days through today so the chart line always extends to today.
      {
        const dayMap = new Map<string, { units: number; revenue: number }>();
        for (const row of dedupedRows) {
          // Use the same business-date derivation as isRowWithinWindow so
          // filtering and grouping are always consistent (no cross-date leakage).
          const dateStr = getRowBusinessDate(
            (row as any).purchase_timestamp_utc,
            (row as any).order_date,
          );
          if (!dateStr || dateStr.length < 10) continue;
          const qty = Math.max(1, Number(row.quantity || 0));
          const explicit = getLineRevenue(row, fxRates);
          const rawRev = explicit > 0 ? explicit : avgUnitPrice > 0 ? avgUnitPrice * qty : 0;
          const lineRev = toUsd(rawRev, (row as any).marketplace);
          const entry = dayMap.get(dateStr) || { units: 0, revenue: 0 };
          entry.units += qty;
          entry.revenue += lineRev;
          dayMap.set(dateStr, entry);
        }

        // ── FEC reconciliation: backfill days where sales_orders is missing/sparse ──
        {
          const FEC_PAGE = 1000;
          const fecDayMap = new Map<string, { units: number; revenue: number }>();
          for (let from = 0; from < 100000; from += FEC_PAGE) {
            const { data: fecPage, error: fecErr } = await supabase
              .from("financial_events_cache")
              .select("event_date, sales, promotional_rebates, marketplace, marketplace_id")
              .eq("user_id", user.id)
              .eq("event_type", "shipment")
              .gte("event_date", cutoffDate)
              .lte("event_date", todayStr)
              .range(from, from + FEC_PAGE - 1);
            if (fecErr) { console.warn("[LiveSalesPopup] FEC fallback error:", fecErr); break; }
            if (!fecPage || fecPage.length === 0) break;

            for (const row of fecPage) {
              const resolvedMp = resolveFinancialEventMarketplace(row, selectedMarketplace);
              if (!resolvedMp) continue;
              const day = String(row.event_date || "").slice(0, 10);
              if (!day || day < cutoffDate || day > todayStr) continue;
              // Net out Amazon promotional rebates (lightning deals, marketplace
              // coupons) so per-ASIN revenue matches Sellerboard net of promo.
              // financial_events_cache.sales/promotional_rebates are already
              // USD (fetch-profit-loss converts at ingestion) -- do NOT run
              // this through toUsd(), which is for native-currency
              // sales_orders fields only. Doing so here divided non-US rows
              // by the marketplace FX rate a second time.
              const gross = Math.abs(Number(row.sales || 0));
              const promo = Math.abs(Number(row.promotional_rebates || 0));
              const rev = Math.max(0, gross - promo);
              const entry = fecDayMap.get(day) || { units: 0, revenue: 0 };
              entry.units += 1;
              entry.revenue += rev;
              fecDayMap.set(day, entry);
            }
            if (fecPage.length < FEC_PAGE) break;
          }

          for (const [day, fecData] of fecDayMap) {
            const soData = dayMap.get(day);
            if (!soData || soData.revenue < 1) {
              dayMap.set(day, { units: fecData.units, revenue: fecData.revenue });
            } else if (fecData.revenue > soData.revenue * 1.5 && fecData.units > soData.units) {
              dayMap.set(day, { units: fecData.units, revenue: fecData.revenue });
            }
          }
        }

        const todayLocal = getLocalDateStr(new Date());
        const dailyArr: { day: string; label: string; units: number; revenue: number }[] = [];

        if (window === "month") {
          const mTodayPT = getLocalDateStr(new Date());
          const [mPtY, mPtM] = mTodayPT.split('-').map(Number);
          const mStart = `${mPtY}-${String(mPtM).padStart(2, '0')}-01`;
          for (
            let cursor = new Date(`${mStart}T12:00:00`);
            getLocalDateStr(cursor) <= todayLocal;
            cursor.setDate(cursor.getDate() + 1)
          ) {
            const day = getLocalDateStr(cursor);
            const d = dayMap.get(day) || { units: 0, revenue: 0 };
            dailyArr.push({
              day,
              label: new Date(`${day}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
              units: d.units,
              revenue: Math.round(d.revenue * 100) / 100,
            });
          }

          let monthUnits = 0;
          let monthRevenue = 0;
          for (const d of dayMap.values()) {
            monthUnits += d.units;
            monthRevenue += d.revenue;
          }
          setMonthSummary({ units: monthUnits, revenue: Math.round(monthRevenue * 100) / 100 });
          setTodaySummary({ units: totalUnits, revenue: Math.round(totalRevenue * 100) / 100 });
        } else {
          const d = dayMap.get(todayLocal) || { units: 0, revenue: 0 };
          dailyArr.push({
            day: todayLocal,
            label: new Date(`${todayLocal}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
            units: d.units,
            revenue: Math.round(d.revenue * 100) / 100,
          });
          setMonthSummary(null);
          setTodaySummary({ units: totalUnits, revenue: Math.round(totalRevenue * 100) / 100 });
        }

        setDailySales(dailyArr);
        setChartSource("sales_orders");
        console.log(`[LiveSalesPopup] ✅ Chart loaded (${window}): ${dedupedRows.length} orders, ${dailyArr.length} days, marketplace=${selectedMarketplace}`);
      }

      setRows(Array.from(asinMap.values()).sort((a, b) => b.revenue - a.revenue));
      setSummary({ units: totalUnits, revenue: totalRevenue });
    } catch (err: any) {
      console.error("[LiveSalesPopup] Error:", err);
    } finally {
      setLoading(false);
    }
  }, [user?.id, open, window, selectedMarketplace, fxRates, isAmazonConnected]);

  const refreshLiveSales = useCallback(
    async (force = false) => {
      if (!user?.id || !open) return;
      await fetchSales();
      void startBackgroundSync({ force, silent: true }).catch((err) => {
        console.warn("[LiveSalesPopup] Background sync failed:", err);
      });
    },
    [user?.id, open, startBackgroundSync, fetchSales],
  );

  useEffect(() => { fetchSales(); }, [fetchSales, syncState.syncVersion]);

  useEffect(() => {
    if (!open || !user?.id) return;
    void refreshLiveSales(true);
    const id = setInterval(() => {
      if (!isSyncing) void refreshLiveSales(true);
    }, 60000);
    return () => clearInterval(id);
  }, [open, user?.id, refreshLiveSales, isSyncing]);

  const hasChartData = dailySales.length > 0;

  // Top bar always shows TODAY stats
  const displaySummary = todaySummary;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[95vw] w-[1100px] max-h-[88vh] flex flex-col p-0 gap-0 overflow-hidden">
        {/* Header */}
        <DialogHeader className="px-6 pt-5 pb-3 border-b border-border bg-gradient-to-r from-background to-muted/30">
          <DialogTitle className="flex items-center gap-2.5 text-lg font-bold">
            <div className="p-1.5 rounded-lg bg-emerald-500/10">
              <ShoppingCart className="h-5 w-5 text-emerald-500" />
            </div>
            InventorySprint Repricer in Action
          </DialogTitle>
          <DialogDescription className="sr-only">
            Live sales summary with product image, title, ASIN, units sold, and revenue.
          </DialogDescription>
        </DialogHeader>

        {/* Not connected state */}
        {isAmazonConnected === false && (
          <div className="flex flex-col items-center justify-center py-16 px-6 gap-4">
            <AlertTriangle className="h-10 w-10 text-muted-foreground/50" />
            <p className="text-lg font-semibold text-foreground">No Amazon Marketplaces Connected</p>
            <p className="text-sm text-muted-foreground text-center max-w-md">
              Connect your Amazon account to view live sales data.
            </p>
          </div>
        )}

        {isAmazonConnected !== false && (
        <>
        {/* Controls bar */}
        <div className="flex flex-wrap items-center gap-3 px-6 py-2 border-b border-border bg-muted/20">
          {availableMarketplaces.length > 1 && (
            <div className="flex items-center gap-0.5 rounded-xl border border-border bg-background p-0.5 shadow-sm">
              {availableMarketplaces.map((mp) => (
                <button
                  key={mp}
                  onClick={() => setSelectedMarketplace(mp)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all ${
                    selectedMarketplace === mp
                      ? "bg-primary text-primary-foreground shadow-md"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                  }`}
                >
                  {MARKETPLACE_FLAGS[mp] || "🏳️"} {mp}
                </button>
              ))}
            </div>
          )}

          <div className="flex items-center gap-4 ml-auto">
            <div className="flex items-center gap-2">
              <div className="flex flex-col items-end">
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Units</span>
                  {loading && (
                    <span className="inline-flex items-center gap-1 text-[9px] font-medium text-amber-500 bg-amber-500/10 px-1.5 py-0.5 rounded-full animate-pulse">
                      <Loader2 className="h-2.5 w-2.5 animate-spin" />
                      Updating…
                    </span>
                  )}
                </div>
                <span className={`text-lg font-bold tabular-nums leading-tight transition-opacity duration-300 ${loading ? 'text-muted-foreground/70' : 'text-foreground'}`}>{displaySummary.units}</span>
              </div>
              <div className="w-px h-8 bg-border" />
              <div className="flex flex-col items-end">
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Revenue</span>
                  {loading && (
                    <span className="inline-flex items-center gap-1 text-[9px] font-medium text-amber-500 bg-amber-500/10 px-1.5 py-0.5 rounded-full animate-pulse">
                      <Loader2 className="h-2.5 w-2.5 animate-spin" />
                      Updating…
                    </span>
                  )}
                </div>
                <span className={`text-lg font-bold tabular-nums leading-tight transition-opacity duration-300 ${loading ? 'text-emerald-600/50' : 'text-emerald-600'}`}>{homeCurrencySymbol}{displaySummary.revenue.toFixed(2)}</span>
              </div>
            </div>
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8 rounded-lg"
              onClick={() => void refreshLiveSales(true)}
              disabled={loading || isSyncing}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading || isSyncing ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </div>

        {/* Main content: vertical layout — table top, chart bottom */}
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {/* Product list — hidden for now */}
          {/* TODO: Re-enable product list rows when ready */}

          {/* Bottom: Month summary + Chart — full width */}
          <div className="flex-1 border-t border-border bg-muted/10 px-2 py-2">
            {/* Month summary bar */}
            {monthSummary && (
              <div className="flex items-center justify-between px-3 py-1.5 mb-2 rounded-lg bg-card border border-border">
                <span className="text-xs font-semibold text-muted-foreground">📅 This Month</span>
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Units</span>
                    <span className="text-sm font-bold text-foreground tabular-nums">{monthSummary.units}</span>
                  </div>
                  <div className="w-px h-5 bg-border" />
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Revenue</span>
                    <span className="text-sm font-bold text-emerald-600 tabular-nums">{homeCurrencySymbol}{monthSummary.revenue.toFixed(2)}</span>
                  </div>
                </div>
              </div>
            )}
            {chartSource === "error" ? (
              <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 mx-2">
                <div className="flex items-center gap-2 mb-1">
                  <AlertTriangle className="h-4 w-4 text-destructive" />
                  <h3 className="text-xs font-bold text-destructive">Chart Unavailable</h3>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Financial settlement data failed to load. Try refreshing.
                </p>
              </div>
            ) : hasChartData ? (
              <div className="h-[160px]">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={dailySales} margin={{ left: 4, right: 4, top: 4, bottom: 4 }}>
                    <defs>
                      <linearGradient id="revGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="hsl(142, 76%, 36%)" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="hsl(142, 76%, 36%)" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.5} />
                    <XAxis dataKey="label" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                    <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickFormatter={(v) => `${homeCurrencySymbol}${v}`} width={55} />
                    <Tooltip
                      contentStyle={{
                        background: "hsl(var(--card))",
                        border: "1px solid hsl(var(--border))",
                        borderRadius: "8px",
                        fontSize: "11px",
                        boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
                      }}
                      formatter={(value: number, name: string) => [
                        name === "revenue" ? `${homeCurrencySymbol}${value.toFixed(2)}` : value,
                        name === "revenue" ? "Revenue" : "Units",
                      ]}
                    />
                    <Area type="monotone" dataKey="revenue" stroke="hsl(142, 76%, 36%)" fill="url(#revGradient)" strokeWidth={2} />
                    <Bar dataKey="units" fill="hsl(221, 83%, 53%)" opacity={0.6} radius={[3, 3, 0, 0]} barSize={20} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            ) : !loading ? (
              <div className="text-center text-muted-foreground text-sm py-6">
                No chart data available
              </div>
            ) : null}
          </div>
        </div>
        </>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default LiveSalesPopup;
