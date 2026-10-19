import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Loader2, RotateCw, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
// MARKETPLACE_CURRENCY lives in currencyConversion, NOT marketplaceCurrency --
// the latter exports MARKETPLACE_CONFIGS and getCurrencyForMarketplace instead.
// MobileLiveSales declares its own local copy, which is what misled me into
// importing from the wrong module and broke the production build at d94712d.
import { getCancelledLineUsd, MARKETPLACE_CURRENCY } from "@/lib/sales/currencyConversion";

interface CancelledRow {
  id: string;
  order_id: string | null;
  asin: string | null;
  title: string | null;
  image_url: string | null;
  marketplace: string | null;
  quantity: number | null;
  sold_price: number | null;
  total_sale_amount: number | null;
  estimated_price: number | null;
  order_status: string | null;
  is_cancelled: boolean | null;
  cancelled_at: string | null;
  order_date: string | null;
}

interface Props {
  rangeStart: string;
  rangeEnd: string;
  label: string;
  dark?: boolean;
}

export default function CancelledOrdersSection({ rangeStart, rangeEnd, label, dark }: Props) {
  const { user } = useAuth();
  const [rows, setRows] = useState<CancelledRow[]>([]);
  const [loading, setLoading] = useState(false);
  // Own FX. This component is rendered by both LiveSales and MobileLiveSales
  // and receives no converter, which is how it ended up showing a cancelled
  // MX order's native estimate as dollars.
  const [fxRates, setFxRates] = useState<Record<string, number>>({});

  const toUsd = useCallback((amount: number, mp?: string | null) => {
    const currency = MARKETPLACE_CURRENCY[String(mp || "US").trim()] || "USD";
    if (currency === "USD") return amount;
    const rate = fxRates[currency];
    return rate && rate > 0 ? amount / rate : amount;
  }, [fxRates]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from("fx_rates").select("quote, rate").eq("base", "USD");
      if (cancelled || !data) return;
      const map: Record<string, number> = {};
      for (const r of data as Array<{ quote: string; rate: number }>) {
        if (r?.quote && Number(r.rate) > 0) map[r.quote] = Number(r.rate);
      }
      setFxRates(map);
    })();
    return () => { cancelled = true; };
  }, []);

  const fetchCancelled = useCallback(async () => {
    if (!user?.id || !rangeStart || !rangeEnd) return;
    setLoading(true);
    try {
      const PAGE = 1000;
      const all: CancelledRow[] = [];
      for (let from = 0; from < 20000; from += PAGE) {
        const { data, error } = await supabase
          .from("sales_orders")
          .select(
            "id, order_id, asin, title, image_url, marketplace, quantity, sold_price, total_sale_amount, estimated_price, order_status, is_cancelled, cancelled_at, order_date",
          )
          .eq("user_id", user.id)
          .gte("order_date", rangeStart)
          .lte("order_date", rangeEnd)
          .not("order_id", "like", "%-REFUND")
          .or("is_cancelled.eq.true,order_status.eq.Canceled,order_status.eq.Cancelled")
          .order("order_date", { ascending: false })
          .range(from, from + PAGE - 1);

        if (error) {
          console.warn("[CancelledOrdersSection] fetch error:", error.message);
          break;
        }
        if (!data || data.length === 0) break;
        all.push(...(data as CancelledRow[]));
        if (data.length < PAGE) break;
      }
      // Dedupe by base order_id+asin
      const seen = new Set<string>();
      const deduped = all.filter((r) => {
        const key = `${(r.order_id || "").replace(/-REFUND(-\d+)?$/, "")}::${r.asin || ""}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      setRows(deduped);
    } finally {
      setLoading(false);
    }
  }, [user?.id, rangeStart, rangeEnd]);

  useEffect(() => {
    fetchCancelled();
  }, [fetchCancelled]);

  const totalQty = rows.length; // cancelled rows have qty zeroed; show order count as units
  // Was: Math.abs(estimated_price ?? sold_price ?? total_sale_amount) -- which
  // took the NATIVE estimate first and never converted it.
  const totalAmount = rows.reduce((s, r) => s + getCancelledLineUsd(r, toUsd), 0);

  const cardBg = dark ? "bg-white/[0.04] border border-white/10 rounded-xl" : "bg-card rounded-lg border";
  const titleCls = dark ? "text-white" : "";
  const subCls = dark ? "text-white/70" : "text-muted-foreground";
  const headerBorder = dark ? "border-white/10" : "border-b";
  const theadCls = dark ? "bg-white/[0.06] text-xs font-bold uppercase text-white/80" : "bg-muted/40 text-xs uppercase text-muted-foreground";
  const cellCls = dark ? "text-white/90" : "";
  const rowBorder = dark ? "border-white/10" : "border-t";
  const emptyCls = dark ? "py-10 text-center text-sm text-white/80" : "py-10 text-center text-sm text-muted-foreground";
  const loadCls = dark ? "flex items-center justify-center py-10 text-sm text-white/80" : "flex items-center justify-center py-10 text-sm text-muted-foreground";
  const refreshBtn = dark ? "text-white hover:bg-white/10" : "";

  return (
    <section className={dark ? "py-3" : "container mx-auto px-4 py-6"}>
      <div className={cardBg}>
        <div className={`flex flex-wrap items-center justify-between gap-3 p-4 ${headerBorder}`}>
          <div>
            <h2 className={`text-lg font-bold flex items-center gap-2 ${titleCls}`}>
              <XCircle className={`h-5 w-5 ${dark ? "text-red-400" : "text-destructive"}`} />
              Cancelled Orders
            </h2>
            <p className={`text-xs ${subCls}`}>
              {label} · {rangeStart === rangeEnd ? rangeStart : `${rangeStart} → ${rangeEnd}`} ·{" "}
              {rows.length} order{rows.length === 1 ? "" : "s"} · excluded from sales totals
            </p>
          </div>
          <Button size="sm" variant="ghost" onClick={fetchCancelled} disabled={loading} className={refreshBtn}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCw className="h-4 w-4" />}
          </Button>
        </div>

        <div className="overflow-x-auto">
          {loading && rows.length === 0 ? (
            <div className={loadCls}>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading cancelled orders…
            </div>
          ) : rows.length === 0 ? (
            <div className={emptyCls}>
              No cancelled orders for {label.toLowerCase()}.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className={theadCls}>
                <tr>
                  <th className="px-4 py-2 text-left">Date</th>
                  <th className="px-4 py-2 text-left">Product</th>
                  <th className="px-4 py-2 text-left">Order</th>
                  <th className="px-4 py-2 text-left">Mkt</th>
                  <th className="px-4 py-2 text-left">Status</th>
                  <th className="px-4 py-2 text-right">Est. Value</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const amt = Math.abs(
                    getCancelledLineUsd(r, toUsd),
                  );
                  return (
                    <tr key={r.id} className={`${rowBorder} opacity-80`}>
                      <td className={`px-4 py-2 whitespace-nowrap font-medium ${cellCls}`}>{r.order_date}</td>
                      <td className={`px-4 py-2 ${cellCls}`}>
                        <div className="flex items-center gap-2">
                          {r.image_url && (
                            <img
                              src={r.image_url}
                              alt=""
                              className="h-10 w-10 min-w-10 rounded object-cover"
                            />
                          )}
                          <div>
                            <div className="font-medium truncate max-w-[420px]">
                              {r.title || r.asin}
                            </div>
                            <div className={`text-xs ${subCls}`}>{r.asin}</div>
                          </div>
                        </div>
                      </td>
                      <td className={`px-4 py-2 font-mono text-xs ${cellCls}`}>
                        {(r.order_id || "").replace(/-REFUND(-\d+)?$/, "")}
                      </td>
                      <td className={`px-4 py-2 text-xs font-medium ${cellCls}`}>{r.marketplace || "US"}</td>
                      <td className={`px-4 py-2 text-xs ${cellCls}`}>
                        <span className={`px-1.5 py-0.5 rounded ${dark ? "bg-red-500/20 text-red-300" : "bg-destructive/20 text-destructive"}`}>
                          Cancelled
                        </span>
                      </td>
                      <td className={`px-4 py-2 text-right line-through ${subCls}`}>
                        ${amt.toFixed(2)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </section>
  );
}
