/**
 * COG on Record -- one average unit cost per ASIN, set by the seller.
 *
 * ── WHY THIS PAGE EXISTS ─────────────────────────────────────────────────
 *
 * The seller's original design (stated 2026-09-14), modelled on InventoryLab:
 * keep ONE average COG per product and let COGS read it, instead of deriving a
 * cost from every Created Listings lot (total / units) and freezing it on each
 * sale. Created Listings cost stays as purchase history, for reference.
 *
 * COGs were seeded once by migration 20260914030000 from purchase lots, using
 * the rule the seller reviewed. The import's own figure is kept in
 * `calculated_cost` beside the COG so an edited value can always be compared.
 *
 * ── APPLIED TO 2026 SALES, IMMEDIATELY ────────────────────────────────────
 *
 * Switched on in 20260915010000, at the seller's instruction: like
 * InventoryLab, saving a COG re-prices EVERY sale of that product dated
 * 2026-01-01 onward, at once, with no "apply from which date" prompt. 2025 is
 * never touched. The COG is written into the cost columns P&L, Sales Report,
 * Live Sales, mobile and Excel already read, so they all agree.
 *
 * Every change is logged by a database trigger into
 * asin_cog_on_record_history. The browser can read that log, not write it.
 *
 * Clearing a COG is not offered: sales would keep the last applied cost while
 * the page showed "not set", which is the silent disagreement this removes.
 *
 * ── LISTED LIKE SYNCED INVENTORY, NEWEST FIRST (2026-09-15) ───────────────
 *
 * Rows come from get_cog_page_products() (20260915031000): one per product
 * with a valid Created Listing, plus products given a COG by hand -- NOT from
 * the COG table alone. The seller creates a listing and expects to find it at
 * the top here to enter its cost; 1,463 products had no COG row and so never
 * appeared while the page listed that table.
 *
 * A product with no COG shows an EMPTY cost box. It is deliberately not
 * pre-filled from the listing's cost: the seller types the average after
 * reviewing, and a pre-filled number would hide which products were actually
 * reviewed. "Use" beside the latest purchase copies that cost into the box,
 * but only saving makes it the COG. Until then the product's sales keep their
 * Created Listings cost.
 *
 * "Date created" is the newest listing's date_created (falling back to
 * created_at) -- what Synced Inventory sorts by -- parsed with the shared
 * parseListingDate so bare dates do not show as the previous day.
 *
 * ── FILLED FROM LISTINGS (2026-09-15, 20260915050000) ─────────────────────
 *
 * At the seller's request, a brand-new product's COG is now filled
 * automatically from its listing's unit cost (skipping no cost, placeholders
 * under $0.10/unit, and the unit-price-in-total mix-up). Those rows have
 * source = 'listing' and stay "Not reviewed" until the seller saves a COG or
 * presses "Mark reviewed" -- so auto-filled costs remain distinguishable from
 * checked ones, which is why the seller first wanted no auto-fill at all.
 *
 * A restock never changes an existing COG. If its unit cost differs by more
 * than 25%, the row carries price_change_* and is pinned to the top of the
 * default order with "Use" (copies the new price into the box) and "Keep"
 * (dismisses the flag). Saving any COG clears the flag too.
 *
 * ── WAITING FOR AMAZON (2026-09-15, 20260915070000) ──────────────────────
 *
 * Listings appear the moment they are saved, including PENDING_VALIDATION
 * ones, tagged "Waiting for Amazon" -- validation takes a median 21 minutes
 * and occasionally hours, and the seller wants to cost a listing straight
 * away. A cost can be typed while waiting. The AUTOMATIC fill still waits for
 * Amazon's confirmation, so a rejected listing never gets one; rejected
 * listings are not shown at all.
 *
 * ── TYPES ────────────────────────────────────────────────────────────────
 *
 * src/integrations/supabase/types.ts predates these tables and the RPC, so
 * calls go through an untyped client and rows are typed locally.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Helmet } from "react-helmet-async";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import {
  AlertTriangle, Check, Copy, History, Info, Loader2, Plus, RefreshCw, RotateCcw, Search, Tag,
} from "lucide-react";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { formatListingDate, parseListingDate } from "@/lib/listingDate";

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

/** One product, as returned by get_cog_page_products(). COG fields are null when no COG row exists. */
interface ProductRow {
  asin: string;
  title: string | null;
  image_url: string | null;
  sku: string | null;
  date_created: string | null;
  last_created_at: string | null;
  first_listed: string | null;
  listing_count: number;
  is_restock: boolean;
  latest_unit_cost: number | null;
  latest_units: number | null;
  latest_lot_date: string | null;
  cog_id: string | null;
  unit_cost: number | null;
  source: CogSource | null;
  needs_review: boolean | null;
  review_note: string | null;
  calculated_cost: number | null;
  calculation: Calculation | null;
  cog_updated_at: string | null;
  in_listings: boolean;
  reviewed_at: string | null;
  price_change_unit_cost: number | null;
  price_change_units: number | null;
  price_change_detected_at: string | null;
  /** The product's newest listing is saved but Amazon has not confirmed it yet. */
  awaiting_amazon: boolean;
  pending_listing_count: number;
}

