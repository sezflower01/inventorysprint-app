import { useEffect, useMemo, useState, useCallback } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { functionErrorMessage } from "@/lib/amazonConnection";
import { useAuth } from "@/contexts/AuthContext";
import { Loader2, Package, RefreshCw } from "lucide-react";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  asin: string;
  productTitle: string;
  imageUrl: string | null;
  currentPrice: number | null;
  unitCost: number | null;
  /** When true, skips the Keepa-powered stability/intel call to save tokens. */
  skipKeepa?: boolean;
}

type Fees = { referralFee: number; fbaFee: number; variableClosingFee: number };
type FeesState = Fees | "loading" | "error" | null;

type ProductIntel = {
  bsr_current: number | null;
  bsr_avg_90: number | null;
  sellers_fba: number | null;
  sellers_fbm: number | null;
  amazon_buybox_pct: number | null;
  amazon_presence_pct: number | null;
  fba_fee_estimate: number | null;
  brand: string | null;
  variation_count: number | null;
  category_tree: string | null;
  product_age_days: number | null;
  est_monthly_sales: number | null;
};

type StabilityData = {
  verdict: "stable" | "moderate" | "volatile" | "unknown";
  swing_pct: number | null;
  intel?: ProductIntel | null;
  reason?: string | null;
};

type DecisionLevel = "safe" | "opportunity" | "risky" | "avoid" | "unknown";

const computeDecision = (
  stab: StabilityData | null,
  profitCtx?: { profit: number | null; roi: number | null; hasCost: boolean } | null,
): { level: DecisionLevel; label: string; emoji: string; reasons: string[] } => {
  if (!stab || !stab.intel) {
    return { level: "unknown", label: "Gathering data…", emoji: "⏳", reasons: [] };
  }
  const intel = stab.intel;
  const reasons: string[] = [];
  let avoidHits = 0, riskyHits = 0, safeHits = 0;

  if (stab.verdict === "stable") { safeHits++; reasons.push("Stable 90d price"); }
  else if (stab.verdict === "volatile") { riskyHits++; reasons.push("Volatile price swings"); }

  const amzPresence = intel.amazon_presence_pct;
  if (amzPresence != null) {
    if (amzPresence >= 70) { avoidHits++; reasons.push(`Amazon sells ${amzPresence.toFixed(0)}% of time`); }
    else if (amzPresence >= 30) { riskyHits++; reasons.push(`Amazon sells ${amzPresence.toFixed(0)}% of time`); }
    else if (amzPresence < 5) { safeHits++; reasons.push("Amazon rarely sells"); }
  }

  const totalSellers = (intel.sellers_fba ?? 0) + (intel.sellers_fbm ?? 0);
  if (intel.sellers_fba != null) {
    if (totalSellers >= 15) { riskyHits++; reasons.push(`${totalSellers} active sellers`); }
    else if (totalSellers <= 3) { safeHits++; reasons.push(`Low competition (${totalSellers} sellers)`); }
  }

  const bsr = intel.bsr_current;
  if (bsr != null) {
    if (bsr <= 10000) { safeHits++; reasons.push(`Top BSR #${bsr.toLocaleString()}`); }
    else if (bsr > 500000) { riskyHits++; reasons.push(`Slow seller (BSR #${bsr.toLocaleString()})`); }
  }

  let level: DecisionLevel;
  let label: string, emoji: string;
  if (avoidHits >= 1) { level = "avoid"; label = "Avoid"; emoji = "❌"; }
  else if (riskyHits >= 2) { level = "risky"; label = "Risky"; emoji = "⚠️"; }
  else if (safeHits >= 3 && riskyHits === 0) { level = "opportunity"; label = "Opportunity"; emoji = "🔥"; }
  else if (safeHits >= 2 && riskyHits <= 1) { level = "safe"; label = "Safe Buy"; emoji = "✅"; }
  else if (riskyHits >= 1) { level = "risky"; label = "Risky"; emoji = "⚠️"; }
  else { level = "unknown"; label = "Mixed signals"; emoji = "🤔"; }

  if (profitCtx?.hasCost && profitCtx.profit != null) {
    const p = profitCtx.profit;
    const r = profitCtx.roi ?? 0;
    if (p < 1) { level = "avoid"; label = "Avoid"; emoji = "❌"; reasons.unshift(`Profit too low ($${p.toFixed(2)})`); }
    else if (p < 2) { level = "risky"; label = "Risky"; emoji = "⚠️"; reasons.unshift(`Low profit ($${p.toFixed(2)})`); }
    else if (p < 3 || r < 25) {
      if (level === "safe" || level === "opportunity") { level = "risky"; label = "Risky"; emoji = "⚠️"; }
      reasons.unshift(`Thin margin ($${p.toFixed(2)} · ${r.toFixed(0)}% ROI)`);
    }
  }
  return { level, label, emoji, reasons: reasons.slice(0, 4) };
};

