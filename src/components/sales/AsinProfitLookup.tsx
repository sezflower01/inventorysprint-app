/**
 * ASIN Profit Lookup — one ASIN, one date range, what it actually earned.
 *
 * ── WHY IT LIVES ON THE SALES REPORT AND NOT THE P&L ─────────────────────
 *
 * The P&L reads financial_events_cache, Amazon's settlement data, and those
 * rows carry no asin — verified empty for B0CKJNCZLY across all of 2026. So
 * per-ASIN profit cannot come from the P&L's source at all. It comes from
 * sales_orders, which is exactly what this page already shows, which is why
 * this sits here rather than on a page of its own.
 *
 * ── WHY THE ARITHMETIC IS NOT IN THIS FILE ───────────────────────────────
 *
 * It is in get_asin_profit() in the database, and it must stay there. Working
 * out what one ASIN earned produced four different answers on 2026-10-03, each
 * from a reasonable-looking query over the same table: -$2,369 (counted
 * -REFUND rows as sales), $119 (subtracted the gross refund from a profit whose
 * fees were already deducted), $1,370 (correct), and 4.6% ROI (the $119 figure,
 * which read as "stop buying this" for a product returning 53%).
 *
 * A component that recomputed any of that would become a fifth answer. Same
 * lesson as plModel.ts: one definition, every surface calls it.
 *
 * ── WHAT THE NUMBERS MEAN ────────────────────────────────────────────────
 *
 * Two net figures are shown, never one. A returned unit costs the FBA fee
 * Amazon keeps plus its admin retention — and the COG too, but only if the unit
 * cannot be resold. Which of those applies is a fact about the seller's
 * returns, not about the maths, so both are shown and labelled. For this
 * account the resold branch is the normal one (2 unsellable removals against 94
 * returns in 2026), and the written-off branch is the floor.
 *
 * Excluded rows are surfaced rather than hidden. Zero-priced sale rows — the
 * price-resolver fallback — are left out of the calculation because they charge
 * full fees against no revenue, and 354 ASINs carry them. A number that
 * silently dropped rows would be worse than no number.
 */
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Loader2, Search, TrendingUp, AlertTriangle } from "lucide-react";
import { toast } from "sonner";

