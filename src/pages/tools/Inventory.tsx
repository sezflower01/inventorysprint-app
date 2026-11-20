import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import type { Json } from "@/integrations/supabase/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { toast } from "@/hooks/use-toast";
import { Helmet } from "react-helmet-async";
import { Trash2, Plus, RefreshCw, Calculator, Package, TrendingUp } from "lucide-react";
import { ActualRoiCalculatorDialog } from "@/components/inventory/ActualRoiCalculatorDialog";
import { CostSourceBadge } from "@/components/inventory/CostSourceBadge";
import { ApplyToPurchaseButton } from "@/components/inventory/ApplyToPurchaseButton";
import { CreatePurchaseFromCostButton } from "@/components/inventory/CreatePurchaseFromCostButton";
import { RevertToPurchaseButton } from "@/components/inventory/RevertToPurchaseButton";
import { useAsinPurchaseRecords } from "@/hooks/use-asin-purchase-records";
import { calculateReplenishQty } from "@/lib/replenishment";
import { getListingUnitCost, getInventoryUnitCost } from "@/lib/cost-contract";

interface InventoryItem {
  id: string;
  asin: string;
  sku: string;
  fnsku: string | null;
  title: string;
  image_url: string | null;
  price: number | null;
  cost: number | null;
  amount: number | null;
  units: number | null;
  available: number | null;
  reserved: number | null;
  inbound: number | null;
  unfulfilled: number | null;
  supplier_links: Array<{ link: string; discount_code: string }>;
  created_at: string;
  updated_at: string;
  unit_cost: number | null;
  fees_json: any;
  sales_30d?: number; // units sold in selected period
  listing_created_at?: string | null; // Amazon listing creation date
  last_inventory_sync_at?: string | null; // Last sync timestamp
  historical_sales?: number; // total units sold historically
  historical_days?: number; // days since first sale
  // Phase 7 — Operational Cost Override Layer
  unit_cost_manual?: boolean | null;
  manual_cost_updated_at?: string | null;
  manual_cost_source?: string | null;
  manual_cost_reason?: string | null;
  // Ghost audit fields (soft-delete history)
  listing_status?: string | null;
  ghost_reason?: string | null;
  ghosted_at?: string | null;
  ghost_source?: string | null;
  deleted_reason?: string | null;
}