type CogSource = "import" | "manual" | "listing";

/** The COG table's columns, as returned by insert/update. */
interface CogRecord {
  id: string;
  unit_cost: number | null;
  source: CogSource;
  needs_review: boolean;
  review_note: string | null;
  calculated_cost: number | null;
  calculation: Calculation;
  updated_at: string;
  title: string | null;
  reviewed_at: string | null;
  price_change_unit_cost: number | null;
  price_change_units: number | null;
  price_change_detected_at: string | null;
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

type View = "all" | "unset" | "has" | "not_reviewed" | "price_changed" | "waiting" | "review" | "manual" | "recent";
type SortKey = "newest" | "oldest" | "review" | "sold" | "difference" | "edited" | "asin";

const PAGE_SIZE = 100;
const FETCH_CHUNK = 1000; // PostgREST's default row cap per request
/** New / Restock tags only mean something for recent listings. */
const RECENT_DAYS = 30;

const FLAG_LABELS: Record<string, { label: string; hint: string }> = {
  differs_from_sales: { label: "Differs from sales", hint: "More than 30% away from the cost your 2026 sales carried before COG on Record." },
  drift: { label: "Price moved", hint: "Your latest purchase differs from the calculated average by more than 25%." },
  one_lot: { label: "One purchase", hint: "Calculated from a single purchase lot." },
  sold_gt_bought: { label: "History incomplete", hint: "More units sold in 2026 than purchases on record." },
};

const COG_COLS = "id, unit_cost, source, needs_review, review_note, calculated_cost, calculation, updated_at, title, "
  + "reviewed_at, price_change_unit_cost, price_change_units, price_change_detected_at";

/** Filled automatically from a listing and not yet confirmed by the seller. */
const isNotReviewed = (r: { source: CogSource | null; reviewed_at: string | null; unit_cost: number | null }) =>
  r.source === "listing" && !r.reviewed_at && r.unit_cost != null;
const hasPriceChange = (r: { price_change_unit_cost: number | null }) => r.price_change_unit_cost != null;

const pctChange = (from: number | null, to: number | null) =>
  from && to != null ? Math.round(((to - from) / from) * 100) : null;
const HISTORY_COLS = "id, asin, action, old_unit_cost, new_unit_cost, sales_rows_repriced, changed_by_email, changed_at, note";

const money = (v: number | null | undefined) =>
  v == null || Number.isNaN(Number(v)) ? "—" : `$${Number(v).toFixed(2)}`;

const fmtWhen = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;
const cogTable = () => db.from("asin_cog_on_record");
const historyTable = () => db.from("asin_cog_on_record_history");

const recentCutoff = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - RECENT_DAYS);
  return d.getTime();
};