interface AsinProfit {
  asin: string;
  units_sold: number;
  orders: number;
  revenue: number;
  fees: number;
  label_fees: number;
  cogs: number;
  gross_profit: number;
  gross_per_unit: number;
  gross_roi_pct: number;
  units_returned: number;
  return_rate_pct: number;
  return_cost: number;
  net_profit: number;
  net_per_unit: number;
  net_roi_pct: number;
  net_if_written_off: number;
  roi_if_written_off: number;
  avg_sale_price: number;
  avg_unit_cost: number;
  excluded_zero_rows: number;
  excluded_zero_fees: number;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const money = (n: number | null | undefined) =>
  n == null ? "—" : `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (n: number | null | undefined) => (n == null ? "—" : `${n.toFixed(1)}%`);

/** Presets cover the questions actually asked: this year, the quarter, the month. */
function presetRange(key: "ytd" | "90d" | "30d" | "lastmonth"): { start: string; end: string } {
  const today = new Date();
  if (key === "ytd") return { start: `${today.getFullYear()}-01-01`, end: iso(today) };
  if (key === "90d") {
    const s = new Date(today);
    s.setDate(s.getDate() - 90);
    return { start: iso(s), end: iso(today) };
  }
  if (key === "30d") {
    const s = new Date(today);
    s.setDate(s.getDate() - 30);
    return { start: iso(s), end: iso(today) };
  }
  const first = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const last = new Date(today.getFullYear(), today.getMonth(), 0);
  return { start: iso(first), end: iso(last) };
}

export default function AsinProfitLookup() {
  const [asin, setAsin] = useState("");
  const [start, setStart] = useState(presetRange("ytd").start);
  const [end, setEnd] = useState(presetRange("ytd").end);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AsinProfit | null>(null);

  const applyPreset = (key: "ytd" | "90d" | "30d" | "lastmonth") => {
    const r = presetRange(key);
    setStart(r.start);
    setEnd(r.end);
  };

  async function run() {
    const a = asin.trim().toUpperCase();
    if (!/^[A-Z0-9]{10}$/.test(a)) {
      toast.error("Enter a 10-character ASIN");
      return;
    }
    setLoading(true);
    setResult(null);
    const { data, error } = await supabase.rpc("get_asin_profit", {
      p_asin: a,
      p_start: start,
      p_end: end,
    });
    setLoading(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    const row = (Array.isArray(data) ? data[0] : data) as AsinProfit | undefined;
    if (!row || !row.units_sold) {
      setResult(row ?? null);
      toast.info(`No sales for ${a} in that range`);
      return;
    }
    setResult(row);
  }

  const roiTone = (v: number | null | undefined) =>
    v == null ? "text-muted-foreground" : v >= 40 ? "text-emerald-500" : v >= 20 ? "text-amber-500" : "text-destructive";

  return (
    <Card className="p-4 space-y-4">
      <div className="flex items-center gap-2">
        <TrendingUp className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold">ASIN profit for a period</h3>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="apl-asin" className="text-xs">ASIN</Label>
          <Input
            id="apl-asin"
            value={asin}
            onChange={(e) => setAsin(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") run(); }}
            placeholder="B0CKJNCZLY"
            className="w-40 font-mono"
            maxLength={10}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="apl-start" className="text-xs">From</Label>
          <Input id="apl-start" type="date" value={start} onChange={(e) => setStart(e.target.value)} className="w-40" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="apl-end" className="text-xs">To</Label>
          <Input id="apl-end" type="date" value={end} onChange={(e) => setEnd(e.target.value)} className="w-40" />
        </div>
        <Button onClick={run} disabled={loading} className="gap-1.5">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
          Calculate
        </Button>
        <div className="flex gap-1">
          {([["ytd", "This year"], ["90d", "90 days"], ["30d", "30 days"], ["lastmonth", "Last month"]] as const).map(
            ([k, label]) => (
              <Button key={k} variant="outline" size="sm" className="text-xs h-8" onClick={() => applyPreset(k)}>
                {label}
              </Button>
            ),
          )}
        </div>
      </div>

      {result && result.units_sold > 0 && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            <Metric label="Units sold" value={String(result.units_sold)} sub={`${result.orders} orders`} />
            <Metric label="Revenue" value={money(result.revenue)} sub={`avg ${money(result.avg_sale_price)}/unit`} />
            <Metric label="Amazon fees" value={money(-result.fees)} sub={result.label_fees > 0 ? `+ ${money(result.label_fees)} labels` : "FBA + referral"} />
            <Metric label="Cost of goods" value={money(-result.cogs)} sub={`avg ${money(result.avg_unit_cost)}/unit`} />
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm border-t pt-3">
            <Metric
              label="Gross profit"
              value={money(result.gross_profit)}
              sub={`${money(result.gross_per_unit)}/unit · ${pct(result.gross_roi_pct)} ROI`}
            />
            <Metric
              label="Returns"
              value={`${result.units_returned} units`}
              sub={`${pct(result.return_rate_pct)} · costing ${money(result.return_cost)}`}
            />
            <div>
              <div className="text-xs text-muted-foreground">Net profit</div>
              <div className={`text-lg font-bold tabular-nums ${roiTone(result.net_roi_pct)}`}>
                {money(result.net_profit)}
              </div>
              <div className="text-xs text-muted-foreground">
                {money(result.net_per_unit)}/unit · <span className={`font-semibold ${roiTone(result.net_roi_pct)}`}>{pct(result.net_roi_pct)} ROI</span>
              </div>
            </div>
            <Metric
              label="If returns unsellable"
              value={money(result.net_if_written_off)}
              sub={`${pct(result.roi_if_written_off)} ROI — the floor`}
            />
          </div>

          {result.excluded_zero_rows > 0 && (
            <div className="flex items-start gap-2 text-xs text-amber-500 border-t pt-3">
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>
                {result.excluded_zero_rows} order{result.excluded_zero_rows === 1 ? "" : "s"} excluded: recorded with no
                sale price while still charged {money(result.excluded_zero_fees)} of fees. Counting them would show this
                ASIN as less profitable than it is — they are a data fault, not a giveaway.
              </span>
            </div>
          )}

          <p className="text-xs text-muted-foreground border-t pt-3">
            A returned unit costs the FBA fee Amazon keeps plus its refund admin retention — not the refunded price,
            since the referral fee is credited back. Net profit assumes returns are restocked as sellable, which is the
            normal case here; the floor figure also writes off their cost.
          </p>
        </div>
      )}

      {result && result.units_sold === 0 && (
        <p className="text-sm text-muted-foreground">No sales recorded for that ASIN in this range.</p>
      )}
    </Card>
  );
}

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-base font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}
