/**
 * COG on Record -- one average unit cost per ASIN, set by the seller.
 *
 * ── WHY THIS PAGE EXISTS ─────────────────────────────────────────────────
 *
 * The seller's original design (stated 2026-09-14), modelled on InventoryLab:
 * keep ONE average COG per product and let COGS read it, instead of deriving a
 * cost from every Created Listings lot (total / units) and freezing it on each
 * sale. Most restocks of a product cost about the same, so one typed average
 * is both simpler to maintain and closer to how the seller thinks about cost.
 * Created Listings cost stays as purchase history, for reference.
 *
 * Rows were seeded once by migration 20260914030000 from purchase lots, using
 * the rule the seller reviewed (placeholder, inverted and outlier lots dropped;
 * last-12-months average when 10+ units were bought, else all-time). The
 * import's own figure is kept in `calculated_cost` beside the COG so an edited
 * value can always be compared with what purchase history says.
 *
 * ── APPLIED TO 2026 SALES, IMMEDIATELY ────────────────────────────────────
 *
 * Switched on in migration 20260915010000, at the seller's instruction: like
 * InventoryLab, saving a COG re-prices EVERY sale of that product dated
 * 2026-01-01 onward, at once, with no "apply from which date" prompt. 2025 is
 * never touched. The COG is written into the cost columns P&L, Sales Report,
 * Live Sales, mobile and Excel already read, so they all agree.
 *
 * Every change is logged by a database trigger into
 * asin_cog_on_record_history (who, from, to, when, how many sales re-priced).
 * The browser can read that log but cannot write or edit it.
 *
 * Clearing a COG is not offered: sales would keep the last applied cost while
 * the page showed "not set", which is exactly the kind of silent disagreement
 * this feature exists to remove.
 *
 * ── TYPES ────────────────────────────────────────────────────────────────
 *
 * src/integrations/supabase/types.ts predates this table, so queries go
 * through an untyped client and rows are typed locally. Regenerating types is
 * a repo-wide change, deliberately not bundled with this page.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Helmet } from "react-helmet-async";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import {
  AlertTriangle, Check, Copy, History, Info, Loader2, Plus, RefreshCw, RotateCcw, Search, Tag,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";

interface Calculation {
  basis?: "last_12m" | "all_time";
  avg_last_12m?: number | null;
  avg_all_time?: number | null;
  latest_lot_unit?: number | null;
  min_lot_unit?: number | null;
  max_lot_unit?: number | null;
  units_bought_all?: number | null;
  units_bought_12m?: number | null;
  lots_used?: number | null;
  first_purchase?: string | null;
  last_purchase?: string | null;
  units_sold_2026?: number | null;
  sales_unit_cost_2026?: number | null;
  flags?: string[];
}

interface CogRow {
  id: string;
  asin: string;
  title: string | null;
  unit_cost: number | null;
  source: "import" | "manual";
  needs_review: boolean;
  review_note: string | null;
  calculated_cost: number | null;
  calculation: Calculation;
  updated_at: string;
}

interface HistoryEntry {
  id: number;
  asin: string;
  action: "added" | "changed" | "cleared" | "removed";
  old_unit_cost: number | null;
  new_unit_cost: number | null;
  sales_rows_repriced: number;
  changed_by_email: string | null;
  changed_at: string;
  note: string | null;
}

type View = "all" | "review" | "unset" | "manual" | "import";
type SortKey = "sold" | "difference" | "asin" | "edited";

const PAGE_SIZE = 100;
const FETCH_CHUNK = 1000; // PostgREST's default row cap per request

const FLAG_LABELS: Record<string, { label: string; hint: string }> = {
  differs_from_sales: { label: "Differs from sales", hint: "More than 30% away from the cost your 2026 sales currently carry." },
  drift: { label: "Price moved", hint: "Your latest purchase differs from this average by more than 25%." },
  one_lot: { label: "One purchase", hint: "Calculated from a single purchase lot." },
  sold_gt_bought: { label: "History incomplete", hint: "More units sold in 2026 than purchases on record." },
};

const money = (v: number | null | undefined) =>
  v == null || Number.isNaN(Number(v)) ? "—" : `$${Number(v).toFixed(2)}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cogTable = () => (supabase as any).from("asin_cog_on_record");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const historyTable = () => (supabase as any).from("asin_cog_on_record_history");

const HISTORY_COLS = "id, asin, action, old_unit_cost, new_unit_cost, sales_rows_repriced, changed_by_email, changed_at, note";

const fmtWhen = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** Per-product change log, fetched when opened. */
function HistoryButton({ asin }: { asin: string }) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setError(null);
      const { data, error: e } = await historyTable()
        .select(HISTORY_COLS).eq("asin", asin).order("changed_at", { ascending: false }).limit(50);
      if (cancelled) return;
      if (e) setError(e.message);
      else setEntries((data ?? []) as HistoryEntry[]);
    })();
    return () => { cancelled = true; };
  }, [open, asin]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={`Change history for ${asin}`} title="Change history">
          <History className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <div className="border-b px-3 py-2 text-sm font-medium">Changes to {asin}</div>
        <div className="max-h-72 overflow-y-auto">
          {error ? (
            <p className="p-3 text-sm text-destructive">Couldn't load history: {error}</p>
          ) : entries === null ? (
            <p className="p-3 text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…</p>
          ) : entries.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">No changes since the import.</p>
          ) : (
            <ul className="divide-y">
              {entries.map((h) => (
                <li key={h.id} className="px-3 py-2 text-sm">
                  <div className="tabular-nums">
                    {h.old_unit_cost == null ? "not set" : money(h.old_unit_cost)} → <span className="font-medium">{h.new_unit_cost == null ? "not set" : money(h.new_unit_cost)}</span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {fmtWhen(h.changed_at)} · {h.sales_rows_repriced.toLocaleString()} sale{h.sales_rows_repriced === 1 ? "" : "s"} re-priced
                    {h.changed_by_email ? ` · ${h.changed_by_email}` : ""}
                  </div>
                  {h.note && <div className="text-xs text-muted-foreground mt-0.5">{h.note}</div>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** How many sales the save just re-priced, read from the log the trigger wrote. */
async function latestRepriceCount(asin: string): Promise<number | null> {
  const { data } = await historyTable()
    .select("sales_rows_repriced").eq("asin", asin).order("id", { ascending: false }).limit(1);
  const n = (data as { sales_rows_repriced: number }[] | null)?.[0]?.sales_rows_repriced;
  return typeof n === "number" ? n : null;
}

const repricedPhrase = (n: number | null) =>
  n == null ? "" : n === 0 ? " — no 2026 sales to re-price" : ` — ${n.toLocaleString()} 2026 sale${n === 1 ? "" : "s"} re-priced`;

export default function CogOnRecord() {
  const { user } = useAuth();
  const [rows, setRows] = useState<CogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [view, setView] = useState<View>("all");
  const [flag, setFlag] = useState<string>("any");
  const [sort, setSort] = useState<SortKey>("sold");
  const [page, setPage] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [newAsin, setNewAsin] = useState("");
  const [newCost, setNewCost] = useState("");
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setLoadError(null);
    try {
      const all: CogRow[] = [];
      for (let from = 0; ; from += FETCH_CHUNK) {
        const { data, error } = await cogTable()
          .select("id, asin, title, unit_cost, source, needs_review, review_note, calculated_cost, calculation, updated_at")
          .eq("user_id", user.id)
          .order("asin", { ascending: true })
          .range(from, from + FETCH_CHUNK - 1);
        if (error) throw error;
        const chunk = (data ?? []) as CogRow[];
        all.push(...chunk);
        if (chunk.length < FETCH_CHUNK) break;
      }
      setRows(all);
    } catch (e) {
      // Shown, not swallowed: an empty table must never be mistaken for
      // "no COGs on record".
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[CogOnRecord] load failed", e);
      setLoadError(msg);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => { load(); }, [load]);

  const stats = useMemo(() => ({
    total: rows.length,
    set: rows.filter((r) => r.unit_cost != null).length,
    review: rows.filter((r) => r.needs_review).length,
    unset: rows.filter((r) => r.unit_cost == null).length,
    manual: rows.filter((r) => r.source === "manual").length,
  }), [rows]);

  const filtered = useMemo(() => {
    const tokens = search.toUpperCase().split(/[\s,]+/).filter(Boolean);
    const multiAsin = tokens.length > 1 && tokens.every((t) => /^[A-Z0-9]{10}$/.test(t));
    const q = search.trim().toLowerCase();

    const out = rows.filter((r) => {
      if (view === "review" && !r.needs_review) return false;
      if (view === "unset" && r.unit_cost != null) return false;
      if (view === "manual" && r.source !== "manual") return false;
      if (view === "import" && r.source !== "import") return false;
      if (flag !== "any" && !(r.calculation?.flags ?? []).includes(flag)) return false;
      if (!q) return true;
      if (multiAsin) return tokens.includes(r.asin);
      return r.asin.toLowerCase().includes(q) || (r.title ?? "").toLowerCase().includes(q);
    });

    const soldOf = (r: CogRow) => Number(r.calculation?.units_sold_2026 ?? 0);
    const diffOf = (r: CogRow) => {
      const sales = Number(r.calculation?.sales_unit_cost_2026 ?? 0);
      const cog = Number(r.unit_cost ?? r.calculated_cost ?? 0);
      return sales > 0 && cog > 0 ? Math.abs(cog - sales) * soldOf(r) : 0;
    };

    // Anything needing attention always sorts first, whatever the chosen order.
    out.sort((a, b) => {
      const attention = Number(b.needs_review) - Number(a.needs_review);
      if (attention !== 0) return attention;
      switch (sort) {
        case "difference": return diffOf(b) - diffOf(a);
        case "asin": return a.asin.localeCompare(b.asin);
        case "edited": return b.updated_at.localeCompare(a.updated_at);
        default: return soldOf(b) - soldOf(a) || a.asin.localeCompare(b.asin);
      }
    });
    return out;
  }, [rows, search, view, flag, sort]);

  useEffect(() => { setPage(0); }, [search, view, flag, sort]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const visible = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const parseCost = (raw: string): number | null | "invalid" => {
    const s = raw.trim().replace(/^\$/, "");
    if (s === "") return null;
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0) return "invalid";
    return Math.round(n * 100) / 100;
  };

  const saveCost = async (row: CogRow, raw: string) => {
    const parsed = parseCost(raw);
    if (parsed === "invalid" || (parsed == null && row.unit_cost != null)) {
      toast.error("Enter a cost of $0 or more. A COG can be changed but not cleared, because 2026 sales already use it.");
      return;
    }
    if (parsed == null) {
      setDrafts((d) => { const n = { ...d }; delete n[row.id]; return n; });
      return;
    }
    if (parsed === row.unit_cost) {
      setDrafts((d) => { const n = { ...d }; delete n[row.id]; return n; });
      return;
    }
    setSavingId(row.id);
    // Setting a COG by hand resolves the review flag: the flag exists to say
    // "decide this yourself", and saving is that decision.
    const patch = { unit_cost: parsed, source: "manual", needs_review: false };
    const { data, error } = await cogTable()
      .update(patch)
      .eq("id", row.id)
      .select("id, asin, title, unit_cost, source, needs_review, review_note, calculated_cost, calculation, updated_at")
      .single();
    setSavingId(null);
    if (error) {
      toast.error(`Couldn't save ${row.asin}: ${error.message}`);
      return;
    }
    setRows((rs) => rs.map((r) => (r.id === row.id ? (data as CogRow) : r)));
    setDrafts((d) => { const n = { ...d }; delete n[row.id]; return n; });
    const n = await latestRepriceCount(row.asin);
    toast.success(`${row.asin}: COG set to ${money(parsed)}${repricedPhrase(n)}`);
  };

  const addProduct = async () => {
    if (!user) return;
    const asin = newAsin.trim().toUpperCase();
    if (!/^[A-Z0-9]{10}$/.test(asin)) {
      toast.error("An ASIN is 10 letters and digits, e.g. B0G4BQ42W3.");
      return;
    }
    const parsed = parseCost(newCost);
    if (parsed === "invalid" || parsed == null) {
      toast.error("Enter the COG for this product.");
      return;
    }
    const existing = rows.find((r) => r.asin === asin);
    if (existing) {
      setView("all");
      setFlag("any");
      setSearch(asin);
      toast.info(`${asin} is already on record — it's shown below to edit.`);
      return;
    }
    setAdding(true);
    // Borrow a title from purchase history or inventory so the row is
    // recognisable; the COG itself never comes from there.
    let title: string | null = null;
    const { data: cl } = await supabase
      .from("created_listings").select("title").eq("user_id", user.id).eq("asin", asin)
      .not("title", "is", null).order("created_at", { ascending: false }).limit(1);
    title = (cl as { title: string | null }[] | null)?.[0]?.title ?? null;
    if (!title) {
      const { data: inv } = await supabase
        .from("inventory").select("title").eq("user_id", user.id).eq("asin", asin)
        .not("title", "is", null).limit(1);
      title = (inv as { title: string | null }[] | null)?.[0]?.title ?? null;
    }
    const { data, error } = await cogTable()
      .insert({ user_id: user.id, asin, unit_cost: parsed, source: "manual", title })
      .select("id, asin, title, unit_cost, source, needs_review, review_note, calculated_cost, calculation, updated_at")
      .single();
    setAdding(false);
    if (error) {
      toast.error(`Couldn't add ${asin}: ${error.message}`);
      return;
    }
    setRows((rs) => [...rs, data as CogRow]);
    setNewAsin("");
    setNewCost("");
    const n = await latestRepriceCount(asin);
    toast.success(`${asin} added at ${money(parsed)}${repricedPhrase(n)}`);
  };

  const copyAsin = async (asin: string) => {
    try { await navigator.clipboard.writeText(asin); toast.success("ASIN copied"); }
    catch { toast.error("Copy failed"); }
  };

  return (
    <>
      <Helmet>
        <title>COG on Record | InventorySprint</title>
      </Helmet>
      <div className="min-h-screen flex flex-col bg-background">
        <Navbar />
        <main className="flex-1 container max-w-7xl mx-auto py-8 px-4">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div className="flex items-center gap-3">
              <Tag className="h-6 w-6 text-primary" />
              <h1 className="text-2xl font-bold">COG on Record</h1>
              {!loading && (
                <span className="text-sm text-muted-foreground">({stats.total.toLocaleString()} products)</span>
              )}
            </div>
            <Button variant="outline" size="sm" onClick={load} disabled={loading} className="gap-1.5">
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>

          <div className="mb-5 flex gap-3 rounded-lg border border-border bg-muted/40 p-3 text-sm">
            <Info className="h-4 w-4 mt-0.5 shrink-0 text-primary" />
            <div className="space-y-1">
              <p>
                One average cost per product, used as its COG. Starting values were calculated from your
                purchase lots in the <Link to="/tools/created-listings" className="underline underline-offset-2">Product Library</Link>;
                the calculated figure stays beside each COG for comparison.
              </p>
              <p className="font-medium">
                Saving a COG immediately re-prices every 2026 sale of that product in Profit &amp; Loss, Sales Report
                and Live Sales. 2025 is never changed. Every change is logged — open <History className="inline h-3.5 w-3.5 align-text-bottom" /> on a row to see it.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
            {[
              { label: "COG set", value: stats.set, onClick: () => setView("all") },
              { label: "Needs review", value: stats.review, onClick: () => setView("review"), warn: stats.review > 0 },
              { label: "No COG yet", value: stats.unset, onClick: () => setView("unset") },
              { label: "Set by you", value: stats.manual, onClick: () => setView("manual") },
            ].map((s) => (
              <button
                key={s.label}
                type="button"
                onClick={s.onClick}
                className={`rounded-lg border p-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  s.warn ? "border-amber-500/60 bg-amber-500/5" : "border-border"
                }`}
              >
                <div className="text-xs uppercase tracking-wide text-muted-foreground">{s.label}</div>
                <div className="text-2xl font-semibold tabular-nums">{loading ? "—" : s.value.toLocaleString()}</div>
              </button>
            ))}
          </div>

          <div className="mb-4 rounded-lg border border-border p-3">
            <div className="text-sm font-medium mb-2">Add a product</div>
            <div className="flex flex-col sm:flex-row gap-2">
              <Input
                placeholder="ASIN"
                value={newAsin}
                onChange={(e) => setNewAsin(e.target.value)}
                className="sm:w-48 font-mono"
                maxLength={10}
              />
              <Input
                placeholder="COG, e.g. 12.50"
                value={newCost}
                onChange={(e) => setNewCost(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") addProduct(); }}
                className="sm:w-40 tabular-nums"
                inputMode="decimal"
              />
              <Button onClick={addProduct} disabled={adding} className="gap-1.5">
                {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                Add
              </Button>
            </div>
          </div>

          <div className="flex flex-col lg:flex-row gap-2 mb-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search by ASIN or title — or paste several ASINs"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select value={view} onValueChange={(v) => setView(v as View)}>
              <SelectTrigger className="w-full lg:w-[170px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All products</SelectItem>
                <SelectItem value="review">Needs review</SelectItem>
                <SelectItem value="unset">No COG yet</SelectItem>
                <SelectItem value="manual">Set by you</SelectItem>
                <SelectItem value="import">From import</SelectItem>
              </SelectContent>
            </Select>
            <Select value={flag} onValueChange={setFlag}>
              <SelectTrigger className="w-full lg:w-[190px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Any flag</SelectItem>
                {Object.entries(FLAG_LABELS).map(([k, v]) => (
                  <SelectItem key={k} value={k}>{v.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
              <SelectTrigger className="w-full lg:w-[220px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="sold">Most sold in 2026</SelectItem>
                <SelectItem value="difference">Biggest $ gap vs sales</SelectItem>
                <SelectItem value="edited">Recently edited</SelectItem>
                <SelectItem value="asin">ASIN</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {loadError ? (
            <div className="rounded-lg border border-destructive/50 bg-destructive/5 p-4 text-sm flex gap-2">
              <AlertTriangle className="h-4 w-4 mt-0.5 text-destructive" />
              <div>
                <p className="font-medium">COGs couldn't be loaded.</p>
                <p className="text-muted-foreground">{loadError}</p>
              </div>
            </div>
          ) : loading ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground gap-2">
              <Loader2 className="h-5 w-5 animate-spin" /> Loading COGs…
            </div>
          ) : (
            <>
              <div className="text-xs text-muted-foreground mb-2 tabular-nums">
                {filtered.length.toLocaleString()} shown
                {filtered.length > PAGE_SIZE && ` · page ${page + 1} of ${pageCount}`}
              </div>
              <div className="rounded-lg border border-border overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="min-w-[280px]">Product</TableHead>
                      <TableHead className="w-[230px]">COG on record</TableHead>
                      <TableHead className="text-right">Calculated</TableHead>
                      <TableHead className="text-right">Purchases</TableHead>
                      <TableHead className="text-right">2026 sales</TableHead>
                      <TableHead>Flags</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visible.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center text-muted-foreground py-10">
                          No products match these filters.
                        </TableCell>
                      </TableRow>
                    )}
                    {visible.map((r) => {
                      const c = r.calculation ?? {};
                      const draft = drafts[r.id];
                      const shown = draft ?? (r.unit_cost == null ? "" : Number(r.unit_cost).toFixed(2));
                      const dirty = draft !== undefined && parseCost(draft) !== r.unit_cost;
                      const saving = savingId === r.id;
                      return (
                        <TableRow key={r.id} className={r.needs_review ? "bg-amber-500/5" : undefined}>
                          <TableCell className="align-top">
                            <div className="flex items-center gap-1.5">
                              <span className="font-mono text-xs">{r.asin}</span>
                              <button
                                type="button"
                                onClick={() => copyAsin(r.asin)}
                                className="text-muted-foreground hover:text-foreground"
                                aria-label={`Copy ${r.asin}`}
                              >
                                <Copy className="h-3 w-3" />
                              </button>
                              {r.needs_review && (
                                <Badge variant="outline" className="border-amber-500/70 text-amber-700 dark:text-amber-400 text-[10px]">
                                  Needs review
                                </Badge>
                              )}
                              {r.source === "manual" && !r.needs_review && (
                                <Badge variant="secondary" className="text-[10px]">Set by you</Badge>
                              )}
                            </div>
                            <div className="text-sm line-clamp-2 mt-0.5" title={r.title ?? undefined}>
                              {r.title || <span className="text-muted-foreground">Untitled</span>}
                            </div>
                            {r.needs_review && r.review_note && (
                              <div className="text-xs text-amber-700 dark:text-amber-400 mt-1">{r.review_note}</div>
                            )}
                          </TableCell>
                          <TableCell className="align-top">
                            <div className="flex items-center gap-1">
                              <div className="relative">
                                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">$</span>
                                <Input
                                  value={shown}
                                  placeholder="Not set"
                                  onChange={(e) => setDrafts((d) => ({ ...d, [r.id]: e.target.value }))}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") saveCost(r, shown);
                                    if (e.key === "Escape") setDrafts((d) => { const n = { ...d }; delete n[r.id]; return n; });
                                  }}
                                  className="h-8 w-24 pl-5 tabular-nums"
                                  inputMode="decimal"
                                  aria-label={`COG for ${r.asin}`}
                                />
                              </div>
                              {dirty && (
                                <Button size="icon" className="h-8 w-8" onClick={() => saveCost(r, shown)} disabled={saving} aria-label="Save COG">
                                  {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                                </Button>
                              )}
                              {!dirty && r.calculated_cost != null && r.unit_cost !== r.calculated_cost && (
                                <Button
                                  size="icon" variant="ghost" className="h-8 w-8"
                                  onClick={() => setDrafts((d) => ({ ...d, [r.id]: Number(r.calculated_cost).toFixed(2) }))}
                                  title={`Use the calculated ${money(r.calculated_cost)}`}
                                  aria-label="Use calculated cost"
                                >
                                  <RotateCcw className="h-3.5 w-3.5" />
                                </Button>
                              )}
                              <HistoryButton asin={r.asin} />
                            </div>
                          </TableCell>
                          <TableCell className="align-top text-right tabular-nums text-sm">
                            <div>{money(r.calculated_cost)}</div>
                            {c.basis && (
                              <div className="text-xs text-muted-foreground">
                                {c.basis === "last_12m" ? "last 12 months" : "all purchases"}
                              </div>
                            )}
                            {c.min_lot_unit != null && c.max_lot_unit != null && c.min_lot_unit !== c.max_lot_unit && (
                              <div className="text-xs text-muted-foreground">
                                {money(c.min_lot_unit)}–{money(c.max_lot_unit)}
                              </div>
                            )}
                          </TableCell>
                          <TableCell className="align-top text-right tabular-nums text-sm">
                            {c.units_bought_all != null ? (
                              <>
                                <div>{Number(c.units_bought_all).toLocaleString()} units</div>
                                <div className="text-xs text-muted-foreground">
                                  {c.lots_used} lot{c.lots_used === 1 ? "" : "s"}
                                  {c.last_purchase ? ` · last ${c.last_purchase}` : ""}
                                </div>
                                {c.latest_lot_unit != null && (
                                  <div className="text-xs text-muted-foreground">latest {money(c.latest_lot_unit)}</div>
                                )}
                              </>
                            ) : <span className="text-muted-foreground">—</span>}
                          </TableCell>
                          <TableCell className="align-top text-right tabular-nums text-sm">
                            {Number(c.units_sold_2026 ?? 0) > 0 ? (
                              <>
                                <div>{Number(c.units_sold_2026).toLocaleString()} sold</div>
                                <div className="text-xs text-muted-foreground">costed at {money(c.sales_unit_cost_2026)}</div>
                              </>
                            ) : <span className="text-muted-foreground">—</span>}
                          </TableCell>
                          <TableCell className="align-top">
                            <div className="flex flex-wrap gap-1">
                              {(c.flags ?? []).map((f) => (
                                <Badge key={f} variant="outline" className="text-[10px] font-normal" title={FLAG_LABELS[f]?.hint}>
                                  {FLAG_LABELS[f]?.label ?? f}
                                </Badge>
                              ))}
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
              {pageCount > 1 && (
                <div className="flex items-center justify-end gap-2 mt-3">
                  <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Previous</Button>
                  <span className="text-sm text-muted-foreground tabular-nums">{page + 1} / {pageCount}</span>
                  <Button variant="outline" size="sm" disabled={page >= pageCount - 1} onClick={() => setPage((p) => p + 1)}>Next</Button>
                </div>
              )}
            </>
          )}
        </main>
        <Footer />
      </div>
    </>
  );
}
