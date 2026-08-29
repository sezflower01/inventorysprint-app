/**
 * Unshipped Purchases — money spent that never reached Amazon.
 *
 * ── WHY THIS EXISTS ALONGSIDE PurchaseVsShipmentReport ────────────────────
 *
 * That report starts from `shipment_purchase_allocations` and then keeps only
 * allocations whose shipment draft still exists, deleting the rest as orphans.
 * Both of those are correct for its question — "of what I put into shipments,
 * what is mismatched" — and both make it structurally blind to this one:
 *
 *   * a purchase never allocated to any shipment has no allocation row at all;
 *   * a purchase allocated to a draft that was later deleted is auto-purged.
 *
 * Those are exactly the rows worth money. This page starts from the other end
 * — every `created_listings` row, i.e. everything paid for — and asks what of
 * it can be accounted for at Amazon.
 *
 * ── WHY NOT received_quantity ─────────────────────────────────────────────
 *
 * `created_listings.received_quantity` looks like the obvious field and is not
 * usable here. Its only writer is a manual input in PurchaseHistoryDialog, and
 * the established convention treats NULL as "received everything ordered"
 * (PurchaseHistoryDialog effectiveReceived). So it is null on almost every row
 * and a report keyed on it would find nothing. It is shown as a column when
 * set, because a user-entered shortfall is real evidence, but it never drives
 * a status.
 *
 * The load-bearing signal is `fba_shipment_items` — Amazon's own record of
 * what was shipped and what was received.
 *
 * ── FALSE ACCUSATIONS ARE THE FAILURE MODE ────────────────────────────────
 *
 * The output of this page is "contact your supplier about money". Telling
 * someone a supplier shorted them when the units actually arrived is worse
 * than showing nothing, so anything that proves an ASIN reached Amazon
 * suppresses the strongest status:
 *
 *   * a matching `fba_shipment_items` row, and
 *   * an `inventory` row, which only exists for an ASIN Amazon has held.
 *
 * Shipment history also depends on how far the FBA shipment sync reaches
 * back (`shipment_backfill_progress`), so a purchase older than that coverage
 * can look unshipped when it simply predates the data. The UI says so rather
 * than pretending otherwise.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Loader2, AlertTriangle, ExternalLink, Search, Route, RefreshCw, FileWarning } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getListingUnitCostSafe } from "@/lib/cost-contract";
import AsinTraceDialog from "@/components/inventory/AsinTraceDialog";

type ListingRow = {
  id: string;
  asin: string;
  sku: string | null;
  title: string | null;
  image_url: string | null;
  units: number | null;
  received_quantity: number | null;
  cost: number | null;
  amount: number | null;
  date_created: string | null;
  created_at: string;
  supplier_links: unknown;
};

type ShipItem = {
  asin: string | null;
  seller_sku: string | null;
  quantity_shipped: number | null;
  quantity_received: number | null;
};

type GapKind = "never_shipped" | "short_shipped" | "not_received" | "accounted";

type GapRow = {
  key: string;
  asin: string;
  sku: string | null;
  title: string;
  image_url: string | null;
  supplier: string;
  supplierUrl: string | null;
  purchased: number;
  purchaseCount: number;
  shipped: number;
  received: number;
  sold: number;
  onHand: number;
  manualReceived: number | null;
  unitCost: number | null;
  moneyAtRisk: number | null;
  ageDays: number | null;
  purchaseDate: string | null;
  kind: GapKind;
};

/** Date-only strings parse as UTC midnight; force local so ages don't skew a day. */
function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00`) : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function supplierInfo(links: unknown): { name: string; url: string | null } {
  if (!Array.isArray(links) || links.length === 0) return { name: "—", url: null };
  const first = links[0] as { supplier_name?: string; name?: string; url?: string; link?: string };
  return {
    name: first?.supplier_name ?? first?.name ?? "—",
    url: first?.url ?? first?.link ?? null,
  };
}

const KIND_META: Record<GapKind, { label: string; cls: string; blurb: string }> = {
  never_shipped: {
    label: "Never reached Amazon",
    cls: "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30",
    blurb: "Nothing sold, nothing in stock, no shipment record. Either it never arrived from the supplier, or it is still with you.",
  },
  short_shipped: {
    label: "Short",
    cls: "bg-amber-500/15 text-amber-800 dark:text-amber-400 border-amber-500/30",
    blurb: "Fewer units can be located (sold + in stock) than were purchased.",
  },
  not_received: {
    label: "Amazon didn't receive",
    cls: "bg-orange-500/15 text-orange-800 dark:text-orange-400 border-orange-500/30",
    blurb: "Shipped to Amazon but not fully checked in — a reconciliation claim, not a supplier issue.",
  },
  accounted: {
    label: "Accounted for",
    cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30",
    blurb: "Shipped quantity covers what was purchased.",
  },
};

type StatusFilter = "gaps" | "all" | GapKind;

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const FILTER_LABELS: Record<StatusFilter, string> = {
  gaps: "Discrepancies",
  all: "All purchases",
  never_shipped: KIND_META.never_shipped.label,
  short_shipped: KIND_META.short_shipped.label,
  not_received: KIND_META.not_received.label,
  accounted: "Fully shipped",
};

// Order matters: the two summary views first, then the individual statuses
// worst-first, so the list reads down in descending urgency.
const FILTER_ORDER: StatusFilter[] = [
  "gaps", "never_shipped", "short_shipped", "not_received", "accounted", "all",
];

async function fetchAllPaged(table: string, columns: string, userId: string): Promise<any[]> {
  const out: any[] = [];
  const size = 1000;
  for (let from = 0; ; from += size) {
    const { data, error } = await supabase
      .from(table as any)
      .select(columns)
      .eq("user_id", userId)
      .range(from, from + size - 1);
    if (error) { console.warn(`[unshipped-purchases] ${table}:`, error.message); break; }
    const batch = (data ?? []) as any[];
    out.push(...batch);
    if (batch.length < size) break;
  }
  return out;
}

// Survives unmount, so leaving the page and coming back does not re-run the
// whole load.
//
// This page issues four requests, one of which aggregates ~70k sales rows.
// Re-running that on every mount made navigating away and back feel broken --
// several seconds of spinner to rebuild data that had not changed. React
// Router unmounts the route component, so component state alone cannot survive
// it; the cache has to sit at module scope. Same approach as
// _assignmentsFilterCache in AssignmentsTable.
//
// Keyed by user id: a different account must never be shown the previous
// account's purchases from a stale cache.
//
// Deliberately NOT time-expired. An automatic refresh is exactly what was
// unwanted here — the data is a reconciliation being worked through, and having
// rows shift underneath while reading them is worse than being slightly stale.
// Refreshing is the button's job.
const _purchasesCache: {
  userId: string | null;
  loadedAt: number | null;
  listings: ListingRow[];
  shipItems: ShipItem[];
  stock: Map<string, number>;
  known: Set<string>;
  sold: Map<string, number>;
} = { userId: null, loadedAt: null, listings: [], shipItems: [], stock: new Map(), known: new Set(), sold: new Map() };

export default function UnshippedPurchases() {
  const { user } = useAuth();
  const [listings, setListings] = useState<ListingRow[]>([]);
  const [shipItems, setShipItems] = useState<ShipItem[]>([]);
  const [stockByAsin, setStockByAsin] = useState<Map<string, number>>(new Map());
  const [knownAsins, setKnownAsins] = useState<Set<string>>(new Set());
  const [soldByAsin, setSoldByAsin] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(true);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  // "gaps" (everything except fully shipped) is the default because that is
  // the working set -- the page exists to be worked through, not browsed.
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("gaps");
  // Period filter on the PURCHASE date. The page's headline caveat is that a
  // purchase older than the FBA shipment sync coverage looks unshipped when it
  // merely predates the data — narrowing to a recent year is the direct way to
  // exclude that false signal, so this is a correctness tool, not just
  // convenience.
  const [yearFilter, setYearFilter] = useState<string>("all");
  const [monthFilter, setMonthFilter] = useState<string>("all");
  const [traceAsin, setTraceAsin] = useState<{ asin: string; title: string } | null>(null);

  const loadData = useCallback(async (force: boolean) => {
    if (!user) return;

    if (!force && _purchasesCache.userId === user.id && _purchasesCache.loadedAt) {
      setListings(_purchasesCache.listings);
      setShipItems(_purchasesCache.shipItems);
      setStockByAsin(_purchasesCache.stock);
      setKnownAsins(_purchasesCache.known);
      setSoldByAsin(_purchasesCache.sold);
      setLoadedAt(_purchasesCache.loadedAt);
      setLoading(false);
      return;
    }

    (async () => {
      setLoading(true);
      const [l, s, inv, sold] = await Promise.all([
        fetchAllPaged("created_listings", "id, asin, sku, title, image_url, units, received_quantity, cost, amount, date_created, created_at, supplier_links", user.id),
        fetchAllPaged("fba_shipment_items", "asin, seller_sku, quantity_shipped, quantity_received", user.id),
        fetchAllPaged("inventory", "asin, available, reserved, inbound", user.id),
        // Server-side aggregate. sales_orders is ~70k rows; totalling it in the
        // browser would mean 70+ paged requests per load, and any paging slip
        // would understate sales -- the exact failure this is fixing.
        supabase.rpc("sold_units_by_asin"),
      ]);
      const stock = new Map<string, number>();
      const known = new Set<string>();
      for (const r of inv as any[]) {
        if (!r.asin) continue;
        // Presence is tracked separately from quantity. An inventory row at 0
        // still proves Amazon has HELD this ASIN -- rows exist only for stock
        // Amazon has actually seen -- and that is the whole difference between
        // sold out and never arrived.
        known.add(r.asin);
        stock.set(r.asin, (stock.get(r.asin) ?? 0)
          + (Number(r.available) || 0) + (Number(r.reserved) || 0) + (Number(r.inbound) || 0));
      }
      const soldMap = new Map<string, number>();
      if ((sold as any)?.error) {
        // Loud, not silent: without sales the page reverts to its old
        // shipment-only behaviour, which overstates what is missing.
        console.warn("[unshipped-purchases] sold_units_by_asin:", (sold as any).error.message);
      }
      for (const r of (((sold as any)?.data ?? []) as any[])) {
        if (r.asin) soldMap.set(r.asin, Number(r.units_sold) || 0);
      }

      const now = Date.now();
      _purchasesCache.userId = user.id;
      _purchasesCache.loadedAt = now;
      _purchasesCache.listings = l as ListingRow[];
      _purchasesCache.shipItems = s as ShipItem[];
      _purchasesCache.stock = stock;
      _purchasesCache.known = known;
      _purchasesCache.sold = soldMap;

      setListings(l as ListingRow[]);
      setShipItems(s as ShipItem[]);
      setStockByAsin(stock);
      setKnownAsins(known);
      setSoldByAsin(soldMap);
      setLoadedAt(now);
      setLoading(false);
    })();
  }, [user]);

  // Mount only. Reads the cache when there is one, so returning to the page is
  // instant and nothing moves while you are reading it.
  useEffect(() => { void loadData(false); }, [loadData]);

  const allRows = useMemo<GapRow[]>(() => {
    // Shipment totals keyed by ASIN. Deliberately ASIN-level, not ASIN+SKU:
    // a listing is frequently recreated under a new SKU, and matching on the
    // pair would report the original purchase as unshipped every time that
    // happened. ASIN is the stable identity of the thing bought.
    const shippedByAsin = new Map<string, { shipped: number; received: number }>();
    for (const it of shipItems) {
      const asin = it.asin;
      if (!asin) continue;
      const agg = shippedByAsin.get(asin) ?? { shipped: 0, received: 0 };
      agg.shipped += Number(it.quantity_shipped) || 0;
      agg.received += Number(it.quantity_received) || 0;
      shippedByAsin.set(asin, agg);
    }

    // Purchases roll up per ASIN too, so buying the same product three times
    // is one line with the combined quantity rather than three lines each
    // looking unshipped against the same shipment.
    const byAsin = new Map<string, GapRow>();
    const now = Date.now();

    for (const l of listings) {
      if (!l.asin) continue;
      const purchased = Number(l.units) || 0;
      if (purchased <= 0) continue; // nothing was bought; nothing to reconcile

      const unit = getListingUnitCostSafe({ cost: l.cost, amount: l.amount, units: l.units });
      const when = parseDate(l.date_created) ?? parseDate(l.created_at);

      const existing = byAsin.get(l.asin);
      if (existing) {
        existing.purchased += purchased;
        existing.purchaseCount += 1;
        if (unit !== null) {
          // Weighted so a mixed-price history reports a real blended cost.
          const prevUnits = existing.purchased - purchased;
          const prevTotal = (existing.unitCost ?? 0) * prevUnits;
          existing.unitCost = (prevTotal + unit * purchased) / existing.purchased;
        }
        if (when && (!existing.purchaseDate || when < new Date(existing.purchaseDate))) {
          existing.purchaseDate = when.toISOString();
        }
        if (l.received_quantity != null) {
          existing.manualReceived = (existing.manualReceived ?? 0) + Number(l.received_quantity);
        }
        continue;
      }

      const sup = supplierInfo(l.supplier_links);
      byAsin.set(l.asin, {
        key: l.asin,
        asin: l.asin,
        sku: l.sku,
        title: l.title || l.asin,
        image_url: l.image_url,
        supplier: sup.name,
        supplierUrl: sup.url,
        purchased,
        purchaseCount: 1,
        shipped: 0,
        received: 0,
        sold: 0,
        onHand: 0,
        manualReceived: l.received_quantity != null ? Number(l.received_quantity) : null,
        unitCost: unit,
        moneyAtRisk: null,
        ageDays: when ? Math.floor((now - when.getTime()) / 86_400_000) : null,
        purchaseDate: when ? when.toISOString() : null,
        kind: "never_shipped",
      });
    }

    const out: GapRow[] = [];
    for (const r of byAsin.values()) {
      const ship = shippedByAsin.get(r.asin);
      r.shipped = ship?.shipped ?? 0;
      r.received = ship?.received ?? 0;
      r.sold = soldByAsin.get(r.asin) ?? 0;
      r.onHand = stockByAsin.get(r.asin) ?? 0;

      // A SALE is the strongest proof a unit reached Amazon -- Amazon cannot
      // ship to a customer what it never received -- and current stock is the
      // same kind of evidence. Both beat fba_shipment_items, which does not
      // reach back far enough: measured on B0G4BQ42W3 (2026-08-28) that table
      // knew about 58 units while 977 had actually sold, so the page reported
      // 1,422 units missing against a true figure of ~384.
      //
      // Shipment quantity is still counted, for units that shipped but have
      // neither sold nor landed in stock yet.
      const located = Math.max(r.sold + r.onHand, r.shipped);
      const missing = Math.max(0, r.purchased - located);
      r.moneyAtRisk = r.unitCost != null ? missing * r.unitCost : null;

      // The floor under this classification: never claim an ASIN never reached
      // Amazon while Amazon holds an inventory row for it, even at zero. Without
      // this a fully sold-out ASIN reads as never delivered the moment sales
      // data is unavailable -- exactly what happened on B0G8811NCN before the
      // sold_units_by_asin RPC was deployed, on a page that tells you to go ask
      // a supplier for money.
      if (located === 0 && !knownAsins.has(r.asin)) {
        r.kind = "never_shipped";
      } else if (missing > 0) {
        r.kind = "short_shipped";
      // quantity_received is only believable when nothing contradicts it.
      //
      // Found 2026-08-28 on B0GKZK1NYH: 5 shipped, 0 received -- and 11 SOLD.
      // Amazon obviously received them; the received figure was simply never
      // synced on those old shipments. The page was reporting "Amazon didn't
      // receive" and offering a claim link, which would have meant filing
      // claims contradicted by the seller's own sales data.
      //
      // A unit that sold or is in stock reached Amazon, full stop. Only claim a
      // shortfall when the evidence does not already account for the shipment.
      } else if (r.shipped > 0 && r.received < r.shipped && (r.sold + r.onHand) < r.shipped) {
        r.kind = "not_received";
      } else {
        r.kind = "accounted";
      }

      // Recompute age from the stored ISO date after the merge above.
      const d = parseDate(r.purchaseDate);
      r.ageDays = d ? Math.floor((now - d.getTime()) / 86_400_000) : null;
      out.push(r);
    }

    // Money first — this page exists to be worked top-down. Rows with an
    // unknown unit cost sort under the priced ones rather than to the bottom,
    // since "unknown" is not the same as "nothing at stake".
    return out.sort((a, b) => {
      const am = a.moneyAtRisk ?? -1;
      const bm = b.moneyAtRisk ?? -1;
      if (bm !== am) return bm - am;
      return (b.purchased - Math.max(b.sold + b.onHand, b.shipped)) - (a.purchased - Math.max(a.sold + a.onHand, a.shipped));
    });
    // Deliberately NOT dependent on the filters. Computing the full set once
    // means the dropdown can show a count per status, and the summary cards
    // stay put while you filter.
  }, [listings, shipItems, stockByAsin, knownAsins, soldByAsin]);

  // Years present in the data, newest first, so the dropdown never offers a
  // year with nothing behind it.
  const years = useMemo(() => {
    const set = new Set<number>();
    for (const r of allRows) {
      const d = parseDate(r.purchaseDate);
      if (d) set.add(d.getFullYear());
    }
    return Array.from(set).sort((a, b) => b - a);
  }, [allRows]);

  // Applied BEFORE counts and totals, so both describe the period on screen.
  // A count of "Discrepancies (12)" that silently included other years would
  // not match the table under it.
  const periodRows = useMemo(() => {
    if (yearFilter === "all" && monthFilter === "all") return allRows;
    return allRows.filter((r) => {
      const d = parseDate(r.purchaseDate);
      // No purchase date means the period cannot be established. Excluded
      // rather than assumed into the selected period — this page is used to
      // decide whether to chase a supplier for money.
      if (!d) return false;
      if (yearFilter !== "all" && d.getFullYear() !== Number(yearFilter)) return false;
      if (monthFilter !== "all" && d.getMonth() !== Number(monthFilter)) return false;
      return true;
    });
  }, [allRows, yearFilter, monthFilter]);

  const undatedCount = useMemo(
    () => allRows.filter((r) => !parseDate(r.purchaseDate)).length,
    [allRows],
  );

  const counts = useMemo(() => {
    const c: Record<StatusFilter, number> = {
      gaps: 0, all: periodRows.length,
      never_shipped: 0, short_shipped: 0, not_received: 0, accounted: 0,
    };
    for (const r of periodRows) {
      c[r.kind]++;
      if (r.kind !== "accounted") c.gaps++;
    }
    return c;
  }, [periodRows]);

  const rows = useMemo(() => {
    let list = periodRows;
    if (statusFilter === "gaps") list = list.filter((r) => r.kind !== "accounted");
    else if (statusFilter !== "all") list = list.filter((r) => r.kind === statusFilter);

    if (query.trim()) {
      const q = query.trim().toLowerCase();
      list = list.filter(
        (r) => r.asin.toLowerCase().includes(q) ||
               r.title.toLowerCase().includes(q) ||
               (r.sku ?? "").toLowerCase().includes(q) ||
               r.supplier.toLowerCase().includes(q),
      );
    }
    return list;
  }, [periodRows, statusFilter, query]);

  // From allRows, never the filtered set: these cards are the headline
  // exposure for the whole account. Recomputing them per filter would make
  // "unaccounted value" fall every time you narrowed the view, which reads as
  // the problem shrinking rather than the view narrowing.
  const totals = useMemo(() => {
    let money = 0, units = 0, unpriced = 0, neverShipped = 0;
    for (const r of periodRows) {
      if (r.kind === "accounted") continue;
      units += Math.max(0, r.purchased - Math.max(r.sold + r.onHand, r.shipped));
      if (r.moneyAtRisk != null) money += r.moneyAtRisk; else unpriced++;
      if (r.kind === "never_shipped") neverShipped++;
    }
    return { money, units, unpriced, neverShipped, lines: periodRows.filter((r) => r.kind !== "accounted").length };
  }, [periodRows]);

  const money = (n: number | null) =>
    n == null ? "—" : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <div className="min-h-screen bg-background p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center gap-2 mb-1">
          <Link to="/tools">
            <Button variant="ghost" size="sm"><ArrowLeft className="h-4 w-4 mr-1" /> Back</Button>
          </Link>
          <h1 className="text-2xl font-bold">Unshipped Purchases</h1>
        </div>
        <p className="text-sm text-muted-foreground mb-4 max-w-3xl">
          Every purchase recorded in Created Listings, checked against Amazon's own record of what
          was shipped and received. Rows at the top are money you spent that cannot be accounted for
          at Amazon.
        </p>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          <Card className="p-3">
            <div className="text-xs text-muted-foreground">Unaccounted value</div>
            <div className="text-2xl font-bold tabular-nums text-red-600 dark:text-red-400">{money(totals.money)}</div>
            {totals.unpriced > 0 && (
              <div className="text-[11px] text-muted-foreground mt-0.5">+{totals.unpriced} line(s) with no reliable unit cost</div>
            )}
          </Card>
          <Card className="p-3">
            <div className="text-xs text-muted-foreground">Units unaccounted</div>
            <div className="text-2xl font-bold tabular-nums">{totals.units.toLocaleString()}</div>
          </Card>
          <Card className="p-3">
            <div className="text-xs text-muted-foreground">Never reached Amazon</div>
            <div className="text-2xl font-bold tabular-nums">{totals.neverShipped}</div>
          </Card>
          <Card className="p-3">
            <div className="text-xs text-muted-foreground">Lines to review</div>
            <div className="text-2xl font-bold tabular-nums">{totals.lines}</div>
          </Card>
        </div>

        <div className="flex flex-wrap items-center gap-2 mb-3">
          <div className="relative">
            <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="ASIN, SKU, title or supplier"
              className="pl-8 w-[280px] h-9"
            />
          </div>
          <Select value={yearFilter} onValueChange={setYearFilter}>
            <SelectTrigger className="w-[130px] h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All years</SelectItem>
              {years.map((y) => (
                <SelectItem key={y} value={String(y)}>{y}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={monthFilter} onValueChange={setMonthFilter}>
            <SelectTrigger className="w-[150px] h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All months</SelectItem>
              {MONTHS.map((m, i) => (
                <SelectItem key={m} value={String(i)}>{m}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
            <SelectTrigger className="w-[260px] h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FILTER_ORDER.map((k) => (
                <SelectItem key={k} value={k}>
                  <span className="flex items-center gap-2">
                    {FILTER_LABELS[k]}
                    <span className="text-xs text-muted-foreground tabular-nums">({counts[k]})</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void loadData(true)}
            disabled={loading}
            className="gap-1.5"
            title="Re-read purchases, shipments, stock and sales"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          {loadedAt && (
            <span className="text-xs text-muted-foreground">
              Updated {new Date(loadedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </span>
          )}

          <Link to="/tools/purchase-vs-shipment" className="ml-auto">
            <Button variant="ghost" size="sm">Purchase vs Shipment report →</Button>
          </Link>
        </div>

        {(yearFilter !== "all" || monthFilter !== "all") && undatedCount > 0 && (
          <Card className="p-3 mb-3 text-xs text-muted-foreground">
            {undatedCount} purchase{undatedCount === 1 ? " has" : "s have"} no recorded date and
            {" "}{undatedCount === 1 ? "is" : "are"} hidden while a period is selected. Switch the
            year back to <strong>All years</strong> to see {undatedCount === 1 ? "it" : "them"}.
          </Card>
        )}

        <Card className="p-3 mb-4 border-amber-500/30 bg-amber-500/5">
          <div className="flex gap-2 text-xs text-muted-foreground">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-500" />
            <div>
              <strong className="text-foreground">Check before contacting a supplier.</strong>{" "}
              Units are counted as having reached Amazon if they <strong>sold</strong> or are{" "}
              <strong>in stock</strong> — a sale is proof, since Amazon cannot ship what it never
              received. Shipment records are used too, but only as a third signal: they do not reach
              back far enough to be trusted alone. Use the <strong>Trace</strong> button on a row to
              see the per-marketplace breakdown before treating anything as a shortfall.
            </div>
          </div>
        </Card>

        {loading ? (
          <div className="flex items-center gap-2 text-muted-foreground p-8 justify-center">
            <Loader2 className="h-4 w-4 animate-spin" /> Reconciling purchases against shipments…
          </div>
        ) : rows.length === 0 ? (
          <Card className="p-8 text-center text-muted-foreground">
            {statusFilter === "gaps"
              ? "Nothing unaccounted for. Every purchase matches a shipment."
              : statusFilter === "all"
                ? "No purchases recorded."
                : `No purchases matching "${FILTER_LABELS[statusFilter]}".`}
          </Card>
        ) : (
          <div className="overflow-x-auto border rounded-lg">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr className="text-left [&>th]:px-3 [&>th]:py-2 [&>th]:font-medium [&>th]:text-xs [&>th]:text-muted-foreground [&>th]:uppercase [&>th]:tracking-wide">
                  <th>Product</th>
                  <th>Supplier</th>
                  <th className="text-right">Bought</th>
                  <th className="text-right">Shipped</th>
                  <th className="text-right">Received</th>
                  <th className="text-right">Sold</th>
                  <th className="text-right">In stock</th>
                  <th className="text-right">Missing</th>
                  <th className="text-right">Value</th>
                  <th className="text-right">Age</th>
                  <th>Status</th>
                  <th className="text-right">Trace</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const missing = Math.max(0, r.purchased - Math.max(r.sold + r.onHand, r.shipped));
                  const meta = KIND_META[r.kind];
                  return (
                    <tr key={r.key} className="border-t hover:bg-muted/30">
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          {r.image_url && (
                            <img src={r.image_url} alt="" className="w-8 h-8 rounded object-contain bg-muted shrink-0" />
                          )}
                          <div className="min-w-0">
                            <div className="truncate max-w-[320px]" title={r.title}>{r.title}</div>
                            <div className="text-xs text-muted-foreground font-mono">
                              {/*
                                amazon.com specifically: created_listings is the
                                US catalogue (the refresh enqueue scopes to US,
                                and CA/MX/BR sell from the same US pool), so a
                                marketplace-aware URL would have nothing to vary
                                on here.

                                Not nested inside a row-level link -- the row is
                                not a link -- so this needs no stopPropagation.
                              */}
                              <a
                                href={`https://www.amazon.com/dp/${r.asin}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-primary hover:underline"
                                title="Open on Amazon"
                              >
                                {r.asin}
                              </a>
                              {r.sku ? ` · ${r.sku}` : ""}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {r.supplierUrl ? (
                          <a href={r.supplierUrl} target="_blank" rel="noopener noreferrer"
                             className="inline-flex items-center gap-1 text-primary hover:underline">
                            {r.supplier}<ExternalLink className="h-3 w-3" />
                          </a>
                        ) : r.supplier}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {r.purchased}
                        {/*
                          Without this, a total like 1,480 reads as a data
                          error. It is normally many separate purchase records
                          -- one seller had ~120 twelve-unit cases of a single
                          ASIN -- and a bare aggregate gives no way to tell a
                          large real total from a duplication bug. It cost a
                          round of SQL to establish that once already.
                        */}
                        {r.purchaseCount > 1 && (
                          <span
                            className="block text-[10px] text-muted-foreground font-normal"
                            title={`Summed across ${r.purchaseCount} purchase records for this ASIN`}
                          >
                            {r.purchaseCount} purchases
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.shipped}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {r.received}
                        {r.manualReceived != null && r.manualReceived !== r.purchased && (
                          <span className="block text-[10px] text-muted-foreground" title="Manually recorded as received from the supplier">
                            {r.manualReceived} from supplier
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.sold || "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.onHand || "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums font-semibold">
                        {missing > 0 ? missing : "—"}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums font-semibold">
                        {r.moneyAtRisk != null && r.moneyAtRisk > 0 ? money(r.moneyAtRisk) : "—"}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-xs text-muted-foreground">
                        {r.ageDays != null ? `${r.ageDays}d` : "—"}
                      </td>
                      <td className="px-3 py-2">
                        <Badge variant="outline" className={`text-[11px] ${meta.cls}`} title={meta.blurb}>
                          {meta.label}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 text-right">
                        {/* Answers where the units went without leaving the
                            page. The common answer is a sale on CA/MX/BR, which
                            never appears in US Seller Central. */}
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2"
                            onClick={() => setTraceAsin({ asin: r.asin, title: r.title })}
                            title="Trace every unit of this ASIN"
                          >
                            <Route className="h-3.5 w-3.5" />
                          </Button>
                          {/* Only on rows where Amazon checked in fewer units than
                              were sent. A claim button on every row would be noise;
                              here it marks the rows with money actually recoverable,
                              and opens the same dialog, which lists the specific
                              shipments and links each to Seller Central. */}
                          {r.shipped > r.received && (r.sold + r.onHand) < r.shipped && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2 text-orange-600 dark:text-orange-400 hover:text-orange-700"
                              onClick={() => setTraceAsin({ asin: r.asin, title: r.title })}
                              title={`${r.shipped - r.received} unit(s) sent but not received by Amazon — open to file a claim`}
                            >
                              <FileWarning className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <AsinTraceDialog
        asin={traceAsin?.asin ?? null}
        title={traceAsin?.title}
        open={traceAsin !== null}
        onOpenChange={(o) => { if (!o) setTraceAsin(null); }}
      />
    </div>
  );
}
