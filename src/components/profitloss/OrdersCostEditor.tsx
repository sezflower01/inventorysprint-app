import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Loader2, Save, AlertCircle, CheckCircle2, RefreshCw, CloudDownload } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { getListingUnitCost, getInventoryUnitCost } from "@/lib/cost-contract";
import { getMarketplaceConfig } from "@/lib/marketplaceCurrency";
import { useHomeMarketplace } from "@/hooks/use-home-marketplace";

interface OrderRecord {
  id: string;
  order_id: string;
  asin: string;
  sku: string | null;
  title: string | null;
  image_url: string | null;
  quantity: number;
  sold_price: number;
  total_fees: number;
  unit_cost: number | null;
  /**
   * What the P&L actually costs this order at, via resolve_unit_cost_v1 --
   * snapshot, then manual override, cost_history, purchase batches /
   * created_listings, and finally inventory. This, NOT unit_cost, decides
   * whether a cost is missing: unit_cost is only the first of those five
   * sources, so judging by it alone reported orders as missing that COGS had
   * already costed correctly.
   */
  resolved_unit_cost?: number | null;
  /** Which source supplied resolved_unit_cost. 'unresolved' = genuinely none. */
  resolved_source?: string | null;
  order_date: string;
  marketplace: string | null;
}

interface OrdersCostEditorProps {
  userId: string;
  startDate: string;
  endDate: string;
  onCostUpdated?: () => void;
}

// order.sold_price/order.total_fees are stored in THAT order's own marketplace
// currency (Amazon never converts), so each row must show its own marketplace's
// symbol rather than a single hardcoded USD label.
const formatNativeCurrency = (amount: number, marketplace: string | null | undefined) => {
  const symbol = getMarketplaceConfig(String(marketplace || "US").toUpperCase()).currencySymbol;
  return `${symbol}${new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount)}`;
};

// Page through every row of a Supabase query — bypasses the default 1000-row
// cap so SKU→ASIN / cost lookups don't silently miss data on large accounts.
const PAGE_LOOKUP = 1000;
async function loadAllRows<T = any>(builder: () => any): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; ; from += PAGE_LOOKUP) {
    // Stable order applied HERE, where the paging happens: callers pass a
    // builder, so none of them can be relied on to remember.
    const { data, error } = await builder()
      .order("id", { ascending: true })
      .range(from, from + PAGE_LOOKUP - 1);
    if (error) {
      console.error("[loadAllRows] paging failed:", error);
      throw error;
    }
    if (!data || data.length === 0) break;
    all.push(...(data as T[]));
    if (data.length < PAGE_LOOKUP) break;
  }
  return all;
}