/** Merge a saved COG record back into its product row. */
const withCog = (row: ProductRow, c: CogRecord): ProductRow => ({
  ...row,
  cog_id: c.id,
  unit_cost: c.unit_cost,
  source: c.source,
  needs_review: c.needs_review,
  review_note: c.review_note,
  calculated_cost: c.calculated_cost,
  calculation: c.calculation,
  cog_updated_at: c.updated_at,
  title: row.title ?? c.title,
  reviewed_at: c.reviewed_at,
  price_change_unit_cost: c.price_change_unit_cost,
  price_change_units: c.price_change_units,
  price_change_detected_at: c.price_change_detected_at,
});

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
            <p className="p-3 text-sm text-muted-foreground">No changes recorded.</p>
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
  const [rows, setRows] = useState<ProductRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [view, setView] = useState<View>("all");
  const [flag, setFlag] = useState<string>("any");
  const [sort, setSort] = useState<SortKey>("newest");
  const [page, setPage] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingAsin, setSavingAsin] = useState<string | null>(null);
  const [newAsin, setNewAsin] = useState("");
  const [newCost, setNewCost] = useState("");
  const [adding, setAdding] = useState(false);

  const lastLoadedAt = useRef(0);
  const inFlight = useRef(false);

  /**
   * Fetch every product. `silent` keeps the current table on screen while it
   * reloads -- used when the tab regains focus, so a returning seller does not
   * see the table blank out, and a failure is a toast rather than an error
   * panel replacing rows that are still valid.
   */
  const load = useCallback(async (silent = false) => {
    if (!user || inFlight.current) return;
    inFlight.current = true;
    if (!silent) {
      setLoading(true);
      setLoadError(null);
    }
    try {
      const all: ProductRow[] = [];
      for (let from = 0; ; from += FETCH_CHUNK) {
        const { data, error } = await db.rpc("get_cog_page_products").range(from, from + FETCH_CHUNK - 1);
        if (error) throw error;
        const chunk = (data ?? []) as ProductRow[];
        all.push(...chunk);
        if (chunk.length < FETCH_CHUNK) break;
      }
      setRows(all);
      lastLoadedAt.current = Date.now();
    } catch (e) {
      // Shown, not swallowed: an empty table must never be mistaken for
      // "no products".
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[CogOnRecord] load failed", e);
      if (silent) toast.error(`Couldn't refresh products: ${msg}`);
      else setLoadError(msg);
    } finally {
      inFlight.current = false;
      if (!silent) setLoading(false);
    }
  }, [user]);

  useEffect(() => { load(); }, [load]);

  // Refresh when the seller comes back to this tab.
  //
  // The workflow this page serves is "create a listing elsewhere, return here,
  // enter its cost". The list loaded once on open, so a listing created after
  // that stayed missing until a manual refresh -- reported 2026-09-15 for
  // B01A0LTJBO, which the database already returned second from the top.
  // Drafts are separate state keyed by ASIN, so typed-but-unsaved costs
  // survive the reload. Throttled so flicking between tabs is not a query each
  // time.
  useEffect(() => {
    const MIN_GAP_MS = 20_000;
    const onReturn = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastLoadedAt.current < MIN_GAP_MS) return;
      load(true);
    };
    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener("focus", onReturn);
    return () => {
      document.removeEventListener("visibilitychange", onReturn);
      window.removeEventListener("focus", onReturn);
    };
  }, [load]);

  const cutoff = useMemo(recentCutoff, [rows]);
  const isRecent = useCallback(
    (r: ProductRow) => (parseListingDate(r.date_created)?.getTime() ?? 0) >= cutoff,
    [cutoff],
  );

  const stats = useMemo(() => ({
    total: rows.length,
    unset: rows.filter((r) => r.unit_cost == null).length,
    review: rows.filter((r) => r.needs_review).length,
    recent: rows.filter(isRecent).length,
    recentUnset: rows.filter((r) => isRecent(r) && r.unit_cost == null).length,
    manual: rows.filter((r) => r.source === "manual").length,
    notReviewed: rows.filter(isNotReviewed).length,
    priceChanged: rows.filter(hasPriceChange).length,
    waiting: rows.filter((r) => r.awaiting_amazon).length,
  }), [rows, isRecent]);

  const filtered = useMemo(() => {
    const tokens = search.toUpperCase().split(/[\s,]+/).filter(Boolean);
    const multiAsin = tokens.length > 1 && tokens.every((t) => /^[A-Z0-9]{10}$/.test(t));
    const q = search.trim().toLowerCase();

    const out = rows.filter((r) => {
      if (view === "unset" && r.unit_cost != null) return false;
      if (view === "has" && r.unit_cost == null) return false;
      if (view === "review" && !r.needs_review) return false;
      if (view === "manual" && r.source !== "manual") return false;
      if (view === "recent" && !isRecent(r)) return false;
      if (view === "not_reviewed" && !isNotReviewed(r)) return false;
      if (view === "price_changed" && !hasPriceChange(r)) return false;
      if (view === "waiting" && !r.awaiting_amazon) return false;
      if (flag !== "any" && !(r.calculation?.flags ?? []).includes(flag)) return false;
      if (!q) return true;
      if (multiAsin) return tokens.includes(r.asin);
      return r.asin.toLowerCase().includes(q)
        || (r.title ?? "").toLowerCase().includes(q)
        || (r.sku ?? "").toLowerCase().includes(q);
    });

    const dateOf = (r: ProductRow) => parseListingDate(r.date_created)?.getTime() ?? null;
    const createdOf = (r: ProductRow) => (r.last_created_at ? Date.parse(r.last_created_at) : 0);
    const soldOf = (r: ProductRow) => Number(r.calculation?.units_sold_2026 ?? 0);
    const diffOf = (r: ProductRow) => {
      const sales = Number(r.calculation?.sales_unit_cost_2026 ?? 0);
      const cog = Number(r.unit_cost ?? r.calculated_cost ?? 0);
      return sales > 0 && cog > 0 ? Math.abs(cog - sales) * soldOf(r) : 0;
    };
    // Newest first, with undated products (COG added by hand, no listing)
    // always last in either direction.
    const byDate = (a: ProductRow, b: ProductRow, dir: 1 | -1) => {
      const da = dateOf(a);
      const dbb = dateOf(b);
      if (da == null || dbb == null) return (da == null ? 1 : 0) - (dbb == null ? 1 : 0);
      return dir * (da - dbb) || dir * (createdOf(a) - createdOf(b)) || a.asin.localeCompare(b.asin);
    };

    out.sort((a, b) => {
      switch (sort) {
        case "oldest": return byDate(a, b, 1);
        case "review":
          return Number(!!b.needs_review) - Number(!!a.needs_review)
            || Number(a.unit_cost != null) - Number(b.unit_cost != null)
            || byDate(a, b, -1);
        case "sold": return soldOf(b) - soldOf(a) || a.asin.localeCompare(b.asin);
        case "difference": return diffOf(b) - diffOf(a);
        case "edited": return (b.cog_updated_at ?? "").localeCompare(a.cog_updated_at ?? "");
        case "asin": return a.asin.localeCompare(b.asin);
        default:
          // A restock whose price moved >25% is pinned above everything, most
          // recent first -- the seller asked for these at the top.
          return Number(hasPriceChange(b)) - Number(hasPriceChange(a))
            || (b.price_change_detected_at ?? "").localeCompare(a.price_change_detected_at ?? "")
            || byDate(a, b, -1);
      }
    });
    return out;
  }, [rows, search, view, flag, sort, isRecent]);

  useEffect(() => { setPage(0); }, [search, view, flag, sort]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const visible = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const clearDraft = (asin: string) =>
    setDrafts((d) => { const n = { ...d }; delete n[asin]; return n; });

  const parseCost = (raw: string): number | null | "invalid" => {
    const s = raw.trim().replace(/^\$/, "");
    if (s === "") return null;
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0) return "invalid";
    return Math.round(n * 100) / 100;
  };

  const saveCost = async (row: ProductRow, raw: string) => {
    if (!user) return;
    const parsed = parseCost(raw);
    if (parsed === "invalid" || (parsed == null && row.unit_cost != null)) {
      toast.error("Enter a cost of $0 or more. A COG can be changed but not cleared, because 2026 sales already use it.");
      return;
    }
    if (parsed == null || parsed === row.unit_cost) {
      clearDraft(row.asin);
      return;
    }
    setSavingAsin(row.asin);
    // A product without a COG row gets one; one that has a row is updated.
    // Either way the database trigger re-prices its 2026 sales and logs it.
    // Saving by hand resolves every flag -- review, not-reviewed and price
    // change -- because saving IS the decision.
    const now = new Date().toISOString();
    const { data, error } = row.cog_id
      ? await cogTable()
          .update({
            unit_cost: parsed, source: "manual", needs_review: false, reviewed_at: now,
            price_change_unit_cost: null, price_change_units: null,
            price_change_listing_id: null, price_change_detected_at: null,
          })
          .eq("id", row.cog_id).select(COG_COLS).single()
      : await cogTable()
          .insert({ user_id: user.id, asin: row.asin, unit_cost: parsed, source: "manual", title: row.title, reviewed_at: now })
          .select(COG_COLS).single();
    setSavingAsin(null);
    if (error) {
      toast.error(`Couldn't save ${row.asin}: ${error.message}`);
      return;
    }
    setRows((rs) => rs.map((r) => (r.asin === row.asin ? withCog(r, data as CogRecord) : r)));
    clearDraft(row.asin);
    const n = await latestRepriceCount(row.asin);
    toast.success(`${row.asin}: COG ${row.cog_id ? "set" : "added"} at ${money(parsed)}${repricedPhrase(n)}`);
  };

  /**
   * Confirm an automatically filled COG without changing it, or keep the
   * current COG after a price change. Neither touches unit_cost, so no sales
   * are re-priced and nothing is added to the change log.
   */
  const updateFlags = async (row: ProductRow, patch: Record<string, unknown>, done: string) => {
    if (!row.cog_id) return;
    setSavingAsin(row.asin);
    const { data, error } = await cogTable().update(patch).eq("id", row.cog_id).select(COG_COLS).single();
    setSavingAsin(null);
    if (error) {
      toast.error(`Couldn't update ${row.asin}: ${error.message}`);
      return;
    }
    setRows((rs) => rs.map((r) => (r.asin === row.asin ? withCog(r, data as CogRecord) : r)));
    toast.success(done);
  };

  const markReviewed = (row: ProductRow) =>
    updateFlags(row, { reviewed_at: new Date().toISOString() }, `${row.asin}: marked reviewed at ${money(row.unit_cost)}`);

  const keepCurrent = (row: ProductRow) =>
    updateFlags(
      row,
      { price_change_unit_cost: null, price_change_units: null, price_change_listing_id: null, price_change_detected_at: null },
      `${row.asin}: kept COG at ${money(row.unit_cost)}`,
    );

  /** For a product with no listing on record -- everything listed already has a row. */
  const addProduct = async () => {
    if (!user) return;
    const asin = newAsin.trim().toUpperCase();
    if (!/^[A-Z0-9]{10}$/.test(asin)) {
      toast.error("An ASIN is 10 letters and digits, e.g. B0G4BQ42W3.");
      return;
    }
    const existing = rows.find((r) => r.asin === asin);
    if (existing) {
      setView("all");
      setFlag("any");
      setSearch(asin);
      toast.info(`${asin} is already listed below — enter its COG there.`);
      return;
    }
    const parsed = parseCost(newCost);
    if (parsed === "invalid" || parsed == null) {
      toast.error("Enter the COG for this product.");
      return;
    }
    setAdding(true);
    const { data: inv } = await supabase
      .from("inventory").select("title, image_url").eq("user_id", user.id).eq("asin", asin)
      .not("title", "is", null).limit(1);
    const invRow = (inv as { title: string | null; image_url: string | null }[] | null)?.[0];
    const { data, error } = await cogTable()
      .insert({ user_id: user.id, asin, unit_cost: parsed, source: "manual", title: invRow?.title ?? null, reviewed_at: new Date().toISOString() })
      .select(COG_COLS).single();
    setAdding(false);
    if (error) {
      toast.error(`Couldn't add ${asin}: ${error.message}`);
      return;
    }
    const blank: ProductRow = {
      asin, title: invRow?.title ?? null, image_url: invRow?.image_url ?? null, sku: null,
      date_created: null, last_created_at: null, first_listed: null, listing_count: 0, is_restock: false,
      latest_unit_cost: null, latest_units: null, latest_lot_date: null,
      cog_id: null, unit_cost: null, source: null, needs_review: null, review_note: null,
      calculated_cost: null, calculation: null, cog_updated_at: null, in_listings: false,
      reviewed_at: null, price_change_unit_cost: null, price_change_units: null, price_change_detected_at: null,
      awaiting_amazon: false, pending_listing_count: 0,
    };
    setRows((rs) => [...rs, withCog(blank, data as CogRecord)]);
    setNewAsin("");
    setNewCost("");
    const n = await latestRepriceCount(asin);
    toast.success(`${asin} added at ${money(parsed)}${repricedPhrase(n)}`);
  };

  const copyAsin = async (asin: string) => {
    try { await navigator.clipboard.writeText(asin); toast.success("ASIN copied"); }
    catch { toast.error("Copy failed"); }
  };

  const tiles: { label: string; value: number; view: View; hint?: string; warn?: boolean }[] = [
    { label: "Price changed", value: stats.priceChanged, view: "price_changed", warn: stats.priceChanged > 0,
      hint: stats.priceChanged > 0 ? "restocks >25% from your COG" : undefined },
    { label: "Not reviewed", value: stats.notReviewed, view: "not_reviewed", warn: stats.notReviewed > 0,
      hint: stats.notReviewed > 0 ? "filled from listings" : undefined },
    { label: "No COG yet", value: stats.unset, view: "unset", warn: stats.recentUnset > 0,
      hint: stats.recentUnset > 0 ? `${stats.recentUnset} listed in the last ${RECENT_DAYS} days` : undefined },
    { label: `Listed last ${RECENT_DAYS} days`, value: stats.recent, view: "recent",
      hint: stats.waiting > 0 ? `${stats.waiting} waiting for Amazon` : undefined },
  ];

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
            <Button variant="outline" size="sm" onClick={() => load()} disabled={loading} className="gap-1.5">
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>

          <div className="mb-5 flex gap-3 rounded-lg border border-border bg-muted/40 p-3 text-sm">
            <Info className="h-4 w-4 mt-0.5 shrink-0 text-primary" />
            <div className="space-y-1">
              <p>
                Every product in your <Link to="/tools/created-listings" className="underline underline-offset-2">Product Library</Link>,
                newest listing first — new listings show as soon as you save them, marked
                <span className="font-medium"> Waiting for Amazon</span> until Amazon confirms. Once confirmed, a new product's COG is
                filled from its listing's unit cost and marked <span className="font-medium">From listing</span> until you review it. Restocks never change your COG — a purchase
                more than 25% away is flagged <span className="font-medium">Price changed</span> at the top.
              </p>
              <p className="font-medium">
                Saving a COG immediately re-prices every 2026 sale of that product in Profit &amp; Loss, Sales Report
                and Live Sales. 2025 is never changed. Every change is logged — open <History className="inline h-3.5 w-3.5 align-text-bottom" /> on a row to see it.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
            {tiles.map((s) => (
              <button
                key={s.label}
                type="button"
                onClick={() => setView(view === s.view ? "all" : s.view)}
                aria-pressed={view === s.view}
                className={`rounded-lg border p-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  view === s.view ? "border-primary ring-1 ring-primary" : s.warn ? "border-amber-500/60 bg-amber-500/5" : "border-border"
                }`}
              >
                <div className="text-xs uppercase tracking-wide text-muted-foreground">{s.label}</div>
                <div className="text-2xl font-semibold tabular-nums">{loading ? "—" : s.value.toLocaleString()}</div>
                {s.hint && !loading && <div className="text-xs text-amber-700 dark:text-amber-400">{s.hint}</div>}
              </button>
            ))}
          </div>

          <div className="flex flex-col lg:flex-row gap-2 mb-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search by ASIN, title or SKU — or paste several ASINs"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select value={view} onValueChange={(v) => setView(v as View)}>
              <SelectTrigger className="w-full lg:w-[180px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All products</SelectItem>
                <SelectItem value="price_changed">Price changed</SelectItem>
                <SelectItem value="not_reviewed">Not reviewed (from listing)</SelectItem>
                <SelectItem value="waiting">Waiting for Amazon</SelectItem>
                <SelectItem value="unset">No COG yet</SelectItem>
                <SelectItem value="has">Has a COG</SelectItem>
                <SelectItem value="recent">Listed last {RECENT_DAYS} days</SelectItem>
                <SelectItem value="review">Needs review</SelectItem>
                <SelectItem value="manual">Set by you</SelectItem>
              </SelectContent>
            </Select>
            <Select value={flag} onValueChange={setFlag}>
              <SelectTrigger className="w-full lg:w-[180px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Any flag</SelectItem>
                {Object.entries(FLAG_LABELS).map(([k, v]) => (
                  <SelectItem key={k} value={k}>{v.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
              <SelectTrigger className="w-full lg:w-[210px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="newest">Date created: newest</SelectItem>
                <SelectItem value="oldest">Date created: oldest</SelectItem>
                <SelectItem value="review">Needs review first</SelectItem>
                <SelectItem value="sold">Most sold in 2026</SelectItem>
                <SelectItem value="difference">Biggest $ gap vs sales</SelectItem>
                <SelectItem value="edited">Recently edited</SelectItem>
                <SelectItem value="asin">ASIN</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <details className="mb-4 rounded-lg border border-border px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium">Add a product that isn't listed</summary>
            <div className="flex flex-col sm:flex-row gap-2 pt-2">
              <Input placeholder="ASIN" value={newAsin} onChange={(e) => setNewAsin(e.target.value)} className="sm:w-48 font-mono" maxLength={10} />
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
          </details>

          {loadError ? (
            <div className="rounded-lg border border-destructive/50 bg-destructive/5 p-4 text-sm flex gap-2">
              <AlertTriangle className="h-4 w-4 mt-0.5 text-destructive" />
              <div>
                <p className="font-medium">Products couldn't be loaded.</p>
                <p className="text-muted-foreground">{loadError}</p>
              </div>
            </div>
          ) : loading ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground gap-2">
              <Loader2 className="h-5 w-5 animate-spin" /> Loading products…
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
                      <TableHead className="w-[64px]">Image</TableHead>
                      <TableHead className="min-w-[260px]">Product</TableHead>
                      <TableHead className="whitespace-nowrap">Date created</TableHead>
                      <TableHead className="w-[230px]">COG on record</TableHead>
                      <TableHead className="text-right whitespace-nowrap">Latest purchase</TableHead>
                      <TableHead className="text-right">Calculated</TableHead>
                      <TableHead className="text-right whitespace-nowrap">2026 sales</TableHead>
                      <TableHead>Flags</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visible.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={8} className="text-center text-muted-foreground py-10">
                          No products match these filters.
                        </TableCell>
                      </TableRow>
                    )}
                    {visible.map((r) => {
                      const c = r.calculation ?? {};
                      const draft = drafts[r.asin];
                      const shown = draft ?? (r.unit_cost == null ? "" : Number(r.unit_cost).toFixed(2));
                      const parsedDraft = draft === undefined ? undefined : parseCost(draft);
                      const dirty = draft !== undefined && parsedDraft !== r.unit_cost && !(parsedDraft == null && r.unit_cost == null);
                      const saving = savingAsin === r.asin;
                      const recent = isRecent(r);
                      const created = formatListingDate(r.date_created);
                      const firstListed = r.is_restock ? formatListingDate(r.first_listed) : null;
                      return (
                        <TableRow key={r.asin} className={r.needs_review ? "bg-amber-500/5" : undefined}>
                          <TableCell className="align-top">
                            {r.image_url ? (
                              <img src={r.image_url} alt="" loading="lazy" className="w-12 h-12 object-cover rounded" />
                            ) : (
                              <div className="w-12 h-12 bg-muted rounded flex items-center justify-center text-[10px] text-muted-foreground text-center">
                                No Image
                              </div>
                            )}
                          </TableCell>
                          <TableCell className="align-top">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="font-mono text-xs">{r.asin}</span>
                              <button
                                type="button"
                                onClick={() => copyAsin(r.asin)}
                                className="text-muted-foreground hover:text-foreground"
                                aria-label={`Copy ${r.asin}`}
                              >
                                <Copy className="h-3 w-3" />
                              </button>
                              {r.awaiting_amazon && (
                                <Badge
                                  variant="outline"
                                  className="text-[10px] border-slate-400 text-slate-600 dark:text-slate-300 border-dashed"
                                  title="Saved, but Amazon hasn't confirmed this listing yet (usually about 20 minutes). You can enter a cost now; the automatic cost only fills in once Amazon confirms."
                                >
                                  Waiting for Amazon
                                </Badge>
                              )}
                              {recent && (
                                r.is_restock ? (
                                  <Badge variant="outline" className="text-[10px] border-sky-500/60 text-sky-700 dark:text-sky-400" title="A new purchase of a product you already had">
                                    Restock
                                  </Badge>
                                ) : (
                                  <Badge className="text-[10px] bg-emerald-600 hover:bg-emerald-600 text-white" title="First listing for this product">
                                    New
                                  </Badge>
                                )
                              )}
                              {r.needs_review && (
                                <Badge variant="outline" className="border-amber-500/70 text-amber-700 dark:text-amber-400 text-[10px]">
                                  Needs review
                                </Badge>
                              )}
                              {r.source === "manual" && !r.needs_review && (
                                <Badge variant="secondary" className="text-[10px]">Set by you</Badge>
                              )}
                              {r.source === "listing" && (
                                <Badge variant="outline" className="text-[10px]" title="COG filled automatically from the listing's unit cost">
                                  From listing{isNotReviewed(r) ? " · not reviewed" : ""}
                                </Badge>
                              )}
                              {hasPriceChange(r) && (
                                <Badge className="text-[10px] bg-orange-600 hover:bg-orange-600 text-white" title="A restock more than 25% away from your COG">
                                  Price changed
                                </Badge>
                              )}
                            </div>
                            <div className="text-sm line-clamp-2 mt-0.5" title={r.title ?? undefined}>
                              {r.title || <span className="text-muted-foreground">Untitled</span>}
                            </div>
                            {r.sku && <div className="text-xs text-muted-foreground font-mono mt-0.5">{r.sku}</div>}
                            {r.needs_review && r.review_note && (
                              <div className="text-xs text-amber-700 dark:text-amber-400 mt-1">{r.review_note}</div>
                            )}
                          </TableCell>
                          <TableCell className="align-top text-xs whitespace-nowrap tabular-nums">
                            {created ? (
                              <>
                                <div className="text-sm">{created}</div>
                                {firstListed && <div className="text-muted-foreground">first {firstListed}</div>}
                                {r.listing_count > 1 && <div className="text-muted-foreground">{r.listing_count} listings</div>}
                              </>
                            ) : <span className="text-muted-foreground">Not listed</span>}
                          </TableCell>
                          <TableCell className="align-top">
                            <div className="flex items-center gap-1">
                              <div className="relative">
                                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">$</span>
                                <Input
                                  value={shown}
                                  placeholder="Not set"
                                  onChange={(e) => setDrafts((d) => ({ ...d, [r.asin]: e.target.value }))}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") saveCost(r, shown);
                                    if (e.key === "Escape") clearDraft(r.asin);
                                  }}
                                  className={`h-8 w-24 pl-5 tabular-nums ${r.unit_cost == null && draft === undefined ? "border-dashed" : ""}`}
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
                                  onClick={() => setDrafts((d) => ({ ...d, [r.asin]: Number(r.calculated_cost).toFixed(2) }))}
                                  title={`Use the calculated ${money(r.calculated_cost)}`}
                                  aria-label="Use calculated cost"
                                >
                                  <RotateCcw className="h-3.5 w-3.5" />
                                </Button>
                              )}
                              {r.cog_id && <HistoryButton asin={r.asin} />}
                            </div>
                            {isNotReviewed(r) && !dirty && !hasPriceChange(r) && (
                              <Button
                                size="sm" variant="outline" className="mt-1.5 h-7 px-2 text-xs gap-1"
                                onClick={() => markReviewed(r)} disabled={saving}
                                title="Confirm this cost from the listing without changing it"
                              >
                                <Check className="h-3 w-3" /> Mark reviewed
                              </Button>
                            )}
                            {hasPriceChange(r) && (
                              <div className="mt-1.5 rounded-md border border-orange-500/50 bg-orange-500/5 px-2 py-1.5 text-xs">
                                <div className="tabular-nums">
                                  New purchase <span className="font-medium">{money(r.price_change_unit_cost)}</span>
                                  {pctChange(r.unit_cost, r.price_change_unit_cost) != null && (
                                    <> ({(pctChange(r.unit_cost, r.price_change_unit_cost) ?? 0) > 0 ? "+" : ""}{pctChange(r.unit_cost, r.price_change_unit_cost)}%)</>
                                  )}
                                  {r.price_change_units != null && <span className="text-muted-foreground"> · {Number(r.price_change_units).toLocaleString()} units</span>}
                                </div>
                                <div className="mt-1 flex gap-1">
                                  <Button
                                    size="sm" className="h-6 px-2 text-xs"
                                    onClick={() => setDrafts((d) => ({ ...d, [r.asin]: Number(r.price_change_unit_cost).toFixed(2) }))}
                                    disabled={saving}
                                    title="Copy the new price into the COG box — press ✓ to save it"
                                  >
                                    Use {money(r.price_change_unit_cost)}
                                  </Button>
                                  <Button
                                    size="sm" variant="ghost" className="h-6 px-2 text-xs"
                                    onClick={() => keepCurrent(r)} disabled={saving}
                                    title="Keep your COG and dismiss this flag"
                                  >
                                    Keep {money(r.unit_cost)}
                                  </Button>
                                </div>
                              </div>
                            )}
                          </TableCell>
                          <TableCell className="align-top text-right tabular-nums text-sm">
                            {r.latest_unit_cost != null ? (
                              <>
                                <div className="flex items-center justify-end gap-1">
                                  <span>{money(r.latest_unit_cost)}</span>
                                  {r.unit_cost !== r.latest_unit_cost && (
                                    <Button
                                      size="sm" variant="ghost" className="h-6 px-1.5 text-xs"
                                      onClick={() => setDrafts((d) => ({ ...d, [r.asin]: Number(r.latest_unit_cost).toFixed(2) }))}
                                      title="Copy into the COG box — nothing is saved until you press ✓"
                                    >
                                      Use
                                    </Button>
                                  )}
                                </div>
                                <div className="text-xs text-muted-foreground">
                                  {Number(r.latest_units).toLocaleString()} unit{Number(r.latest_units) === 1 ? "" : "s"}
                                  {r.latest_lot_date ? ` · ${formatListingDate(r.latest_lot_date)}` : ""}
                                </div>
                              </>
                            ) : <span className="text-muted-foreground">—</span>}
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
                            {Number(c.units_sold_2026 ?? 0) > 0 ? (
                              <>
                                <div>{Number(c.units_sold_2026).toLocaleString()} sold</div>
                                <div className="text-xs text-muted-foreground">was costed {money(c.sales_unit_cost_2026)}</div>
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
