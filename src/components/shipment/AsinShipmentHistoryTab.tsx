import { useEffect, useMemo, useState } from "react";
import { Search, Loader2, Package } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export interface AsinHistoryShipment {
  id: string;
  shipmentName: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  continuedToAmazonAt?: string;
  items: Array<{
    asin: string;
    sku: string;
    title: string;
    imageUrl: string | null;
    qtyToShip: number;
  }>;
}

interface Props {
  shipments: AsinHistoryShipment[];
}

// "archived" belongs here. Archiving is a filing action -- archiveShipment
// only flips the status and stamps archivedAt, keeping every item -- and
// ShipmentBuilder already groups it with synced/completed as a terminal state
// (normalizeAcceptedShipmentState). Leaving it out meant a shipment that had
// genuinely gone to Amazon vanished from "shipment history" the moment it was
// tidied away, which is indistinguishable from the record being deleted.
// Measured 2026-08-28: 63 continued, 12 archived, 13 draft.
//
// "draft" stays out on purpose: a draft was never shipped, so it is not
// history.
const HISTORICAL_STATUSES = new Set(["continued", "synced", "completed", "archived"]);

const fmtMoney = (n: number) =>
  `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const pickShipmentDate = (s: AsinHistoryShipment): string =>
  s.completedAt || s.continuedToAmazonAt || s.createdAt || s.updatedAt;

export default function AsinShipmentHistoryTab({ shipments }: Props) {
  const [query, setQuery] = useState("");
  const [searched, setSearched] = useState("");
  const [costByAsin, setCostByAsin] = useState<Record<string, number>>({});
  const [loadingCost, setLoadingCost] = useState(false);

  const historical = useMemo(
    () => shipments.filter((s) => HISTORICAL_STATUSES.has(s.status)),
    [shipments],
  );

  const matches = useMemo(() => {
    const target = searched.trim().toUpperCase();
    if (!target) return [] as Array<{ shipment: AsinHistoryShipment; item: AsinHistoryShipment["items"][number] }>;
    const rows: Array<{ shipment: AsinHistoryShipment; item: AsinHistoryShipment["items"][number] }> = [];
    for (const s of historical) {
      for (const it of s.items) {
        if ((it.asin ?? "").trim().toUpperCase() === target && (it.qtyToShip ?? 0) > 0) {
          rows.push({ shipment: s, item: it });
        }
      }
    }
    rows.sort((a, b) => new Date(pickShipmentDate(b.shipment)).getTime() - new Date(pickShipmentDate(a.shipment)).getTime());
    return rows;
  }, [historical, searched]);

  // Fetch unit cost for the searched ASIN (Contract A: created_listings.amount = unit cost)
  useEffect(() => {
    const asin = searched.trim().toUpperCase();
    if (!asin || costByAsin[asin] !== undefined) return;
    let cancelled = false;
    (async () => {
      setLoadingCost(true);
      const { data, error } = await supabase
        .from("created_listings")
        .select("asin, amount, cost, units, updated_at")
        .eq("asin", asin)
        .order("updated_at", { ascending: false })
        .limit(1);
      if (cancelled) return;
      let unit = 0;
      if (!error && data && data.length > 0) {
        const r = data[0] as { amount: number | null; cost: number | null; units: number | null };
        if (typeof r.amount === "number" && r.amount >= 0) unit = r.amount;
        else if ((r.cost ?? 0) > 0 && (r.units ?? 0) > 0) unit = (r.cost as number) / (r.units as number);
      }
      setCostByAsin((prev) => ({ ...prev, [asin]: unit }));
      setLoadingCost(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [searched, costByAsin]);

  const unitCost = costByAsin[searched.trim().toUpperCase()] ?? 0;
  const totalUnits = matches.reduce((sum, r) => sum + (r.item.qtyToShip ?? 0), 0);
  const totalCost = matches.reduce((sum, r) => sum + (r.item.qtyToShip ?? 0) * unitCost, 0);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSearched(query.trim());
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>ASIN Shipment History</CardTitle>
        <CardDescription>
          Search by ASIN to see every shipment (Continued / Synced / Completed) that included it,
          with units and cost totals.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={onSubmit} className="flex flex-col gap-2 sm:flex-row">
          <Input
            placeholder="Enter ASIN (e.g. B003WGVMVK)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="sm:max-w-xs uppercase"
          />
          <Button type="submit" className="gap-2" disabled={!query.trim()}>
            <Search className="h-4 w-4" />
            Search
          </Button>
          {searched ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setQuery("");
                setSearched("");
              }}
            >
              Clear
            </Button>
          ) : null}
        </form>

        {!searched ? (
          <div className="rounded-md border border-white/10 bg-shipment-row-alt text-white/70 p-6 text-sm">
            Enter an ASIN above to generate the report.
          </div>
        ) : query.trim().toUpperCase() !== searched.trim().toUpperCase() ? (
          /*
            The box has been edited but Search has not been pressed, so the
            result below still describes the PREVIOUS ASIN. Left alone that
            reads as "this ASIN has no shipments" while naming a different one
            in small print -- reported 2026-08-28 as history appearing to have
            been deleted. Show the stale state explicitly instead.
          */
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 text-white/80 p-6 text-sm">
            Showing results for <span className="font-mono">{searched.toUpperCase()}</span>.
            Press <strong>Search</strong> to look up <span className="font-mono">{query.trim().toUpperCase()}</span>.
          </div>
        ) : matches.length === 0 ? (
          <div className="rounded-md border border-white/10 bg-shipment-row-alt text-white/70 p-6 text-sm">
            No shipments found for ASIN <span className="font-mono">{searched.toUpperCase()}</span>.
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge variant="secondary">ASIN: {searched.toUpperCase()}</Badge>
              <Badge variant="secondary">{matches.length} shipments</Badge>
              <Badge variant="secondary">
                Unit cost: {loadingCost ? <Loader2 className="ml-1 inline h-3 w-3 animate-spin" /> : fmtMoney(unitCost)}
              </Badge>
            </div>

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Shipment Name</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Image</TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead>ASIN</TableHead>
                  <TableHead className="text-right">Units</TableHead>
                  <TableHead className="text-right">Unit Cost</TableHead>
                  <TableHead className="text-right">Total Cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {matches.map(({ shipment, item }) => {
                  const date = pickShipmentDate(shipment);
                  const line = (item.qtyToShip ?? 0) * unitCost;
                  return (
                    <TableRow key={`${shipment.id}-${item.sku || item.asin}`}>
                      <TableCell className="font-medium">{shipment.shipmentName || "Untitled"}</TableCell>
                      {/* Now that archived rows appear here, the status has to be
                          visible -- otherwise an archived shipment is
                          indistinguishable from a live one. */}
                      <TableCell>
                        <Badge variant="secondary" className="text-[10px] capitalize">{shipment.status}</Badge>
                      </TableCell>
                      <TableCell>{date ? new Date(date).toLocaleDateString() : "—"}</TableCell>
                      <TableCell>
                        {item.imageUrl ? (
                          <img
                            src={item.imageUrl}
                            alt={item.title}
                            className="h-12 w-12 min-w-12 min-h-12 object-cover rounded"
                            loading="lazy"
                          />
                        ) : (
                          <div className="h-12 w-12 min-w-12 min-h-12 rounded bg-muted flex items-center justify-center">
                            <Package className="h-5 w-5 text-muted-foreground" />
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="max-w-[280px] truncate" title={item.title}>{item.title}</TableCell>
                      <TableCell className="font-mono text-xs">{item.asin}</TableCell>
                      <TableCell className="text-right tabular-nums">{item.qtyToShip}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtMoney(unitCost)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtMoney(line)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell colSpan={5} className="font-semibold text-right">Totals</TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">{totalUnits}</TableCell>
                  <TableCell />
                  <TableCell className="text-right font-semibold tabular-nums">{fmtMoney(totalCost)}</TableCell>
                </TableRow>
              </TableFooter>
            </Table>

            {unitCost === 0 ? (
              <p className="text-xs text-muted-foreground">
                No unit cost found for this ASIN in Product Library — totals shown as $0.00. Add cost in Product Library to populate.
              </p>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