export default function OrdersCostEditor({
  userId,
  startDate,
  endDate,
  onCostUpdated,
}: OrdersCostEditorProps) {
  const { homeCurrencySymbol } = useHomeMarketplace();
  const [orders, setOrders] = useState<OrderRecord[]>([]);
  const [loading, setLoading] = useState(false);
  // True when resolve_order_costs_v1 could not be reached, so the counts
  // below fall back to stored costs and the UI must say so.
  const [resolveUnavailable, setResolveUnavailable] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [fetchingAmazon, setFetchingAmazon] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const [enrichProgress, setEnrichProgress] = useState({ current: 0, total: 0 });
  const [editedCosts, setEditedCosts] = useState<Record<string, string>>({});
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());
  const [showMissingOnly, setShowMissingOnly] = useState(true);
  const [groupByAsin, setGroupByAsin] = useState(true); // Default to grouped view

  const [effectiveUserId, setEffectiveUserId] = useState<string>(userId);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase.auth.getUser();
      const authId = data.user?.id;
      if (!cancelled) {
        setEffectiveUserId(authId || userId);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const fetchOrders = useCallback(async () => {
    if (!effectiveUserId || !startDate || !endDate) return;

    setLoading(true);
    try {
      // Page through ALL rows — Supabase caps each query at 1000, so
      // without paging we silently miss thousands of broken orders.
      const PAGE = 1000;
      const all: OrderRecord[] = [];
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from("sales_orders")
          .select(
            "id, order_id, asin, sku, title, image_url, quantity, sold_price, total_fees, unit_cost, order_date, marketplace"
          )
          .eq("user_id", effectiveUserId)
          .gte("order_date", startDate)
          .lte("order_date", endDate)
          .order("order_date", { ascending: false })
          .range(from, from + PAGE - 1);

        if (error) {
          console.error("Error fetching orders:", error);
          toast.error("Failed to fetch orders");
          return;
        }
        if (!data || data.length === 0) break;
        all.push(...(data as OrderRecord[]));
        if (data.length < PAGE) break;
      }

      // Filter out rows the user can't act on:
      //  - Refund mirror rows (inherit cost from parent shipment)
      //  - UNKNOWN-ASIN refund-side ghosts
      //  - PENDING orders — Amazon hasn't released ASIN/SKU/price yet,
      //    so there's literally nothing to backfill until the next sync.
      const filtered = all.filter((o) => {
        if (o.order_id?.includes("-REFUND")) return false;
        const asinUpper = (o.asin || "").toUpperCase();
        if (asinUpper === "UNKNOWN") return false;
        if (asinUpper === "PENDING") return false;
        if (((o as any).order_status || "").toLowerCase() === "pending") return false;
        return true;
      });
      // Ask the P&L's resolver what each order actually costs. One RPC for the
      // whole range rather than a call per order.
      //
      // A failure here must NOT silently fall back to unit_cost -- that is the
      // exact misreporting this replaced, and it would return without warning.
      // Leave resolved_* undefined and let the UI say it could not check.
      let resolvedById = new Map<string, { cost: number; source: string }>();
      let resolveFailed = false;
      try {
        const { data: resolvedRows, error: resolveErr } = await (supabase as any).rpc(
          "resolve_order_costs_v1",
          { p_start: startDate, p_end: endDate },
        );
        if (resolveErr) throw resolveErr;
        resolvedById = new Map(
          ((resolvedRows || []) as Array<{
            order_row_id: string;
            resolved_unit_cost: number | null;
            resolved_source: string | null;
          }>).map((r) => [
            r.order_row_id,
            { cost: Number(r.resolved_unit_cost) || 0, source: r.resolved_source || "unresolved" },
          ]),
        );
      } catch (e) {
        resolveFailed = true;
        console.error("[OrdersCostEditor] resolve_order_costs_v1 failed", e);
        toast.error("Could not check resolved costs — showing stored costs only.");
      }

      setResolveUnavailable(resolveFailed);
      setOrders(
        filtered.map((o) => {
          const hit = resolvedById.get(o.id);
          return hit
            ? { ...o, resolved_unit_cost: hit.cost, resolved_source: hit.source }
            : o;
        }),
      );
    } catch (err) {
      console.error("Error:", err);
      toast.error("Failed to fetch orders");
    } finally {
      setLoading(false);
    }
  }, [effectiveUserId, startDate, endDate]);

  useEffect(() => {
    fetchOrders();
  }, [fetchOrders]);

  const handleCostChange = (orderId: string, value: string) => {
    setEditedCosts((prev) => ({ ...prev, [orderId]: value }));
  };

  const saveCost = async (order: OrderRecord) => {
    const costStr = editedCosts[order.id];
    if (costStr === undefined) return;

    const costValue = parseFloat(costStr);
    if (isNaN(costValue) || costValue < 0) {
      toast.error("Please enter a valid cost");
      return;
    }

    setSavingIds((prev) => new Set(prev).add(order.id));

    try {
      const { error } = await supabase
        .from("sales_orders")
        .update({ unit_cost: costValue })
        .eq("id", order.id);

      if (error) {
        console.error("Error saving cost:", error);
        toast.error("Failed to save cost");
        return;
      }

      // Update local state
      setOrders((prev) =>
        prev.map((o) => (o.id === order.id ? { ...o, unit_cost: costValue } : o))
      );
      setEditedCosts((prev) => {
        const next = { ...prev };
        delete next[order.id];
        return next;
      });

      toast.success(`Cost saved for order ${order.order_id}`);
      onCostUpdated?.();
    } catch (err) {
      console.error("Error:", err);
      toast.error("Failed to save cost");
    } finally {
      setSavingIds((prev) => {
        const next = new Set(prev);
        next.delete(order.id);
        return next;
      });
    }
  };

  // Save cost for all orders in a grouped ASIN
  const saveGroupCost = async (group: { asin: string; orders: OrderRecord[] }) => {
    const costStr = editedCosts[`group-${group.asin}`];
    if (costStr === undefined) return;

    const costValue = parseFloat(costStr);
    if (isNaN(costValue) || costValue < 0) {
      toast.error("Please enter a valid cost");
      return;
    }

    setSavingIds((prev) => new Set(prev).add(`group-${group.asin}`));

    try {
      // Update all orders with this ASIN
      const orderIds = group.orders.map((o) => o.id);
      const { error } = await supabase
        .from("sales_orders")
        .update({ unit_cost: costValue })
        .in("id", orderIds);

      if (error) {
        console.error("Error saving group cost:", error);
        toast.error("Failed to save cost");
        return;
      }

      // Update local state
      setOrders((prev) =>
        prev.map((o) =>
          orderIds.includes(o.id) ? { ...o, unit_cost: costValue } : o
        )
      );
      setEditedCosts((prev) => {
        const next = { ...prev };
        delete next[`group-${group.asin}`];
        return next;
      });

      toast.success(`Cost saved for ${group.orders.length} orders (${group.asin})`);
      onCostUpdated?.();
    } catch (err) {
      console.error("Error:", err);
      toast.error("Failed to save cost");
    } finally {
      setSavingIds((prev) => {
        const next = new Set(prev);
        next.delete(`group-${group.asin}`);
        return next;
      });
    }
  };

  const saveAllCosts = async () => {
    const idsToSave = Object.keys(editedCosts);
    if (idsToSave.length === 0) {
      toast.info("No changes to save");
      return;
    }

    let successCount = 0;
    let errorCount = 0;

    for (const id of idsToSave) {
      const order = orders.find((o) => o.id === id);
      if (!order) continue;

      const costStr = editedCosts[id];
      const costValue = parseFloat(costStr);
      if (isNaN(costValue) || costValue < 0) {
        errorCount++;
        continue;
      }

      setSavingIds((prev) => new Set(prev).add(id));

      try {
        const { error } = await supabase
          .from("sales_orders")
          .update({ unit_cost: costValue })
          .eq("id", id);

        if (error) {
          errorCount++;
        } else {
          successCount++;
          setOrders((prev) =>
            prev.map((o) => (o.id === id ? { ...o, unit_cost: costValue } : o))
          );
        }
      } catch {
        errorCount++;
      } finally {
        setSavingIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    }

    setEditedCosts({});

    if (successCount > 0) {
      toast.success(`Saved ${successCount} cost(s)`);
      onCostUpdated?.();
    }
    if (errorCount > 0) {
      toast.error(`Failed to save ${errorCount} cost(s)`);
    }
  };

  // Helper to check if a value looks like a numeric SKU (not a real ASIN)
  const isNumericSku = (value: string) => /^\d{7,}$/.test(value);

  // Enrich orders that have incomplete data (missing cost, missing title/image, PENDING/UNKNOWN ASIN, or numeric ASIN)
  const enrichOrdersData = async () => {
    // Find orders missing data or cost
    const ordersToEnrich = orders.filter(
      (o) =>
        // cost
        !o.unit_cost ||
        o.unit_cost === 0 ||
        // identifiers
        o.asin === "PENDING" ||
        o.asin === "UNKNOWN" ||
        isNumericSku(o.asin) ||
        // metadata
        !o.title ||
        o.title === "Order Processing..." ||
        o.title === "-" ||
        !o.image_url
    );

    if (ordersToEnrich.length === 0) {
      toast.info("All orders already have complete data");
      return;
    }

    setEnriching(true);
    setEnrichProgress({ current: 0, total: ordersToEnrich.length });

    // Fetch all inventory, created_listings, and fnsku_map for this user — PAGED
    // (Supabase caps each query at 1000 rows; without paging we silently miss
    // 80%+ of SKU→ASIN mappings on accounts with >1000 listings/inventory).
    const [inventoryData, createdListingsData, fnskuData] = await Promise.all([
      loadAllRows<any>(() =>
        supabase.from("inventory").select("asin, sku, title, image_url, cost, units, amount").eq("user_id", effectiveUserId)
      ),
      loadAllRows<any>(() =>
        supabase.from("created_listings").select("asin, sku, title, image_url, cost, units, amount").eq("user_id", effectiveUserId)
      ),
      loadAllRows<any>(() => supabase.from("fnsku_map").select("seller_sku, asin, fnsku")),
    ]);

    // Build lookup maps by SKU and ASIN
    const skuToData = new Map<string, { asin: string; title: string; image_url: string | null; unit_cost: number | null }>();
    const asinToData = new Map<string, { title: string; image_url: string | null; unit_cost: number | null }>();
    const skuToAsin = new Map<string, string>(); // SKU -> real ASIN from fnsku_map

    // Process fnsku_map first to build SKU -> ASIN mapping
    (fnskuData || []).forEach((item) => {
      if (item.seller_sku && item.asin) {
        skuToAsin.set(item.seller_sku, item.asin);
      }
    });

    // Process inventory — Contract A via getInventoryUnitCost (cost=UNIT, amount=TOTAL)
    (inventoryData || []).forEach((item) => {
      const unitCost = getInventoryUnitCost(item);
      if (item.sku) {
        skuToData.set(item.sku, { asin: item.asin, title: item.title, image_url: item.image_url, unit_cost: unitCost });
        // Also add to skuToAsin if not already there
        if (!skuToAsin.has(item.sku)) {
          skuToAsin.set(item.sku, item.asin);
        }
      }
      asinToData.set(item.asin, { title: item.title, image_url: item.image_url, unit_cost: unitCost });
    });

    // Process created_listings — Contract A via getListingUnitCost (cost=TOTAL, amount=UNIT)
    (createdListingsData || []).forEach((item) => {
      const unitCost = getListingUnitCost(item);
      if (item.sku) {
        skuToData.set(item.sku, { asin: item.asin, title: item.title, image_url: item.image_url, unit_cost: unitCost });
        if (!skuToAsin.has(item.sku)) {
          skuToAsin.set(item.sku, item.asin);
        }
      }
      asinToData.set(item.asin, { title: item.title, image_url: item.image_url, unit_cost: unitCost });
    });

    let enrichedCount = 0;

    for (let i = 0; i < ordersToEnrich.length; i++) {
      const order = ordersToEnrich[i];
      setEnrichProgress({ current: i + 1, total: ordersToEnrich.length });

      // Determine the real ASIN and SKU
      let realAsin = order.asin;
      let realSku = order.sku;

      // If ASIN looks like a numeric SKU, try to find the real ASIN
      if (isNumericSku(order.asin)) {
        const mappedAsin = skuToAsin.get(order.asin);
        if (mappedAsin) {
          realAsin = mappedAsin;
          realSku = order.asin; // The "asin" field actually contains the SKU
        }
      }

      // Also try to map the SKU field if it's numeric
      if (realSku && isNumericSku(realSku) && !skuToAsin.has(realSku)) {
        // SKU not found, try looking it up via the asin field if it was numeric
        const mappedAsin = skuToAsin.get(realSku);
        if (mappedAsin) {
          realAsin = mappedAsin;
        }
      }

      // Try to find matching data by SKU first, then by real ASIN
      let matchedData = realSku ? skuToData.get(realSku) : null;
      
      // If no match by SKU, try by the numeric ASIN (which is actually a SKU)
      if (!matchedData && isNumericSku(order.asin)) {
        matchedData = skuToData.get(order.asin);
      }
      
      // If still no match, try by real ASIN
      if (!matchedData && realAsin && realAsin !== "PENDING" && realAsin !== "UNKNOWN" && !isNumericSku(realAsin)) {
        const asinData = asinToData.get(realAsin);
        if (asinData) {
          matchedData = { asin: realAsin, ...asinData };
        }
      }

      // Build update object with only the fields that need updating
      const updates: Record<string, any> = {};

      // Fix the ASIN if it's numeric (actually a SKU) and we found the real ASIN
      if ((order.asin === "PENDING" || order.asin === "UNKNOWN" || isNumericSku(order.asin)) && realAsin && !isNumericSku(realAsin)) {
        updates.asin = realAsin;
      }

      // Fix SKU if the asin field contained the SKU
      if (isNumericSku(order.asin) && (!order.sku || order.sku === order.asin)) {
        updates.sku = order.asin; // Set SKU to the numeric value that was in ASIN
      }

      if (matchedData) {
        if ((!order.title || order.title === "Order Processing..." || order.title === "-") && matchedData.title) {
          updates.title = matchedData.title;
        }
        if (!order.image_url && matchedData.image_url) {
          updates.image_url = matchedData.image_url;
        }
        if ((!order.unit_cost || order.unit_cost === 0) && matchedData.unit_cost) {
          updates.unit_cost = matchedData.unit_cost;
        }
      }

      if (Object.keys(updates).length > 0) {
        const { error } = await supabase
          .from("sales_orders")
          .update(updates)
          .eq("id", order.id);

        if (!error) {
          enrichedCount++;
          // Update local state
          setOrders((prev) =>
            prev.map((o) => (o.id === order.id ? { ...o, ...updates } : o))
          );
        }
      }
    }

    setEnriching(false);
    setEnrichProgress({ current: 0, total: 0 });

    if (enrichedCount > 0) {
      toast.success(`Enriched ${enrichedCount} orders with data from inventory/listings/fnsku_map`);
      onCostUpdated?.();
    } else {
      toast.info("No matching data found in inventory, created listings, or fnsku_map");
    }
  };

  // Fetch missing data from Amazon APIs for orders that couldn't be enriched locally
  // IMPORTANT: we query the DB for missing rows to avoid stale UI state.
  const fetchFromAmazon = async () => {
    if (!effectiveUserId || !startDate || !endDate) return;

    setFetchingAmazon(true);

    try {
      // 1) Pull missing title/image rows from DB
      const { data: missingOrders, error: missingError } = await supabase
        .from("sales_orders")
        .select(
          "id, order_id, asin, sku, title, image_url, quantity, sold_price, total_fees, unit_cost, order_date, marketplace"
        )
        .eq("user_id", effectiveUserId)
        .gte("order_date", startDate)
        .lte("order_date", endDate)
        .not("order_id", "like", "%-REFUND%")
        .or(
          "title.is.null,title.eq.,title.eq.-,title.eq.Order Processing...,image_url.is.null,image_url.eq."
        )
        .order("order_date", { ascending: false });

      if (missingError) {
        console.error("Error fetching missing orders:", missingError);
        toast.error("Failed to fetch missing orders");
        return;
      }

      const ordersToFetch = (missingOrders || []) as OrderRecord[];

      if (ordersToFetch.length === 0) {
        toast.info("No missing title/image records found");
        return;
      }

      // 2) Load local mapping + cost authority (created_listings) — PAGED to
      //    bypass Supabase's 1000-row default cap. Without paging, dash-pattern
      //    seller SKUs (e.g. "M1-FKDT-3HBS") and amzn.gr.* IDs in the asin
      //    column never resolve to a real ASIN, so cost/title/image stay missing.
      // Contract A: include `amount` (= UNIT cost) so getListingUnitCost can prefer it over cost/units.
      const [createdListingsData, fnskuData] = await Promise.all([
        loadAllRows<any>(() =>
          supabase
            .from("created_listings")
            .select("asin, sku, cost, units, amount, image_url, title")
            .eq("user_id", effectiveUserId)
        ),
        loadAllRows<any>(() => supabase.from("fnsku_map").select("seller_sku, asin")),
      ]);

      const skuToAsin = new Map<string, string>();
      (fnskuData || []).forEach((row) => {
        if (row.seller_sku && row.asin) skuToAsin.set(row.seller_sku, row.asin);
      });

      const asinToListing = new Map<
        string,
        { cost: number | null; units: number | null; amount: number | null; image_url: string | null; title: string | null }
      >();
      const skuToListing = new Map<
        string,
        { asin: string; cost: number | null; units: number | null; amount: number | null; image_url: string | null; title: string | null }
      >();

      (createdListingsData || []).forEach((row) => {
        asinToListing.set(row.asin, {
          cost: row.cost,
          units: row.units,
          amount: row.amount,
          image_url: row.image_url,
          title: row.title,
        });
        if (row.sku) {
          skuToListing.set(row.sku, {
            asin: row.asin,
            cost: row.cost,
            units: row.units,
            amount: row.amount,
            image_url: row.image_url,
            title: row.title,
          });
          if (!skuToAsin.has(row.sku)) skuToAsin.set(row.sku, row.asin);
        }
      });

      const marketplaceIdFor = (m: string | null) => {
        if (m === "CA") return "A2EUQ1WTGCTBG2";
        if (m === "MX") return "A1AM78C64UM0Y8";
        return "ATVPDKIKX0DER"; // US
      };

      const isValidAsin = (value: string) => /^[A-Z0-9]{10}$/i.test(value);

      // 3) Partition: needs Orders API vs can use Catalog API now
      const ordersNeedingAsin: OrderRecord[] = [];
      const asinMarketKeyToOrders = new Map<string, OrderRecord[]>(); // key = `${marketplaceId}:${asin}`

      const addToCatalogMap = (asin: string, order: OrderRecord) => {
        const marketplaceId = marketplaceIdFor(order.marketplace);
        const key = `${marketplaceId}:${asin}`;
        const list = asinMarketKeyToOrders.get(key) || [];
        list.push(order);
        asinMarketKeyToOrders.set(key, list);
      };

      for (const order of ordersToFetch) {
        let realAsin = order.asin;

        // numeric ASINs are actually SKUs
        if (isNumericSku(order.asin)) {
          const mapped = skuToAsin.get(order.asin) || (order.sku ? skuToAsin.get(order.sku) : undefined);
          if (mapped) realAsin = mapped;
          else {
            ordersNeedingAsin.push(order);
            continue;
          }
        }

        if (!realAsin || realAsin === "PENDING" || realAsin === "UNKNOWN") {
          ordersNeedingAsin.push(order);
          continue;
        }

        // We'll only call Catalog for valid ASIN format
        if (isValidAsin(realAsin)) {
          addToCatalogMap(realAsin, order);
        }
      }

      // Progress = order batches + catalog calls
      const uniqueOrderIds = [...new Set(ordersNeedingAsin.map((o) => o.order_id))];
      const batchSize = 20;
      const orderBatches = Math.ceil(uniqueOrderIds.length / batchSize);
      const totalWork = Math.max(orderBatches + asinMarketKeyToOrders.size, 1);

      let processed = 0;
      let updated = 0;
      setEnrichProgress({ current: 0, total: totalWork });

      // 4) Step 1: resolve ASIN via Orders API (GetOrderItems)
      for (let i = 0; i < uniqueOrderIds.length; i += batchSize) {
        const batch = uniqueOrderIds.slice(i, i + batchSize);
        processed++;
        setEnrichProgress({ current: processed, total: totalWork });

        const { data, error } = await supabase.functions.invoke("get-order-items", {
          body: { orderIds: batch },
        });

        if (error || !data?.results) {
          console.warn("get-order-items failed:", error);
          continue;
        }

        for (const orderId of Object.keys(data.results)) {
          const items = data.results[orderId] as { asin: string; sku: string; title: string }[];
          if (!items || items.length === 0) continue;

          const matchingOrders = ordersNeedingAsin.filter((o) => o.order_id === orderId);

          for (const order of matchingOrders) {
            const item = items.find((it) => it.sku === order.asin || it.sku === order.sku) || items[0];
            if (!item?.asin) continue;

            const updates: Record<string, any> = {
              asin: item.asin,
              sku: item.sku || order.sku || order.asin,
            };

            if ((!order.title || order.title === "-" || order.title === "Order Processing...") && item.title) {
              updates.title = item.title;
            }

            // Unit cost from created_listings only (authoritative — Contract A via helper)
            const listing = asinToListing.get(item.asin) || (item.sku ? skuToListing.get(item.sku) : undefined);
            if ((!order.unit_cost || order.unit_cost === 0) && listing) {
              const unitCost = getListingUnitCost(listing);
              if (unitCost != null && unitCost > 0) updates.unit_cost = unitCost;
            }

            // Prefer local image/title if available in created_listings
            if (!order.image_url && listing?.image_url) updates.image_url = listing.image_url;
            if ((!order.title || order.title === "-") && listing?.title) updates.title = listing.title;

            const { error: updateError } = await supabase.from("sales_orders").update(updates).eq("id", order.id);
            if (!updateError) {
              updated++;
              setOrders((prev) => prev.map((o) => (o.id === order.id ? { ...o, ...updates } : o)));

              // If still missing image and ASIN format is valid, schedule Catalog fetch
              const nextAsin = updates.asin as string;
              const nextImage = updates.image_url as string | undefined;
              if (!nextImage && isValidAsin(nextAsin)) {
                addToCatalogMap(nextAsin, { ...order, ...updates });
              }
            }
          }
        }

        // gentle pacing
        if (i + batchSize < uniqueOrderIds.length) {
          await new Promise((r) => setTimeout(r, 800));
        }
      }

      // 5) Step 2: catalog lookups for images/titles
      for (const [key, ordersForKey] of asinMarketKeyToOrders.entries()) {
        processed++;
        setEnrichProgress({ current: processed, total: totalWork });

        const [marketplaceId, asin] = key.split(":");

        const { data, error } = await supabase.functions.invoke("fetch-product-price", {
          body: { asin, marketplaceId },
        });

        if (error || data?.error) {
          console.warn(`fetch-product-price failed for ${asin}:`, error || data?.error);
          continue;
        }

        for (const order of ordersForKey) {
          const updates: Record<string, any> = {};

          if ((!order.title || order.title === "-" || order.title === "Order Processing...") && data.title) {
            updates.title = data.title;
          }
          if (!order.image_url && data.imageUrl) {
            updates.image_url = data.imageUrl;
          }

          // Unit cost from created_listings if present (Contract A via helper)
          const listing = asinToListing.get(asin) || (order.sku ? skuToListing.get(order.sku) : undefined);
          if ((!order.unit_cost || order.unit_cost === 0) && listing) {
            const unitCost = getListingUnitCost(listing);
            if (unitCost != null && unitCost > 0) updates.unit_cost = unitCost;
          }

          if (Object.keys(updates).length === 0) continue;

          const { error: updateError } = await supabase.from("sales_orders").update(updates).eq("id", order.id);
          if (!updateError) {
            updated++;
            setOrders((prev) => prev.map((o) => (o.id === order.id ? { ...o, ...updates } : o)));
          }
        }

        await new Promise((r) => setTimeout(r, 200));
      }

      if (updated > 0) {
        toast.success(`Updated ${updated} order(s) with Amazon/local data`);
        onCostUpdated?.();
        await fetchOrders();
      } else {
        toast.info("No additional data found for remaining orders");
      }
    } finally {
      setFetchingAmazon(false);
      setEnrichProgress({ current: 0, total: 0 });
    }
  };

  // Server-side bulk backfill — resolves SKU→ASIN via fnsku_map and pulls
  // unit_cost / title / image from created_listings + inventory in one pass,
  // bypassing any 1000-row UI cap.
  const runBackfillFromLibrary = async () => {
    if (!effectiveUserId || !startDate || !endDate) return;
    setBackfilling(true);
    const toastId = toast.loading("Backfilling from your Library and Inventory…");
    try {
      const { data, error } = await supabase.functions.invoke(
        "backfill-orders-cost",
        { body: { startDate, endDate } }
      );
      if (error) {
        toast.error(`Backfill failed: ${error.message}`, { id: toastId });
        return;
      }
      const scanned = data?.scanned ?? 0;
      const updated = data?.updated ?? 0;
      const f = data?.by_field ?? {};
      toast.success(
        `Backfill complete — scanned ${scanned}, updated ${updated} (cost: ${f.unit_cost ?? 0}, asin: ${f.asin ?? 0}, title: ${f.title ?? 0}, image: ${f.image_url ?? 0})`,
        { id: toastId, duration: 6000 }
      );
      await fetchOrders();
      onCostUpdated?.();
    } catch (err) {
      toast.error(`Backfill error: ${(err as Error).message}`, { id: toastId });
    } finally {
      setBackfilling(false);
    }
  };

  // Count orders missing data (including numeric ASINs which are actually SKUs)
  const missingDataCount = orders.filter(
    (o) => 
      o.asin === "PENDING" || 
      o.asin === "UNKNOWN" ||
      isNumericSku(o.asin) || 
      !o.title || 
      o.title === "Order Processing..." || 
      o.title === "-" ||
      !o.image_url
  ).length;

  /**
   * An order counts as missing a cost only when the P&L cannot resolve one.
   *
   * When the resolver is unavailable we fall back to the stored cost, but the
   * UI says so rather than quietly reverting to the old, over-reporting rule.
   */
  const effectiveCost = (o: OrderRecord): number => {
    if (typeof o.resolved_unit_cost === "number") return o.resolved_unit_cost;
    return Number(o.unit_cost) || 0;
  };
  const missingCostOrders = orders.filter((o) => effectiveCost(o) <= 0);
  const displayOrders = showMissingOnly ? missingCostOrders : orders;

  const missingCount = missingCostOrders.length;
  const hasChanges = Object.keys(editedCosts).length > 0;

  // Group missing cost orders by ASIN
  const groupedByAsin = (() => {
    const groups = new Map<string, { asin: string; sku: string | null; title: string | null; image_url: string | null; orders: OrderRecord[]; totalQty: number }>();
    for (const order of missingCostOrders) {
      const key = order.asin;
      const existing = groups.get(key);
      if (existing) {
        existing.orders.push(order);
        existing.totalQty += order.quantity;
        // Prefer populated title/image
        if (!existing.title && order.title) existing.title = order.title;
        if (!existing.image_url && order.image_url) existing.image_url = order.image_url;
        if (!existing.sku && order.sku) existing.sku = order.sku;
      } else {
        groups.set(key, {
          asin: order.asin,
          sku: order.sku,
          title: order.title,
          image_url: order.image_url,
          orders: [order],
          totalQty: order.quantity,
        });
      }
    }
    // Sort by order count descending
    return Array.from(groups.values()).sort((a, b) => b.orders.length - a.orders.length);
  })();

  return (
    <Card className="mt-6">
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="flex items-center gap-2">
            <AlertCircle className="h-5 w-5 text-orange-500" />
            Orders Cost Editor
            {missingCount > 0 && (
              <Badge
                variant="destructive"
                className="ml-2"
                title="Orders in this date range with no unit cost recorded — these are the ones that affect COGS."
              >
                {missingCount} missing cost
              </Badge>
            )}
            {missingDataCount > 0 && (
              <Badge
                variant="secondary"
                className="ml-1"
                title="Orders missing display metadata only (ASIN placeholder, title, or image). Does NOT affect COGS or P&L — cosmetic enrichment only."
              >
                {missingDataCount} missing metadata
              </Badge>
            )}
          </CardTitle>
          <div className="flex items-center gap-4 flex-wrap">
            <Button
              onClick={runBackfillFromLibrary}
              size="lg"
              variant="default"
              disabled={enriching || fetchingAmazon || backfilling}
              title="Resolve every missing-cost order in this date range using your fnsku map, Product Library and Inventory (server-side, no row limit)"
              className="bg-green-600 hover:bg-green-700 text-white font-bold text-base px-6 py-6 shadow-lg shadow-green-600/30 ring-2 ring-green-400/40"
            >
              {backfilling ? (
                <>
                  <Loader2 className="h-5 w-5 mr-2 animate-spin" />
                  Backfilling…
                </>
              ) : (
                <>
                  <RefreshCw className="h-5 w-5 mr-2" />
                  Backfill from Library
                </>
              )}
            </Button>
            <Button 
              onClick={enrichOrdersData} 
              size="sm" 
              variant="outline"
              disabled={enriching || fetchingAmazon || backfilling || missingDataCount === 0}
            >
              {enriching ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  {enrichProgress.current}/{enrichProgress.total}
                </>
              ) : (
                <>
                  <RefreshCw className="h-4 w-4 mr-2" />
                  Enrich Data
                </>
              )}
            </Button>
            <Button 
              onClick={fetchFromAmazon} 
              size="sm" 
              variant="outline"
              disabled={enriching || fetchingAmazon || backfilling || missingDataCount === 0}
            >
              {fetchingAmazon ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  {enrichProgress.current}/{enrichProgress.total}
                </>
              ) : (
                <>
                  <CloudDownload className="h-4 w-4 mr-2" />
                  Fetch from Amazon
                </>
              )}
            </Button>
            <div className="flex items-center gap-2">
              <Switch
                id="group-asin"
                checked={groupByAsin}
                onCheckedChange={setGroupByAsin}
                disabled={!showMissingOnly}
              />
              <Label htmlFor="group-asin" className="text-sm">
                Group by ASIN
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                id="show-missing"
                checked={showMissingOnly}
                onCheckedChange={(checked) => {
                  setShowMissingOnly(checked);
                  if (!checked) setGroupByAsin(false);
                }}
              />
              <Label htmlFor="show-missing" className="text-sm">
                Show missing only
              </Label>
            </div>
            {hasChanges && (
              <Button onClick={saveAllCosts} size="sm">
                <Save className="h-4 w-4 mr-2" />
                Save All ({Object.keys(editedCosts).length})
              </Button>
            )}
          </div>
        </div>
        <p className="text-sm text-muted-foreground mt-2">
          Add unit cost for orders to calculate accurate COGS. Date range: {startDate} to {endDate}
        </p>
        {effectiveUserId !== userId && (
          <p className="text-xs text-muted-foreground">
            Note: viewing orders for your current login ({effectiveUserId}).
          </p>
        )}
        {enriching && (
          <Progress value={(enrichProgress.current / enrichProgress.total) * 100} className="mt-2" />
        )}
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin mr-2" />
            Loading orders...
          </div>
        ) : displayOrders.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
            <CheckCircle2 className="h-8 w-8 text-green-500 mb-2" />
            {showMissingOnly
              ? "All orders have cost data!"
              : "No orders found for this period."}
          </div>
        ) : groupByAsin && showMissingOnly ? (
          <div className="rounded-md border overflow-auto max-h-[500px]">
            <Table>
              <TableHeader className="sticky top-0 bg-background z-10">
                <TableRow>
                  <TableHead className="w-[80px]">Image</TableHead>
                  <TableHead>ASIN / SKU</TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead className="text-center">Orders</TableHead>
                  <TableHead className="text-center">Units</TableHead>
                  <TableHead className="w-[140px]">Unit Cost ({homeCurrencySymbol})</TableHead>
                  <TableHead className="w-[80px]">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {groupedByAsin.map((group) => {
                  const currentCost = editedCosts[`group-${group.asin}`] ?? "";
                  const hasUnsavedChange = editedCosts[`group-${group.asin}`] !== undefined && editedCosts[`group-${group.asin}`] !== "";
                  const isSaving = savingIds.has(`group-${group.asin}`);

                  return (
                    <TableRow key={group.asin} className="bg-orange-50/50 dark:bg-orange-950/20">
                      <TableCell>
                        {group.image_url ? (
                          <img
                            src={group.image_url}
                            alt={group.title || group.asin}
                            className="w-12 h-12 object-contain rounded"
                          />
                        ) : (
                          <div className="w-12 h-12 bg-muted rounded flex items-center justify-center text-xs">
                            No img
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="font-mono text-sm">{group.asin}</div>
                        {group.sku && (
                          <div className="text-xs text-muted-foreground">{group.sku}</div>
                        )}
                      </TableCell>
                      <TableCell className="max-w-[200px]">
                        <div className="truncate text-sm" title={group.title || undefined}>
                          {group.title || "-"}
                        </div>
                      </TableCell>
                      <TableCell className="text-center">
                        <Badge variant="secondary">{group.orders.length}</Badge>
                      </TableCell>
                      <TableCell className="text-center">{group.totalQty}</TableCell>
                      <TableCell>
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          placeholder="0.00"
                          value={currentCost}
                          onChange={(e) => handleCostChange(`group-${group.asin}`, e.target.value)}
                          className="w-full border-orange-400"
                          disabled={isSaving}
                        />
                      </TableCell>
                      <TableCell>
                        <Button
                          size="sm"
                          variant={hasUnsavedChange ? "default" : "ghost"}
                          onClick={() => saveGroupCost(group)}
                          disabled={!hasUnsavedChange || isSaving}
                        >
                          {isSaving ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Save className="h-4 w-4" />
                          )}
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        ) : (
          <div className="rounded-md border overflow-auto max-h-[500px]">
            <Table>
              <TableHeader className="sticky top-0 bg-background z-10">
                <TableRow>
                  <TableHead className="w-[80px]">Image</TableHead>
                  <TableHead>ASIN / SKU</TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead className="text-center">Qty</TableHead>
                  <TableHead className="text-right">Price</TableHead>
                  <TableHead className="text-right">Fees</TableHead>
                  <TableHead className="w-[140px]">Unit Cost ({homeCurrencySymbol})</TableHead>
                  <TableHead className="w-[80px]">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {displayOrders.map((order) => {
                  const currentCost = editedCosts[order.id] ?? (order.unit_cost?.toString() || "");
                  const hasUnsavedChange =
                    editedCosts[order.id] !== undefined &&
                    editedCosts[order.id] !== (order.unit_cost?.toString() || "");
                  const isSaving = savingIds.has(order.id);
                  // Highlight only what the P&L genuinely cannot cost. A stored
                  // cost of 0 that resolves from cost_history or a listing is
                  // NOT missing -- flagging those is what drove the pointless
                  // backfill loop.
                  const hasCost = effectiveCost(order) > 0;
                  const inheritedFrom =
                    hasCost && !(order.unit_cost && order.unit_cost > 0)
                      ? order.resolved_source
                      : null;

                  return (
                    <TableRow key={order.id} className={!hasCost ? "bg-orange-50/50 dark:bg-orange-950/20" : ""}>
                      <TableCell>
                        {order.image_url ? (
                          <img
                            src={order.image_url}
                            alt={order.title || order.asin}
                            className="w-12 h-12 object-contain rounded"
                          />
                        ) : (
                          <div className="w-12 h-12 bg-muted rounded flex items-center justify-center text-xs">
                            No img
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="font-mono text-sm">{order.asin}</div>
                        {order.sku && (
                          <div className="text-xs text-muted-foreground">{order.sku}</div>
                        )}
                        <div className="text-xs text-muted-foreground">
                          {order.order_date}
                        </div>
                      </TableCell>
                      <TableCell className="max-w-[200px]">
                        <div className="truncate text-sm" title={order.title || undefined}>
                          {order.title || "-"}
                        </div>
                        {order.marketplace && (
                          <Badge variant="outline" className="mt-1 text-xs">
                            {order.marketplace}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-center">{order.quantity}</TableCell>
                      <TableCell className="text-right">
                        {formatNativeCurrency(order.sold_price, order.marketplace)}
                      </TableCell>
                      <TableCell className="text-right text-red-600">
                        {formatNativeCurrency(order.total_fees, order.marketplace)}
                      </TableCell>
                      <TableCell>
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          placeholder="0.00"
                          value={currentCost}
                          onChange={(e) => handleCostChange(order.id, e.target.value)}
                          className={`w-full ${!hasCost && !editedCosts[order.id] ? "border-orange-400" : ""}`}
                          disabled={isSaving}
                        />
                        {/* This order has no stored cost but the P&L costs it
                            anyway, from the source named here. Saying so is the
                            difference between "no cost" and "cost came from
                            somewhere other than this box". */}
                        {inheritedFrom && (
                          <span className="mt-0.5 block text-[10px] text-muted-foreground">
                            from {inheritedFrom}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Button
                          size="sm"
                          variant={hasUnsavedChange ? "default" : "ghost"}
                          onClick={() => saveCost(order)}
                          disabled={!hasUnsavedChange || isSaving}
                        >
                          {isSaving ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Save className="h-4 w-4" />
                          )}
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
        <div className="mt-4 text-sm text-muted-foreground">
          {groupByAsin && showMissingOnly
            ? `${groupedByAsin.length} unique ASINs across ${missingCount} orders missing cost`
            : `Showing ${displayOrders.length} of ${orders.length} orders`}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {resolveUnavailable
            ? "Could not reach the cost resolver — counts above reflect stored costs only and may overstate what is missing."
            : "“Missing” means the P&L cannot resolve a cost from any source — stored cost, manual override, cost history, purchase batches, listings or inventory. An order with a blank box here is not missing a cost if it resolves from one of the others."}
        </p>
      </CardContent>
    </Card>
  );
}
