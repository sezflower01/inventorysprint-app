import { useEffect, useState, useCallback, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { fetchAllPages } from "@/lib/sales/paginatedFetch";
import { useAuth } from "@/contexts/AuthContext";
import { Loader2, RotateCw, ChevronDown, ChevronRight, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { addDaysISO } from "@/lib/sales/dateRange";
import { formatMarketplaceDate } from "@/lib/sales/dateLocale";
import { useHomeMarketplace } from "@/hooks/use-home-marketplace";
import { getCurrencyForMarketplace } from "@/lib/marketplaceCurrency";

const AMAZON_SC_DOMAIN: Record<string, string> = {
  US: "sellercentral.amazon.com", ATVPDKIKX0DER: "sellercentral.amazon.com",
  CA: "sellercentral.amazon.ca", A2EUQ1WTGCTBG2: "sellercentral.amazon.ca",
  MX: "sellercentral.amazon.com.mx", A1AM78C64UM0Y8: "sellercentral.amazon.com.mx",
  BR: "sellercentral.amazon.com.br", A2Q3Y263D00KWC: "sellercentral.amazon.com.br",
  UK: "sellercentral.amazon.co.uk", GB: "sellercentral.amazon.co.uk", A1F83G8C2ARO7P: "sellercentral.amazon.co.uk",
  DE: "sellercentral.amazon.de", A1PA6795UKMFR9: "sellercentral.amazon.de",
  FR: "sellercentral.amazon.fr", A13V1IB3VIYBER: "sellercentral.amazon.fr",
  IT: "sellercentral.amazon.it", APJ6JRA9NG5V4: "sellercentral.amazon.it",
  ES: "sellercentral.amazon.es", A1RKKUPIHCS9HS: "sellercentral.amazon.es",
  JP: "sellercentral.amazon.co.jp", A1VC38T7YXB528: "sellercentral.amazon.co.jp",
  AU: "sellercentral.amazon.com.au", A39IBJ37TRP1C6: "sellercentral.amazon.com.au",
};
function buildAmazonOrderUrl(orderId: string, mkt: string | null | undefined): string {
  const key = (mkt || "US").toUpperCase();
  const domain = AMAZON_SC_DOMAIN[key] || AMAZON_SC_DOMAIN[mkt || ""] || "sellercentral.amazon.com";
  const clean = orderId.replace(/-REFUND(-\d+)?$/, "");
  return `https://${domain}/orders-v3/order/${clean}`;
}

/**
 * Renders one collapsible section per Amazon fee/credit category present in
 * financial_events_cache for the selected period — mirroring the RefundsSection
 * pattern so Sales Report shows a full P&L-style breakdown by category.
 */

interface FecRow {
  id: string;
  event_type: string | null;
  event_date: string | null;
  amazon_order_id: string | null;
  asin: string | null;
  marketplace: string | null;
  // fee columns we sum
  referral_fees: number | null;
  fba_fees: number | null;
  variable_closing_fees: number | null;
  fixed_closing_fees: number | null;
  fba_inbound_fees: number | null;
  fba_inbound_convenience_fee: number | null;
  fba_storage_fees: number | null;
  fba_removal_fees: number | null;
  fba_disposal_fees: number | null;
  fba_long_term_storage_fees: number | null;
  fba_customer_return_fees: number | null;
  digital_services_fee: number | null;
  other_fees: number | null;
  liquidations_brokerage_fee: number | null;
  re_commerce_grading_charge: number | null;
  compensated_clawback: number | null;
  hrr_non_apparel: number | null;
  restocking_fee: number | null;
  shipping_chargeback: number | null;
  fbm_shipping_label_fee: number | null;
  shipping_credits: number | null;
  // credits
  reimbursements: number | null;
  liquidations: number | null;
  warehouse_lost: number | null;
  warehouse_damage: number | null;
  reversal_reimbursement: number | null;
  free_replacement_refund_items: number | null;
  other_income: number | null;
}

interface SalesOrderInfo {
  order_id: string;
  fulfillment_channel: string | null;
  shipping_label_fee: number | null;
  seller_sku: string | null;
  asin: string | null;
  marketplace: string | null;
}

interface PendingFbmOrder {
  order_id: string;
  asin: string | null;
  seller_sku: string | null;
  marketplace: string | null;
  order_date: string | null;
  shipping_label_fee: number | null;
  status: string | null;
}

interface InboundFeeRow {
  id: string;
  shipment_id: string | null;
  fee_type: string | null;
  fee_amount: number | null;
  posted_date: string | null;
  shipment_day: string | null;
  asin: string | null;
  sku: string | null;
}

type Kind = "fee" | "credit";

interface CategoryDef {
  key: string;                       // virtual key for UI grouping
  sourceKey?: keyof FecRow;          // single FEC column to read
  sourceKeys?: (keyof FecRow)[];     // OR multiple columns summed per-event
  label: string;
  kind: Kind;
  match?: (row: FecRow) => boolean;
}

const CATEGORIES: CategoryDef[] = [
  // Fees
  { key: "referral_fees", sourceKey: "referral_fees", label: "Referral Fees", kind: "fee" },
  { key: "fba_fees", sourceKey: "fba_fees", label: "FBA Fulfillment Fees", kind: "fee" },
  { key: "variable_closing_fees", sourceKey: "variable_closing_fees", label: "Variable Closing Fees", kind: "fee" },
  { key: "fixed_closing_fees", sourceKey: "fixed_closing_fees", label: "Fixed Closing Fees", kind: "fee" },
  { key: "fba_inbound_fees", sourceKey: "fba_inbound_fees", label: "FBA Inbound Transportation Fees", kind: "fee" },
  { key: "fba_inbound_convenience_fee", sourceKey: "fba_inbound_convenience_fee", label: "FBA Inbound Convenience Fee", kind: "fee" },
  { key: "fba_storage_fees", sourceKey: "fba_storage_fees", label: "FBA Storage Fees", kind: "fee" },
  { key: "fba_long_term_storage_fees", sourceKey: "fba_long_term_storage_fees", label: "FBA Long-Term Storage Fees", kind: "fee" },
  { key: "fba_removal_fees", sourceKey: "fba_removal_fees", label: "FBA Removal Fees", kind: "fee" },
  { key: "fba_disposal_fees", sourceKey: "fba_disposal_fees", label: "FBA Disposal Fees", kind: "fee" },
  { key: "fba_customer_return_fees", sourceKey: "fba_customer_return_fees", label: "FBA Customer Return Fees", kind: "fee" },
  { key: "digital_services_fee", sourceKey: "digital_services_fee", label: "Digital Services Fee", kind: "fee" },
  { key: "liquidations_brokerage_fee", sourceKey: "liquidations_brokerage_fee", label: "Liquidations Brokerage Fee", kind: "fee" },
  { key: "re_commerce_grading_charge", sourceKey: "re_commerce_grading_charge", label: "Re-Commerce Grading Charge", kind: "fee" },
  { key: "compensated_clawback", sourceKey: "compensated_clawback", label: "Compensated Clawback", kind: "fee" },
  { key: "hrr_non_apparel", sourceKey: "hrr_non_apparel", label: "HRR Non-Apparel Rollup", kind: "fee" },
  // Seller-paid shipping charges from Amazon settlement data.
  // Do not hide these as memo rows: if Amazon posts a ShippingChargeback or
  // Buy Shipping fee, show it as paid/deducted.
  {
    key: "shipping_paid_to_amazon_total",
    sourceKeys: ["fbm_shipping_label_fee", "shipping_chargeback"],
    label: "Shipping Paid to Amazon — Labels / Shipping Chargebacks",
    kind: "fee",
  },
  { key: "other_fees", sourceKey: "other_fees", label: "Other Fees", kind: "fee" },
  // Credits
  { key: "shipping_credits", sourceKey: "shipping_credits", label: "Shipping Credits Collected From Buyer", kind: "credit" },
  // Moved out of the fee list 2026-11-11. It sat under kind:"fee", which
  // renders as -$X in red, so a restocking penalty Amazon charges the
  // RETURNING BUYER and hands to the seller was displayed as money the seller
  // paid. `kind` only drives display here (each section totals its own items),
  // so this is a presentation fix, not an arithmetic one -- but it was the
  // visible half of a real sign error: see refundMath.ts and RefundsSection.
  { key: "restocking_fee", sourceKey: "restocking_fee", label: "Restocking Fees Credit (charged to buyer)", kind: "credit" },
  { key: "reimbursements", sourceKey: "reimbursements", label: "Reimbursements", kind: "credit" },
  { key: "liquidations", sourceKey: "liquidations", label: "Liquidations Revenue", kind: "credit" },
  { key: "warehouse_lost", sourceKey: "warehouse_lost", label: "Warehouse Lost", kind: "credit" },
  { key: "warehouse_damage", sourceKey: "warehouse_damage", label: "Warehouse Damage", kind: "credit" },
  { key: "reversal_reimbursement", sourceKey: "reversal_reimbursement", label: "Reversal Reimbursement", kind: "credit" },
  { key: "free_replacement_refund_items", sourceKey: "free_replacement_refund_items", label: "Free Replacement Refund Items", kind: "credit" },
  { key: "other_income", sourceKey: "other_income", label: "Other Income", kind: "credit" },
];

// Build the column list once. Always include fba_fees as discriminator.
const SELECT_COLS = Array.from(new Set<string>([
  "id", "event_type", "event_date", "amazon_order_id", "asin", "marketplace",
  "fba_fees",
  ...CATEGORIES.flatMap((c) => [c.sourceKey, ...(c.sourceKeys || [])])
    .filter((k): k is keyof FecRow => !!k),
])).join(",");



interface Props {
  rangeStart: string;
  rangeEnd: string;
  label: string;
  dark?: boolean;
}

export default function FeeBreakdownSections({ rangeStart, rangeEnd, label, dark }: Props) {
  const { user } = useAuth();
  const { homeMarketplace, homeCurrency, homeCurrencySymbol } = useHomeMarketplace();
  const [rows, setRows] = useState<FecRow[]>([]);
  const [orderInfo, setOrderInfo] = useState<Record<string, SalesOrderInfo>>({});
  const [pendingFbm, setPendingFbm] = useState<PendingFbmOrder[]>([]);
  const [inboundRows, setInboundRows] = useState<InboundFeeRow[]>([]);
  const [orderSearch, setOrderSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [fxRates, setFxRates] = useState<Record<string, number>>({ USD: 1 });

  useEffect(() => {
    supabase.from("fx_rates").select("quote, rate").then(({ data }) => {
      const next: Record<string, number> = { USD: 1 };
      for (const row of (data as any[]) || []) next[String(row.quote || "")] = Number(row.rate) || 1;
      setFxRates(next);
    });
  }, []);

  // Two distinct sources feed this component, in two different currency
  // states -- do not treat them the same way:
  //  - financial_events_cache / fba_inbound_fees rows are already USD at
  //    ingestion (convertToUSD in fetch-profit-loss/index.ts and
  //    sync-inbound-fees/index.ts). Converting these by marketplace again
  //    (the previous behavior of this function) was a second, erroneous
  //    conversion that shrunk non-US amounts by the FX rate a second time.
  //  - sales_orders.shipping_label_fee (used by the pending-FBM list below)
  //    is genuinely still in the order's native marketplace currency --
  //    sync-fbm-label-cost/index.ts writes SP-API's raw CurrencyAmount with
  //    no conversion. This one still needs the native -> USD step.
  //
  // Both then apply the same USD -> seller's home display currency step.
  const usdToHomeCurrency = useCallback((amountUsd: number): number => {
    return homeCurrency === "USD" ? amountUsd : amountUsd * (fxRates[homeCurrency] || 1);
  }, [fxRates, homeCurrency]);
  const toHomeCurrency = useCallback((amount: number, mkt: string | null | undefined): number => {
    const nativeCurrency = getCurrencyForMarketplace(String(mkt || homeMarketplace || "US").toUpperCase());
    const usd = nativeCurrency === "USD" ? amount : amount / (fxRates[nativeCurrency] || 1);
    return usdToHomeCurrency(usd);
  }, [fxRates, homeMarketplace, usdToHomeCurrency]);

  const fetchRows = useCallback(async () => {
    if (!user?.id || !rangeStart || !rangeEnd) return;
    setLoading(true);
    try {
      const PAGE = 1000;
      const all: FecRow[] = [];
      for (let from = 0; from < 50000; from += PAGE) {
        const { data, error } = await supabase
          .from("financial_events_cache")
          .select(SELECT_COLS)
          .eq("user_id", user.id)
          .gte("event_date", rangeStart)
          .lte("event_date", rangeEnd)
          .order("event_date", { ascending: false })
          .range(from, from + PAGE - 1);
        if (error) {
          console.warn("[FeeBreakdownSections] fetch error:", error.message);
          break;
        }
        if (!data || data.length === 0) break;
        all.push(...(data as unknown as FecRow[]));
        if (data.length < PAGE) break;
      }
      setRows(all);

      const inboundData = await fetchAllPages<InboundFeeRow>(() =>
        supabase
          .from("fba_inbound_fees")
          .select("id,shipment_id,fee_type,fee_amount,posted_date,shipment_day,asin,sku")
          .eq("user_id", user.id)
          .ilike("fee_type", "%Transportation%")
          .or(`and(shipment_day.gte.${rangeStart},shipment_day.lte.${rangeEnd}),and(shipment_day.is.null,posted_date.gte.${rangeStart},posted_date.lte.${rangeEnd})`)
          .order("posted_date", { ascending: false }),
        { label: "FeeBreakdown inbound" },
      );
      setInboundRows(inboundData);

      const orderIds = Array.from(new Set(all.map((r) => r.amazon_order_id).filter(Boolean))) as string[];
      const info: Record<string, SalesOrderInfo> = {};
      for (let i = 0; i < orderIds.length; i += 500) {
        const batch = orderIds.slice(i, i + 500);
        const { data: orderRows, error: orderErr } = await supabase
          .from("sales_orders")
          .select("order_id,fulfillment_channel,shipping_label_fee,seller_sku,asin,marketplace")
          .eq("user_id", user.id)
          .in("order_id", batch);
        if (orderErr) {
          console.warn("[FeeBreakdownSections] order info fetch error:", orderErr.message);
          continue;
        }
        for (const orderRow of (orderRows || []) as SalesOrderInfo[]) {
          info[orderRow.order_id] = orderRow;
        }
      }
      setOrderInfo(info);

      // Fetch recent unmatched FBM orders so searches can find older orders whose
      // settlement posted late or whose FEC row is missing/mis-keyed by Amazon.
      const pendingLookbackStart = addDaysISO(rangeStart, -180);
      const settledFbmIds = new Set(
        all
          .filter((r) => Number(r.fbm_shipping_label_fee || 0) !== 0 || Number(r.shipping_chargeback || 0) !== 0)
          .map((r) => r.amazon_order_id)
          .filter(Boolean) as string[],
      );
      const pendingRows = await fetchAllPages<PendingFbmOrder>(() =>
        supabase
          .from("sales_orders")
          .select("order_id,asin,seller_sku,marketplace,order_date,shipping_label_fee,status")
          .eq("user_id", user.id)
          .eq("fulfillment_channel", "MFN")
          .gte("order_date", pendingLookbackStart)
          .lte("order_date", rangeEnd)
          .order("order_date", { ascending: false }),
        { label: "FeeBreakdown pending FBM" },
      );
      const pending = (pendingRows || []).filter(
        (o: PendingFbmOrder) => !settledFbmIds.has(o.order_id),
      );
      setPendingFbm(pending as PendingFbmOrder[]);
    } finally {
      setLoading(false);
    }
  }, [user?.id, rangeStart, rangeEnd]);

  useEffect(() => {
    fetchRows();
  }, [fetchRows]);

  const sections = useMemo(() => {
    const q = orderSearch.trim().toLowerCase();
    return CATEGORIES.map((cat) => {
      if (cat.key === "fba_inbound_fees" && inboundRows.length > 0) {
        const items = inboundRows.map((fee) => ({
          row: {
            id: fee.id,
            event_type: fee.fee_type || "FBAInboundTransportationFee",
            event_date: fee.shipment_day || fee.posted_date,
            amazon_order_id: fee.shipment_id,
            asin: fee.asin || fee.sku,
            marketplace: homeMarketplace,
            fba_fees: null,
            fba_inbound_fees: fee.fee_amount,
          } as FecRow,
          // fee_amount is already USD (sync-inbound-fees converts at
          // ingestion) -- only the USD -> home-display-currency step applies.
          val: usdToHomeCurrency(Number(fee.fee_amount || 0)),
        })).filter((x) => x.val !== 0);
        const total = items.reduce((s, x) => s + x.val, 0);
        return { cat, items, total };
      }
      const items = rows
        .filter((r) => (cat.match ? cat.match(r) : true))
        .filter((r) => {
          // Search only applies to the shipping category, and matches through
          // sales_orders too because Amazon FEC sometimes stores a wrong ASIN.
          if (cat.key !== "shipping_paid_to_amazon_total") return true;
          if (!q) return true;
          const info = r.amazon_order_id ? orderInfo[r.amazon_order_id] : undefined;
          return [r.amazon_order_id, r.asin, info?.asin, info?.seller_sku]
            .some((value) => (value || "").toLowerCase().includes(q));
        })
        .map((r) => {
          let val = 0;
          if (cat.sourceKeys && cat.sourceKeys.length > 0) {
            for (const k of cat.sourceKeys) val += Number(r[k] || 0);
          } else if (cat.sourceKey) {
            val = Number(r[cat.sourceKey] || 0);
          }
          // val is already USD (financial_events_cache is pre-converted at
          // ingestion) -- only the USD -> home-display-currency step applies.
          return { row: r, val: usdToHomeCurrency(val) };
        })
        .filter((x) => x.val !== 0);
      const total = items.reduce((s, x) => s + x.val, 0);
      return { cat, items, total };
    }).filter((s) => s.items.length > 0 || s.cat.key === "shipping_paid_to_amazon_total");
  }, [rows, inboundRows, orderInfo, orderSearch, homeMarketplace]);

  const toggle = (k: string) => setOpen((o) => ({ ...o, [k]: !o[k] }));

  const fulfillmentLabel = (row: FecRow, categoryKey?: string) => {
    if (categoryKey === "fba_inbound_fees") return { text: "FBA", cls: dark ? "bg-sky-400/15 text-sky-200" : "bg-sky-100 text-sky-800" };
    const info = row.amazon_order_id ? orderInfo[row.amazon_order_id] : undefined;
    const channel = (info?.fulfillment_channel || "").toUpperCase();
    const label = channel === "MFN" ? "FBM" : channel === "AFN" ? "FBA" : "Unknown";
    if (label === "FBM") return { text: "FBM", cls: dark ? "bg-amber-400/15 text-amber-200" : "bg-amber-100 text-amber-800" };
    if (label === "FBA") return { text: "FBA", cls: dark ? "bg-sky-400/15 text-sky-200" : "bg-sky-100 text-sky-800" };
    return { text: "Unknown", cls: dark ? "bg-white/10 text-white/70" : "bg-muted text-muted-foreground" };
  };




  const cardBg = dark ? "bg-white/[0.04] border border-white/10 rounded-xl" : "bg-card rounded-lg border";
  const titleCls = dark ? "text-white font-bold" : "font-semibold";
  const subCls = dark ? "text-white/70" : "text-muted-foreground";
  const theadCls = dark ? "bg-white/[0.06] text-xs font-bold uppercase text-white/80" : "bg-muted/40 text-xs uppercase text-muted-foreground";
  const cellCls = dark ? "text-white/90" : "";
  const rowBorder = dark ? "border-white/10" : "border-t";
  const innerBorder = dark ? "border-white/10" : "border-t";
  const negColor = dark ? "text-red-300" : "text-destructive";
  const posColor = dark ? "text-emerald-400" : "text-emerald-600";
  const footerBg = dark ? "bg-white/[0.04] font-bold text-white" : "bg-muted/30 font-semibold";
  const emptyCls = dark ? "py-10 text-center text-sm text-white/80 bg-white/[0.04] border border-white/10 rounded-xl" : "py-10 text-center text-sm text-muted-foreground rounded-lg border bg-card";
  const loadCls = dark ? "flex items-center justify-center py-10 text-sm text-white/80 bg-white/[0.04] border border-white/10 rounded-xl" : "flex items-center justify-center py-10 text-sm text-muted-foreground rounded-lg border bg-card";
  const refreshBtn = dark ? "text-white hover:bg-white/10" : "";
  const displayRange = rangeStart === rangeEnd
    ? formatMarketplaceDate(rangeStart, homeMarketplace)
    : `${formatMarketplaceDate(rangeStart, homeMarketplace)} → ${formatMarketplaceDate(rangeEnd, homeMarketplace)}`;

  return (
    <section className={dark ? "py-3 space-y-3" : "container mx-auto px-4 py-6 space-y-4"}>
      <div className="flex items-center justify-between">
        <h2 className={`text-lg ${titleCls}`}>Amazon Fees & Credits Breakdown</h2>
        <Button size="sm" variant="ghost" onClick={fetchRows} disabled={loading} className={refreshBtn}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCw className="h-4 w-4" />}
        </Button>
      </div>

      {loading && rows.length === 0 ? (
        <div className={loadCls}>
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading fee breakdown…
        </div>
      ) : sections.length === 0 ? (
        <div className={emptyCls}>
          No Amazon fee or credit events for {label.toLowerCase()}.
        </div>
      ) : (
        sections.filter(({ cat }) => cat.key !== "shipping_credits").map(({ cat, items, total }) => {
          const isOpen = !!open[cat.key as string];
          const isNegativeDisplay = cat.kind === "fee" ? total !== 0 : cat.kind === "credit" ? total < 0 : false;
          const display =
            cat.kind === "fee"
              ? `−${homeCurrencySymbol}${Math.abs(total).toFixed(2)}`
              : `${total >= 0 ? "+" : "−"}${homeCurrencySymbol}${Math.abs(total).toFixed(2)}`;
          const headerAmountColor =
            isNegativeDisplay ? negColor : posColor;
          return (
            <div key={cat.key as string} className={cardBg}>
              <button
                type="button"
                onClick={() => toggle(cat.key as string)}
                className="flex w-full items-center justify-between gap-3 p-4 text-left"
              >
                <div className="flex items-center gap-2">
                  {isOpen ? (
                    <ChevronDown className={`h-4 w-4 ${dark ? "text-white/70" : ""}`} />
                  ) : (
                    <ChevronRight className={`h-4 w-4 ${dark ? "text-white/70" : ""}`} />
                  )}
                  <div>
                    <h3 className={`font-bold ${dark ? "text-white" : "font-semibold"}`}>{cat.label}</h3>
                    <p className={`text-xs ${subCls}`}>
                      {label} · {displayRange} ·{" "}
                      {items.length} event{items.length === 1 ? "" : "s"}
                    </p>
                  </div>
                </div>
                <span className={`font-mono text-sm ${headerAmountColor}`}>
                  {display}
                </span>
              </button>


              {isOpen && (
                <div className={`overflow-x-auto ${innerBorder}`}>
                  {cat.key === "shipping_paid_to_amazon_total" && (
                    <div className={`flex items-center gap-2 px-4 py-2 ${dark ? "border-b border-white/10 bg-white/[0.04]" : "border-b bg-muted/20"}`}>
                      <Search className={`h-4 w-4 ${dark ? "text-white/60" : "text-muted-foreground"}`} />
                      <input
                        value={orderSearch}
                        onChange={(e) => setOrderSearch(e.target.value)}
                        placeholder="Search order ID in this section"
                        className={`w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground ${dark ? "placeholder:text-white/50" : ""}`}
                      />
                      {orderSearch && (
                        <button type="button" onClick={() => setOrderSearch("")} className={`text-xs font-semibold ${dark ? "text-white/70" : "text-muted-foreground"}`}>
                          Clear
                        </button>
                      )}
                    </div>
                  )}
                  {cat.key === "shipping_paid_to_amazon_total" && (() => {
                    const q = orderSearch.trim().toLowerCase();
                    const filtered = pendingFbm.filter((o) => !q || [o.order_id, o.asin, o.seller_sku].some((value) => (value || "").toLowerCase().includes(q)));
                    if (filtered.length === 0) return null;
                    const pendingTotal = filtered.reduce((s, o) => s + toHomeCurrency(Number(o.shipping_label_fee || 0), o.marketplace), 0);
                    return (
                      <div className={`px-4 py-3 ${dark ? "border-b border-white/10 bg-amber-400/[0.06]" : "border-b bg-amber-50"}`}>
                        <div className="flex items-center justify-between mb-2">
                          <p className={`text-xs font-bold uppercase ${dark ? "text-amber-200" : "text-amber-800"}`}>
                            Pending FBM orders · awaiting Amazon settlement · {filtered.length} order{filtered.length === 1 ? "" : "s"}
                          </p>
                          <span className={`text-xs font-mono ${dark ? "text-amber-200/80" : "text-amber-800/80"}`}>
                            {pendingTotal > 0 ? `expected −${homeCurrencySymbol}${pendingTotal.toFixed(2)}` : "label fee not yet known"}
                          </span>
                        </div>
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs">
                            <tbody>
                              {filtered.map((o) => (
                                <tr key={o.order_id} className={dark ? "border-t border-white/10" : "border-t"}>
                                  <td className={`px-2 py-1 whitespace-nowrap ${cellCls}`}>{formatMarketplaceDate(o.order_date, o.marketplace || homeMarketplace)}</td>
                                  <td className={`px-2 py-1 font-mono ${cellCls}`}>{o.order_id}</td>
                                  <td className={`px-2 py-1 font-mono ${cellCls}`}>{o.asin || "—"}</td>
                                  <td className={`px-2 py-1 font-mono ${cellCls}`}>{o.seller_sku || "—"}</td>
                                  <td className={`px-2 py-1 ${cellCls}`}>{o.marketplace || homeMarketplace}</td>
                                  <td className="px-2 py-1">
                                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${dark ? "bg-amber-400/15 text-amber-200" : "bg-amber-100 text-amber-800"}`}>
                                      FBM · {o.status || "pending"}
                                    </span>
                                  </td>
                                  <td className={`px-2 py-1 text-right font-mono ${dark ? "text-white/70" : "text-muted-foreground"}`}>
                                    {Number(o.shipping_label_fee || 0) > 0
                                      ? `−${homeCurrencySymbol}${toHomeCurrency(Number(o.shipping_label_fee), o.marketplace).toFixed(2)} (est)`
                                      : "—"}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        <p className={`mt-2 text-[11px] ${dark ? "text-white/60" : "text-muted-foreground"}`}>
                          Not deducted in this section yet — these orders have no matching paid-shipping settlement row in the selected period.
                        </p>
                      </div>
                    );
                  })()}
                  <table className="w-full text-sm">
                    <thead className={theadCls}>
                      <tr>
                        <th className="px-4 py-2 text-left">Date</th>
                        <th className="px-4 py-2 text-left">Event</th>
                        <th className="px-4 py-2 text-left">Order</th>
                        <th className="px-4 py-2 text-left">ASIN</th>
                        <th className="px-4 py-2 text-left">Mkt</th>
                        <th className="px-4 py-2 text-left">Fulfillment</th>
                        <th className="px-4 py-2 text-right">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map(({ row, val }, idx) => {
                        const isNeg = cat.kind === "fee" ? val !== 0 : cat.kind === "credit" ? val < 0 : false;
                        const amt =
                          cat.kind === "fee"
                            ? `−${homeCurrencySymbol}${Math.abs(val).toFixed(2)}`
                            : `${val >= 0 ? "+" : "−"}${homeCurrencySymbol}${Math.abs(val).toFixed(2)}`;
                        const cellColor = isNeg ? negColor : posColor;
                        const fulfillment = fulfillmentLabel(row, cat.key);

                        return (
                          <tr key={`${row.id}-${idx}`} className={rowBorder}>
                            <td className={`px-4 py-2 whitespace-nowrap font-medium ${cellCls}`}>{formatMarketplaceDate(row.event_date, row.marketplace || homeMarketplace)}</td>
                            <td className={`px-4 py-2 text-xs font-medium ${cellCls}`}>{row.event_type || "—"}</td>
                            <td className={`px-4 py-2 font-mono text-xs font-medium ${cellCls}`}>
                              {row.amazon_order_id ? (
                                <a
                                  href={buildAmazonOrderUrl(row.amazon_order_id, row.marketplace || homeMarketplace)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className={dark ? "text-sky-300 hover:underline" : "text-primary hover:underline"}
                                >
                                  {row.amazon_order_id}
                                </a>
                              ) : (
                                "—"
                              )}
                            </td>
                            <td className={`px-4 py-2 font-mono text-xs font-medium ${cellCls}`}>{row.asin || "—"}</td>
                            <td className={`px-4 py-2 text-xs font-medium ${cellCls}`}>{row.marketplace || homeMarketplace}</td>
                            <td className="px-4 py-2 text-xs font-bold">
                              <span className={`rounded-full px-2 py-1 ${fulfillment.cls}`}>{fulfillment.text}</span>
                            </td>
                            <td className={`px-4 py-2 text-right font-mono font-bold ${cellColor}`}>
                              {amt}
                            </td>

                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot className={footerBg}>
                      <tr>
                          <td className="px-4 py-2" colSpan={6}>
                          Total
                        </td>
                        <td
                          className={`px-4 py-2 text-right font-mono font-bold ${headerAmountColor}`}
                        >
                          {display}
                        </td>

                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </div>
          );
        })
      )}
    </section>
  );
}