const decisionStyle: Record<DecisionLevel, string> = {
  safe: "border-emerald-400/60 text-emerald-100 bg-emerald-500/15",
  opportunity: "border-orange-400/60 text-orange-100 bg-orange-500/15",
  risky: "border-amber-400/60 text-amber-100 bg-amber-500/15",
  avoid: "border-rose-500/70 text-rose-100 bg-rose-500/20",
  unknown: "border-white/20 text-white/70 bg-white/5",
};

export function ScannerStyleRoiDialog({
  open,
  onOpenChange,
  asin,
  productTitle,
  imageUrl,
  currentPrice,
  unitCost,
  skipKeepa = false,
}: Props) {
  const { user } = useAuth();
  const [fees, setFees] = useState<FeesState>(null);
  const [stability, setStability] = useState<StabilityData | "loading" | { status: "error"; message: string } | null>(null);
  const [livePrice, setLivePrice] = useState<number | null>(currentPrice);
  const [priceLoading, setPriceLoading] = useState(false);
  const [costInput, setCostInput] = useState({
    totalCost: unitCost != null ? String(unitCost) : "",
    salePrice: "",
  });

  // Hydrate from cost memory + provided defaults whenever opened.
  useEffect(() => {
    if (!open || !asin) return;
    setLivePrice(currentPrice);
    setCostInput({
      totalCost: unitCost != null && unitCost > 0 ? String(unitCost) : "",
      salePrice: "",
    });

    // Fetch persisted memory by ASIN (matches scanner memory)
    (async () => {
      if (!user?.id) return;
      try {
        const { data } = await supabase
          .from("mobile_scan_cost_memory")
          .select("total_cost, units, sale_price_override")
          .eq("user_id", user.id)
          .eq("asin", asin.toUpperCase())
          .maybeSingle();
        if (data) {
          const tc = data.total_cost != null ? Number(data.total_cost) : null;
          const u = data.units != null ? Math.max(1, Number(data.units)) : 1;
          const cog = tc != null && u > 0 ? tc / u : null;
          setCostInput((prev) => ({
            totalCost: cog != null && cog > 0 ? String(cog) : prev.totalCost,
            // In Inventory Valuation context (skipKeepa), never hydrate persisted what-if — always start clean.
            salePrice: skipKeepa ? "" : (data.sale_price_override != null ? String(data.sale_price_override) : ""),
          }));
        }
      } catch (e) {
        console.warn("[roi-dialog] memory lookup failed", e);
      }
    })();
  }, [open, asin, user?.id, unitCost, currentPrice]);

  // Fetch fees + stability when opened
  useEffect(() => {
    if (!open || !asin) return;
    const A = asin.toUpperCase();

    (async () => {
      setFees("loading");
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) throw new Error("No session");
        const { data, error } = await supabase.functions.invoke("fetch-listing-snapshot", {
          body: { asin: A },
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        if (error) {
          // This dialog rethrows, so whatever is attached here is what the
          // outer handler shows. Without this it would be the useless
          // "non-2xx status code" even though the 409 body says exactly what
          // to do. See src/lib/amazonConnection.ts.
          throw new Error(await functionErrorMessage(error, "Could not load fees"));
        }
        const f = data?.fees;
        if (f) {
          setFees({
            referralFee: Number(f.referralFee) || 0,
            fbaFee: Number(f.fbaFee) || 0,
            variableClosingFee: Number(f.variableClosingFee) || 0,
          });
        } else {
          setFees("error");
        }
        const p = data?.price != null ? Number(data.price) : null;
        if (p && isFinite(p) && p > 0) setLivePrice(p);
      } catch {
        setFees("error");
      }
    })();

    if (skipKeepa) {
      setStability({ status: "skipped", message: "Product Intel disabled in Inventory Valuation" } as any);
      return;
    }

    (async () => {
      setStability("loading");
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) throw new Error("No session");
        const { data, error } = await supabase.functions.invoke("mobile-scan-price-stability", {
          body: { asin: A, marketplace: "US", force: false },
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        if (error) throw error;
        if (!data || data.error) throw new Error(data?.error || "stability failed");
        setStability(data as StabilityData);
      } catch (e: any) {
        setStability({ status: "error", message: e?.message || "stability failed" });
      }
    })();
  }, [open, asin, skipKeepa]);

  const refetchPrice = useCallback(async () => {
    if (!asin) return;
    setPriceLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("No session");
      const { data } = await supabase.functions.invoke("fetch-listing-snapshot", {
        body: { asin: asin.toUpperCase() },
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const p = data?.price != null ? Number(data.price) : null;
      if (p && isFinite(p) && p > 0) setLivePrice(p);
    } finally {
      setPriceLoading(false);
    }
  }, [asin]);

  // Persist cost edits to memory (debounced)
  useEffect(() => {
    if (!open || !user?.id || !asin) return;
    const t = setTimeout(async () => {
      const tc = parseFloat(costInput.totalCost);
      const sp = parseFloat(costInput.salePrice);
      const safeCost = isFinite(tc) && tc > 0 ? tc : null;
      // In Inventory Valuation (skipKeepa), the what-if sale price is throwaway — never persist it.
      const safeSale = skipKeepa ? null : (isFinite(sp) && sp > 0 ? sp : null);
      try {
        const { data: existing } = await supabase
          .from("mobile_scan_cost_memory")
          .select("id")
          .eq("user_id", user.id)
          .is("barcode", null)
          .eq("asin", asin.toUpperCase())
          .maybeSingle();
        const payload = {
          user_id: user.id,
          barcode: null as string | null,
          asin: asin.toUpperCase(),
          total_cost: safeCost,
          units: 1,
          sale_price_override: safeSale,
        };
        if (existing?.id) {
          await supabase.from("mobile_scan_cost_memory").update(payload).eq("id", existing.id);
        } else {
          await supabase.from("mobile_scan_cost_memory").insert(payload);
        }
      } catch (e) {
        console.warn("[roi-dialog] persist failed", e);
      }
    }, 600);
    return () => clearTimeout(t);
  }, [costInput.totalCost, costInput.salePrice, open, user?.id, asin, skipKeepa]);

  const effPrice = useMemo(() => {
    const m = parseFloat(costInput.salePrice || "");
    if (isFinite(m) && m > 0) return m;
    if (livePrice != null && livePrice > 0) return livePrice;
    return null;
  }, [costInput.salePrice, livePrice]);

  const result = useMemo(() => {
    const totalCostNum = parseFloat(costInput.totalCost);
    const totalFees = fees && typeof fees === "object" ? fees.referralFee + fees.fbaFee + fees.variableClosingFee : 0;
    const feesReady = typeof fees === "object" && fees !== null;
    const afterFees = effPrice != null ? effPrice - totalFees : null;
    const maxCost30 = afterFees != null && afterFees > 0 ? afterFees / 1.30 : null;
    const breakeven = afterFees;
    if (!isFinite(totalCostNum) || totalCostNum <= 0 || effPrice == null) {
      return { cog: 0, totalFees, profit: 0, roi: 0, feesReady, afterFees, breakeven, maxCost30, hasCost: false };
    }
    const cog = totalCostNum;
    const profit = effPrice - totalFees - cog;
    const roi = cog > 0 ? (profit / cog) * 100 : 0;
    return { cog, totalFees, profit, roi, feesReady, afterFees, breakeven, maxCost30, hasCost: true };
  }, [costInput.totalCost, effPrice, fees]);

  const stab = stability && typeof stability === "object" && !("status" in stability) ? (stability as StabilityData) : null;
  const intel = stab?.intel || null;
  const decision = computeDecision(stab, result ? { profit: result.profit, roi: result.roi, hasCost: !!result.hasCost } : null);
  const overrideActive = costInput.salePrice !== "" && parseFloat(costInput.salePrice) > 0;
  const priceFromAmazon = livePrice != null && livePrice > 0;
  const sourceLabel = overrideActive ? "(What-if)" : priceFromAmazon ? "(Amazon)" : "(Manual)";
  const badgeLabel = overrideActive ? "What-if price" : priceFromAmazon ? "Live from Amazon" : "Manually entered";
  const noAmazonPrice = !priceFromAmazon;

  const handleOpenChange = useCallback((next: boolean) => {
    if (!next) {
      // Auto-reset What-if price when closing the popup
      setCostInput((p) => ({ ...p, salePrice: "" }));
    }
    onOpenChange(next);
  }, [onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md p-0 border-0 bg-transparent shadow-none overflow-visible [&>button]:text-white [&>button]:opacity-100 [&>button]:hover:opacity-80 [&>button]:z-10">
        <div className="rounded-2xl bg-gradient-to-br from-[hsl(222,84%,4.9%)] via-[hsl(230,50%,10%)] to-[hsl(260,50%,8%)] text-white border border-white/10 shadow-2xl overflow-hidden max-h-[88vh] flex flex-col">
          <DialogHeader className="px-4 pt-4 pb-2 border-b border-white/10 shrink-0">
            <DialogTitle className="text-sm font-semibold text-white">Profit & ROI Calculator</DialogTitle>
          </DialogHeader>

          <div className="px-4 py-4 overflow-y-auto">
            {/* Product card */}
            <div className="rounded-2xl bg-white/[0.03] border border-white/10 p-3 mb-3">
              <div className="flex items-start gap-3">
                <div className="h-14 w-14 rounded-lg bg-white/10 overflow-hidden flex items-center justify-center shrink-0">
                  {imageUrl ? <img src={imageUrl} alt={productTitle} className="w-full h-full object-cover" /> : <Package className="h-6 w-6 text-white/40" />}
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="text-xs font-semibold text-white leading-tight line-clamp-2">{productTitle}</h3>
                  <a
                    href={`https://www.amazon.com/dp/${asin}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-blue-300 hover:text-blue-200 hover:underline mt-1 font-mono inline-block"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {asin}
                  </a>
                </div>
              </div>
            </div>

            <div className="rounded-2xl bg-white/[0.03] border border-white/10 p-4">
              <div className="text-[11px] uppercase tracking-wide text-white/50 font-semibold mb-2">Profit & ROI</div>

              {noAmazonPrice && (
                <div className="mb-2">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] text-white/50">Sale Price ($) — Amazon price unavailable</span>
                    <button type="button" onClick={refetchPrice} disabled={priceLoading} className="text-[10px] text-emerald-300 hover:text-emerald-200 inline-flex items-center gap-1">
                      <RefreshCw className={`h-3 w-3 ${priceLoading ? "animate-spin" : ""}`} /> Retry Amazon
                    </button>
                  </div>
                  <input type="number" inputMode="decimal" step="0.01" min="0" placeholder="0.00"
                    value={costInput.salePrice}
                    onChange={(e) => setCostInput((p) => ({ ...p, salePrice: e.target.value }))}
                    className="w-full h-9 px-2 rounded-lg bg-white/5 border border-amber-400/40 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-emerald-400/60" />
                </div>
              )}

              <label className="block">
                <span className="text-[10px] text-white/50">Cost per unit ($)</span>
                <input type="number" inputMode="decimal" step="0.01" min="0" placeholder="0.00"
                  value={costInput.totalCost}
                  onChange={(e) => setCostInput((p) => ({ ...p, totalCost: e.target.value }))}
                  className="mt-1 w-full h-10 px-3 rounded-lg bg-white/5 border border-white/15 text-base text-white placeholder:text-white/30 focus:outline-none focus:border-emerald-400/60" />
              </label>

              {fees === "loading" && <div className="mt-2 text-[10px] text-white/50 flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Fetching Amazon fees…</div>}
              {fees === "error" && <div className="mt-2 text-[10px] text-amber-300">Could not load Amazon fees — calculation excludes fees.</div>}

              {(effPrice != null || priceFromAmazon) && (
                <div className="mt-3 rounded-lg border border-emerald-400/30 bg-emerald-500/10 p-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-[10px] text-emerald-200/80 font-semibold uppercase tracking-wide">Sale Price {sourceLabel}</div>
                      <div className="mt-1 flex items-center gap-2">
                        <span className="text-emerald-300 font-bold">$</span>
                        <input
                          type="number" inputMode="decimal" step="0.01" min="0"
                          placeholder={priceFromAmazon ? String(livePrice?.toFixed(2)) : "0.00"}
                          value={costInput.salePrice}
                          onChange={(e) => setCostInput((p) => ({ ...p, salePrice: e.target.value }))}
                          className="w-24 h-8 px-2 rounded-md bg-white/10 border border-emerald-400/40 text-base font-bold text-emerald-200 placeholder:text-emerald-200/40 focus:outline-none focus:border-emerald-300"
                          aria-label="Sale price override"
                        />
                        {overrideActive && (
                          <button type="button" onClick={() => setCostInput((p) => ({ ...p, salePrice: "" }))} className="text-[10px] text-emerald-200/80 hover:text-emerald-100 underline">Reset</button>
                        )}
                      </div>
                      {result?.feesReady && result.afterFees != null && (
                        <div className="text-[10px] text-emerald-200/80 mt-1">
                          After fees: <span className="font-semibold text-emerald-200">${result.afterFees.toFixed(2)}</span>
                          {result.maxCost30 != null && <span className="text-white/50"> · Max cost @30% ROI: <span className="text-white/80 font-medium">${result.maxCost30.toFixed(2)}</span></span>}
                        </div>
                      )}
                    </div>
                    <Badge variant="outline" className="text-[9px] border-emerald-400/40 text-emerald-200 shrink-0">{badgeLabel}</Badge>
                  </div>
                </div>
              )}

              {stab && (
                <div className={`mt-3 rounded-lg border ${decisionStyle[decision.level]} px-3 py-2`}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-lg leading-none">{decision.emoji}</span>
                      <span className="text-sm font-bold uppercase tracking-wide">{decision.label}</span>
                    </div>
                    {intel?.est_monthly_sales != null && <span className="text-[10px] opacity-80">~{intel.est_monthly_sales}/mo sales</span>}
                  </div>
                  {decision.reasons.length > 0 && (
                    <ul className="mt-1 text-[10px] opacity-90 space-y-0.5">
                      {decision.reasons.map((r, i) => <li key={i}>• {r}</li>)}
                    </ul>
                  )}
                </div>
              )}

              {intel && (
                <details className="mt-2 rounded-lg border border-white/10 bg-white/[0.03]">
                  <summary className="cursor-pointer px-3 py-2 text-[11px] font-semibold text-white/80 flex items-center justify-between">
                    <span>📊 Product Intel</span>
                    <span className="text-[10px] text-white/50">tap to expand</span>
                  </summary>
                  <div className="px-3 pb-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10px]">
                    {intel.bsr_current != null && (
                      <div className="flex justify-between col-span-2"><span className="text-white/50">BSR</span>
                        <span className="text-white font-medium">#{intel.bsr_current.toLocaleString()}{intel.bsr_avg_90 != null && intel.bsr_avg_90 !== intel.bsr_current && <span className="text-white/40 ml-1">(90d avg #{intel.bsr_avg_90.toLocaleString()})</span>}</span>
                      </div>
                    )}
                    {(intel.sellers_fba != null || intel.sellers_fbm != null) && (
                      <div className="flex justify-between col-span-2"><span className="text-white/50">Sellers</span><span className="text-white font-medium">{intel.sellers_fba ?? 0} FBA · {intel.sellers_fbm ?? 0} FBM</span></div>
                    )}
                    {intel.amazon_presence_pct != null && (
                      <div className="flex justify-between col-span-2"><span className="text-white/50">Amazon presence</span>
                        <span className={`font-medium ${intel.amazon_presence_pct >= 50 ? "text-rose-300" : intel.amazon_presence_pct >= 20 ? "text-amber-300" : "text-emerald-300"}`}>{intel.amazon_presence_pct.toFixed(0)}% of last 90d</span>
                      </div>
                    )}
                    {intel.amazon_buybox_pct != null && <div className="flex justify-between col-span-2"><span className="text-white/50">Amazon Buy Box</span><span className="text-white font-medium">{intel.amazon_buybox_pct.toFixed(0)}% wins</span></div>}
                    {intel.fba_fee_estimate != null && <div className="flex justify-between col-span-2"><span className="text-white/50">FBA pick & pack</span><span className="text-white font-medium">${intel.fba_fee_estimate.toFixed(2)} (Keepa est.)</span></div>}
                    {intel.brand && <div className="flex justify-between col-span-2"><span className="text-white/50">Brand</span><span className="text-white font-medium truncate ml-2">{intel.brand}</span></div>}
                    {intel.variation_count != null && intel.variation_count > 0 && <div className="flex justify-between col-span-2"><span className="text-white/50">Variations</span><span className="text-white font-medium">{intel.variation_count}</span></div>}
                    {intel.product_age_days != null && (
                      <div className="flex justify-between col-span-2"><span className="text-white/50">Listed since</span>
                        <span className="text-white font-medium">{intel.product_age_days >= 365 ? `${(intel.product_age_days / 365).toFixed(1)} years` : `${intel.product_age_days} days`}</span>
                      </div>
                    )}
                    {intel.category_tree && <div className="col-span-2 mt-1 pt-1 border-t border-white/10"><span className="text-white/40 text-[9px]">{intel.category_tree}</span></div>}
                  </div>
                </details>
              )}

              {result && result.hasCost ? (
                <>
                  <div className="mt-3 grid grid-cols-3 gap-2">
                    <div className="rounded-lg bg-white/5 border border-white/10 p-2"><div className="text-[10px] text-white/50">Unit Cost</div><div className="text-sm font-semibold text-white">${result.cog.toFixed(2)}</div></div>
                    <div className="rounded-lg bg-white/5 border border-white/10 p-2"><div className="text-[10px] text-white/50">Fees</div><div className="text-sm font-semibold text-white">{result.feesReady ? `$${result.totalFees.toFixed(2)}` : "—"}</div></div>
                    <div className={`rounded-lg border p-2 ${result.profit >= 0 ? "bg-emerald-500/10 border-emerald-400/30" : "bg-red-500/10 border-red-400/30"}`}><div className="text-[10px] text-white/50">Profit</div><div className={`text-sm font-semibold ${result.profit >= 0 ? "text-emerald-300" : "text-red-300"}`}>${result.profit.toFixed(2)}</div></div>
                    <div className={`col-span-3 rounded-lg border p-2 flex items-center justify-between ${result.roi >= 0 ? "bg-emerald-500/10 border-emerald-400/30" : "bg-red-500/10 border-red-400/30"}`}>
                      <span className="text-[11px] text-white/60">ROI</span>
                      <span className={`text-base font-bold ${result.roi >= 0 ? "text-emerald-300" : "text-red-300"}`}>{result.roi.toFixed(2)}%</span>
                    </div>
                    {result.feesReady && result.breakeven != null && (
                      <div className="col-span-3 grid grid-cols-2 gap-2">
                        <div className="rounded-lg bg-white/5 border border-white/10 p-2 flex items-center justify-between"><span className="text-[10px] text-white/50">Breakeven cost</span><span className="text-xs font-semibold text-white">${result.breakeven.toFixed(2)}</span></div>
                        {result.maxCost30 != null && <div className="rounded-lg bg-white/5 border border-white/10 p-2 flex items-center justify-between"><span className="text-[10px] text-white/50">Max @30% ROI</span><span className="text-xs font-semibold text-white">${result.maxCost30.toFixed(2)}</span></div>}
                      </div>
                    )}
                  </div>
                  {result.feesReady && result.profit < 3 && result.profit >= 0 && (
                    <div className="mt-2 rounded-lg border border-amber-400/40 bg-amber-500/10 px-2 py-1.5 text-[10px] text-amber-100">⚠️ Low margin — a small price drop can wipe out profit.</div>
                  )}
                </>
              ) : (
                <div className="mt-2 text-[10px] text-white/40">
                  {result?.feesReady && result.maxCost30 != null
                    ? <>Enter cost to see profit. Aim below <span className="text-white/70 font-semibold">${result.maxCost30.toFixed(2)}</span> for 30%+ ROI.</>
                    : "Enter cost per unit to see profit and ROI."}
                </div>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