export default function Inventory() {
  const { user } = useAuth();
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [updatingPrice, setUpdatingPrice] = useState<string | null>(null);

  // Phase 7+ — which ASINs have a Created Listing? Drives badge label and
  // "Create purchase record" CTA visibility.
  const { hasPurchaseRecord } = useAsinPurchaseRecords(
    inventory.map((i) => i.asin).filter(Boolean),
  );
  const [editingCost, setEditingCost] = useState<string | null>(null);
  const [editedCostValue, setEditedCostValue] = useState("");
  const [editingUnitCost, setEditingUnitCost] = useState<string | null>(null);
  const [editedUnitCostValue, setEditedUnitCostValue] = useState("");
  const [editedUnitCostReason, setEditedUnitCostReason] = useState("");
  const [showOverriddenOnly, setShowOverriddenOnly] = useState(false);
  const [showGhostsOnly, setShowGhostsOnly] = useState(false);
  const [editingSuppliers, setEditingSuppliers] = useState<string | null>(null);
  const [editedSuppliers, setEditedSuppliers] = useState<Array<{ link: string; discount_code: string }>>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(50);
  const [sortBy, setSortBy] = useState<'available' | 'roi' | 'replenish' | 'created' | null>(null);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [stockFilter, setStockFilter] = useState<'all' | 'in-stock' | 'out-of-stock' | 'needs-replenish'>('all');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkUpdating, setBulkUpdating] = useState(false);
  const [frozenSortOrder, setFrozenSortOrder] = useState<string[] | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [salesPeriodDays, setSalesPeriodDays] = useState(30); // Custom sales period for replenishment
  const [fullSyncing, setFullSyncing] = useState(false);
  const [fullSyncProgress, setFullSyncProgress] = useState<{ message: string; current: number; total: number } | null>(null);

  const syncFromAmazon = async () => {
    try {
      setSyncing(true);
      toast({
        title: "Syncing inventory",
        description: "Fetching latest inbound, reserved & available units from Amazon...",
      });
      
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        throw new Error("Not authenticated");
      }

      const response = await supabase.functions.invoke('sync-amazon-inventory', {
        headers: { Authorization: `Bearer ${session.access_token}` }
      });

      if (response.error) throw response.error;

      const processed = response.data?.processed ?? 0;
      const titlesEnriched = response.data?.titlesEnriched ?? 0;
      const assignmentBackfillCreated = response.data?.assignmentBackfillCreated ?? 0;
      const assignmentBackfillReenabled = response.data?.assignmentBackfillReenabled ?? 0;
      const assignmentMsg = assignmentBackfillCreated > 0 || assignmentBackfillReenabled > 0
        ? ` Backfilled ${assignmentBackfillCreated} missing assignments${assignmentBackfillReenabled > 0 ? ` and re-enabled ${assignmentBackfillReenabled}` : ''}.`
        : '';
      const desc = titlesEnriched > 0 
        ? `Updated quantities for ${processed} items. Fixed ${titlesEnriched} missing titles.${assignmentMsg}`
        : `Updated quantities for ${processed} items from Amazon.${assignmentMsg}`;
      toast({
        title: "Inventory synced",
        description: desc,
      });
      await fetchInventory();
    } catch (error: any) {
      console.error("Sync error:", error);
      toast({
        variant: "destructive",
        title: "Sync failed",
        description: error?.message ?? "Unable to sync inventory from Amazon.",
      });
    } finally {
      setSyncing(false);
    }
  };

  // Full Quantity Sync using Reports API (for ALL SKUs including zero-qty)
  const fullQuantitySync = async () => {
    try {
      setFullSyncing(true);
      setFullSyncProgress({ message: "Starting full inventory sync...", current: 0, total: 6 });
      
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        throw new Error("Not authenticated");
      }

      const response = await supabase.functions.invoke('sync-inventory-report', {
        headers: { Authorization: `Bearer ${session.access_token}` }
      });

      if (response.error) throw response.error;

      const progressId = response.data?.progressId;
      if (!progressId) {
        throw new Error("No progress ID returned");
      }

      toast({
        title: "Full sync started",
        description: "Requesting inventory report from Amazon. This may take a few minutes...",
      });

      // Poll for progress
      const pollInterval = setInterval(async () => {
        try {
          const { data: progress, error: progressError } = await supabase
            .from('pl_sync_progress')
            .select('status, message, current_chunk, total_chunks, error')
            .eq('id', progressId)
            .single();

          if (progressError) {
            console.error("Progress poll error:", progressError);
            return;
          }

          if (progress) {
            setFullSyncProgress({
              message: progress.message || "Syncing...",
              current: progress.current_chunk || 0,
              total: progress.total_chunks || 6,
            });

            if (progress.status === 'complete') {
              clearInterval(pollInterval);
              setFullSyncing(false);
              setFullSyncProgress(null);
              toast({
                title: "Full sync complete",
                description: progress.message || "All inventory quantities updated.",
              });
              await fetchInventory();
            } else if (progress.status === 'error') {
              clearInterval(pollInterval);
              setFullSyncing(false);
              setFullSyncProgress(null);
              toast({
                variant: "destructive",
                title: "Full sync failed",
                description: progress.error || progress.message || "Unknown error",
              });
            }
          }
        } catch (pollError) {
          console.error("Poll error:", pollError);
        }
      }, 2000);

      // Safety timeout after 10 minutes
      setTimeout(() => {
        clearInterval(pollInterval);
        if (fullSyncing) {
          setFullSyncing(false);
          setFullSyncProgress(null);
          toast({
            variant: "destructive",
            title: "Sync timeout",
            description: "The sync is taking too long. Check logs for details.",
          });
        }
      }, 600000);

    } catch (error: any) {
      console.error("Full sync error:", error);
      setFullSyncing(false);
      setFullSyncProgress(null);
      toast({
        variant: "destructive",
        title: "Full sync failed",
        description: error?.message ?? "Unable to start full inventory sync.",
      });
    }
  };
  
  // Clear frozen sort when user changes sort criteria or page
  useEffect(() => {
    setFrozenSortOrder(null);
  }, [sortBy, sortDirection, currentPage]);
  const [roiDialogOpen, setRoiDialogOpen] = useState(false);
  const [selectedRoiItem, setSelectedRoiItem] = useState<InventoryItem | null>(null);

  useEffect(() => {
    if (user) {
      fetchInventory();
    }
  }, [user]);

  const fetchInventory = async () => {
    try {
      setLoading(true);
      console.log("Fetching inventory with batched ranges...");

      // Fetch inventory records in batches to avoid 1000-row limit
      const batchSize = 1000;
      let from = 0;
      let allItems: any[] = [];
      let hasMore = true;
      let batchIndex = 0;
      const seenIds = new Set<string>();

      while (hasMore) {
        console.log(`Fetching inventory batch ${batchIndex + 1}, range ${from}-${from + batchSize - 1}`);
        const { data, error } = await supabase
          .from("inventory")
          .select("*")
          .eq('user_id', user?.id)
          .order("created_at", { ascending: false })
          // created_at is not unique, so it cannot order pages on its own:
          // a tie spanning a page boundary repeats or skips rows. id breaks it.
          .order("id", { ascending: true })
          .range(from, from + batchSize - 1);

        if (error) {
          console.error("Fetch error:", error);
          throw error;
        }

        const batchLength = data?.length || 0;
        console.log(`Received batch ${batchIndex + 1} with ${batchLength} records`);

        if (batchLength === 0) {
          hasMore = false;
        } else {
          // Filter out duplicates by ID
          const uniqueItems = (data || []).filter((item: any) => {
            if (seenIds.has(item.id)) {
              console.warn(`Duplicate ID found: ${item.id}, skipping`);
              return false;
            }
            seenIds.add(item.id);
            return true;
          });

          allItems = allItems.concat(uniqueItems);

          if (batchLength < batchSize) {
            hasMore = false;
          } else {
            from += batchSize;
            batchIndex += 1;

            // Safety guard: don't fetch more than 20,000 records
            if (batchIndex >= 20) {
              console.warn("Reached maximum batch limit (20). Stopping further fetches.");
              hasMore = false;
            }
          }
        }
      }

      console.log("Total fetched inventory records:", allItems.length);

      // Identify items missing cost/units data that need enrichment from created_listings
      const itemsNeedingEnrichment = allItems.filter(
        (item: any) => item.amount === null || item.units === null
      );

      console.log(`Found ${itemsNeedingEnrichment.length} items needing cost/units enrichment from created_listings`);

      // Batch fetch and update missing cost/units data
      if (itemsNeedingEnrichment.length > 0) {
        const asinsToEnrich = Array.from(
          new Set(itemsNeedingEnrichment.map((item: any) => item.asin))
        );

        console.log(`Fetching created_listings data for ${asinsToEnrich.length} unique ASINs...`);

        // Fetch all created_listings rows for these ASINs
        const { data: createdListingsData } = await supabase
          .from("created_listings")
          .select("asin, cost, units, created_at")
          .in("asin", asinsToEnrich)
          .order("created_at", { ascending: false });

        if (createdListingsData && createdListingsData.length > 0) {
          // Group by ASIN and pick most recent row with units > 0
          const asinToCostMap = new Map<string, { cost: number; units: number }>();

          createdListingsData.forEach((row: any) => {
            if (!row.asin || asinToCostMap.has(row.asin)) return;

            // Find first row with units > 0 for this ASIN
            const rowWithUnits = (createdListingsData as any[])
              .filter((r: any) => r.asin === row.asin && r.units && r.units > 0)
              .sort(
                (a: any, b: any) =>
                  new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
              )[0];

            if (rowWithUnits?.cost && rowWithUnits?.units) {
              asinToCostMap.set(row.asin, {
                cost: Number(rowWithUnits.cost),
                units: Number(rowWithUnits.units),
              });
            }
          });

          console.log(
            `Mapped cost/units for ${asinToCostMap.size} ASINs, updating inventory table...`
          );

          // Batch update inventory table with cost/units from created_listings
          const updatePromises = itemsNeedingEnrichment
            .map((item: any) => {
              const costData = asinToCostMap.get(item.asin);
              if (!costData) return null;

              return supabase
                .from("inventory")
                .update({
                  amount: costData.cost,
                  units: costData.units,
                })
                .eq("id", item.id);
            })
            .filter(Boolean);

          if (updatePromises.length > 0) {
            await Promise.all(updatePromises);
            console.log(
              `Successfully enriched ${updatePromises.length} inventory items with cost/units data`
            );
            // NOTE: we intentionally do NOT re-fetch inventory here to avoid 1000-row cap;
            // allItems already contains the full dataset for this session.
          }
        }
      }

      // Build unique ASIN list from inventory

      // Build unique ASIN list from inventory
      const uniqueAsins = Array.from(
        new Set(
          allItems
            .map((item) => item.asin)
            .filter((asin: string | null | undefined) => !!asin)
        )
      ) as string[];

      // Build a simple ASIN -> data map from Created Listings for this user
      // For each ASIN, use the most recent row that has actual Units data
      const costMap = new Map<string, { unitCost: number | null; totalCost: number | null; units: number | null; fees: any; image_url: string | null; price: number | null }>();
 
      try {
        const { data: clData, error: clError } = await supabase
          .from("created_listings")
          .select("asin, cost, units, image_url, price, created_at")
          .eq('user_id', user?.id)
          .order("created_at", { ascending: false }); // Most recent first

        if (clError) {
          console.error("Error fetching created listings for cost map:", clError);
        } else {
          clData?.forEach((clItem: any) => {
            if (!clItem.asin) return;
 
            // Skip if we already have a complete entry for this ASIN with units data
            const existing = costMap.get(clItem.asin);
            if (existing && existing.units !== null && existing.units > 0) return;
 
            // On Created Listings page (Contract A):
            //   cost = TOTAL batch cost, amount = UNIT cost, units = purchase qty
            // Use getListingUnitCost helper to derive UNIT cost.
            const totalCost =
              clItem.cost !== null && clItem.cost !== undefined ? Number(clItem.cost) : null;
            const units =
              clItem.units !== null && clItem.units !== undefined ? Number(clItem.units) : null;
 
            const unitCost = getListingUnitCost({
              cost: totalCost,
              units,
              amount: (clItem as any).amount,
            });
 
            // Only set/update if this row has units OR we don't have any entry yet
            if (units !== null && units > 0) {
              // This row has units - use it
              costMap.set(clItem.asin, {
                unitCost,
                totalCost,
                units,
                fees: null,
                image_url: clItem.image_url || null,
                price: clItem.price !== null ? Number(clItem.price) : null,
              });
            } else if (!existing) {
              // No entry yet - set even if units is null (better than nothing)
              costMap.set(clItem.asin, {
                unitCost,
                totalCost,
                units,
                fees: null,
                image_url: clItem.image_url || null,
                price: clItem.price !== null ? Number(clItem.price) : null,
              });
            }
          });
        }
 
        console.log("Cost map size from Created Listings (most recent with units per ASIN):", costMap.size, "Sample B0D1YM8D4Q:", costMap.get("B0D1YM8D4Q"));
      } catch (e) {
        console.error("Unexpected error while building cost map from Created Listings:", e);
      }
 
      // Fetch sales data by ASIN based on selected period
      const periodStartDate = new Date();
      periodStartDate.setDate(periodStartDate.getDate() - salesPeriodDays);
      const periodStartStr = periodStartDate.toISOString().split('T')[0];
      
      const { data: salesData } = await supabase
        .from('sales_orders')
        .select('asin, quantity')
        .eq('user_id', user?.id)
        .gte('order_date', periodStartStr);
      
      // Aggregate sales by ASIN for selected period
      const salesMap = new Map<string, number>();
      salesData?.forEach((sale: any) => {
        if (sale.asin && sale.asin !== 'PENDING') {
          const current = salesMap.get(sale.asin) || 0;
          salesMap.set(sale.asin, current + (sale.quantity || 1));
        }
      });
      
      console.log(`Fetched ${salesPeriodDays}-day sales for ${salesMap.size} ASINs`);

      // Fetch ALL historical sales (no date filter) for historical velocity fallback
      const { data: allSalesData } = await supabase
        .from('sales_orders')
        .select('asin, quantity, order_date')
        .eq('user_id', user?.id);
      
      // Aggregate historical sales by ASIN and track earliest order date
      const historicalSalesMap = new Map<string, { totalUnits: number; earliestDate: string }>();
      allSalesData?.forEach((sale: any) => {
        if (sale.asin && sale.asin !== 'PENDING') {
          const current = historicalSalesMap.get(sale.asin);
          if (current) {
            current.totalUnits += (sale.quantity || 1);
            if (sale.order_date < current.earliestDate) {
              current.earliestDate = sale.order_date;
            }
          } else {
            historicalSalesMap.set(sale.asin, {
              totalUnits: sale.quantity || 1,
              earliestDate: sale.order_date,
            });
          }
        }
      });

      console.log(`Fetched historical sales for ${historicalSalesMap.size} ASINs`);

      // Calculate days since first sale for each ASIN
      const today = new Date();
      const getHistoricalDays = (earliestDate: string): number => {
        const firstSaleDate = new Date(earliestDate);
        const diffMs = today.getTime() - firstSaleDate.getTime();
        return Math.max(1, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
      };

      const formattedData = allItems.map(item => {
        const costEntry = costMap.get(item.asin);
 
        // Check if unit_cost was manually edited - if so, preserve it
        let finalUnitCost: number | null;
        if (item.unit_cost_manual && item.cost !== null && item.cost !== undefined) {
          // Preserve manually edited unit cost (Contract A: inventory.cost = UNIT)
          finalUnitCost = Number(item.cost);
        } else {
          // Contract A: prefer created_listings unit cost (helper-derived);
          // fallback to inventory unit cost via getInventoryUnitCost
          // (cost=UNIT, or amount/units when cost missing).
          const fallbackUnitCost = getInventoryUnitCost({
            cost: item.cost,
            amount: item.amount,
            units: item.units,
          });
          finalUnitCost = costEntry?.unitCost ?? fallbackUnitCost;
        }
 
        const result: InventoryItem = {
          ...item,
          supplier_links: Array.isArray(item.supplier_links)
            ? (item.supplier_links as Array<{ link: string; discount_code: string }>)
            : [],
          // Use Created Listings values when available (matching that page's display)
          amount: costEntry?.totalCost ?? item.amount ?? null,
          units: costEntry?.units ?? item.units ?? null,
          unit_cost: finalUnitCost,
          fees_json: item.fees_json ?? null,
          // Prioritize image_url and price from created_listings
          image_url: costEntry?.image_url || item.image_url || null,
          price: costEntry?.price ?? item.price ?? null,
          // Add sales data for the selected period
          sales_30d: salesMap.get(item.asin) || 0,
          // Add historical sales data for fallback
          historical_sales: historicalSalesMap.get(item.asin)?.totalUnits || 0,
          historical_days: historicalSalesMap.get(item.asin) 
            ? getHistoricalDays(historicalSalesMap.get(item.asin)!.earliestDate) 
            : undefined,
        } as InventoryItem;

        if (item.asin === 'B0D1YM8D4Q') {
          console.log('Inventory mapping for B0D1YM8D4Q', { rawItem: item, costEntry, result });
        }

        return result;
      });

      setInventory(formattedData);
    } catch (error: any) {
      console.error("Error fetching inventory:", error);
      toast({
        variant: "destructive",
        title: "Failed to load inventory",
        description: error?.message ?? "Unable to load inventory data.",
      });
    } finally {
      setLoading(false);
    }
  };


  const startEditingCost = (item: InventoryItem) => {
    setEditingCost(item.id);
    setEditedCostValue(item.amount?.toString() || "");
  };

  const saveCost = async (itemId: string) => {
    try {
      const newCost = parseFloat(editedCostValue);
      if (isNaN(newCost) || newCost < 0) {
        toast({
          variant: "destructive",
          title: "Invalid cost",
          description: "Please enter a valid cost.",
        });
        return;
      }

      const { error } = await supabase
        .from("inventory")
        .update({ amount: newCost })
        .eq("id", itemId);

      if (error) throw error;

      toast({
        title: "Unit cost updated",
        description: "Saved new total cost.",
      });
      setEditingCost(null);
      fetchInventory();
    } catch (error: any) {
      console.error("Error updating cost:", error);
      toast({
        variant: "destructive",
        title: "Failed to update cost",
        description: "Please try again.",
      });
    }
  };

  const startEditingSuppliers = (item: InventoryItem) => {
    setEditingSuppliers(item.id);
    setEditedSuppliers(item.supplier_links.length > 0 ? [...item.supplier_links] : [{ link: "", discount_code: "" }]);
  };

  const addSupplierRow = () => {
    setEditedSuppliers([...editedSuppliers, { link: "", discount_code: "" }]);
  };

  const removeSupplierRow = (index: number) => {
    setEditedSuppliers(editedSuppliers.filter((_, i) => i !== index));
  };

  const updateSupplierField = (index: number, field: 'link' | 'discount_code', value: string) => {
    const newSuppliers = [...editedSuppliers];
    newSuppliers[index][field] = value;
    setEditedSuppliers(newSuppliers);
  };

  const saveSuppliers = async (itemId: string) => {
    try {
      const filteredSuppliers = editedSuppliers.filter(s => s.link.trim() !== "");

      const { error } = await supabase
        .from("inventory")
        .update({ supplier_links: filteredSuppliers as any })
        .eq("id", itemId);

      if (error) throw error;

      toast({
        title: "Suppliers updated",
        description: "Saved supplier links.",
      });
      setEditingSuppliers(null);
      fetchInventory();
    } catch (error: any) {
      console.error("Error updating suppliers:", error);
      toast({
        variant: "destructive",
        title: "Failed to update suppliers",
        description: "Please try again.",
      });
    }
  };

  const updatePrice = async (item: InventoryItem) => {
    console.log('🔄 Update button clicked for ASIN:', item.asin);
    
    try {
      setUpdatingPrice(item.id);
      console.log('📡 Getting session...');
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");

      // First, check created_listings for image_url and price (avoids SP-API calls)
      const { data: createdListingsData } = await supabase
        .from("created_listings")
        .select("image_url, price, title, cost, units, created_at")
        .eq("asin", item.asin)
        .order("created_at", { ascending: false });

      let fromCreatedListings: { image_url?: string | null; price?: number | null; title?: string | null } = {};
      let unitCost: number | null = null;
      let totalCost: number | null = null;
      let units: number | null = null;

      if (createdListingsData && createdListingsData.length > 0) {
        // Find the most recent row that has useful data
        const rowWithImage = createdListingsData.find(row => row.image_url);
        const rowWithPrice = createdListingsData.find(row => row.price && row.price > 0);
        const rowWithUnits = createdListingsData.find(row => row.units && row.units > 0);
        const selectedRow = rowWithUnits || createdListingsData[0];

        fromCreatedListings = {
          image_url: rowWithImage?.image_url || null,
          price: rowWithPrice?.price || null,
          title: createdListingsData[0]?.title || null
        };

        // Extract cost/units from selected row
        totalCost = selectedRow.cost !== null && selectedRow.cost !== undefined 
          ? Number(selectedRow.cost) 
          : null;
        units = selectedRow.units !== null && selectedRow.units !== undefined 
          ? Number(selectedRow.units) 
          : null;

        // Calculate unit cost via Contract A helper (prefer amount=UNIT, else cost/units)
        unitCost = getListingUnitCost({
          cost: totalCost,
          units,
          amount: (selectedRow as any).amount,
        });

        console.log('📦 Found created_listings data for', item.asin, fromCreatedListings);
      }

      // Determine if we need SP-API call (only if missing image OR price from created_listings)
      const needsSpApi = !fromCreatedListings.image_url || !fromCreatedListings.price;
      let spApiData: any = null;

      if (needsSpApi) {
        console.log('✅ Calling fetch-listing-snapshot (missing data from created_listings)...');
        const { data, error } = await supabase.functions.invoke(
          'fetch-listing-snapshot',
          {
            body: { 
              asin: item.asin,
              sku: item.sku,
              fnsku: item.fnsku,
              marketplaceId: 'ATVPDKIKX0DER'
            },
            headers: { Authorization: `Bearer ${session.access_token}` }
          }
        );

        if (error) {
          const msg = error.message || "";
          if (msg.includes("NOT_FOUND")) {
            console.log("SP-API: ASIN not found, using created_listings data only");
          } else if (msg.includes("QUOTA_EXCEEDED") || msg.includes("429")) {
            console.log("SP-API quota exceeded, using created_listings data only");
          } else {
            console.error("SP-API error:", msg);
          }
        } else {
          spApiData = data;
        }
      } else {
        console.log('⏭️ Skipping SP-API call - have image and price from created_listings');
      }

      // Build update object - prioritize created_listings data over SP-API
      const updateData: any = {};
      
      // Image: created_listings first, then SP-API
      if (fromCreatedListings.image_url) {
        updateData.image_url = fromCreatedListings.image_url;
      } else if (spApiData?.imageUrl) {
        updateData.image_url = spApiData.imageUrl;
      }

      // Price: created_listings first, then SP-API
      if (fromCreatedListings.price && fromCreatedListings.price > 0) {
        updateData.price = fromCreatedListings.price;
      } else if (spApiData?.price !== undefined) {
        updateData.price = spApiData.price;
      }

      // Title: created_listings first, then SP-API
      if (fromCreatedListings.title) {
        updateData.title = fromCreatedListings.title;
      } else if (spApiData?.title) {
        updateData.title = spApiData.title;
      }

      // Inventory status from SP-API only
      if (spApiData?.available !== undefined) updateData.available = spApiData.available;
      if (spApiData?.reserved !== undefined) updateData.reserved = spApiData.reserved;
      if (spApiData?.inbound !== undefined) updateData.inbound = spApiData.inbound;
      if (spApiData?.unfulfilled !== undefined) updateData.unfulfilled = spApiData.unfulfilled;
      
      // Save Total Cost and Units from created_listings into inventory table
      if (totalCost !== null) updateData.amount = totalCost;
      if (units !== null) updateData.units = units;
      
      // Update only this single row in database
      const { error: updateError } = await supabase
        .from("inventory")
        .update(updateData)
        .eq("id", item.id);

      if (updateError) throw updateError;

      // Update only this record in local state while preserving array order
      setInventory(prevInventory => {
        const index = prevInventory.findIndex(invItem => invItem.id === item.id);
        if (index === -1) return prevInventory;
        
        const updatedItem = {
          ...prevInventory[index],
          ...updateData,
          amount: totalCost,
          units: units,
          unit_cost: unitCost,
          cost: unitCost
        };
        
        const newInventory = [...prevInventory];
        newInventory[index] = updatedItem;
        return newInventory;
      });

      toast({
        title: "Product updated",
        description: "Inventory and pricing information refreshed.",
      });
    } catch (error: any) {
      console.error("Error updating product:", error);
      toast({
        variant: "destructive",
        title: "Failed to update product",
        description: error?.message ?? "Please try again.",
      });
    } finally {
      setUpdatingPrice(null);
    }
  };
  const extractDomain = (url: string): string => {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname.replace('www.', '');
    } catch {
      return 'Invalid URL';
    }
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === paginatedInventory.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(paginatedInventory.map(item => item.id)));
    }
  };

  const toggleSelectItem = (id: string) => {
    const newSelected = new Set(selectedIds);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedIds(newSelected);
  };

  // Smart selection functions for incomplete records
  const selectEmptyUnitCost = () => {
    const incompleteIds = sortedInventory
      .filter(item => !item.unit_cost || item.unit_cost === 0)
      .map(item => item.id);
    setSelectedIds(new Set(incompleteIds));
    toast({
      title: "Selection updated",
      description: `Selected ${incompleteIds.length} records with empty unit cost.`,
    });
  };

  const selectEmptyPrice = () => {
    const incompleteIds = sortedInventory
      .filter(item => !item.price || item.price === 0)
      .map(item => item.id);
    setSelectedIds(new Set(incompleteIds));
    toast({
      title: "Selection updated",
      description: `Selected ${incompleteIds.length} records with empty price.`,
    });
  };

  const selectMissingImages = () => {
    const incompleteIds = sortedInventory
      .filter(item => !item.image_url)
      .map(item => item.id);
    setSelectedIds(new Set(incompleteIds));
    toast({
      title: "Selection updated",
      description: `Selected ${incompleteIds.length} records with missing images.`,
    });
  };

  const selectAllIncomplete = () => {
    const incompleteIds = sortedInventory
      .filter(item => 
        !item.unit_cost || 
        item.unit_cost === 0 || 
        !item.price || 
        item.price === 0 || 
        !item.image_url ||
        !item.fees_json
      )
      .map(item => item.id);
    setSelectedIds(new Set(incompleteIds));
    toast({
      title: "Selection updated",
      description: `Selected ${incompleteIds.length} incomplete records.`,
    });
  };

  const fixAllIncomplete = async () => {
    // Auto-select all incomplete records
    const incompleteIds = sortedInventory
      .filter(item => 
        !item.unit_cost || 
        item.unit_cost === 0 || 
        !item.price || 
        item.price === 0 || 
        !item.image_url ||
        !item.fees_json
      )
      .map(item => item.id);

    if (incompleteIds.length === 0) {
      toast({
        title: "Nothing to update",
        description: "All records are already complete.",
      });
      return;
    }

    // Set selection and trigger update
    setSelectedIds(new Set(incompleteIds));
    toast({
      title: "Auto-fix started",
      description: `Found ${incompleteIds.length} incomplete records. Starting auto-fix...`,
    });
    
    // Wait a brief moment for UI to update selection
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Trigger the bulk update
    await updateSelectedRecords();
  };

  const updateSelectedRecords = async (itemsToProcess?: InventoryItem[]) => {
    // If items are passed directly, use them; otherwise get from selectedIds
    const selectedItems = itemsToProcess || sortedInventory.filter(item => selectedIds.has(item.id));
    
    if (selectedItems.length === 0) {
      toast({
        variant: "destructive",
        title: "No records selected",
        description: "Please select at least one record to update.",
      });
      return;
    }

    const BATCH_SIZE = 50;
    const totalItems = selectedItems.length;
    const totalBatches = Math.ceil(totalItems / BATCH_SIZE);

    try {
      setBulkUpdating(true);
      
      // Freeze current sort order during bulk updates
      setFrozenSortOrder(sortedInventory.map(item => item.id));
      
      let totalSuccess = 0;
      let totalErrors = 0;
      let totalSkipped = 0;

      toast({
        title: "Bulk update started",
        description: `Processing ${totalItems} records in ${totalBatches} batch(es)...`,
      });

      // Process ALL batches automatically
      for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
        const startIdx = batchIndex * BATCH_SIZE;
        const endIdx = Math.min(startIdx + BATCH_SIZE, totalItems);
        const batchItems = selectedItems.slice(startIdx, endIdx);
        
        toast({
          title: `Batch ${batchIndex + 1}/${totalBatches}`,
          description: `Processing records ${startIdx + 1} - ${endIdx} of ${totalItems}...`,
        });

        for (let i = 0; i < batchItems.length; i++) {
          const item = batchItems[i];
          const globalIndex = startIdx + i + 1;
          
          // Check if record is already complete before updating
          const isComplete = item.image_url && 
                            item.price && 
                            item.price > 0 && 
                            item.unit_cost && 
                            item.unit_cost > 0;
          
          if (isComplete) {
            totalSkipped++;
            console.log(`⏭️ Skipped ${item.asin} - already complete`);
            continue;
          }
          
          try {
            toast({
              title: "Updating record",
              description: `[${globalIndex}/${totalItems}] Updating ${item.asin}...`,
            });
            await updatePrice(item);
            totalSuccess++;
            // Small delay to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 500));
          } catch (error: any) {
            totalErrors++;
            const errorMsg = error?.message || 'Unknown error';
            console.error(`❌ Failed to update ${item.asin}:`, errorMsg);
            
            // Stop all batches if too many consecutive errors
            if (totalErrors >= 10 && totalSuccess === 0) {
              toast({
                variant: "destructive",
                title: "Update stopped",
                description: "Too many errors - stopping. Check your Amazon API connection.",
              });
              setSelectedIds(new Set());
              return;
            }
          }
        }
        
        // Brief pause between batches
        if (batchIndex < totalBatches - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      // Show final completion summary
      toast({
        title: "✅ Bulk update complete",
        description: `Updated: ${totalSuccess} | Skipped: ${totalSkipped} | Errors: ${totalErrors}`,
      });
      
      // Clear selection when done
      setSelectedIds(new Set());
      
    } catch (error: any) {
      console.error("Bulk update error:", error);
      toast({
        variant: "destructive",
        title: "Bulk update failed",
        description: error?.message ? `Bulk update failed: ${error.message}` : "Bulk update failed.",
      });
    } finally {
      setBulkUpdating(false);
    }
  };

  const saveUnitCost = async (itemId: string) => {
    try {
      const newUnitCost = parseFloat(editedUnitCostValue);
      if (isNaN(newUnitCost)) {
        toast({
          variant: "destructive",
          title: "Invalid unit cost",
          description: "Please enter a valid number.",
        });
        return;
      }

      const nowIso = new Date().toISOString();
      const trimmedReason = editedUnitCostReason.trim();
      const reasonToSave = trimmedReason ? trimmedReason.slice(0, 200) : null;

      // Phase 7+ — classify source so the cost badge can show
      // "Manual / No Purchase Record" when no Created Listing exists.
      const editedItem = inventory.find((inv) => inv.id === itemId);
      let manualSource: 'user' | 'manual_no_purchase_record' = 'user';
      if (editedItem?.asin) {
        try {
          const { count } = await supabase
            .from('created_listings')
            .select('id', { count: 'exact', head: true })
            .eq('asin', editedItem.asin);
          if ((count ?? 0) === 0) manualSource = 'manual_no_purchase_record';
        } catch {
          /* non-fatal */
        }
      }

      const { error } = await supabase
        .from("inventory")
        .update({ 
          cost: newUnitCost,
          unit_cost_manual: true,
          manual_cost_updated_at: nowIso,
          manual_cost_source: manualSource,
          manual_cost_reason: reasonToSave,
        })
        .eq("id", itemId);

      if (error) throw error;

      // Update only this record inline in state while preserving array position
      setInventory(prevInventory => {
        const index = prevInventory.findIndex(invItem => invItem.id === itemId);
        if (index === -1) return prevInventory;
        
        const updatedItem = {
          ...prevInventory[index],
          cost: newUnitCost,
          unit_cost: newUnitCost,
          unit_cost_manual: true,
          manual_cost_updated_at: nowIso,
          manual_cost_source: manualSource,
          manual_cost_reason: reasonToSave,
        };
        
        const newInventory = [...prevInventory];
        newInventory[index] = updatedItem;
        return newInventory;
      });

      toast({
        title: "Unit cost updated",
        description: "Saved manual unit cost.",
      });
      setEditingUnitCost(null);
      setEditedUnitCostReason("");
    } catch (error: any) {
      toast({
        variant: "destructive",
        title: "Failed to update unit cost",
        description: error?.message ?? "Please try again.",
      });
    }
  };

  const deleteItem = async (id: string) => {
    const reason = prompt(
      "Why are you removing this item? (saved to ghost history so you can review it later)",
      ""
    );
    if (reason === null) return; // user cancelled

    try {
      // SOFT-DELETE: tombstone the row so it can be retrieved via
      // "Show Ghost ASINs" later. Never physically delete.
      const { error } = await supabase
        .from("inventory")
        .update({
          listing_status: "DELETED",
          ghost_reason: "manual_user_delete",
          ghosted_at: new Date().toISOString(),
          ghost_source: "inventory_ui",
          deleted_by: user?.id,
          deleted_reason: reason?.trim() || "(no reason given)",
        })
        .eq("id", id);

      if (error) throw error;
      toast({
        title: "Item moved to ghost list",
        description: "Reason saved. View it any time via 'Show Ghost ASINs'.",
      });
      fetchInventory();
    } catch (error: any) {
      console.error("Error soft-deleting item:", error);
      toast({
        variant: "destructive",
        title: "Failed to remove item",
        description: "Please try again.",
      });
    }
  };

  // Helper to calculate replenish qty for filtering/sorting
  // Uses historical sales velocity as fallback when no recent sales
  const getReplenishQty = (item: InventoryItem): number => {
    return calculateReplenishQty({
      salesUnits: item.sales_30d ?? 0,
      salesPeriodDays: salesPeriodDays,
      available: item.available ?? 0,
      inbound: item.inbound ?? 0,
      reserved: item.reserved ?? 0,
      // Historical fallback for arbitrage products with irregular availability
      historicalSalesUnits: item.historical_sales,
      historicalDays: item.historical_days,
    });
  };

  // A row is a "ghost" when it is tombstoned or has a recorded ghost_reason.
  // Mirrors the platform-wide rule in src/lib/ghostFilter.ts but here we
  // explicitly INCLUDE ghosts only when the toggle is on.
  const isGhost = (item: InventoryItem): boolean => {
    const ls = (item.listing_status || "").toUpperCase();
    if (ls === "NOT_IN_CATALOG" || ls === "DELETED") return true;
    if (item.ghosted_at) return true;
    if ((item.sku || "").toLowerCase().startsWith("amzn.gr.")) return true;
    return false;
  };

  const filteredInventory = inventory.filter((item) => {
    // Ghost toggle: when ON show ghosts only; when OFF hide all ghosts.
    const ghost = isGhost(item);
    if (showGhostsOnly ? !ghost : ghost) return false;

    // Apply search filter
    const matchesSearch =
      item.asin.toLowerCase().includes(searchTerm.toLowerCase()) ||
      item.sku.toLowerCase().includes(searchTerm.toLowerCase()) ||
      item.title.toLowerCase().includes(searchTerm.toLowerCase());

    // Apply stock filter (skipped in ghost mode — ghosts are usually 0-stock)
    let matchesStock = true;
    if (!showGhostsOnly) {
      if (stockFilter === 'in-stock') {
        matchesStock = (item.available ?? 0) > 0;
      } else if (stockFilter === 'out-of-stock') {
        matchesStock = (item.available ?? 0) === 0;
      } else if (stockFilter === 'needs-replenish') {
        matchesStock = getReplenishQty(item) > 0;
      }
    }

    const matchesOverride = !showOverriddenOnly || item.unit_cost_manual === true;
    return matchesSearch && matchesStock && matchesOverride;
  });

  // Apply sorting (unless frozen during bulk updates)
  const sortedInventory = frozenSortOrder 
    ? frozenSortOrder.map(id => filteredInventory.find(item => item.id === id)).filter(Boolean) as InventoryItem[]
    : [...filteredInventory].sort((a, b) => {
        if (sortBy === 'available') {
          const aVal = a.available ?? 0;
          const bVal = b.available ?? 0;
          return sortDirection === 'asc' ? aVal - bVal : bVal - aVal;
        }
        if (sortBy === 'replenish') {
          const aVal = getReplenishQty(a);
          const bVal = getReplenishQty(b);
          return sortDirection === 'asc' ? aVal - bVal : bVal - aVal;
        }
        if (sortBy === 'created') {
          // Sort by listing creation date
          const aDate = a.listing_created_at ? new Date(a.listing_created_at).getTime() : 0;
          const bDate = b.listing_created_at ? new Date(b.listing_created_at).getTime() : 0;
          return sortDirection === 'asc' ? aDate - bDate : bDate - aDate;
        }
        if (sortBy === 'roi') {
          // Calculate ROI for both items using actual Amazon fees from SP-API (matching ROI Calculator)
          const calculateRoi = (item: InventoryItem): number => {
            if (item.price && item.unit_cost && item.fees_json) {
              const referralFee = Number(item.fees_json.referralFee || 0);
              const fbaFee = Number(item.fees_json.fbaFee || 0);
              const variableClosingFee = Number(item.fees_json.variableClosingFee || 0);
              const otherFees = Number(item.fees_json.otherFees || 0);

              const totalFees = referralFee + fbaFee + variableClosingFee + otherFees;
              const profit = item.price - totalFees - item.unit_cost;
              return (profit / item.unit_cost) * 100;
            }
            return -Infinity; // Items without actual SP-API fees go to the bottom
          };

          const aRoi = calculateRoi(a);
          const bRoi = calculateRoi(b);
          return sortDirection === 'asc' ? aRoi - bRoi : bRoi - aRoi;
        }
        return 0;
      });

  // Pagination calculations
  const totalPages = Math.ceil(sortedInventory.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const paginatedInventory = sortedInventory.slice(startIndex, endIndex);

  const handleSortByAvailable = () => {
    if (sortBy === 'available') {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy('available');
      setSortDirection('desc');
    }
  };

  const handleSortByRoi = () => {
    if (sortBy === 'roi') {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy('roi');
      setSortDirection('desc');
    }
  };

  const handleSortByReplenish = () => {
    if (sortBy === 'replenish') {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy('replenish');
      setSortDirection('desc');
    }
  };

  const handleSortByCreated = () => {
    if (sortBy === 'created') {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy('created');
      setSortDirection('desc');
    }
  };

  // Reset to page 1 when search term, items per page, or stock filter changes
  useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm, itemsPerPage, stockFilter, showOverriddenOnly, showGhostsOnly]);

  return (
    <>
      <Helmet>
        <title>Inventory Management - InventorySprint</title>
        <meta
          name="description"
          content="Manage your Amazon FBA inventory with ASIN, SKU, FNSKU tracking and supplier information"
        />
      </Helmet>
      <div className="min-h-screen flex flex-col bg-background">
        <Navbar />
        <main className="flex-1 px-2 py-8">
          <div className="max-w-full">
            <div className="flex justify-between items-center mb-6 px-2">
              <h1 className="text-3xl font-bold text-foreground">
                Inventory Management
              </h1>
              <Button onClick={() => (window.location.href = "/tools/create-listing")}>
                <Plus className="mr-2 h-4 w-4" />
                Add New Item
              </Button>
            </div>

            <Card className="p-4 mb-6">
              <div className="flex items-center justify-between gap-4 flex-wrap mb-4">
                <div className="flex flex-col gap-2">
                  <Input
                    placeholder="Search by ASIN, SKU, or Title..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="max-w-md"
                  />
                  <div className="flex gap-2 flex-wrap">
                    <Button 
                      onClick={syncFromAmazon}
                      disabled={syncing || loading || fullSyncing}
                      variant="outline"
                      size="sm"
                    >
                      {syncing ? (
                        <>
                          <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                          Syncing...
                        </>
                      ) : (
                        <>
                          <RefreshCw className="mr-2 h-4 w-4" />
                          Sync Quantities
                        </>
                      )}
                    </Button>
                    <Button 
                      onClick={fullQuantitySync}
                      disabled={fullSyncing || syncing || loading}
                      variant="outline"
                      size="sm"
                      className="bg-primary/10"
                    >
                      {fullSyncing ? (
                        <>
                          <Package className="mr-2 h-4 w-4 animate-pulse" />
                          {fullSyncProgress ? `${fullSyncProgress.current}/${fullSyncProgress.total}` : 'Syncing...'}
                        </>
                      ) : (
                        <>
                          <Package className="mr-2 h-4 w-4" />
                          Full Qty Sync (Reports)
                        </>
                      )}
                    </Button>
                    <Button 
                      onClick={async () => {
                        // Pass ALL inventory records directly to update function
                        const allItems = [...sortedInventory];
                        setSelectedIds(new Set(allItems.map(item => item.id)));
                        toast({
                          title: "Bulk update started",
                          description: `Processing all ${allItems.length} records...`,
                        });
                        // Pass items directly to avoid state timing issues
                        await updateSelectedRecords(allItems);
                      }}
                      disabled={bulkUpdating || loading || sortedInventory.length === 0 || fullSyncing}
                      variant="outline"
                      size="sm"
                    >
                      {bulkUpdating ? (
                        <>
                          <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                          Updating...
                        </>
                      ) : (
                        <>
                          <RefreshCw className="mr-2 h-4 w-4" />
                          Update All (SP-API)
                        </>
                      )}
                    </Button>
                  </div>
                  {fullSyncProgress && (
                    <div className="w-full mt-2 p-2 bg-muted rounded-md text-sm">
                      <div className="flex items-center gap-2">
                        <RefreshCw className="h-4 w-4 animate-spin text-primary" />
                        <span className="text-muted-foreground">{fullSyncProgress.message}</span>
                      </div>
                      <div className="mt-1 w-full bg-background rounded-full h-2">
                        <div 
                          className="bg-primary h-2 rounded-full transition-all duration-300"
                          style={{ width: `${(fullSyncProgress.current / fullSyncProgress.total) * 100}%` }}
                        />
                      </div>
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-4 flex-wrap">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-muted-foreground">Sales Period:</span>
                    <select
                      value={salesPeriodDays}
                      onChange={(e) => {
                        setSalesPeriodDays(Number(e.target.value));
                      }}
                      className="border rounded px-3 py-2 text-sm bg-background"
                    >
                      <option value={7}>7 days</option>
                      <option value={14}>14 days</option>
                      <option value={30}>30 days</option>
                      <option value={60}>60 days</option>
                      <option value={90}>90 days</option>
                    </select>
                    <Button
                      onClick={() => fetchInventory()}
                      disabled={loading}
                      variant="outline"
                      size="sm"
                    >
                      {loading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                    </Button>
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="flex items-center gap-1.5 text-sm text-muted-foreground cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={showOverriddenOnly}
                        onChange={(e) => setShowOverriddenOnly(e.target.checked)}
                        className="h-3.5 w-3.5"
                      />
                      Overridden cost only
                    </label>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant={showGhostsOnly ? "default" : "outline"}
                      size="sm"
                      onClick={() => setShowGhostsOnly((v) => !v)}
                      className={showGhostsOnly ? "bg-amber-600 hover:bg-amber-700 text-white" : ""}
                      title="Show ASINs that were tombstoned (deleted, not-in-catalog, FBM-orphaned, amzn.gr.* relisted, or manually removed). Includes the reason and timestamp."
                    >
                      {showGhostsOnly ? "Showing Ghost ASINs" : "Show Ghost ASINs"}
                    </Button>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-muted-foreground">Filter:</span>
                    <select
                      value={stockFilter}
                      onChange={(e) => setStockFilter(e.target.value as 'all' | 'in-stock' | 'out-of-stock' | 'needs-replenish')}
                      className="border rounded px-3 py-2 text-sm bg-background"
                    >
                      <option value="all">All Products</option>
                      <option value="in-stock">In Stock Only</option>
                      <option value="out-of-stock">Out of Stock</option>
                      <option value="needs-replenish">Needs Replenishment</option>
                    </select>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-muted-foreground">Show:</span>
                    <select
                      value={itemsPerPage}
                      onChange={(e) => setItemsPerPage(Number(e.target.value))}
                      className="border rounded px-3 py-2 text-sm bg-background"
                    >
                      <option value={50}>50 records</option>
                      <option value={250}>250 records</option>
                    </select>
                  </div>
                </div>
              </div>
              
              {/* Smart Selection Buttons */}
              <div className="border-t pt-4 space-y-3">
                <div className="text-sm font-medium text-foreground mb-2">Smart Selection Tools</div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                  <Button
                    onClick={selectEmptyUnitCost}
                    disabled={bulkUpdating || loading}
                    variant="outline"
                    size="sm"
                    className="text-xs"
                  >
                    Select Empty Cost
                  </Button>
                  <Button
                    onClick={selectEmptyPrice}
                    disabled={bulkUpdating || loading}
                    variant="outline"
                    size="sm"
                    className="text-xs"
                  >
                    Select Empty Price
                  </Button>
                  <Button
                    onClick={selectMissingImages}
                    disabled={bulkUpdating || loading}
                    variant="outline"
                    size="sm"
                    className="text-xs"
                  >
                    Select Missing Images
                  </Button>
                  <Button
                    onClick={selectAllIncomplete}
                    disabled={bulkUpdating || loading}
                    variant="outline"
                    size="sm"
                    className="text-xs"
                  >
                    Select All Incomplete
                  </Button>
                </div>
                <Button
                  onClick={fixAllIncomplete}
                  disabled={bulkUpdating || loading}
                  variant="default"
                  className="w-full bg-gradient-to-r from-primary to-primary/80 hover:from-primary/90 hover:to-primary/70"
                >
                  {bulkUpdating ? (
                    <>
                      <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                      Auto-Fixing Incomplete Records...
                    </>
                  ) : (
                    <>
                      <RefreshCw className="mr-2 h-4 w-4" />
                      Fix All Incomplete Records (One-Click)
                    </>
                  )}
                </Button>
              </div>
              
              {selectedIds.size > 0 && (
                <div className="border-t pt-4">
                  <Button 
                    onClick={() => updateSelectedRecords()}
                    disabled={bulkUpdating}
                    variant="default"
                    className="w-full"
                  >
                    {bulkUpdating ? (
                      <>
                        <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                        Updating {selectedIds.size} records...
                      </>
                    ) : (
                      <>
                        <RefreshCw className="mr-2 h-4 w-4" />
                        Update Selected Records ({selectedIds.size})
                      </>
                    )}
                  </Button>
                </div>
              )}
            </Card>

            {loading ? (
              <div className="text-center py-12">
                <p className="text-muted-foreground">Loading inventory...</p>
              </div>
            ) : sortedInventory.length === 0 ? (
              <Card className="p-12 text-center">
                <p className="text-muted-foreground mb-4">
                  {searchTerm
                    ? "No items match your search"
                    : "No inventory items yet"}
                </p>
                {!searchTerm && (
                  <Button onClick={() => (window.location.href = "/tools/create-listing")}>
                    Add Your First Item
                  </Button>
                )}
              </Card>
            ) : (
              <>
                <div className="mb-4 text-xs text-muted-foreground">
                  Showing {startIndex + 1}-{Math.min(endIndex, sortedInventory.length)} of {sortedInventory.length} items
                </div>
                <div className="overflow-x-auto border rounded-lg">
                  <table className="w-full border-collapse">
                   <thead>
                    <tr className="bg-muted">
                      <th className="px-1 py-2 text-center whitespace-nowrap text-xs">
                        <input
                          type="checkbox"
                          checked={selectedIds.size === paginatedInventory.length && paginatedInventory.length > 0}
                          onChange={toggleSelectAll}
                          disabled={bulkUpdating}
                          className="cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                        />
                      </th>
                      <th className="px-1 py-2 text-left whitespace-nowrap text-xs">Update</th>
                      <th className="px-1 py-2 text-left whitespace-nowrap text-xs">Image</th>
                      <th className="px-1 py-2 text-left whitespace-nowrap text-xs">ASIN</th>
                      <th className="px-1 py-2 text-left whitespace-nowrap text-xs">SKU</th>
                      <th className="px-1 py-2 text-left whitespace-nowrap text-xs">Title</th>
                      <th className="px-1 py-2 text-left whitespace-nowrap text-xs">Price</th>
                      <th className="px-1 py-2 text-left whitespace-nowrap text-xs hidden">Total Cost</th>
                      <th className="px-1 py-2 text-left whitespace-nowrap text-xs hidden">Units</th>
                      <th className="px-1 py-2 text-left whitespace-nowrap text-xs">Unit Cost</th>
                      <th 
                        className="px-1 py-2 text-left whitespace-nowrap text-xs cursor-pointer hover:bg-muted/70"
                        onClick={handleSortByRoi}
                      >
                        ROI {sortBy === 'roi' && (sortDirection === 'asc' ? '↑' : '↓')}
                      </th>
                      <th 
                        className="px-1 py-2 text-left whitespace-nowrap text-xs cursor-pointer hover:bg-muted/70"
                        onClick={handleSortByAvailable}
                      >
                        Available {sortBy === 'available' && (sortDirection === 'asc' ? '↑' : '↓')}
                      </th>
                      <th className="px-1 py-2 text-left whitespace-nowrap text-xs">Reserved</th>
                      <th className="px-1 py-2 text-left whitespace-nowrap text-xs">Inbound</th>
                      <th className="px-1 py-2 text-left whitespace-nowrap text-xs">Unfulfilled</th>
                      {/* 30d Sales column hidden */}
{/* Replenish column hidden */}
                      <th 
                        className="px-1 py-2 text-left whitespace-nowrap text-xs cursor-pointer hover:bg-muted/70"
                        onClick={handleSortByCreated}
                      >
                        Created {sortBy === 'created' && (sortDirection === 'asc' ? '↑' : '↓')}
                      </th>
                      <th className="px-1 py-2 text-left whitespace-nowrap text-xs">Delete</th>
                    </tr>
                  </thead>
                  <tbody>
                     {paginatedInventory.map((item) => {
                       // Total Cost comes directly from created_listings.amount when available
                       const displayTotalCost =
                         item.amount !== null && item.amount !== undefined
                           ? Number(item.amount)
                           : null;
 
                        // Calculate ROI using actual Amazon fees from SP-API (matching ROI Calculator)
                        let roi: number | null = null;
                        if (item.price && item.unit_cost && item.fees_json) {
                          const referralFee = Number(item.fees_json.referralFee || 0);
                          const fbaFee = Number(item.fees_json.fbaFee || 0);
                          const variableClosingFee = Number(item.fees_json.variableClosingFee || 0);
                          const otherFees = Number(item.fees_json.otherFees || 0);
  
                          const totalFees = referralFee + fbaFee + variableClosingFee + otherFees;
                          const profit = item.price - totalFees - item.unit_cost;
                          roi = (profit / item.unit_cost) * 100;
                        }

                      return (
                        <tr key={item.id} className="border-b border-border hover:bg-muted/50">
                          <td className="px-1 py-2 text-center">
                            <input
                              type="checkbox"
                              checked={selectedIds.has(item.id)}
                              onChange={() => toggleSelectItem(item.id)}
                              disabled={bulkUpdating}
                              className="cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                            />
                          </td>
                          <td className="px-1 py-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => updatePrice(item)}
                              disabled={updatingPrice === item.id || bulkUpdating}
                            >
                              {updatingPrice === item.id ? (
                                <RefreshCw className="h-3 w-3 animate-spin" />
                              ) : (
                                <RefreshCw className="h-3 w-3" />
                              )}
                            </Button>
                          </td>
                          <td className="px-1 py-2">
                            {item.image_url ? (
                              <img
                                src={item.image_url}
                                alt={item.title}
                                className="w-12 h-12 object-cover rounded"
                              />
                            ) : (
                              <div className="w-12 h-12 bg-muted rounded flex items-center justify-center text-[10px] text-muted-foreground">
                                No Image
                              </div>
                            )}
                          </td>
                        <td className="px-1 py-2 font-mono text-xs">
                          <a
                            href={`https://www.amazon.com/dp/${item.asin}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-primary hover:underline"
                          >
                            {item.asin}
                          </a>
                        </td>
                        <td className="px-1 py-2 font-mono text-xs">{item.sku}</td>
                        <td className="px-1 py-2 max-w-[200px] truncate text-xs">
                          {item.title}
                          {showGhostsOnly && (item.ghost_reason || item.listing_status) && (
                            <div
                              className="mt-1 text-[10px] text-amber-700 dark:text-amber-400 font-medium truncate"
                              title={[
                                item.ghost_reason && `Reason: ${item.ghost_reason}`,
                                item.deleted_reason && `Note: ${item.deleted_reason}`,
                                item.ghost_source && `From: ${item.ghost_source}`,
                                item.ghosted_at && `At: ${new Date(item.ghosted_at).toLocaleString()}`,
                                item.listing_status && `Status: ${item.listing_status}`,
                              ].filter(Boolean).join(" • ")}
                            >
                              👻 {item.ghost_reason || item.listing_status}
                              {item.ghosted_at && ` • ${new Date(item.ghosted_at).toLocaleDateString()}`}
                            </div>
                          )}
                        </td>
                        <td className="px-1 py-2 text-xs">
                          {item.price ? `$${item.price.toFixed(2)}` : '—'}
                        </td>
                        <td className="px-1 py-2 text-xs hidden">
                          {displayTotalCost !== null
                            ? `$${displayTotalCost.toFixed(2)}`
                            : '—'}
                        </td>
                        <td className="px-1 py-2 text-xs hidden">
                          {item.units !== null && item.units !== undefined ? item.units : '—'}
                        </td>
                        <td className="px-1 py-2 text-xs">
                          {editingUnitCost === item.id ? (
                            <div className="flex flex-col gap-1">
                              <div className="flex gap-1">
                                <Input
                                  type="number"
                                  step="0.01"
                                  value={editedUnitCostValue}
                                  onChange={(e) => setEditedUnitCostValue(e.target.value)}
                                  className="w-20 h-7 text-xs"
                                  autoFocus
                                />
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => saveUnitCost(item.id)}
                                  className="h-7 px-2"
                                >
                                  Save
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => {
                                    setEditingUnitCost(null);
                                    setEditedUnitCostReason("");
                                  }}
                                  className="h-7 px-2"
                                >
                                  Cancel
                                </Button>
                              </div>
                              <Input
                                type="text"
                                placeholder="Reason (optional)"
                                maxLength={200}
                                value={editedUnitCostReason}
                                onChange={(e) => setEditedUnitCostReason(e.target.value)}
                                className="h-6 text-[10px]"
                              />
                              {parseFloat(editedUnitCostValue) > 0 && (
                                <ApplyToPurchaseButton
                                  asin={item.asin}
                                  unitCost={parseFloat(editedUnitCostValue)}
                                  inventoryId={item.id}
                                  size="sm"
                                  variant="ghost"
                                  className="h-6 px-1 text-[10px]"
                                  onApplied={fetchInventory}
                                />
                              )}
                            </div>
                          ) : (
                            <div className="flex flex-col gap-0.5">
                              <div className="flex items-center gap-1">
                                <span
                                  className="cursor-pointer hover:bg-muted px-1 rounded"
                                  onClick={() => {
                                    setEditingUnitCost(item.id);
                                    setEditedUnitCostValue(item.unit_cost?.toString() || "0");
                                    setEditedUnitCostReason(item.manual_cost_reason ?? "");
                                  }}
                                >
                                  {item.unit_cost || item.unit_cost === 0
                                    ? `$${item.unit_cost.toFixed(2)}`
                                    : '—'}
                                </span>
                                <CostSourceBadge
                                  row={item}
                                  compact
                                  hasPurchaseRecord={hasPurchaseRecord(item.asin)}
                                />
                              </div>
                              {item.unit_cost_manual && (
                                <RevertToPurchaseButton
                                  inventoryId={item.id}
                                  asin={item.asin}
                                  sku={item.sku}
                                  currentCost={item.unit_cost}
                                  size="sm"
                                  variant="ghost"
                                  className="h-5 px-1 text-[10px] text-muted-foreground hover:text-foreground"
                                  onReverted={fetchInventory}
                                />
                              )}
                              {item.unit_cost_manual &&
                                item.unit_cost &&
                                item.unit_cost > 0 &&
                                !hasPurchaseRecord(item.asin) && (
                                  <CreatePurchaseFromCostButton
                                    asin={item.asin}
                                    sku={item.sku}
                                    title={item.title}
                                    unitCost={item.unit_cost}
                                    defaultUnits={
                                      (item.available ?? 0) +
                                      (item.reserved ?? 0) +
                                      (item.inbound ?? 0)
                                    }
                                    imageUrl={item.image_url}
                                    size="sm"
                                    variant="ghost"
                                    className="h-5 px-1 text-[10px] text-sky-600 hover:text-sky-700 dark:text-sky-400"
                                    onCreated={fetchInventory}
                                  />
                                )}
                            </div>
                          )}
                        </td>

                        <td className="px-1 py-2 text-xs">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 gap-1"
                            onClick={() => {
                              setSelectedRoiItem(item);
                              setRoiDialogOpen(true);
                            }}
                          >
                            <Calculator className="h-3 w-3" />
                            ROI
                          </Button>
                        </td>
                        <td className="px-1 py-2 text-center text-xs">{item.available ?? 0}</td>
                        <td className="px-1 py-2 text-center text-xs">{item.reserved ?? 0}</td>
                        <td className="px-1 py-2 text-center text-xs">{item.inbound ?? 0}</td>
                        <td className="px-1 py-2 text-center text-xs">{item.unfulfilled ?? 0}</td>
                        {/* 30d Sales column hidden */}
{/* Replenish column hidden */}
                        <td className="px-1 py-2 text-center text-xs">
                          {item.listing_created_at 
                            ? new Date(item.listing_created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })
                            : <span className="text-muted-foreground">—</span>
                          }
                        </td>
                        <td className="px-1 py-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => deleteItem(item.id)}
                          >
                            <Trash2 className="h-3 w-3 text-destructive" />
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                  </tbody>
                </table>
              </div>
              
              {/* Pagination Controls */}
              <div className="mt-6 flex items-center justify-center gap-2">
                <Button
                  variant="outline"
                  onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                  disabled={currentPage === 1}
                >
                  Previous
                </Button>
                
                <div className="flex items-center gap-2 mx-4">
                  <span className="text-sm text-muted-foreground">
                    Page {currentPage} of {totalPages} ({sortedInventory.length} total items)
                  </span>
                </div>
                
                <Button
                  variant="outline"
                  onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                  disabled={currentPage === totalPages}
                >
                  Next
                </Button>
              </div>
              </>
            )}
            
            {/* Auto-sync runs every 4 hours - no manual sync needed */}
          </div>
        </main>
        <Footer />
      </div>
      
      {/* Actual ROI Calculator Dialog */}
      {selectedRoiItem && (
        <ActualRoiCalculatorDialog
          open={roiDialogOpen}
          onOpenChange={setRoiDialogOpen}
          asin={selectedRoiItem.asin}
          unitCost={selectedRoiItem.unit_cost}
          productTitle={selectedRoiItem.title}
          imageUrl={selectedRoiItem.image_url}
          currentPrice={selectedRoiItem.price}
        />
      )}
    </>
  );
}
