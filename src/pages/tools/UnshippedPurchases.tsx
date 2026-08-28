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

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Loader2, AlertTriangle, ExternalLink, Search } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { getListingUnitCostSafe } from "@/lib/cost-contract";

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
  shipped: number;
  received: number;
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
    blurb: "No FBA shipment record and no inventory row. Either it never arrived from the supplier, or it is still with you.",
  },
  short_shipped: {
    label: "Short",
    cls: "bg-amber-500/15 text-amber-800 dark:text-amber-400 border-amber-500/30",
    blurb: "Fewer units reached an FBA shipment than were purchased.",
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

export default function UnshippedPurchases() {
  const { user } = useAuth();
  const [listings, setListings] = useState<ListingRow[]>([]);
  const [shipItems, setShipItems] = useState<ShipItem[]>([]);
  const [inventoryAsins, setInventoryAsins] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [onlyGaps, setOnlyGaps] = useState(true);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [l, s, inv] = await Promise.all([
        fetchAllPaged("created_listings", "id, asin, sku, title, image_url, units, received_quantity, cost, amount, date_created, created_at, supplier_links", user.id),
        fetchAllPaged("fba_shipment_items", "asin, seller_sku, quantity_shipped, quantity_received", user.id),
        fetchAllPaged("inventory", "asin", user.id),
      ]);
      if (cancelled) return;
      setListings(l as ListingRow[]);
      setShipItems(s as ShipItem[]);
      setInventoryAsins(new Set((inv as { asin: string }[]).map((r) => r.asin).filter(Boolean)));
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [user]);

  const rows = useMemo<GapRow[]>(() => {
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
        shipped: 0,
        received: 0,
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

      const missing = Math.max(0, r.purchased - r.shipped);
      r.moneyAtRisk = r.unitCost != null ? missing * r.unitCost : null;

      if (r.shipped === 0 && !inventoryAsins.has(r.asin)) {
        r.kind = "never_shipped";
      } else if (missing > 0) {
        r.kind = "short_shipped";
      } else if (r.shipped > 0 && r.received < r.shipped) {
        r.kind = "not_received";
      } else {
        r.kind = "accounted";
      }

      // Recompute age from the stored ISO date after the merge above.
      const d = parseDate(r.purchaseDate);
      r.ageDays = d ? Math.floor((now - d.getTime()) / 86_400_000) : null;
      out.push(r);
    }

    let list = out;
    if (onlyGaps) list = list.filter((r) => r.kind !== "accounted");
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      list = list.filter(
        (r) => r.asin.toLowerCase().includes(q) ||
               r.title.toLowerCase().includes(q) ||
               (r.sku ?? "").toLowerCase().includes(q) ||
               r.supplier.toLowerCase().includes(q),
      );
    }

    // Money first — this page exists to be worked top-down. Rows with an
    // unknown unit cost sort under the priced ones rather than to the bottom,
    // since "unknown" is not the same as "nothing at stake".
    return list.sort((a, b) => {
      const am = a.moneyAtRisk ?? -1;
      const bm = b.moneyAtRisk ?? -1;
      if (bm !== am) return bm - am;
      return (b.purchased - b.shipped) - (a.purchased - a.shipped);
    });
  }, [listings, shipItems, inventoryAsins, query, onlyGaps]);

  const totals = useMemo(() => {
    let money = 0, units = 0, unpriced = 0, neverShipped = 0;
    for (const r of rows) {
      if (r.kind === "accounted") continue;
      units += Math.max(0, r.purchased - r.shipped);
      if (r.moneyAtRisk != null) money += r.moneyAtRisk; else unpriced++;
      if (r.kind === "never_shipped") neverShipped++;
    }
    return { money, units, unpriced, neverShipped, lines: rows.filter((r) => r.kind !== "accounted").length };
  }, [rows]);

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
          <Button variant={onlyGaps ? "default" : "outline"} size="sm" onClick={() => setOnlyGaps((v) => !v)}>
            {onlyGaps ? "Showing gaps only" : "Showing everything"}
          </Button>
          <Link to="/tools/purchase-vs-shipment" className="ml-auto">
            <Button variant="ghost" size="sm">Purchase vs Shipment report →</Button>
          </Link>
        </div>

        <Card className="p-3 mb-4 border-amber-500/30 bg-amber-500/5">
          <div className="flex gap-2 text-xs text-muted-foreground">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-500" />
            <div>
              <strong className="text-foreground">Check before contacting a supplier.</strong>{" "}
              "Never reached Amazon" means no FBA shipment record and no inventory row for that ASIN.
              A purchase older than your FBA shipment sync coverage can look unshipped simply because
              the shipment predates the data — confirm against the shipment itself before treating a
              line as a supplier shortfall.
            </div>
          </div>
        </Card>

        {loading ? (
          <div className="flex items-center gap-2 text-muted-foreground p-8 justify-center">
            <Loader2 className="h-4 w-4 animate-spin" /> Reconciling purchases against shipments…
          </div>
        ) : rows.length === 0 ? (
          <Card className="p-8 text-center text-muted-foreground">
            {onlyGaps ? "Nothing unaccounted for. Every purchase matches a shipment." : "No purchases recorded."}
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
                  <th className="text-right">Missing</th>
                  <th className="text-right">Value</th>
                  <th className="text-right">Age</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const missing = Math.max(0, r.purchased - r.shipped);
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
                      <td className="px-3 py-2 text-right tabular-nums">{r.purchased}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.shipped}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {r.received}
                        {r.manualReceived != null && r.manualReceived !== r.purchased && (
                          <span className="block text-[10px] text-muted-foreground" title="Manually recorded as received from the supplier">
                            {r.manualReceived} from supplier
                          </span>
                        )}
                      </td>
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
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
