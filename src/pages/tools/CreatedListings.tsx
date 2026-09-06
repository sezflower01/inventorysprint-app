import { useState, useEffect, useRef, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useSubscription } from "@/hooks/use-subscription";
import { getInventoryCache, setInventoryCache } from "@/hooks/use-inventory-cache";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import type { Json } from "@/integrations/supabase/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import { toast } from "sonner";
import { triggerAutoOnboard } from "@/lib/autoOnboard";
import { Helmet } from "react-helmet-async";
import { Trash2, Plus, RefreshCw, Printer, Upload, X, Copy, Calculator, ShoppingCart, Crown, Loader2, Info, ClipboardList, CalendarIcon } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { generateSKU } from "@/utils/skuGenerator";
import { LabelPrintDialog } from "@/components/personalhour/LabelPrintDialog";
import { RoiCalculatorDialog } from "@/components/inventory/RoiCalculatorDialog";
import { useNavigate } from "react-router-dom";
import * as XLSX from "xlsx";
import { ReplenishmentOrderPanel } from "@/components/inventory/ReplenishmentOrderPanel";
import { EditListingDialog } from "@/components/listings/EditListingDialog";
import { ImportFromInventoryDialog } from "@/components/listings/ImportFromInventoryDialog";
import { PurchaseDetailsDialog } from "@/components/listings/PurchaseDetailsDialog";
import { CostOverrideDialog } from "@/components/inventory/CostOverrideDialog";
import { getListingUnitCost } from "@/lib/cost-contract";
import { useFbaEligibility } from "@/hooks/use-fba-eligibility";
import { FbaReadinessTracker } from "@/components/fba/FbaReadinessTracker";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";

/**
 * Does this Total Cost look like a PER-UNIT price that was typed into the
 * lot-total box?
 *
 * This is the exact mistake that produced six bad lots between 2025-05 and
 * 2025-10, found on 2026-09-05 and worth $2,092.27 of understated COGS. The
 * panel asks for units and a TOTAL and divides, so a per-unit figure entered
 * here silently becomes total/units -- $10.79 across 100 units booked as
 * $0.1079 each, against an item selling for $17-$56. Nothing downstream
 * questioned it; it propagated into created_listing_purchases,
 * created_listings, cost_history and finally the locked snapshot on every
 * order, where it sat for ten months.
 *
 * Two independent tests, because either alone misses cases:
 *   - against the SELLING price, which Amazon supplies and nobody typed. A
 *     unit cost under 5% of what the item sells for is not a bargain.
 *   - against an absolute floor, for listings with no price yet.
 *
 * Single-unit lots are exempt: there total and per-unit are the same number,
 * so the confusion cannot arise.
 */
export function suspiciousUnitCost(
  totalCost: number,
  units: number,
  listPrice: number | null | undefined,
): { suspicious: boolean; cog: number; impliedTotal: number; pctOfPrice: number | null } {
  const cog = units > 0 ? totalCost / units : 0;
  const price = Number(listPrice) || 0;
  const pctOfPrice = price > 0 ? (cog / price) * 100 : null;
  const suspicious =
    units > 1 &&
    totalCost > 0 &&
    cog > 0 &&
    ((price > 0 && cog < price * 0.05) || cog < 0.5);
  return { suspicious, cog, impliedTotal: totalCost * units, pctOfPrice };
}

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
  supplier_links: Array<{ link: string; discount_code: string }>;
  created_at: string;
  updated_at: string;
  date_created: string | null;
  fees_json: any;
  notes: string | null;
  validation_status?: string | null;
  validation_failure_reason?: string | null;
  validation_warning?: string | null;
  inbound_dry_run_status?: string | null;
  inbound_dry_run_error?: string | null;
  inbound_dry_run_plan_id?: string | null;
  inbound_dry_run_at?: string | null;
}

const isPrintableFnsku = (fnsku?: string | null, asin?: string | null) => {
  const code = (fnsku || "").trim().toUpperCase();
  return /^X[A-Z0-9]{9}$/.test(code) && code !== (asin || "").trim().toUpperCase();
};

const formatSupabaseError = (error: any): string => {
  if (!error) return "Unknown error";
  const parts = [error.message, error.details, error.hint, error.code ? `code ${error.code}` : null]
    .filter(Boolean)
    .map(String);
  return parts.length > 0 ? parts.join(" — ") : String(error);
};

let createdListingsMemoryCache: { userId: string; data: InventoryItem[]; timestamp: number } | null = null;

export default function CreatedListings() {
  const { user, loading: authLoading } = useAuth();
  const { isAdmin, loading: subLoading } = useSubscription();
  const memorySnapshot = user?.id && createdListingsMemoryCache?.userId === user.id
    ? createdListingsMemoryCache
    : null;
  const [inventory, setInventory] = useState<InventoryItem[]>(() => memorySnapshot?.data ?? []);
  const [loading, setLoading] = useState(() => !memorySnapshot?.data?.length);
  const [searchTerm, setSearchTerm] = useState("");
  const [updatingPrice, setUpdatingPrice] = useState<string | null>(null);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editDialogItem, setEditDialogItem] = useState<InventoryItem | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(50);
  const [labelDialogOpen, setLabelDialogOpen] = useState(false);
  const [labelsForPrint, setLabelsForPrint] = useState<Array<{ asin: string; fnsku?: string | null; condition?: string | null; title: string }>>([]);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [excelInfoOpen, setExcelInfoOpen] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [cancelImport, setCancelImport] = useState(false);
  const cancelImportRef = useRef(false);
  const [importProgress, setImportProgress] = useState<{ total: number; imported: number } | null>(null);
  const [sortColumn, setSortColumn] = useState<'date_created' | 'price' | null>(null);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  // Fix Synthetic SKUs dialog state
  const [fixSkuOpen, setFixSkuOpen] = useState(false);
  const [fixSkuAsin, setFixSkuAsin] = useState("");
  const [fixSkuOriginal, setFixSkuOriginal] = useState("");
  const [fixSkuBusy, setFixSkuBusy] = useState(false);
  const [fixSkuPreview, setFixSkuPreview] = useState<{ count: number; current: string[] } | null>(null);
  // Auto-fix scan: ASINs with multiple SKUs; first-created SKU treated as source-of-truth
  const [autoFixScanning, setAutoFixScanning] = useState(false);
  const [autoFixApplying, setAutoFixApplying] = useState(false);
  type AutoFixCandidate = { asin: string; sourceSku: string; sourceCreatedAt: string; otherSkus: string[]; rowsToUpdate: number; source: 'inventory' | 'earliest' };
  const [autoFixCandidates, setAutoFixCandidates] = useState<AutoFixCandidate[] | null>(null);
  const [autoFixSelected, setAutoFixSelected] = useState<Set<string>>(new Set());
  const [autoFixResult, setAutoFixResult] = useState<{ asinsFixed: number; rowsUpdated: number; errors: string[] } | null>(null);
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [syncingProductId, setSyncingProductId] = useState<string | null>(null);
  const topScrollRef = useRef<HTMLDivElement>(null);
  const tableScrollRef = useRef<HTMLDivElement>(null);
  const [roiDialogOpen, setRoiDialogOpen] = useState(false);
  const [selectedRoiItem, setSelectedRoiItem] = useState<InventoryItem | null>(null);
  const [autoFetchProgress, setAutoFetchProgress] = useState<{ current: number; total: number } | null>(null);
  const autoFetchRunRef = useRef(false);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const navigate = useNavigate();
  const [selectedSupplier, setSelectedSupplier] = useState<string>("all");
  // Source filter: 'all' | 'new' (newly created listings) | 'purchase' (Add Purchase batches)
  const [sourceFilter, setSourceFilter] = useState<"all" | "new" | "purchase">("all");
  const [supplierSearch, setSupplierSearch] = useState("");
  const [highlightedRowIdx, setHighlightedRowIdx] = useState<number>(-1);
  const [noteText, setNoteText] = useState("");
  const [noteSaving, setNoteSaving] = useState(false);
  const [showNotesOnly, setShowNotesOnly] = useState(false);
  const [panelTotalCost, setPanelTotalCost] = useState("");
  const [panelUnits, setPanelUnits] = useState("");
  const [panelCog, setPanelCog] = useState("");
  const [sumOutput, setSumOutput] = useState("");
  const [panelEffectiveDate, setPanelEffectiveDate] = useState<Date>(new Date());
  const [confirmPurchaseOpen, setConfirmPurchaseOpen] = useState(false);
  const [pendingPurchaseItem, setPendingPurchaseItem] = useState<InventoryItem | null>(null);
  // Acknowledgement for a per-unit cost that looks like it was typed into the
  // Total Cost box. Same gate-the-save-button pattern as purchaseFbmAck below.
  const [costSanityAck, setCostSanityAck] = useState(false);
  const [purchaseFbmAck, setPurchaseFbmAck] = useState(false);
  const purchaseFbaElig = useFbaEligibility({
    asin: pendingPurchaseItem?.asin ?? null,
    marketplace: "US",
    enabled: confirmPurchaseOpen && !!pendingPurchaseItem?.asin,
  });
  const purchaseFbaBlocked = !!purchaseFbaElig.data && !purchaseFbaElig.data.eligible;
  useEffect(() => { if (!confirmPurchaseOpen) setPurchaseFbmAck(false); }, [confirmPurchaseOpen]);
  const [fetchingPriceRoi, setFetchingPriceRoi] = useState(false);
  const [inlineRoiResult, setInlineRoiResult] = useState<{
    price: number; unitCost: number; referralFee: number; fbaFee: number;
    variableClosingFee: number; totalFees: number; profit: number; roi: number; margin: number;
    title: string; imageUrl: string | null; asin: string;
  } | null>(null);
  const [inlineRoiDialogOpen, setInlineRoiDialogOpen] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [purchaseDetailsOpen, setPurchaseDetailsOpen] = useState(false);
  const [purchaseDetailsItem, setPurchaseDetailsItem] = useState<InventoryItem | null>(null);
  const [costOverrideOpen, setCostOverrideOpen] = useState(false);
  const [costOverrideItem, setCostOverrideItem] = useState<InventoryItem | null>(null);
  const [overriddenAsins, setOverriddenAsins] = useState<Set<string>>(new Set());
  // Phase 3 — Add Purchase gate. IDs of listings that pass the shared
  // active_created_listings source of truth (validation + ghost filter).
  // We never re-implement the filter here.
  const [activeListingIds, setActiveListingIds] = useState<Set<string>>(new Set());

  const refreshOverriddenAsins = async () => {
    if (!user) return;
    const { data, error } = await supabase
      .from("asin_cost_overrides")
      .select("asin")
      .eq("user_id", user.id);
    if (!error && data) {
      setOverriddenAsins(new Set(data.map((r: any) => r.asin)));
    }
  };

  const refreshActiveListingIds = async () => {
    if (!user) return;
    // Read from the shared view — no duplicated validation/ghost filters here.
    const ids = new Set<string>();
    const PAGE = 1000;
    let offset = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { data, error } = await (supabase as any)
        .from("active_created_listings")
        .select("id")
        .range(offset, offset + PAGE - 1);
      if (error) {
        console.warn("[Phase3] active_created_listings fetch failed:", error);
        break;
      }
      if (!data || data.length === 0) break;
      for (const r of data) if (r?.id) ids.add(r.id as string);
      if (data.length < PAGE) break;
      offset += PAGE;
    }
    setActiveListingIds(ids);
  };

  useEffect(() => {
    refreshOverriddenAsins();
    refreshActiveListingIds();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);
  const [deleteConfirmTitle, setDeleteConfirmTitle] = useState("");
  const [addingPurchase, setAddingPurchase] = useState(false);
  const lastKnownUserIdRef = useRef("");
  const nowCL = new Date();
  const [selectedMonth, setSelectedMonth] = useState<string>(String(nowCL.getMonth()));
  const [selectedYear, setSelectedYear] = useState<string>(String(nowCL.getFullYear()));
  const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dialogUserId = user?.id || lastKnownUserIdRef.current;

  const PRODUCT_LIBRARY_PRICE_ID = "price_1TOVOkHbbOMAX8kO1zHM4FCu";

  const handleSubscribe = async () => {
    if (!user) {
      toast.error("Please log in first");
      return;
    }
    setCheckoutLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("create-checkout", {
        body: { price_id: PRODUCT_LIBRARY_PRICE_ID },
      });
      if (error) throw error;
      if (data?.url) {
        window.open(data.url, "_blank");
      } else if (data?.updated) {
        toast.success("Subscription updated!");
      }
    } catch (err: any) {
      toast.error(err.message || "Failed to start checkout");
    } finally {
      setCheckoutLoading(false);
    }
  };

  useEffect(() => {
    if (!user) return;

    const IDB_KEY = `${user.id}_created_listings`;
    const FRESH_MS = 5 * 60 * 1000; // 5 minutes — skip background refetch when fresh

    if (createdListingsMemoryCache?.userId === user.id && createdListingsMemoryCache.data.length > 0) {
      setInventory(createdListingsMemoryCache.data);
      setLoading(false);
      return;
    }

    // Try IndexedDB first for instant load
    getInventoryCache(IDB_KEY).then(cached => {
      if (cached?.data && cached.data.length > 0) {
        const formatted = cached.data.map((item: any) => ({
          ...item,
          supplier_links: Array.isArray(item.supplier_links)
            ? item.supplier_links as Array<{ link: string; discount_code: string }>
            : []
        }));
        createdListingsMemoryCache = { userId: user.id, data: formatted, timestamp: cached.timestamp || Date.now() };
        setInventory(formatted);
        setLoading(false);
        // Only background-refresh if cache is older than FRESH_MS.
        // This prevents the "page reloads when I come back" feel.
        const age = Date.now() - (cached.timestamp || 0);
        if (age > FRESH_MS) {
          fetchInventory(true);
        }
      } else {
        fetchInventory();
      }
    });
  }, [user]);

  useEffect(() => {
    if (!user || loading || inventory.length === 0) return;
    createdListingsMemoryCache = {
      userId: user.id,
      data: inventory,
      timestamp: createdListingsMemoryCache?.userId === user.id
        ? createdListingsMemoryCache.timestamp
        : Date.now(),
    };
  }, [user?.id, inventory, loading]);

  // ---- Persist filter/page/scroll across navigation (sessionStorage) ----
  const VIEW_STATE_KEY = "created_listings_view_state_v1";
  const restoredViewRef = useRef(false);

  // Restore once on mount
  useEffect(() => {
    if (restoredViewRef.current) return;
    try {
      const raw = sessionStorage.getItem(VIEW_STATE_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        if (typeof s.searchTerm === "string") setSearchTerm(s.searchTerm);
        if (typeof s.selectedSupplier === "string") setSelectedSupplier(s.selectedSupplier);
        if (typeof s.currentPage === "number") setCurrentPage(s.currentPage);
        if (typeof s.itemsPerPage === "number") setItemsPerPage(s.itemsPerPage);
        if (typeof s.selectedMonth === "string") setSelectedMonth(s.selectedMonth);
        if (typeof s.selectedYear === "string") setSelectedYear(s.selectedYear);
        if (typeof s.showNotesOnly === "boolean") setShowNotesOnly(s.showNotesOnly);
        if (s.sourceFilter === "all" || s.sourceFilter === "new" || s.sourceFilter === "purchase") setSourceFilter(s.sourceFilter);
        if (typeof s.scrollY === "number") {
          // Restore scroll after data renders
          setTimeout(() => window.scrollTo(0, s.scrollY), 50);
          setTimeout(() => window.scrollTo(0, s.scrollY), 250);
        }
      }
    } catch {/* ignore */}
    restoredViewRef.current = true;
  }, []);

  // Save view state whenever filters/page change
  useEffect(() => {
    if (!restoredViewRef.current) return;
    try {
      sessionStorage.setItem(VIEW_STATE_KEY, JSON.stringify({
        searchTerm,
        selectedSupplier,
        currentPage,
        itemsPerPage,
        selectedMonth,
        selectedYear,
        showNotesOnly,
        sourceFilter,
        scrollY: window.scrollY,
      }));
    } catch {/* ignore */}
  }, [searchTerm, selectedSupplier, currentPage, itemsPerPage, selectedMonth, selectedYear, showNotesOnly, sourceFilter]);

  // Save scroll position on unmount/navigation
  useEffect(() => {
    const saveScroll = () => {
      try {
        const raw = sessionStorage.getItem(VIEW_STATE_KEY);
        const s = raw ? JSON.parse(raw) : {};
        s.scrollY = window.scrollY;
        sessionStorage.setItem(VIEW_STATE_KEY, JSON.stringify(s));
      } catch {/* ignore */}
    };
    window.addEventListener("beforeunload", saveScroll);
    return () => {
      saveScroll();
      window.removeEventListener("beforeunload", saveScroll);
    };
  }, []);

  useEffect(() => {
    if (!user) return;
    loadSyncedInventoryKeys();
  }, [user]);

  useEffect(() => {
    if (user?.id) {
      lastKnownUserIdRef.current = user.id;
    }
  }, [user?.id]);

  // Sync scroll between top scrollbar and table container
  useEffect(() => {
    const topScroll = topScrollRef.current;
    const tableScroll = tableScrollRef.current;

    if (!topScroll || !tableScroll) return;

    const handleTopScroll = () => {
      if (tableScroll) {
        tableScroll.scrollLeft = topScroll.scrollLeft;
      }
    };

    const handleTableScroll = () => {
      if (topScroll) {
        topScroll.scrollLeft = tableScroll.scrollLeft;
      }
    };

    topScroll.addEventListener('scroll', handleTopScroll);
    tableScroll.addEventListener('scroll', handleTableScroll);

    return () => {
      topScroll.removeEventListener('scroll', handleTopScroll);
      tableScroll.removeEventListener('scroll', handleTableScroll);
    };
  }, [inventory]);

  const fetchInventory = async (silent = false) => {
    try {
      if (!silent) setLoading(true);
      // Silent background refetch must NOT touch isRefreshing — that flag is
      // owned by the "Refresh Selected" button. Otherwise returning to the page
      // shows a spinning "Refreshing..." button for several seconds.
      console.log("Fetching created listings...");

      // Fetch ALL records in batches to handle 6000+ listings
      let allData: any[] = [];
      let hasMore = true;
      let offset = 0;
      const batchSize = 1000;

      while (hasMore) {
        const { data, error } = await supabase
          .from("created_listings")
          .select("*")
          .order("created_at", { ascending: false })
          .range(offset, offset + batchSize - 1);

        if (error) {
          console.error("Fetch error:", error);
          throw error;
        }

        if (data && data.length > 0) {
          allData = [...allData, ...data];
          offset += batchSize;
          hasMore = data.length === batchSize;
          console.log(`Fetched batch: ${data.length} records (total so far: ${allData.length})`);
        } else {
          hasMore = false;
        }
      }

      console.log("Fetched all created listings:", allData.length);

      const formattedData = allData.map(item => ({
        ...item,
        supplier_links: Array.isArray(item.supplier_links)
          ? item.supplier_links as Array<{ link: string; discount_code: string }>
          : []
      }));

      if (user) {
        createdListingsMemoryCache = { userId: user.id, data: formattedData, timestamp: Date.now() };
      }
      setInventory(formattedData);

      // Persist to IndexedDB for instant load next time
      if (user) {
        setInventoryCache(`${user.id}_created_listings`, formattedData);
      }
      // Keep initial page load lightweight for large datasets.
      // Expensive maintenance/update work should only run via explicit user actions.

    } catch (error: any) {
      console.error("Error fetching created listings:", error);
      if (!silent) toast.error("Failed to load listings");
      if (!silent) setInventory([]);
    } finally {
      if (!silent) setLoading(false);
    }
  };

  const fixNullDateCreated = async (items: InventoryItem[]) => {
    try {
      // Find records with null date_created
      const recordsToFix = items.filter(item => !item.date_created);
      
      if (recordsToFix.length === 0) return;

      console.log(`Fixing ${recordsToFix.length} records with null date_created`);

      // Update each record to set date_created from created_at
      for (const item of recordsToFix) {
        const dateCreated = new Date(item.created_at).toISOString().split('T')[0];
        
        const { error } = await supabase
          .from("created_listings")
          .update({ date_created: dateCreated })
          .eq("id", item.id);

        if (error) {
          console.error(`Error updating date_created for ${item.asin}:`, error);
        } else {
          // Update local state
          setInventory(prev => prev.map(i => 
            i.id === item.id ? { ...i, date_created: dateCreated } : i
          ));
        }
      }

      console.log("Date created fields updated successfully");
    } catch (error: any) {
      console.error("Error fixing null date_created:", error);
    }
  };

  const [syncedInventoryKeys, setSyncedInventoryKeys] = useState<Set<string>>(new Set());

  const syncKeyFor = (item: Pick<InventoryItem, 'asin' | 'sku'>) => `${item.asin}::${item.sku}`;

  const loadSyncedInventoryKeys = async () => {
    if (!user) return;
    const { data, error } = await supabase
      .from('inventory')
      .select('asin, sku')
      .eq('user_id', user.id);

    if (error) {
      console.error('Failed to load synced inventory keys:', error);
      return;
    }

    setSyncedInventoryKeys(new Set((data || []).map((row) => `${row.asin}::${row.sku}`)));
  };

  const handleSyncThisProduct = async (item: InventoryItem) => {
    try {
      setSyncingProductId(item.id);
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error('Not authenticated');

      const { data, error } = await supabase.functions.invoke('rescue-inventory-asin', {
        headers: { Authorization: `Bearer ${session.access_token}` },
        body: { asin: item.asin, sku: item.sku },
      });

      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);

      await loadSyncedInventoryKeys();
      toast.success((data as any)?.had_existing_record ? 'Product inventory refreshed' : 'Product added to Synced Inventory');
    } catch (error: any) {
      console.error('Sync product error:', error);
      toast.error(error?.message || 'Failed to sync this product');
    } finally {
      setSyncingProductId(null);
    }
  };

  // Auto-fetch missing images and titles on page load
  const autoFetchMissingData = async (items: InventoryItem[]) => {
    // Prevent multiple runs
    if (autoFetchRunRef.current) return;
    
    // Find items missing image or title (or having placeholder title)
    const itemsNeedingData = items.filter(item => 
      !item.image_url || 
      !item.title || 
      item.title === "Untitled Product" || 
      item.title.trim() === ""
    );

    if (itemsNeedingData.length === 0) return;

    autoFetchRunRef.current = true;
    console.log(`Auto-fetching data for ${itemsNeedingData.length} items with missing image/title`);
    setAutoFetchProgress({ current: 0, total: itemsNeedingData.length });

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        console.log("Not authenticated, skipping auto-fetch");
        return;
      }

      let successCount = 0;

      for (let i = 0; i < itemsNeedingData.length; i++) {
        const item = itemsNeedingData[i];
        setAutoFetchProgress({ current: i + 1, total: itemsNeedingData.length });

        try {
          const { data, error } = await supabase.functions.invoke(
            'fetch-product-price',
            {
              body: { asin: item.asin },
              headers: { Authorization: `Bearer ${session.access_token}` }
            }
          );

          if (error) {
            const msg = error.message || "";
            if (msg.includes("QUOTA_EXCEEDED") || msg.includes("429")) {
              console.log("Quota exceeded, stopping auto-fetch");
              break;
            }
            // Skip NOT_FOUND items silently - product doesn't exist on Amazon
            if (msg.includes("NOT_FOUND") || msg.includes("404")) {
              console.log(`ASIN ${item.asin} not found on Amazon, skipping`);
              continue;
            }
            continue;
          }

          if (data?.error === "QUOTA_EXCEEDED") {
            console.log("Quota exceeded, stopping auto-fetch");
            break;
          }

          // Skip NOT_FOUND items - product doesn't exist on Amazon
          if (data?.error === "NOT_FOUND") {
            console.log(`ASIN ${item.asin} not found on Amazon, skipping`);
            continue;
          }

          if (data?.title || data?.imageUrl) {
            const updateData: any = {};
            if (data.title && (!item.title || item.title === "Untitled Product")) {
              updateData.title = data.title;
            }
            if (data.imageUrl && !item.image_url) {
              updateData.image_url = data.imageUrl;
            }
            if (data.price !== undefined) {
              updateData.price = data.price;
            }

            if (Object.keys(updateData).length > 0) {
              const { error: updateError } = await supabase
                .from("created_listings")
                .update(updateData)
                .eq("id", item.id);

              if (!updateError) {
                setInventory(prev => prev.map(i =>
                  i.id === item.id ? { ...i, ...updateData } : i
                ));
                successCount++;
              }
            }
          }

          // Delay to respect rate limits
          if (i < itemsNeedingData.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        } catch (err: any) {
          const errorMsg = err?.message || String(err);
          if (errorMsg.includes("QUOTA_EXCEEDED") || errorMsg.includes("429")) {
            console.log("Quota exceeded, stopping auto-fetch");
            break;
          }
          // Skip NOT_FOUND errors silently
          if (errorMsg.includes("NOT_FOUND") || errorMsg.includes("404")) {
            console.log(`ASIN ${item.asin} not found on Amazon, skipping`);
            continue;
          }
          console.error(`Error fetching data for ASIN ${item.asin}:`, err);
        }
      }

      if (successCount > 0) {
        toast.success(`Auto-updated ${successCount} listings with missing data`);
      }
    } catch (error) {
      console.error("Error in auto-fetch:", error);
    } finally {
      setAutoFetchProgress(null);
      autoFetchRunRef.current = false;
    }
  };

  const openEditDialog = (item: InventoryItem) => {
    setEditDialogItem(item);
    setEditDialogOpen(true);
  };

  const handleEditDialogSave = async (data: {
    id: string;
    totalCost: number;
    units: number;
    cog: number;
    suppliers: Array<{ link: string; discount_code: string }>;
  }) => {
    const { error } = await supabase
      .from("created_listings")
      .update({
        cost: data.totalCost,
        units: data.units,
        amount: data.cog,
        supplier_links: data.suppliers as any,
      })
      .eq("id", data.id);

    if (error) {
      toast.error("Failed to save changes");
      throw error;
    }

    toast.success("Listing updated");
    fetchInventory();

    const item = inventory.find(i => i.id === data.id);
    if (item?.asin && item?.sku) {
      triggerAutoOnboard(item.asin, item.sku);
    }
  };

  const updatePrice = async (item: InventoryItem) => {
    try {
      setUpdatingPrice(item.id);
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");

      // Use simplified function that only fetches price without fees to save API quota
      const { data, error } = await supabase.functions.invoke(
        'fetch-product-price',
        {
          body: { asin: item.asin },
          headers: { Authorization: `Bearer ${session.access_token}` }
        }
      );

      if (error) {
        const msg = error.message || "";

        if (msg.includes("NOT_FOUND")) {
          toast.error("Amazon could not find this ASIN in the US marketplace. Price was not updated.");
          setUpdatingPrice(null);
          return;
        }

        if (msg.includes("QUOTA_EXCEEDED") || msg.includes("429")) {
          toast.warning("Amazon SP-API quota exceeded. Try again later.");
          setUpdatingPrice(null);
          return;
        }

        toast.error("Failed to update price: " + msg);
        setUpdatingPrice(null);
        return;
      }

      if (data?.error === "QUOTA_EXCEEDED") {
        toast.warning("Amazon SP-API quota exceeded. Try again later.");
        setUpdatingPrice(null);
        return;
      }

      if (data?.error === "NOT_FOUND") {
        toast.error("Amazon could not find this ASIN in the US marketplace. Price was not updated.");
        setUpdatingPrice(null);
        return;
      }

      if (data?.price) {
        const { error: updateError } = await supabase
          .from("created_listings")
          .update({ 
            price: data.price,
            title: data.title || item.title,
            image_url: data.imageUrl || item.image_url
          })
          .eq("id", item.id);

        if (updateError) throw updateError;

        toast.success(`Price updated to $${data.price.toFixed(2)}`);
        fetchInventory();
      } else {
        toast.error("No price data available");
      }
    } catch (error: any) {
      // Suppress quota exceeded errors to prevent runtime error overlay
      const errorMsg = error?.message || String(error);
      if (errorMsg.includes("QUOTA_EXCEEDED") || errorMsg.includes("429")) {
        console.log("Quota exceeded error suppressed for ASIN:", item.asin);
        toast.warning("Amazon SP-API quota exceeded. Try again later.");
      } else {
        console.error("Error updating price:", error);
        toast.error("Failed to update price");
      }
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

  const deleteItem = async (id: string, title?: string) => {
    setDeleteConfirmId(id);
    setDeleteConfirmTitle(title || "this item");
  };

  const confirmDelete = async () => {
    if (!deleteConfirmId) return;
    try {
      const { error } = await supabase.from("created_listings").delete().eq("id", deleteConfirmId);
      if (error) throw error;
      toast.success("Item deleted");
      setDeleteConfirmId(null);
      await fetchInventory();
    } catch (error: any) {
      console.error("Error deleting item:", error);
      toast.error("Failed to delete item");
    }
  };

  const deleteItemDirect = async (id: string) => {

    try {
      console.log("Deleting item:", id);
      const { error } = await supabase.from("created_listings").delete().eq("id", id);

      if (error) {
        console.error("Delete error:", error);
        throw error;
      }
      
      console.log("Item deleted successfully, refreshing list...");
      toast.success("Item deleted");
      await fetchInventory(); // Await the fetch to ensure it completes
    } catch (error: any) {
      console.error("Error deleting item:", error);
      toast.error("Failed to delete item");
    }
  };

  // ============= FIX SYNTHETIC SKUs =============
  // Rewrites every created_listings row for a given ASIN (current user) so the
  // SKU column equals the user-supplied "original" SKU. Use this to undo the
  // legacy generateSKU() snapshots that fragmented one ASIN across many rows.
  const previewFixSku = async () => {
    const asin = fixSkuAsin.trim().toUpperCase();
    if (!asin) { toast.error("Enter an ASIN"); return; }
    if (!user?.id) return;
    const { data, error } = await supabase
      .from("created_listings")
      .select("sku")
      .eq("user_id", user.id)
      .eq("asin", asin);
    if (error) { toast.error(error.message); return; }
    const skus = Array.from(new Set((data || []).map((r: any) => r.sku).filter(Boolean)));
    setFixSkuPreview({ count: data?.length || 0, current: skus });
  };

  const applyFixSku = async () => {
    const asin = fixSkuAsin.trim().toUpperCase();
    const newSku = fixSkuOriginal.trim();
    if (!asin || !newSku) { toast.error("Enter both ASIN and original SKU"); return; }
    if (!user?.id) return;
    setFixSkuBusy(true);
    try {
      const { data, error } = await supabase
        .from("created_listings")
        .update({ sku: newSku })
        .eq("user_id", user.id)
        .eq("asin", asin)
        .select("id");
      if (error) throw error;
      const n = data?.length || 0;
      toast.success(`Updated ${n} row${n === 1 ? "" : "s"} for ${asin} → SKU "${newSku}"`);
      setInventory(prev => prev.map(i => i.asin === asin ? { ...i, sku: newSku } : i));
      setFixSkuOpen(false);
      setFixSkuAsin(""); setFixSkuOriginal(""); setFixSkuPreview(null);
    } catch (e: any) {
      toast.error(e?.message || "Failed to update SKUs");
    } finally {
      setFixSkuBusy(false);
    }
  };

  // ============= AUTO-FIX ALL =============
  // Scan every created_listings row for the user, group by ASIN, and for each
  // ASIN that has more than one distinct SKU, treat the EARLIEST-created row's
  // SKU as the source of truth. Rewrite all sibling rows to that SKU.
  const scanAutoFix = async () => {
    if (!user?.id) return;
    setAutoFixScanning(true);
    setAutoFixResult(null);
    try {
      // 1) Pull EVERY created_listings row (page through 1000-row cap)
      const PAGE = 1000;
      let from = 0;
      const all: { asin: string; sku: string; created_at: string }[] = [];
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { data, error } = await supabase
          .from("created_listings")
          .select("asin, sku, created_at")
          .eq("user_id", user.id)
          .order("created_at", { ascending: true })
          .range(from, from + PAGE - 1);
        if (error) throw error;
        const rows = data || [];
        all.push(...(rows as any));
        if (rows.length < PAGE) break;
        from += PAGE;
      }

      // 2) Pull inventory (real Amazon SKUs) — used as authoritative source of truth
      const invByAsin = new Map<string, string>();
      let invFrom = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { data, error } = await supabase
          .from("inventory")
          .select("asin, sku")
          .eq("user_id", user.id)
          .range(invFrom, invFrom + PAGE - 1);
        if (error) break;
        const rows = data || [];
        for (const r of rows as any[]) {
          if (r.asin && r.sku && !invByAsin.has(r.asin)) invByAsin.set(r.asin, r.sku);
        }
        if (rows.length < PAGE) break;
        invFrom += PAGE;
      }

      // 3) Group created_listings rows by ASIN
      const byAsin = new Map<string, { sku: string; created_at: string }[]>();
      for (const r of all) {
        if (!r.asin || !r.sku) continue;
        const list = byAsin.get(r.asin) || [];
        list.push({ sku: r.sku, created_at: r.created_at });
        byAsin.set(r.asin, list);
      }

      // 4) Build candidates for EVERY ASIN where any row's SKU differs from the chosen source
      //    Source priority: real Amazon inventory.sku (if present) > earliest-created row's SKU
      const candidates: AutoFixCandidate[] = [];
      for (const [asin, rows] of byAsin.entries()) {
        rows.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
        const invSku = invByAsin.get(asin);
        const sourceSku = invSku || rows[0].sku;
        const source: 'inventory' | 'earliest' = invSku ? 'inventory' : 'earliest';
        const sourceCreatedAt = rows[0].created_at;
        const distinct = Array.from(new Set(rows.map(r => r.sku)));
        const others = distinct.filter(s => s !== sourceSku);
        const rowsToUpdate = rows.filter(r => r.sku !== sourceSku).length;
        if (rowsToUpdate === 0) continue; // already consistent with source
        candidates.push({ asin, sourceSku, sourceCreatedAt, otherSkus: others, rowsToUpdate, source });
      }
      candidates.sort((a, b) => b.rowsToUpdate - a.rowsToUpdate);
      setAutoFixCandidates(candidates);
      setAutoFixSelected(new Set(candidates.map(c => c.asin)));
      const invCount = candidates.filter(c => c.source === 'inventory').length;
      toast.success(`Scan complete — ${candidates.length} ASIN(s) need fixing (${invCount} via real Amazon SKU, ${candidates.length - invCount} via earliest row)`);
    } catch (e: any) {
      toast.error(e?.message || "Scan failed");
      setAutoFixCandidates([]);
    } finally {
      setAutoFixScanning(false);
    }
  };

  const applyAutoFix = async () => {
    if (!user?.id || !autoFixCandidates) return;
    const targets = autoFixCandidates.filter(c => autoFixSelected.has(c.asin));
    if (targets.length === 0) { toast.error("Select at least one ASIN"); return; }
    setAutoFixApplying(true);
    const errors: string[] = [];
    let asinsFixed = 0;
    let rowsUpdated = 0;
    try {
      for (const c of targets) {
        const { data, error } = await supabase
          .from("created_listings")
          .update({ sku: c.sourceSku })
          .eq("user_id", user.id)
          .eq("asin", c.asin)
          .neq("sku", c.sourceSku)
          .select("id");
        if (error) {
          errors.push(`${c.asin}: ${error.message}`);
        } else {
          asinsFixed += 1;
          rowsUpdated += data?.length || 0;
        }
      }
      setInventory(prev => prev.map(i => {
        const t = targets.find(x => x.asin === i.asin);
        return t ? { ...i, sku: t.sourceSku } : i;
      }));
      setAutoFixResult({ asinsFixed, rowsUpdated, errors });
      if (errors.length === 0) {
        toast.success(`Fixed ${asinsFixed} ASIN(s), updated ${rowsUpdated} row(s)`);
      } else {
        toast.error(`Completed with ${errors.length} error(s)`);
      }
      // Refresh scan
      const remaining = autoFixCandidates.filter(c => !autoFixSelected.has(c.asin));
      setAutoFixCandidates(remaining);
      setAutoFixSelected(new Set(remaining.map(c => c.asin)));
    } finally {
      setAutoFixApplying(false);
    }
  };

  const handleAddPurchaseConfirm = async (item: InventoryItem) => {
    try {
      // For "Add new Purchase", panel values are the NEW purchase amounts to add
      const addedTotalCost = panelTotalCost ? parseFloat(panelTotalCost) : 0;
      const addedUnits = panelUnits ? parseInt(panelUnits) : 0;

      // Require valid units and total cost for a purchase history row.
      if (!addedUnits || addedUnits <= 0 || !addedTotalCost || addedTotalCost <= 0) {
        toast.error("Enter units and total cost in the panel before adding a purchase");
        return;
      }

      // FBA eligibility gate — block FBA-bound writes unless user opted into FBM-only
      const blocked = purchaseFbaBlocked;
      if (blocked && !purchaseFbmAck) {
        toast.error("Amazon will reject this ASIN for FBA. Tick \"Save as FBM only\" to continue, or fix the listing barcode in Seller Central.");
        return;
      }
      setAddingPurchase(true);

      // Same contract as extension-create/background.js ARBIPRO_ADD_PURCHASE:
      // never update/upsert/merge the selected row. Every Add Purchase creates
      // a brand-new created_listings row with the exact same SKU and today's date.
      if (!user?.id) {
        setAddingPurchase(false);
        toast.error("You must be logged in to add a purchase record.");
        return;
      }

      const sourceSku = String(item.sku || "").trim();
      if (!sourceSku) {
        setAddingPurchase(false);
        toast.error("Missing SKU on picked listing — refusing to fabricate one. Pick a SKU from the picker.");
        return;
      }

      const newCog = addedUnits > 0 ? addedTotalCost / addedUnits : (item.amount || 0);
      const today = new Date();
      const yyyymmdd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      const fbaTagFields: { fba_blocked: boolean; fba_block_reason: string | null } = blocked
        ? { fba_blocked: true, fba_block_reason: purchaseFbaElig.data?.fba_block_reason ?? "manufacturer_barcode_or_invalid_fnsku" }
        : { fba_blocked: false, fba_block_reason: null };

      const { data, error } = await supabase
        .from("created_listings")
        .insert({
          user_id: user.id,
          asin: item.asin,
          sku: sourceSku,
          fnsku: item.fnsku ?? null,
          title: item.title ?? null,
          image_url: item.image_url ?? null,
          price: item.price ?? null,
          cost: addedTotalCost,
          amount: newCog,
          units: addedUnits,
          supplier_links: Array.isArray(item.supplier_links) ? item.supplier_links : [],
          date_created: yyyymmdd,
          validation_status: "ACTIVE",
          ...fbaTagFields,
        } as any)
        .select()
        .single();

      if (error) throw new Error(`Created listing purchase row insert failed: ${formatSupabaseError(error)}`);
      if (!data?.id) throw new Error("Created listing purchase row insert returned no row ID");

      const formattedData = {
        ...data,
        supplier_links: Array.isArray(data.supplier_links)
          ? data.supplier_links as Array<{ link: string; discount_code: string }>
          : [],
        fees_json: null,
      };
      setInventory(prev => [...prev, formattedData]);

      toast.success(`Purchase added — ${addedUnits} units @ $${newCog.toFixed(2)} COG ✓`);

      // === Cost versioning: write asin_cost_overrides only if COG changed ===
      // Applies to P&L (forward) + Repricer ROI floor. Inventory valuation untouched.
      try {
        const newCog = addedUnits > 0 ? Number((addedTotalCost / addedUnits).toFixed(4)) : 0;
        if (newCog > 0 && user?.id) {
          const effective = format(panelEffectiveDate ?? new Date(), "yyyy-MM-dd");
          // Look up most recent override for this ASIN
          const { data: lastOverride } = await supabase
            .from("asin_cost_overrides")
            .select("unit_cost, effective_from")
            .eq("user_id", user.id)
            .eq("asin", item.asin)
            .order("effective_from", { ascending: false })
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();

          const lastCost = lastOverride?.unit_cost != null ? Number(lastOverride.unit_cost) : null;
          const changed = lastCost == null || Math.abs(lastCost - newCog) >= 0.005;

          if (changed) {
            const { error: ovErr } = await supabase.from("asin_cost_overrides").insert({
              user_id: user.id,
              asin: item.asin,
              unit_cost: newCog,
              effective_from: effective,
              note: `Auto-saved from purchase (${addedUnits} units @ $${(addedTotalCost / addedUnits).toFixed(2)})`,
              created_by: user.id,
            });
            if (ovErr && ovErr.code !== "23505") {
              console.warn("Cost override insert failed:", ovErr);
            } else if (!ovErr) {
              setOverriddenAsins((prev) => {
                const next = new Set(prev);
                next.add(item.asin);
                return next;
              });
              const today = format(new Date(), "yyyy-MM-dd");
              if (effective < today) {
                toast.info(`Cost saved (effective ${effective}) — past P&L snapshots stay frozen`);
              } else {
                toast.success(`COG ${`$${newCog.toFixed(2)}`} effective from ${effective}`);
              }
            }
          }
        }
      } catch (e) {
        console.warn("Cost override side-write failed (non-fatal):", e);
      }
    } catch (error: any) {
      const reason = error?.message || formatSupabaseError(error);
      console.error("Error adding purchase:", error);
      toast.error(`Failed to add purchase: ${reason}`);
    } finally {
      setAddingPurchase(false);
    }
  };

  // Try to silently recover an FNSKU for an item by syncing it from Amazon
  // (rescue-inventory-asin) when the local row has none. Updates state so the
  // label preview reflects the recovered code without any manual click.
  const recoverFnskuForItem = async (item: InventoryItem): Promise<string | null> => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) return null;

      await supabase.functions.invoke('rescue-inventory-asin', {
        headers: { Authorization: `Bearer ${session.access_token}` },
        body: { asin: item.asin, sku: item.sku },
      });

      // Re-read FNSKU from authoritative tables (inventory + fnsku_map)
      const [{ data: invRow }, { data: mapRow }] = await Promise.all([
        supabase.from('inventory').select('fnsku').eq('user_id', user!.id).eq('asin', item.asin).eq('sku', item.sku).maybeSingle(),
        supabase.from('fnsku_map').select('fnsku').eq('asin', item.asin).eq('seller_sku', item.sku).order('updated_at', { ascending: false }).limit(1).maybeSingle(),
      ]);
      const recovered = (invRow?.fnsku || mapRow?.fnsku || '').toString().trim().toUpperCase();
      if (isPrintableFnsku(recovered, item.asin)) {
        await supabase.from('created_listings').update({ fnsku: recovered }).eq('id', item.id);
        setInventory(prev => prev.map(i => i.id === item.id ? { ...i, fnsku: recovered } : i));
        return recovered;
      }
      return null;
    } catch (e) {
      console.warn('Auto FNSKU recovery failed:', e);
      return null;
    }
  };

  const openPrintDialog = async (item: InventoryItem) => {
    if (!item.title) {
      toast.error("Product title is missing");
      return;
    }

    let fnsku = item.fnsku || null;
    if (!fnsku) {
      toast.info("Recovering FNSKU from Amazon…");
      fnsku = await recoverFnskuForItem(item);
      if (fnsku) toast.success(`FNSKU recovered: ${fnsku}`);
    }

    if (!isPrintableFnsku(fnsku, item.asin)) {
      toast.error("Printing blocked: this listing needs a real X00 FNSKU. ASIN/manufacturer barcode labels cannot be printed here.");
      return;
    }

    const labels = [{
      asin: item.asin,
      fnsku: fnsku.trim().toUpperCase(),
      condition: null,
      title: item.title,
    }];

    setLabelsForPrint(labels);
    setLabelDialogOpen(true);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    console.log("File input triggered");
    const file = e.target.files?.[0];
    console.log("Selected file:", file?.name, file?.type, file?.size);
    if (file) {
      setUploadFile(file);
      toast.success(`File selected: ${file.name}`);
    } else {
      console.log("No file selected");
    }
  };

  const processExcelFile = async (file: File) => {
    if (!user) {
      toast.error("You must be logged in to upload");
      return;
    }

      setIsUploading(true);
      setCancelImport(false);
      cancelImportRef.current = false;
      setImportProgress(null);

      try {
      console.log("Starting Excel import...");
      const arrayBuffer = await file.arrayBuffer();
      console.log("File read successfully, size:", arrayBuffer.byteLength);
      
      const workbook = XLSX.read(arrayBuffer, { type: "array" });
      console.log("Workbook parsed, sheets:", workbook.SheetNames);

      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows: any[] = XLSX.utils.sheet_to_json(firstSheet);
      console.log("Rows extracted:", rows.length);
      console.log("First row sample:", rows[0]);

      if (!rows.length) {
        toast.error("No rows found in the Excel file");
        setIsUploading(false);
        return;
      }

      const headerRows: any[][] = XLSX.utils.sheet_to_json(firstSheet, { header: 1 });
      const rawHeaderRow = (headerRows[0] || []) as (string | number | null | undefined)[];
      const rawHeaders = rawHeaderRow.map((h) => (h != null ? String(h) : ""));

      // For logging, show trimmed headers (but keep original strings for key access)
      const headersForLog = rawHeaders.map((h) => h.trim()).filter((h) => h.length > 0);
      console.log("Detected headers:", headersForLog);

      const normalize = (h: string) => h.toLowerCase().replace(/\s+/g, "").replace(/_/g, "");
      const findCol = (...candidates: string[]) => {
        const normalized = rawHeaders.map((h) => ({ h, norm: normalize(h) }));
        for (const cand of candidates) {
          const target = normalize(cand);
          const match = normalized.find((n) => n.norm === target);
          if (match) return match.h;
        }
        return undefined;
      };

      const asinCol = findCol("ASIN");
      const titleCol = findCol("Title"); // Excel "Title" column = supplier URL
      const linkCol = findCol("Link"); // Excel "Link" column = supplier URL
      const supplierCol = findCol("Supplier");
      const discountCodeCol = findCol("Discount"); // Discount code
      const discountCol = findCol("Discount Amount", "DiscountAmount", "AMOUNT", "Amount", "Total Cost", "TotalCost"); // Unit cost
      const unitsCol = findCol("Units", "Qty", "Quantity");
      const unitCostCol = findCol("UnitCost", "Unit Cost", "Unit_Cost");
      const dateCreatedCol = findCol("DateCreated", "Date Created", "Date", "Created");

      console.log("Resolved columns:", { asinCol, titleCol, linkCol, supplierCol, discountCodeCol, discountCol, unitsCol, unitCostCol, dateCreatedCol });

      if (!asinCol) {
        toast.error("Could not find required ASIN column in the file");
        console.error("Missing ASIN column. Headers:", headersForLog);
        setIsUploading(false);
        return;
      }

      let imported = 0;
      const total = rows.length;
      setImportProgress({ total, imported: 0 });
      
      // Show info toast about potential rate limiting
      toast.info(`Starting import of ${total} products. Some may skip if Amazon quota is exceeded.`, { duration: 5000 });

      const batchSize = 50;

      for (let i = 0; i < rows.length; i += batchSize) {
        // Check if user cancelled the import
        if (cancelImportRef.current) {
          console.log("Import cancelled by user at batch", i / batchSize + 1);
          toast.warning(`Import stopped. Processed ${imported} of ${total} products.`);
          break;
        }

        const batch = rows.slice(i, i + batchSize);
        const batchNum = i / batchSize + 1;
        console.log(`Processing batch ${batchNum}, rows ${i + 1} to ${Math.min(i + batchSize, rows.length)}`);

        const records = await Promise.all(
          batch.map(async (row, idx) => {
            try {
              if (cancelImportRef.current) {
                console.log(`Row ${i + idx + 1}: Import cancelled, skipping row`);
                return null;
              }
              const asin = asinCol ? row[asinCol]?.toString().trim() : undefined;
              const supplierUrl = linkCol ? row[linkCol]?.toString().trim() || "" : ""; // Supplier URL from "LINK" column
              // Product title is fetched from Amazon SP-API, not from Excel
              const supplierName = supplierCol ? row[supplierCol]?.toString().trim() || "" : "";

              const discountCode = discountCodeCol ? row[discountCodeCol]?.toString().trim() || "" : ""; // Discount code
              const discountRaw = discountCol ? row[discountCol] : undefined; // Unit cost amount
              const unitsRaw = unitsCol ? row[unitsCol] : undefined;
              const unitCostRaw = unitCostCol ? row[unitCostCol] : undefined;
              const dateCreatedRaw = dateCreatedCol ? row[dateCreatedCol] : undefined;

              // "Discount Amount" column contains unit cost per item, not total cost
              const unitCost = parseFloat(String(discountRaw ?? "0"));
              const units = parseInt(String(unitsRaw ?? "1"), 10);
              // Calculate total cost = unit cost × units
              const totalCost = unitCost * units;

              console.log(`Row ${i + idx + 1}: Excel data - ASIN: ${asin}, UnitCost: $${unitCost.toFixed(2)}, Units: ${units}, TotalCost: $${totalCost.toFixed(2)}`);

              // Parse DateCreated from Excel format into DATE (YYYY-MM-DD), stripping time if present
              let dateCreated: string | null = null;
              if (dateCreatedRaw !== undefined && dateCreatedRaw !== null && dateCreatedRaw !== "") {
                try {
                  if (typeof dateCreatedRaw === "number" && (XLSX as any).SSF?.parse_date_code) {
                    // Excel serial date (includes time as decimal, we only want the date part)
                    const parsed = (XLSX as any).SSF.parse_date_code(dateCreatedRaw);
                    if (parsed && parsed.y && parsed.m && parsed.d) {
                      const year = String(parsed.y);
                      const month = String(parsed.m).padStart(2, "0");
                      const day = String(parsed.d).padStart(2, "0");
                      dateCreated = `${year}-${month}-${day}`;
                    }
                  } else {
                    let dateStr = dateCreatedRaw.toString().trim();
                    
                    // Strip time component if present (e.g., "04/17/2024 10:33:23" -> "04/17/2024")
                    if (dateStr.includes(" ")) {
                      dateStr = dateStr.split(" ")[0]; // Take only the date part before the space
                    }
                    
                    let year: string | undefined;
                    let month: string | undefined;
                    let day: string | undefined;

                    if (dateStr.includes("/")) {
                      const parts = dateStr.split("/");
                      if (parts.length === 3) {
                        // Assume MM/DD/YYYY (US format)
                        [month, day, year] = parts;
                      }
                    } else if (dateStr.includes("-")) {
                      const parts = dateStr.split("-");
                      if (parts.length === 3) {
                        if (parts[0].length === 4) {
                          // YYYY-MM-DD
                          [year, month, day] = parts;
                        } else {
                          // MM-DD-YYYY
                          [month, day, year] = parts;
                        }
                      }
                    }

                    if (year && month && day) {
                      dateCreated = `${year.padStart(4, "0")}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
                    }
                  }
                } catch {
                  console.warn(`Row ${i + idx + 1}: Could not parse date ${dateCreatedRaw}`);
                }
              }

              if (!asin) {
                console.warn(`Row ${i + idx + 1}: Missing ASIN, skipping`, { asin, row });
                return null;
              }

              // Extract domain from supplier URL
              let domain = "";
              if (supplierUrl) {
                try {
                  const url = new URL(supplierUrl.startsWith('http') ? supplierUrl : `https://${supplierUrl}`);
                  domain = url.hostname.replace('www.', '');
                } catch (e) {
                  domain = supplierName || "unknown";
                }
              }

              // Skip SP-API fetch during import to preserve quota
              // User can refresh selected records later using "Refresh Selected" button
              let amazonPrice: number | null = null;
              let amazonTitle: string = "";
              let amazonImage: string = "";
              let amazonFees: number | null = null;
              
              console.log(`Row ${i + idx + 1}: Importing ASIN ${asin} without fetching Amazon data (preserving quota)`);

              // STRICT: ROI cannot be calculated without actual fee data from asin_fee_cache
              // Do NOT use hardcoded 15% / $4.43 fallbacks - this will be calculated after settlement
              let calculatedRoi: number | null = null;
              // ROI left as null - will be calculated when product has actual fee data

              
              const supplierLinks = supplierUrl
                ? [{ link: supplierUrl, discount_code: discountCode }]
                : [];

              // Contract A: created_listings.cost = TOTAL batch cost, amount = UNIT cost.
              // See src/lib/cost-contract.ts for the locked contract.
              const record: any = {
                user_id: user?.id || "",
                asin,
                sku: generateSKU(),
                title: amazonTitle || "Untitled Product", // Use Amazon title only
                image_url: amazonImage || null,
                price: amazonPrice,
                cost: totalCost, // Contract A: TOTAL batch cost
                amount: unitCost, // Contract A: UNIT cost
                units,
                supplier_links: supplierLinks,
                fnsku: null,
                date_created: dateCreated,
              };
              
              console.log(`Row ${i + idx + 1}: Final record:`, {
                asin,
                title: (amazonTitle || "Untitled Product").substring(0, 50),
                price: amazonPrice,
                totalCost,
                unitCost,
                units,
                roi: calculatedRoi?.toFixed(2)
              });

              return record;
            } catch (error) {
              console.error(`Error processing row ${i + idx + 1}:`, error, row);
              return null;
            }
          })
        );

        const validRecords = records.filter((r) => r !== null);

        if (validRecords.length > 0) {
          // Separate records into updates (ASIN exists) and inserts (new ASIN)
          const toInsert: any[] = [];
          const toUpdate: any[] = [];

          for (const record of validRecords) {
            const existing = inventory.find(i => i.asin === record.asin);
            if (existing) {
              toUpdate.push({ record, existing });
            } else {
              toInsert.push(record);
            }
          }

          // Update existing entries: add units and costs.
          // Post-Fix 1, `record` follows Contract A: cost = TOTAL, amount = UNIT.
          // existing.cost is also Contract A TOTAL.
          for (const { record, existing } of toUpdate) {
            const recordUnits = record.units || 0;
            const recordTotalCost = record.cost || 0; // Contract A TOTAL for this batch
            const recordUnitCost = record.amount || 0; // Contract A UNIT
            const updatedUnits = (existing.units || 0) + recordUnits;
            const existingTotalCost = existing.cost || 0;
            const updatedTotalCost = existingTotalCost + recordTotalCost;
            const updatedUnitCost = updatedUnits > 0 ? updatedTotalCost / updatedUnits : 0;

            const { error: updateError } = await supabase
              .from("created_listings")
              .update({
                cost: updatedTotalCost,
                amount: updatedUnitCost,
                units: updatedUnits,
                supplier_links: record.supplier_links?.length > 0 ? record.supplier_links : undefined,
                // PRESERVE original date_created on existing listings — new purchase
                // dates live in created_listing_purchases. Overwriting date_created
                // would erase the original creation date of the listing.
              })
              .eq("id", existing.id);

            if (updateError) {
              console.error(`Update error for ASIN ${record.asin}:`, updateError);
            } else {
              // Record purchase in history
              if (recordUnits > 0) {
                await supabase.from("created_listing_purchases").insert({
                  listing_id: existing.id,
                  user_id: user?.id,
                  units: recordUnits,
                  unit_cost: recordUnitCost,
                  total_cost: recordTotalCost,
                  purchase_date: record.date_created || new Date().toISOString(),
                  note: "Excel import",
                });
              }
              console.log(`Updated existing ASIN ${record.asin}: +${recordUnits} units (total: ${updatedUnits})`);
              imported++;
            }
          }

          // Insert genuinely new ASINs
          if (toInsert.length > 0) {
            console.log(`Inserting batch ${batchNum}: ${toInsert.length} new records, updated ${toUpdate.length} existing`);
            const { data: insertedData, error: insertError } = await supabase.from("created_listings").insert(toInsert).select("id, units, cost, amount, date_created");
            if (insertError) {
              console.error(`Batch ${batchNum} insert error:`, insertError);
              throw insertError;
            }
            // Create purchase records for new inserts
            if (insertedData) {
              const purchaseRecords = insertedData
                .filter(r => (r.units || 0) > 0)
                .map(r => ({
                  listing_id: r.id,
                  user_id: user?.id,
                  units: r.units || 0,
                  unit_cost: r.amount || 0,
                  total_cost: r.cost || 0,
                  purchase_date: r.date_created || new Date().toISOString(),
                  note: "Excel import",
                }));
              if (purchaseRecords.length > 0) {
                await supabase.from("created_listing_purchases").insert(purchaseRecords);
              }
            }
            imported += toInsert.length;
          } else {
            console.log(`Batch ${batchNum}: updated ${toUpdate.length} existing records, 0 new inserts`);
          }

          setImportProgress({ total, imported });
          console.log(`Batch ${batchNum} completed. Total imported: ${imported}/${total}`);
        }
      }

      if (imported > 0) {
        if (!cancelImport) {
          toast.success(`Imported ${imported} of ${rows.length} rows`);
        }
        setUploadFile(null);
        fetchInventory();
      } else {
        if (!cancelImport) {
          toast.error("No valid rows were imported");
        }
      }
    } catch (error: any) {
      // Suppress quota exceeded errors to prevent runtime error overlay
      const errorMsg = error?.message || String(error);
      if (errorMsg.includes("QUOTA_EXCEEDED") || errorMsg.includes("429")) {
        console.log("Import completed with quota limitations");
        toast.warning("Import completed. Some products skipped due to Amazon quota limits.");
      } else {
        console.error("Upload error:", error);
        toast.error(`Failed to process Excel file: ${error.message}`);
      }
    } finally {
      setIsUploading(false);
      setCancelImport(false);
    }
  };

  const handleUploadExcel = async () => {
    if (!uploadFile) {
      toast.error("Please select a file to upload");
      return;
    }

    await processExcelFile(uploadFile);
  };

  const toggleSelectItem = (itemId: string) => {
    setSelectedItems(prev => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  };


  const toggleSelectAll = () => {
    const pageIds = paginatedInventory.map(item => item.id);
    const allOnPageSelected = pageIds.every(id => selectedItems.has(id));
    setSelectedItems(prev => {
      const next = new Set(prev);
      if (allOnPageSelected) {
        pageIds.forEach(id => next.delete(id));
      } else {
        pageIds.forEach(id => next.add(id));
      }
      return next;
    });
  };


  const refreshSelectedItems = async () => {
    if (selectedItems.size === 0) {
      toast.error("Please select at least one item to refresh");
      return;
    }

    const selectedItemsList = Array.from(selectedItems);
    const itemsToRefresh = inventory.filter(item => selectedItemsList.includes(item.id));

    setIsRefreshing(true);
    let successCount = 0;
    let errorCount = 0;

    toast.info(`Refreshing ${itemsToRefresh.length} selected items... This may take a moment.`);

    for (let i = 0; i < itemsToRefresh.length; i++) {
      const item = itemsToRefresh[i];
      
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) throw new Error("Not authenticated");

        // Add timeout to prevent hanging requests
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error("Request timeout")), 30000)
        );

        // Use simplified function that only fetches price without fees to save API quota
        const invokePromise = supabase.functions.invoke(
          'fetch-product-price',
          {
            body: { asin: item.asin },
            headers: { Authorization: `Bearer ${session.access_token}` }
          }
        );

        const { data, error } = await Promise.race([invokePromise, timeoutPromise]) as any;

        if (error) {
          const msg = error.message || "";
          if (msg.includes("QUOTA_EXCEEDED") || msg.includes("429")) {
            toast.warning(`Quota exceeded at item ${i + 1} of ${itemsToRefresh.length}. Stopping refresh.`);
            errorCount++;
            break;
          }
          console.error(`Error refreshing ASIN ${item.asin}:`, error);
          errorCount++;
          continue;
        }

        if (data?.error === "QUOTA_EXCEEDED") {
          toast.warning(`Quota exceeded at item ${i + 1} of ${itemsToRefresh.length}. Stopping refresh.`);
          errorCount++;
          break;
        }

        if (data?.error === "NOT_FOUND") {
          console.log(`ASIN ${item.asin} not found in Amazon marketplace`);
          errorCount++;
          continue;
        }

        if (data?.price !== undefined || data?.title || data?.imageUrl) {
          const updateData: any = {};
          if (data.price !== undefined) updateData.price = data.price;
          if (data.title) updateData.title = data.title;
          if (data.imageUrl) updateData.image_url = data.imageUrl;

          const { error: updateError } = await supabase
            .from("created_listings")
            .update(updateData)
            .eq("id", item.id);

          if (!updateError) {
            // Update local state immediately
            setInventory(prevInventory =>
              prevInventory.map(invItem =>
                invItem.id === item.id
                  ? { ...invItem, ...updateData }
                  : invItem
              )
            );
            successCount++;
          } else {
            console.error(`Error updating ASIN ${item.asin}:`, updateError);
            errorCount++;
          }
        }

        // Delay between API calls to respect rate limits (500ms)
        if (i < itemsToRefresh.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }

      } catch (error: any) {
        const errorMsg = error?.message || String(error);
        console.error(`Exception refreshing ASIN ${item.asin}:`, error);
        
        if (errorMsg.includes("QUOTA_EXCEEDED") || errorMsg.includes("429")) {
          toast.warning(`Quota exceeded at item ${i + 1} of ${itemsToRefresh.length}. Stopping refresh.`);
          break;
        }
        
        if (errorMsg.includes("timeout") || errorMsg.includes("network") || errorMsg.includes("CF Error")) {
          toast.error(`Connection error at item ${i + 1}. Please check your connection and try again.`);
          errorCount++;
          continue;
        }
        
        errorCount++;
      }
    }

    setIsRefreshing(false);
    
    if (successCount > 0) {
      toast.success(`Successfully refreshed ${successCount} items`);
      // No need to refetch - UI already updated via database updates
      setSelectedItems(new Set()); // Clear selection after refresh
    }
    
    if (errorCount > 0) {
      toast.error(`${errorCount} items failed to refresh`);
    }
  };

  const deleteSelectedRecords = async () => {
    if (selectedItems.size === 0) {
      toast.error("No items selected");
      return;
    }

    if (!confirm(`Are you sure you want to delete ${selectedItems.size} selected record(s)? This cannot be undone.`)) {
      return;
    }

    try {
      const itemsToDelete = Array.from(selectedItems);
      
      const { error } = await supabase
        .from("created_listings")
        .delete()
        .in("id", itemsToDelete);

      if (error) throw error;

      toast.success(`Successfully deleted ${itemsToDelete.length} record(s)`);
      setSelectedItems(new Set()); // Clear selection after delete
      await fetchInventory();
    } catch (error: any) {
      console.error("Error deleting selected records:", error);
      toast.error("Failed to delete selected records");
    }
  };

  const handleSort = (column: 'date_created' | 'price') => {
    if (sortColumn === column) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(column);
      setSortDirection('desc');
    }
  };

  const openRoiDialog = (item: InventoryItem) => {
    // Allow dialog to open for all records - it will show appropriate messages for missing data
    setSelectedRoiItem(item);
    setRoiDialogOpen(true);
  };

  // Build a map: item.id -> Set of supplier domains. An item may have multiple
  // supplier links (e.g. Walmart primary + Target secondary) — index ALL of
  // them so supplier filtering / counts don't silently drop matching rows.
  const { supplierByItem, supplierCounts, supplierList } = useMemo(() => {
    const byItem = new Map<string, Set<string>>();
    const counts = new Map<string, number>();
    let noSupplierCount = 0;

    const getDomain = (link: string): string | null => {
      if (!link || !link.trim()) return null;
      try {
        const raw = link.trim();
        const url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
        // Strip www and subdomains like smile., keep core domain
        const host = url.hostname.replace(/^(www\.|smile\.)/i, '');
        // Return just the main domain (e.g. "amazon.com", "walmart.com")
        const parts = host.split('.');
        if (parts.length > 2) return parts.slice(-2).join('.');
        return host;
      } catch {
        return null; // skip unparseable links
      }
    };

    inventory.forEach(item => {
      const links = item.supplier_links?.filter(s => s.link?.trim()) || [];
      if (links.length === 0) {
        noSupplierCount++;
        return;
      }
      const domains = new Set<string>();
      for (const l of links) {
        const d = getDomain(l.link);
        if (d) domains.add(d);
      }
      if (domains.size === 0) {
        noSupplierCount++;
        return;
      }
      byItem.set(item.id, domains);
      domains.forEach(d => counts.set(d, (counts.get(d) || 0) + 1));
    });

    counts.set('__none__', noSupplierCount);
    const list = Array.from(counts.keys()).filter(k => k !== '__none__').sort();
    return { supplierByItem: byItem, supplierCounts: counts, supplierList: list };
  }, [inventory]);

  const availableYears = useMemo(() => {
    const years = new Set<number>();
    inventory.forEach(item => {
      if (item.date_created) {
        const yStr = String(item.date_created).slice(0, 4);
        const y = parseInt(yStr, 10);
        if (!isNaN(y)) years.add(y);
      }
    });
    if (years.size === 0) years.add(nowCL.getFullYear());
    return Array.from(years).sort((a, b) => b - a);
  }, [inventory]);

  // Count how many records exist per ASIN. A "newly created" listing is one
  // that has only a SINGLE row in created_listings — i.e. no Add Purchase
  // snapshot rows have been appended to it yet.
  const asinRecordCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of inventory) {
      if (!it.asin) continue;
      m.set(it.asin, (m.get(it.asin) || 0) + 1);
    }
    return m;
  }, [inventory]);
  const isNewlyCreatedRow = (item: InventoryItem) =>
    (asinRecordCount.get(item.asin) || 0) === 1;
  // Kept for backward compat with old filter logic below
  const isPurchaseBatchRow = (item: InventoryItem) =>
    !!item.notes && item.notes.trim().startsWith("New purchase batch (");

  const filteredInventory = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    const filterMonth = parseInt(selectedMonth);
    const filterYear = parseInt(selectedYear);
    const hasSupplierSearch = supplierSearch.trim().length > 0 || (selectedSupplier !== "all" && selectedSupplier !== "none");
    return inventory.filter((item) => {
      // Source filter (newly created listing vs added purchase batch)
      if (sourceFilter === "new" && !isNewlyCreatedRow(item)) return false;
      if (sourceFilter === "purchase" && isNewlyCreatedRow(item)) return false;

      // Notes-only filter: skip date/supplier filters, show only items with notes
      if (showNotesOnly) {
        if (!item.notes || !item.notes.trim()) return false;
        if (!term) return true;
        return (
          item.asin.toLowerCase().includes(term) ||
          item.sku.toLowerCase().includes(term) ||
          item.title.toLowerCase().includes(term)
        );
      }

      // Skip date filter when supplier search is active OR when a search term is entered
      if (!hasSupplierSearch && !term) {
        if (item.date_created) {
          // date_created is a DATE column — parse as YYYY-MM-DD to avoid UTC->local TZ rollback
          const dateStr = String(item.date_created).slice(0, 10); // "2026-05-01"
          const [yStr, mStr] = dateStr.split("-");
          const itemYear = parseInt(yStr, 10);
          const itemMonth = parseInt(mStr, 10) - 1; // 0-indexed
          if (itemMonth !== filterMonth || itemYear !== filterYear) return false;
        } else {
          return false;
        }
      }

      if (selectedSupplier === "none" && supplierByItem.has(item.id)) return false;
      if (selectedSupplier !== "all" && selectedSupplier !== "none" && !supplierByItem.get(item.id)?.has(selectedSupplier)) return false;

      // Free-text supplier search: substring match against any supplier domain
      // or full link on the item. Decoupled from selectedSupplier so the user
      // can type partial names ("target", "walm") and see every match — not
      // just items whose primary supplier happens to be that domain.
      const supTerm = supplierSearch.trim().toLowerCase();
      if (supTerm) {
        const domains = supplierByItem.get(item.id);
        const linkHit = (item.supplier_links || []).some(s =>
          (s.link || "").toLowerCase().includes(supTerm)
        );
        const domainHit = domains
          ? Array.from(domains).some(d => d.toLowerCase().includes(supTerm))
          : false;
        if (!linkHit && !domainHit) return false;
      }

      if (!term) return true;
      return (
        item.asin.toLowerCase().includes(term) ||
        item.sku.toLowerCase().includes(term) ||
        item.title.toLowerCase().includes(term)
      );
    });
  }, [inventory, searchTerm, selectedSupplier, supplierByItem, selectedMonth, selectedYear, supplierSearch, showNotesOnly, sourceFilter]);

  // Sort filtered inventory
  const sortedInventory = [...filteredInventory].sort((a, b) => {
    // Default: sort by newest date_created first
    if (!sortColumn) {
      const dateA = a.date_created ? new Date(a.date_created).getTime() : (a.created_at ? new Date(a.created_at).getTime() : 0);
      const dateB = b.date_created ? new Date(b.date_created).getTime() : (b.created_at ? new Date(b.created_at).getTime() : 0);
      return dateB - dateA;
    }
    
    if (sortColumn === 'date_created') {
      const dateA = a.date_created ? new Date(a.date_created).getTime() : 0;
      const dateB = b.date_created ? new Date(b.date_created).getTime() : 0;
      return sortDirection === 'asc' ? dateA - dateB : dateB - dateA;
    }
    
    if (sortColumn === 'price') {
      const priceA = a.price || 0;
      const priceB = b.price || 0;
      return sortDirection === 'asc' ? priceA - priceB : priceB - priceA;
    }
    
    return 0;
  });

  // Pagination calculations
  const totalPages = Math.ceil(sortedInventory.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const paginatedInventory = sortedInventory.slice(startIndex, endIndex);

  // Reset to page 1 when search term or items per page changes
  useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm, itemsPerPage]);

  // Reset highlighted row when page changes
  useEffect(() => {
    setHighlightedRowIdx(-1);
    setNoteText("");
  }, [currentPage, searchTerm, selectedSupplier]);

  // Sync note text when highlighted row changes (only on row change, not on data refresh)
  const prevHighlightedRef = useRef<number>(-1);
  useEffect(() => {
    if (highlightedRowIdx !== prevHighlightedRef.current) {
      prevHighlightedRef.current = highlightedRowIdx;
      if (highlightedRowIdx >= 0 && highlightedRowIdx < paginatedInventory.length) {
        setNoteText(paginatedInventory[highlightedRowIdx].notes || "");
      } else {
        setNoteText("");
      }
    }
  }, [highlightedRowIdx]);

  // Keyboard arrow navigation for table rows
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      // Don't intercept if user is in an input/select/textarea
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      e.preventDefault();
      setHighlightedRowIdx(prev => {
        const maxIdx = paginatedInventory.length - 1;
        if (maxIdx < 0) return -1;
        if (e.key === 'ArrowDown') return prev < maxIdx ? prev + 1 : 0;
        if (e.key === 'ArrowUp') return prev > 0 ? prev - 1 : maxIdx;
        return prev;
      });
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [paginatedInventory.length]);

  // Scroll highlighted row into view
  useEffect(() => {
    if (highlightedRowIdx < 0) return;
    const row = tableScrollRef.current?.querySelector(`tbody tr:nth-child(${highlightedRowIdx + 1})`);
    row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [highlightedRowIdx]);


  // Product Library is included in the all-in-one suite subscription / free trial — no separate paywall.

  if (subLoading && inventory.length === 0) {
    return (
      <div className="min-h-screen flex flex-col bg-gradient-to-br from-[hsl(222,84%,4.9%)] via-[hsl(230,50%,10%)] to-[hsl(260,50%,8%)]">
        <Navbar />
        <main className="flex-1 flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </main>
      </div>
    );
  }

  return (
    <>
      <Helmet>
        <title>Product Library - InventorySprint</title>
        <meta
          name="description"
          content="View and manage your manually created Amazon listings"
        />
      </Helmet>
      <div className="min-h-screen flex flex-col bg-gradient-to-br from-[hsl(222,84%,4.9%)] via-[hsl(230,50%,10%)] to-[hsl(260,50%,8%)] relative overflow-hidden">
        {/* Animated gradient orbs */}
        <div className="absolute top-1/4 -left-32 w-96 h-96 bg-primary/20 rounded-full blur-[120px] animate-pulse" />
        <div className="absolute bottom-1/4 -right-32 w-96 h-96 bg-purple-500/15 rounded-full blur-[120px] animate-pulse" style={{ animationDelay: '1s' }} />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-primary/5 rounded-full blur-[200px]" />
        <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-[size:64px_64px]" />
        <Navbar />
        <main className="flex-1 px-2 py-8 pt-24 relative z-10">
          <div className="max-w-full">
            <div className="mb-6 px-2 flex items-center justify-between">
              <h1 className="text-3xl font-bold text-white">
                Product Library
              </h1>
              <div className="flex items-center gap-2">
                <Button
                  onClick={() => navigate("/tools/create-listing")}
                  className="bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-600 hover:to-teal-600 text-white shadow-lg shadow-emerald-500/20"
                  size="sm"
                >
                  <Plus className="mr-1.5 h-4 w-4" />
                  Create Listing
                </Button>
                <Button
                  onClick={() => navigate("/tools/still-thinking")}
                  className="bg-gradient-to-r from-amber-400 to-yellow-500 hover:from-amber-500 hover:to-yellow-600 text-white shadow-lg"
                  size="sm"
                  title="ASINs you saved from the extension while sourcing — not yet purchased"
                >
                  💭 Still Thinking
                </Button>
                <Button
                  onClick={() => navigate("/tools/need-buy-again")}
                  className="bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 text-white shadow-lg"
                  size="sm"
                >
                  <ShoppingCart className="mr-1.5 h-4 w-4" />
                  Need Buy Again
                </Button>
              </div>
            </div>

            {autoFetchProgress && (
              <Card className="p-3 mb-4 bg-blue-500/10 border-blue-500/30">
                <div className="flex items-center gap-3">
                  <RefreshCw className="w-4 h-4 text-blue-500 animate-spin" />
                  <span className="text-sm text-blue-600 dark:text-blue-400">
                    Auto-fetching missing images & titles: {autoFetchProgress.current} / {autoFetchProgress.total}
                  </span>
                </div>
              </Card>
            )}

            {isAdmin && (<><div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
              <Card className="p-3 bg-primary/5 border-2 border-primary/20">
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <Upload className="w-4 h-4 text-primary" />
                    <h3 className="text-sm font-semibold">Import from Excel</h3>
                    <button onClick={() => setExcelInfoOpen(true)} className="ml-1 text-muted-foreground hover:text-primary transition-colors" title="View required columns">
                      <Info className="w-4 h-4" />
                    </button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Upload your .xlsx file to import listings. Click <Info className="w-3 h-3 inline" /> for column format.
                  </p>
                  <div className="flex items-center gap-3">
                    <input
                      type="file"
                      accept=".xlsx,.xls,.csv"
                      onChange={handleFileSelect}
                      className="hidden"
                      id="excel-upload"
                      key={uploadFile?.name || 'file-input'}
                    />
                    <label
                      htmlFor="excel-upload"
                      className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg cursor-pointer hover:bg-primary/90 transition-colors text-sm font-medium shadow-sm"
                      onClick={(e) => {
                        console.log("Label clicked");
                        // Ensure the file input is properly triggered
                        const input = document.getElementById('excel-upload') as HTMLInputElement;
                        if (input) {
                          input.click();
                          e.preventDefault();
                        }
                      }}
                    >
                      <Upload className="w-3 h-3" />
                      {uploadFile ? uploadFile.name : "Choose Excel File"}
                    </label>
                    {uploadFile && !isUploading && (
                      <Button
                        onClick={handleUploadExcel}
                        disabled={isUploading}
                        size="sm"
                        className="text-sm"
                      >
                        Import Listings
                      </Button>
                    )}
                    {isUploading && (
                      <Button
                        onClick={() => {
                          toast.warning("Stopping import... already imported listings will stay.");
                          setCancelImport(true);
                          cancelImportRef.current = true;
                        }}
                        disabled={cancelImport}
                        size="sm"
                        variant="destructive"
                        className="text-sm"
                      >
                        <X className="w-3 h-3 mr-1" />
                        {cancelImport ? "Stopping..." : "Stop Import"}
                      </Button>
                    )}
                  </div>
                  {uploadFile && (
                    <p className="text-xs text-muted-foreground">
                      Selected file: <span className="font-medium">{uploadFile.name}</span>
                    </p>
                  )}
                  {(isUploading || importProgress) && (
                    <p className="text-xs text-muted-foreground">
                      {isUploading && !importProgress
                        ? "Importing..."
                        : importProgress
                        ? `Imported ${importProgress.imported} of ${importProgress.total} rows`
                        : null}
                    </p>
                  )}
                </div>
              </Card>

              <Card className="p-3 bg-destructive/5 border-2 border-destructive/20">
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <Trash2 className="w-4 h-4 text-destructive" />
                    <h3 className="text-sm font-semibold">Delete All Records</h3>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Permanently delete all created listings from your account. This action cannot be undone.
                  </p>
                  <Button
                    variant="destructive"
                    onClick={async () => {
                      if (confirm("Are you sure you want to delete ALL records? This cannot be undone.")) {
                        const { error } = await supabase
                          .from("created_listings")
                          .delete()
                          .eq("user_id", user?.id || "");
                        
                        if (error) {
                          toast.error("Failed to delete records: " + error.message);
                        } else {
                          toast.success("All records deleted successfully");
                          fetchInventory();
                        }
                      }
                    }}
                    className="w-fit"
                    size="sm"
                  >
                    <Trash2 className="mr-1 h-3 w-3" />
                    Delete All Records
                  </Button>
                </div>
              </Card>
            </div>

            <Dialog open={excelInfoOpen} onOpenChange={setExcelInfoOpen}>
              <DialogContent className="max-w-md">
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2">
                    <Info className="h-5 w-5 text-primary" /> Excel Import Format
                  </DialogTitle>
                </DialogHeader>
                <div className="space-y-3">
                  <table className="w-full text-xs border-collapse">
                    <thead>
                      <tr className="border-b border-border">
                        <th className="text-left py-1.5 font-semibold">Column</th>
                        <th className="text-center py-1.5 font-semibold">Required</th>
                        <th className="text-left py-1.5 font-semibold">Description</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="border-b border-border/50"><td className="py-1.5 font-medium">ASIN</td><td className="text-center">✅</td><td className="text-muted-foreground">Amazon ASIN</td></tr>
                      <tr className="border-b border-border/50"><td className="py-1.5 font-medium">Link</td><td className="text-center text-muted-foreground">Optional</td><td className="text-muted-foreground">Supplier URL</td></tr>
                      <tr className="border-b border-border/50"><td className="py-1.5 font-medium">Supplier</td><td className="text-center text-muted-foreground">Optional</td><td className="text-muted-foreground">Supplier name</td></tr>
                      <tr className="border-b border-border/50"><td className="py-1.5 font-medium">Discount</td><td className="text-center text-muted-foreground">Optional</td><td className="text-muted-foreground">Discount code</td></tr>
                      <tr className="border-b border-border/50"><td className="py-1.5 font-medium">Discount Amount</td><td className="text-center text-muted-foreground">Optional</td><td className="text-muted-foreground">Unit cost per item</td></tr>
                      <tr className="border-b border-border/50"><td className="py-1.5 font-medium">Units / Qty</td><td className="text-center text-muted-foreground">Optional</td><td className="text-muted-foreground">Quantity (default: 1)</td></tr>
                      <tr className="border-b border-border/50"><td className="py-1.5 font-medium">Unit Cost</td><td className="text-center text-muted-foreground">Optional</td><td className="text-muted-foreground">Alt. unit cost field</td></tr>
                      <tr><td className="py-1.5 font-medium">Date Created</td><td className="text-center text-muted-foreground">Optional</td><td className="text-muted-foreground">MM/DD/YYYY or YYYY-MM-DD</td></tr>
                    </tbody>
                  </table>
                  <p className="text-xs text-muted-foreground">Only <strong>ASIN</strong> is required — everything else is optional. Title, image, and price are fetched from Amazon automatically.</p>
                </div>
              </DialogContent>
            </Dialog>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
              <Card className="p-3 bg-primary/5 border-2 border-primary/20">
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <RefreshCw className="w-4 h-4 text-primary" />
                    <h3 className="text-sm font-semibold">Refresh Selected Prices</h3>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Update Amazon prices for selected listings. Select items from the table below and click refresh.
                  </p>
                  <Button
                    onClick={refreshSelectedItems}
                    disabled={isRefreshing || selectedItems.size === 0}
                    className="w-fit"
                    size="sm"
                  >
                    {isRefreshing ? (
                      <>
                        <RefreshCw className="mr-1 h-3 w-3 animate-spin" />
                        Refreshing...
                      </>
                    ) : (
                      <>
                        <RefreshCw className="mr-1 h-3 w-3" />
                        Refresh Selected ({selectedItems.size})
                      </>
                    )}
                  </Button>
                </div>
              </Card>

              <Card className="p-3 bg-destructive/5 border-2 border-destructive/20">
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <Trash2 className="w-4 h-4 text-destructive" />
                    <h3 className="text-sm font-semibold">Delete Selected Records</h3>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Permanently delete selected listings from your account. Select items below.
                  </p>
                  <Button
                    variant="destructive"
                    onClick={deleteSelectedRecords}
                    disabled={selectedItems.size === 0}
                    className="w-fit"
                    size="sm"
                  >
                    <Trash2 className="mr-1 h-3 w-3" />
                    Delete Selected ({selectedItems.size})
                  </Button>
                </div>
              </Card>

              <Card className="p-3 bg-primary/5 border-2 border-primary/20">
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <Plus className="w-4 h-4 text-primary" />
                    <h3 className="text-sm font-semibold">Sum Selected (Total Cost & Units)</h3>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Tick multiple rows below, then click Calculate to total their Total Cost and Units.
                  </p>
                  <Button
                    onClick={() => {
                      const ids = Array.from(selectedItems);
                      const rows = inventory.filter(i => ids.includes(i.id));
                      if (rows.length === 0) { setSumOutput("Select at least one row."); return; }
                      const totalCost = rows.reduce((s, r) => s + (Number(r.cost) || 0), 0);
                      const totalUnits = rows.reduce((s, r) => s + (Number(r.units) || 0), 0);
                      setSumOutput(
                        `Selected rows: ${rows.length}\n` +
                        `Sum Total Cost: $${totalCost.toFixed(2)}\n` +
                        `Sum Units: ${totalUnits}`
                      );
                    }}
                    disabled={selectedItems.size === 0}
                    className="w-fit"
                    size="sm"
                  >
                    Calculate ({selectedItems.size})
                  </Button>
                  <Textarea
                    value={sumOutput}
                    readOnly
                    placeholder="Totals will appear here…"
                    className="text-xs font-mono h-24 bg-background"
                  />
                </div>
              </Card>

            </div>


            <Card className="p-3 bg-primary/5 border-2 border-primary/20 mb-4">
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <Plus className="w-4 h-4 text-primary" />
                  <h3 className="text-sm font-semibold">Add New Listing</h3>
                </div>
                <p className="text-xs text-muted-foreground">
                  Create a new listing manually by entering product details and Amazon ASIN.
                </p>
                <Button
                  onClick={() => (window.location.href = "/tools/create-listing")}
                  className="w-fit"
                  size="sm"
                >
                  <Plus className="mr-1 h-3 w-3" />
                  Add New Listing
                </Button>
                <ImportFromInventoryDialog
                  existingAsins={inventory.map(i => i.asin)}
                  onImported={() => fetchInventory()}
                />
              </div>
            </Card></>)}

            <Card className="p-3 mb-4 bg-white/60 backdrop-blur-sm border-white/20">
              <div className="flex flex-col gap-2">
                {/* Supplier Filter + Search side by side */}
                {supplierList.length > 0 && (
                  <div className="flex gap-4 items-end flex-wrap">
                    <div className="flex flex-col gap-1 flex-shrink-0">
                      <label className="text-xs font-extrabold text-[hsl(221,90%,22%)]">
                        Filter by Supplier ({supplierList.length} suppliers)
                      </label>
                      <Select value={selectedSupplier} onValueChange={(v) => { setSelectedSupplier(v); setSupplierSearch(""); setCurrentPage(1); }}>
                        <SelectTrigger className="w-[260px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="max-h-[300px] overflow-y-auto">
                          <SelectItem value="all">All Suppliers ({inventory.length})</SelectItem>
                          <SelectItem value="none">No Supplier ({supplierCounts.get('__none__') || 0})</SelectItem>
                          {supplierList.map(supplier => (
                            <SelectItem key={supplier} value={supplier}>
                              {supplier} ({supplierCounts.get(supplier) || 0})
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    
                    <div className="flex flex-col gap-1 flex-shrink-0">
                      <label className="text-xs font-extrabold text-[hsl(221,90%,22%)]">
                        Note
                      </label>
                      <div className="flex items-center gap-1">
                        <Input
                          placeholder={highlightedRowIdx >= 0 ? "Write a note..." : "Highlight a row first"}
                          value={noteText}
                          onChange={(e) => setNoteText(e.target.value)}
                          disabled={highlightedRowIdx < 0}
                          className="flex-1 min-w-[400px] h-9"
                        />
                        <Button
                          size="sm"
                          className="h-9 px-3 text-xs"
                          disabled={highlightedRowIdx < 0 || noteSaving}
                          onClick={async () => {
                            if (highlightedRowIdx < 0 || highlightedRowIdx >= paginatedInventory.length) return;
                            const item = paginatedInventory[highlightedRowIdx];
                            setNoteSaving(true);
                            const { error } = await supabase
                              .from("created_listings")
                              .update({ notes: noteText || null })
                              .eq("id", item.id);
                            setNoteSaving(false);
                            if (error) {
                              toast.error("Failed to save note");
                            } else {
                              toast.success("Note saved");
                              setInventory(prev => prev.map(i => i.id === item.id ? { ...i, notes: noteText || null } : i));
                            }
                          }}
                        >
                          {noteSaving ? "..." : "Save"}
                        </Button>
                        <Button
                          size="sm"
                          variant="default"
                          className="h-9 px-3 text-xs"
                          onClick={() => { setShowNotesOnly(!showNotesOnly); setCurrentPage(1); }}
                        >
                          {showNotesOnly ? "Show All" : "Notes Only"}
                        </Button>
                      </div>
                    </div>
                    {/* Selected record details */}
                    <div className="flex items-end gap-3 flex-shrink-0">
                      <div className="flex flex-col gap-0.5">
                        <label className="text-[10px] font-semibold text-muted-foreground">Total Cost (lot)</label>
                        <Input
                          value={panelTotalCost}
                          onChange={(e) => {
                            setPanelTotalCost(e.target.value);
                            const tc = parseFloat(e.target.value);
                            const u = parseInt(panelUnits);
                            if (!isNaN(tc) && !isNaN(u) && u > 0) setPanelCog((tc / u).toFixed(2));
                          }}
                          inputMode="decimal"
                          placeholder="—"
                          disabled={highlightedRowIdx < 0}
                          className="w-[100px] h-8 text-xs"
                        />
                      </div>
                      <div className="flex flex-col gap-0.5">
                        <label className="text-[10px] font-semibold text-muted-foreground">Units</label>
                        <Input
                          value={panelUnits}
                          onChange={(e) => {
                            setPanelUnits(e.target.value);
                            const tc = parseFloat(panelTotalCost);
                            const u = parseInt(e.target.value);
                            if (!isNaN(tc) && !isNaN(u) && u > 0) setPanelCog((tc / u).toFixed(2));
                          }}
                          inputMode="numeric"
                          placeholder="—"
                          disabled={highlightedRowIdx < 0}
                          className="w-[70px] h-8 text-xs"
                        />
                      </div>
                      <div className="flex flex-col gap-0.5">
                        <label className="text-[10px] font-semibold text-muted-foreground">COG / unit</label>
                        <Input
                          readOnly
                          value={panelCog ? `$${parseFloat(panelCog).toFixed(2)}/ea` : "—"}
                          title="Total Cost divided by Units. If this looks far too low, the Total Cost box probably has a per-unit price in it."
                          className={cn(
                            "w-[90px] h-8 text-xs bg-muted/40",
                            suspiciousUnitCost(
                              parseFloat(panelTotalCost) || 0,
                              parseInt(panelUnits) || 0,
                              paginatedInventory[highlightedRowIdx]?.price,
                            ).suspicious && "border-amber-500 text-amber-700 dark:text-amber-400 font-semibold",
                          )}
                        />
                      </div>
                      <div className="flex flex-col gap-0.5">
                        <label className="text-[10px] font-semibold text-muted-foreground">Effective from</label>
                        <Popover>
                          <PopoverTrigger asChild>
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={highlightedRowIdx < 0}
                              className={cn(
                                "h-8 px-2 text-xs justify-start font-normal w-[140px]",
                                !panelEffectiveDate && "text-muted-foreground"
                              )}
                            >
                              <CalendarIcon className="mr-1 h-3 w-3" />
                              {panelEffectiveDate ? format(panelEffectiveDate, "MMM d, yyyy") : "Today"}
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent className="w-auto p-0" align="end">
                            <Calendar
                              mode="single"
                              selected={panelEffectiveDate}
                              onSelect={(d) => d && setPanelEffectiveDate(d)}
                              initialFocus
                              className={cn("p-3 pointer-events-auto")}
                            />
                          </PopoverContent>
                        </Popover>
                        {panelEffectiveDate && format(panelEffectiveDate, "yyyy-MM-dd") < format(new Date(), "yyyy-MM-dd") && (
                          <span className="text-[9px] text-amber-600 dark:text-amber-400 leading-tight max-w-[140px]">
                            ⚠ Past date — settled P&amp;L stays frozen
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </Card>

            <div className="flex items-end gap-4 mb-2 flex-wrap">
              <Input
                placeholder="Search ASIN, SKU, Title..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                onPaste={(e) => {
                  e.preventDefault();
                  const pasted = e.clipboardData.getData('text').trim();
                  setSearchTerm(pasted);
                }}
                className="max-w-[260px]"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => { setFixSkuOpen(true); setFixSkuPreview(null); }}
                title="Replace synthetic SKUs for one ASIN with the real original SKU across all rows"
              >
                Fix Synthetic SKUs
              </Button>
              <div className="flex flex-col gap-1 flex-shrink-0">
                <label className="text-xs font-extrabold text-white">
                  Month / Year
                </label>
                <div className="flex gap-2">
                  <Select value={selectedMonth} onValueChange={(v) => { setSelectedMonth(v); setCurrentPage(1); }}>
                    <SelectTrigger className="w-[100px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MONTH_NAMES.map((name, idx) => (
                        <SelectItem key={idx} value={String(idx)}>{name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={selectedYear} onValueChange={(v) => { setSelectedYear(v); setCurrentPage(1); }}>
                    <SelectTrigger className="w-[85px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {availableYears.map(y => (
                        <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {false && (
              <Button
                variant="default"
                size="sm"
                onClick={() => {
                  const selectedId = Array.from(selectedItems)[0];
                  const selectedItem = selectedId
                    ? inventory.find((item) => item.id === selectedId)
                    : highlightedRowIdx >= 0 && highlightedRowIdx < paginatedInventory.length
                      ? paginatedInventory[highlightedRowIdx]
                      : null;

                  if (!selectedItem) {
                    toast.error("Select one record first, then press Create");
                    return;
                  }

                  if (!activeListingIds.has(selectedItem.id)) {
                    toast.error(
                      "This listing isn't active yet (pending, failed, blocked, or removed). Add Purchase is disabled until it's ACTIVE."
                    );
                    return;
                  }

                  const tc = parseFloat(panelTotalCost);
                  const u = parseInt(panelUnits);
                  if (!u || u <= 0 || isNaN(tc) || tc <= 0) {
                    toast.error("Enter Total Cost and Units in the panel first");
                    return;
                  }

                  setCostSanityAck(false);
                  setPendingPurchaseItem(selectedItem);
                  setConfirmPurchaseOpen(true);
                }}
                className="text-xs self-end"
              >
                Add new Purchase
              </Button>
              )}
              <Button
                variant="default"
                size="sm"
                onClick={() => {
                  const selectedId = Array.from(selectedItems)[0];
                  const item = selectedId
                    ? inventory.find((i) => i.id === selectedId)
                    : highlightedRowIdx >= 0 && highlightedRowIdx < paginatedInventory.length
                      ? paginatedInventory[highlightedRowIdx]
                      : null;
                  if (!item) {
                    toast.error("Select or highlight a record first");
                    return;
                  }
                  openEditDialog(item);
                }}
                className="text-xs self-end"
              >
                Edit
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const selectedId = Array.from(selectedItems)[0];
                  const item = selectedId
                    ? inventory.find((i) => i.id === selectedId)
                    : highlightedRowIdx >= 0 && highlightedRowIdx < paginatedInventory.length
                      ? paginatedInventory[highlightedRowIdx]
                      : null;
                  if (!item) {
                    toast.error("Select or highlight a record first");
                    return;
                  }
                  setPurchaseDetailsItem(item);
                  setPurchaseDetailsOpen(true);
                }}
                className="text-xs self-end"
              >
                <ClipboardList className="w-3 h-3 mr-1" />
                Details
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const selectedId = Array.from(selectedItems)[0];
                  const item = selectedId
                    ? inventory.find((i) => i.id === selectedId)
                    : highlightedRowIdx >= 0 && highlightedRowIdx < paginatedInventory.length
                      ? paginatedInventory[highlightedRowIdx]
                      : null;
                  if (!item) {
                    toast.error("Select or highlight a record first");
                    return;
                  }
                  setCostOverrideItem(item);
                  setCostOverrideOpen(true);
                }}
                className="text-xs self-end"
                title="Manage manual cost overrides for this ASIN (affects P&L, Repricer, Inventory Valuation, Sales Report, and Mobile Live Sales — one cost across all pages)"
              >
                <Calculator className="w-3 h-3 mr-1" />
                Cost history
                {(() => {
                  const selectedId = Array.from(selectedItems)[0];
                  const item = selectedId
                    ? inventory.find((i) => i.id === selectedId)
                    : highlightedRowIdx >= 0 && highlightedRowIdx < paginatedInventory.length
                      ? paginatedInventory[highlightedRowIdx]
                      : null;
                  return item && overriddenAsins.has(item.asin) ? (
                    <Badge variant="secondary" className="ml-1.5 h-4 px-1 text-[10px]">override</Badge>
                  ) : null;
                })()}
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  const selectedId = Array.from(selectedItems)[0];
                  const item = selectedId
                    ? inventory.find((i) => i.id === selectedId)
                    : highlightedRowIdx >= 0 && highlightedRowIdx < paginatedInventory.length
                      ? paginatedInventory[highlightedRowIdx]
                      : null;
                  if (!item) {
                    toast.error("Select or highlight a record first");
                    return;
                  }
                  deleteItem(item.id, item.title);
                }}
                className="text-xs self-end"
              >
                <Trash2 className="w-3 h-3 mr-1" />
                Delete
              </Button>
              <Button
                variant="default"
                size="sm"
                disabled={fetchingPriceRoi}
                onClick={async () => {
                  const selectedId = Array.from(selectedItems)[0];
                  const item = selectedId
                    ? inventory.find((i) => i.id === selectedId)
                    : highlightedRowIdx >= 0 && highlightedRowIdx < paginatedInventory.length
                      ? paginatedInventory[highlightedRowIdx]
                      : null;
                  if (!item) {
                    toast.error("Select or highlight a record first");
                    return;
                  }
                  const cogNum = getListingUnitCost(item) ?? 0;
                  if (!cogNum || cogNum <= 0) {
                    toast.error("Unit cost is required to calculate ROI");
                    return;
                  }
                  setFetchingPriceRoi(true);
                  try {
                    const { data: { session } } = await supabase.auth.getSession();
                    if (!session) throw new Error("Not authenticated");
                    // Use fetch-listing-snapshot — same as CreateListing for accurate fees
                    const { data, error } = await supabase.functions.invoke('fetch-listing-snapshot', {
                      body: { asin: item.asin },
                      headers: { Authorization: `Bearer ${session.access_token}` }
                    });
                    if (error) { toast.error("Failed to fetch: " + (error.message || "")); return; }
                    if (data?.error) { toast.error(data.error); return; }
                    const price = data?.price || item.price || 0;
                    // Calculate fees — same formula as CreateListing
                    const fees = data?.fees || {};
                    const referralFee = fees.referralFee || 0;
                    const fbaFee = fees.fbaFee || 0;
                    const variableClosingFee = fees.variableClosingFee || 0;
                    const totalFees = referralFee + fbaFee + variableClosingFee;
                    const profit = price - totalFees - cogNum;
                    const roi = cogNum > 0 ? (profit / cogNum) * 100 : 0;
                    const margin = price > 0 ? (profit / price) * 100 : 0;
                    // Update price in DB
                    if (price > 0) {
                      await supabase.from("created_listings").update({
                        price, title: data?.title || item.title, image_url: data?.imageUrl || item.image_url
                      }).eq("id", item.id);
                      fetchInventory();
                    }
                    setInlineRoiResult({
                      price, unitCost: cogNum, referralFee, fbaFee, variableClosingFee,
                      totalFees, profit: parseFloat(profit.toFixed(2)),
                      roi: parseFloat(roi.toFixed(2)), margin: parseFloat(margin.toFixed(2)),
                      title: data?.title || item.title, imageUrl: data?.imageUrl || item.image_url, asin: item.asin,
                    });
                    setInlineRoiDialogOpen(true);
                    toast.success(`ROI: ${roi.toFixed(2)}%`);
                  } catch (err: any) {
                    toast.error("Failed: " + (err.message || ""));
                  } finally {
                    setFetchingPriceRoi(false);
                  }
                }}
                className="text-xs self-end"
              >
                {fetchingPriceRoi ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <RefreshCw className="w-3 h-3 mr-1" />}
                Get Price & ROI
              </Button>
              <div className="flex flex-col gap-1 flex-shrink-0">
                <label className="text-xs font-extrabold text-white">
                  Search Supplier
                </label>
                <Input
                  placeholder="Type supplier name..."
                  value={supplierSearch}
                  onChange={(e) => {
                    const val = e.target.value;
                    setSupplierSearch(val);
                    // Always reset the exact-supplier sidebar selection so the
                    // free-text substring search drives the filter (matches
                    // across ALL supplier links per item, not just primary).
                    setSelectedSupplier("all");
                    setCurrentPage(1);
                  }}
                  className="w-[220px] h-9"
                />
              </div>
              <div className="flex flex-col gap-1 flex-shrink-0">
                <label className="text-xs font-extrabold text-white">
                  Source
                </label>
                <Select value={sourceFilter} onValueChange={(v) => { setSourceFilter(v as "all" | "new" | "purchase"); setCurrentPage(1); }}>
                  <SelectTrigger className="w-[240px] h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All ({inventory.length})</SelectItem>
                    <SelectItem value="new">
                      Recently Created Only ({inventory.filter(i => isNewlyCreatedRow(i)).length})
                    </SelectItem>
                    <SelectItem value="purchase">
                      Has Added Purchases ({inventory.filter(i => !isNewlyCreatedRow(i)).length})
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1 flex-shrink-0">
                <label className="text-xs font-extrabold text-white opacity-0 select-none">.</label>
                <Button
                  size="lg"
                  onClick={() => {
                    setSourceFilter(sourceFilter === "new" ? "all" : "new");
                    setCurrentPage(1);
                  }}
                  className={
                    sourceFilter === "new"
                      ? "h-11 px-5 text-sm font-bold bg-green-700 hover:bg-green-800 text-white shadow-lg ring-2 ring-green-300"
                      : "h-11 px-5 text-sm font-bold bg-green-600 hover:bg-green-700 text-white shadow-lg"
                  }
                >
                  {sourceFilter === "new" ? "Showing Recently Created" : "Showing All"}
                </Button>
              </div>
            </div>

            {loading && inventory.length === 0 ? (
              <div className="text-center py-12">
                <p className="text-muted-foreground">Loading listings...</p>
              </div>
            ) : inventory.length === 0 ? (
              <Card className="p-12 text-center">
                <p className="text-muted-foreground mb-4">
                  No listings created yet
                </p>
                <Button onClick={() => (window.location.href = "/tools/create-listing")}>
                  Create Your First Listing
                </Button>
              </Card>
            ) : (
              <>
                <div className="flex gap-3 items-start">
                  <div className="w-[260px] flex-shrink-0 sticky top-4 self-start">
                    <Card className="p-3 bg-white/70 backdrop-blur-sm border-white/20">
                      <div className="flex items-center justify-between gap-2 mb-2">
                        <div className="text-xs font-extrabold text-[hsl(221,90%,22%)]">
                          All Suppliers ({supplierList.length})
                        </div>
                        <button
                          type="button"
                          onClick={() => { setSelectedSupplier("all"); setSupplierSearch(""); setCurrentPage(1); }}
                          className="text-[10px] font-semibold px-2 py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90"
                        >
                          Reset
                        </button>
                      </div>
                      <div className="max-h-[70vh] overflow-y-auto -mx-1 px-1 space-y-0.5">
                        <button
                          type="button"
                          onClick={() => { setSelectedSupplier("all"); setSupplierSearch(""); setCurrentPage(1); }}
                          className={`w-full text-left text-xs px-2 py-1.5 rounded hover:bg-muted/60 ${selectedSupplier === "all" ? "bg-primary/10 text-primary font-semibold" : ""}`}
                        >
                          All Suppliers ({inventory.length})
                        </button>
                        <button
                          type="button"
                          onClick={() => { setSelectedSupplier("none"); setSupplierSearch(""); setCurrentPage(1); }}
                          className={`w-full text-left text-xs px-2 py-1.5 rounded hover:bg-muted/60 ${selectedSupplier === "none" ? "bg-primary/10 text-primary font-semibold" : ""}`}
                        >
                          No Supplier ({supplierCounts.get('__none__') || 0})
                        </button>
                        {supplierList.map(supplier => (
                          <button
                            key={supplier}
                            type="button"
                            onClick={() => { setSelectedSupplier(supplier); setSupplierSearch(""); setCurrentPage(1); }}
                            className={`w-full text-left text-xs px-2 py-1.5 rounded hover:bg-muted/60 truncate ${selectedSupplier === supplier ? "bg-primary/10 text-primary font-semibold" : ""}`}
                            title={supplier}
                          >
                            {supplier} ({supplierCounts.get(supplier) || 0})
                          </button>
                        ))}
                      </div>
                    </Card>
                  </div>
                  <div className="flex-1 min-w-0">
                {filteredInventory.length === 0 ? (
                  <Card className="p-12 text-center">
                    <p className="text-muted-foreground">
                      {searchTerm
                        ? "No listings match your search"
                        : selectedSupplier === "none"
                          ? "No listings without a supplier"
                          : `No listings for "${selectedSupplier}"`}
                    </p>
                  </Card>
                ) : (
                <>
                
                {/* Top scrollbar */}
                <div 
                  ref={topScrollRef}
                  className="overflow-x-auto mb-2"
                  style={{ height: '16px' }}
                >
                  <div style={{ width: 'max-content', height: '1px' }}>
                    {/* This div creates the scrollable width matching the table */}
                    <div style={{ display: 'table', tableLayout: 'fixed' }}>
                      <div style={{ width: '2500px', height: '1px' }}></div>
                    </div>
                  </div>
                </div>

                <div ref={tableScrollRef} className="overflow-x-auto border border-white/20 bg-white/10 backdrop-blur-sm rounded-lg max-h-[70vh] overflow-y-auto">
                  <table className="w-full border-collapse">
                  <thead className="sticky top-0 z-20 border-b-2 border-slate-300/50 bg-gradient-to-r from-slate-100/90 to-slate-50/90 backdrop-blur-sm">
                    <tr className="text-xs">
                      <th className="px-1 py-2 text-center whitespace-nowrap text-xs">
                        <input
                          type="checkbox"
                          checked={paginatedInventory.length > 0 && paginatedInventory.every(it => selectedItems.has(it.id))}
                          onChange={toggleSelectAll}
                          className="cursor-pointer"
                        />
                      </th>
                      {/* Label Printing, Update, and Create columns hidden */}
                      {/* ROI column hidden */}
                      {/* Actions column removed - Edit moved to toolbar */}
                      <th className="px-1 py-2 text-left whitespace-nowrap text-xs">Image</th>
                      <th className="px-1 py-2 text-left whitespace-nowrap text-xs">ASIN</th>
                      <th className="px-1 py-2 text-left whitespace-nowrap text-xs">Title</th>
                      <th 
                        className="px-1 py-2 text-left whitespace-nowrap text-xs cursor-pointer hover:bg-muted/50"
                        onClick={() => handleSort('price')}
                      >
                        <div className="flex items-center gap-1">
                          <span className={sortColumn === 'price' ? 'font-bold text-primary' : ''}>Price</span>
                          {sortColumn === 'price' && (
                            <span className="text-primary">{sortDirection === 'asc' ? '↑' : '↓'}</span>
                          )}
                        </div>
                      </th>
                      <th className="px-1 py-2 text-left whitespace-nowrap text-xs">Units</th>
                      <th className="px-1 py-2 text-left whitespace-nowrap text-xs">COG</th>
                      <th className="px-1 py-2 text-left whitespace-nowrap text-xs">Total Cost</th>
                      <th className="hidden">Date Added</th>
                      <th 
                        className="px-1 py-2 text-left whitespace-nowrap text-xs cursor-pointer hover:bg-muted/50"
                        onClick={() => handleSort('date_created')}
                      >
                        <div className="flex items-center gap-1">
                          <span className={sortColumn === 'date_created' ? 'font-bold text-primary' : ''}>Created</span>
                          {sortColumn === 'date_created' && (
                            <span className="text-primary">{sortDirection === 'asc' ? '↑' : '↓'}</span>
                          )}
                        </div>
                      </th>
                      <th className="px-1 py-2 text-left whitespace-nowrap text-xs">Supplier</th>
                      <th className="px-1 py-2 text-left whitespace-nowrap text-xs">Link</th>
                      <th className="px-1 py-2 text-left whitespace-nowrap text-xs">Discount</th>
                      
                    </tr>
                  </thead>
                  <tbody>
                  {paginatedInventory.map((item, idx) => {
                      // Contract A: derive UNIT cost via helper (prefers amount=UNIT, else cost/units).
                      const unitCost = getListingUnitCost(item);
                      const isSynced = syncedInventoryKeys.has(syncKeyFor(item));
                      const isSyncingThisRow = syncingProductId === item.id;

                      return (
                        <tr key={item.id} onClick={() => { setHighlightedRowIdx(idx); setPanelTotalCost(item.cost != null ? String(item.cost) : ""); setPanelUnits(item.units != null ? String(item.units) : ""); const uc = getListingUnitCost(item); setPanelCog(uc != null ? String(uc) : ""); }} className={`border-b border-[hsl(218_32%_78%_/_0.95)] transition-colors cursor-pointer ${highlightedRowIdx === idx ? 'bg-[hsl(210_100%_85%_/_0.95)] ring-2 ring-inset ring-primary/40' : 'bg-white'}`}>
                          <td className="px-1 py-2 text-center">
                            <input
                              type="checkbox"
                              checked={selectedItems.has(item.id)}
                              onClick={(e) => { e.stopPropagation(); setHighlightedRowIdx(idx); }}
                              onChange={() => toggleSelectItem(item.id)}
                              className="cursor-pointer"
                            />
                          </td>
                          {/* Create cell hidden - moved to top */}
                          {/* ROI column hidden */}
                          {/* Edit cell removed - moved to toolbar */}
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
                          <div className="relative inline-flex items-center gap-1">
                            <a
                              href={`https://www.amazon.com/dp/${item.asin}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-primary hover:underline"
                            >
                              {item.asin}
                            </a>
                            <button
                              onClick={() => {
                                navigator.clipboard.writeText(item.asin);
                                toast.success("ASIN copied to clipboard!");
                              }}
                              className="w-4 h-4 flex items-center justify-center rounded border border-border hover:bg-muted hover:border-primary transition-colors"
                              title="Copy ASIN"
                            >
                              <Copy className="w-2.5 h-2.5" />
                            </button>
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-1">
                            <span className="text-[10px] text-muted-foreground">{item.sku}</span>
                            {item.validation_status === 'PENDING_VALIDATION' && (
                              <Badge variant="secondary" className="h-5 px-1.5 text-[10px] bg-amber-100 text-amber-900 border-amber-300" title="Waiting for Amazon to confirm this listing (FNSKU). Hidden from repricer / shipment / reorder tools until validated.">
                                Pending validation
                              </Badge>
                            )}
                            {item.validation_status === 'FAILED_VALIDATION' && (
                              <Badge variant="destructive" className="h-5 px-1.5 text-[10px]" title={item.validation_failure_reason ?? 'Amazon did not confirm this listing.'}>
                                Failed validation
                              </Badge>
                            )}
                            {item.validation_status === 'ARCHIVED_FAILED' && (
                              <Badge variant="outline" className="h-5 px-1.5 text-[10px]">Archived</Badge>
                            )}
                            {item.validation_status === 'SHIPMENT_BLOCKED' && (
                              <Badge variant="destructive" className="h-5 px-1.5 text-[10px]" title={item.inbound_dry_run_error ?? 'Inbound dry-run was rejected by Amazon.'}>
                                Shipment blocked
                              </Badge>
                            )}
                            {item.inbound_dry_run_status === 'PASSED' && (
                              <Badge variant="outline" className="h-5 px-1.5 text-[10px] border-emerald-500 text-emerald-700" title={`Inbound dry-run passed${item.inbound_dry_run_at ? ` on ${new Date(item.inbound_dry_run_at).toLocaleString()}` : ''}`}>
                                Inbound OK
                              </Badge>
                            )}
                            {item.inbound_dry_run_status === 'RUNNING' && (
                              <Badge variant="outline" className="h-5 px-1.5 text-[10px]" title="Inbound dry-run in progress">
                                Inbound testing…
                              </Badge>
                            )}
                            {item.validation_status === 'ACTIVE' && (item.inbound_dry_run_status === 'NOT_RUN' || !item.inbound_dry_run_status || item.inbound_dry_run_status === 'FAILED') && (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-5 px-1.5 text-[10px]"
                                title="Manual: create + immediately cancel an Amazon inbound plan to verify this listing is shipment-ready."
                                onClick={async (e) => {
                                  e.stopPropagation();
                                  const t = toast.loading('Running inbound dry-run…');
                                  try {
                                    const { data, error } = await supabase.functions.invoke('validation-inbound-dry-run', {
                                      body: { listingId: item.id },
                                    });
                                    toast.dismiss(t);
                                    if (error) {
                                      toast.error(error.message || 'Dry-run failed');
                                    } else if (data?.ok) {
                                      toast.success(`Inbound dry-run passed (plan ${data.inboundPlanId} cancelled)`);
                                    } else if (data?.status === 'CANCEL_FAILED') {
                                      toast.error(data.message || 'Cancel failed — check Seller Central');
                                    } else {
                                      toast.error(`Dry-run failed: ${data?.reason ?? 'Unknown'}`);
                                    }
                                    await fetchInventory(true);
                                  } catch (err: any) {
                                    toast.dismiss(t);
                                    toast.error(err?.message ?? 'Dry-run failed');
                                  }
                                }}
                              >
                                Inbound dry-run
                              </Button>
                            )}
                            {item.validation_status === 'ACTIVE' && item.validation_warning && (
                              <Badge variant="outline" className="h-5 px-1.5 text-[10px] border-amber-400 text-amber-800" title={`Active with warning: ${item.validation_warning}`}>
                                Active (warning)
                              </Badge>
                            )}
                            <Badge variant={isSynced ? 'default' : 'secondary'} className="h-5 px-1.5 text-[10px]">
                              {isSynced ? 'Synced' : 'Not synced yet'}
                            </Badge>
                            {!isSynced && (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-5 px-1.5 text-[10px]"
                                disabled={isSyncingThisRow}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleSyncThisProduct(item);
                                }}
                              >
                                {isSyncingThisRow ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Sync this product'}
                              </Button>
                            )}
                          </div>
                        </td>
                        <td className="px-1 py-2 max-w-[200px] truncate text-xs">{item.title}</td>
                        <td className="px-1 py-2 text-xs">
                          {item.price ? `$${item.price.toFixed(2)}` : "—"}
                        </td>
                        <td className="px-1 py-2 text-xs text-center">
                          {item.units || "—"}
                        </td>
                        <td className="px-1 py-2 text-xs">
                          {(() => {
                            // Contract A COG display: prefer amount (=UNIT), else cost/units via helper.
                            const uc = getListingUnitCost(item);
                            return uc != null ? `$${uc.toFixed(2)}` : "—";
                          })()}
                        </td>
                        <td className="px-1 py-2 text-xs">
                          {item.cost != null ? `$${Number(item.cost).toFixed(2)}` : "—"}
                        </td>
                        <td className="px-1 py-2 text-xs text-muted-foreground whitespace-nowrap">
                          {(() => {
                            // Use date_created (DATE column = purchase/snapshot date) to match the month/year filter.
                            // Parse YYYY-MM-DD as local to avoid UTC->local rollback. Fallback to created_at.
                            const raw = item.date_created || item.created_at;
                            if (!raw) return '—';
                            const s = String(raw).slice(0, 10);
                            const [y, m, d] = s.split('-').map((n) => parseInt(n, 10));
                            if (!y || !m || !d) return '—';
                            const local = new Date(y, m - 1, d);
                            return local.toLocaleDateString('en-US', {
                              year: 'numeric',
                              month: 'short',
                              day: 'numeric'
                            });
                          })()}
                        </td>
                        <td className="hidden">
                          {item.date_created ? new Date(item.date_created).toLocaleDateString('en-US', {
                            year: 'numeric',
                            month: '2-digit',
                            day: '2-digit'
                          }) : '—'}
                        </td>
                        <td className="px-1 py-2">
                          <div className="space-y-1">
                            {item.supplier_links.map((supplier, idx) => (
                              <div key={idx} className="text-xs">
                                {extractDomain(supplier.link)}
                              </div>
                            ))}
                          </div>
                        </td>
                         <td className="px-1 py-2">
                           <div className="space-y-1">
                             {item.supplier_links.filter(s => s.link.trim()).length > 0 ? (
                               item.supplier_links
                                 .filter(s => s.link.trim())
                                 .map((s, i) => {
                                   const url = /^https?:\/\//i.test(s.link.trim())
                                     ? s.link.trim()
                                     : `https://${s.link.trim()}`;
                                   return (
                                     <button
                                       key={i}
                                       type="button"
                                       className="block text-xs text-primary hover:underline text-left"
                                       onClick={() => window.open(url, "_blank", "noopener,noreferrer")}
                                       title={url}
                                     >
                                       Open ({i + 1})
                                     </button>
                                   );
                                 })
                             ) : (
                               <span className="text-xs text-muted-foreground">—</span>
                             )}
                           </div>
                         </td>
                        <td className="px-1 py-2">
                          <div className="space-y-1">
                            {item.supplier_links.map((supplier, idx) => (
                              <div key={idx} className="text-xs text-muted-foreground">
                                {supplier.discount_code || "—"}
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

               <div className="mt-2 text-xs text-muted-foreground">
                  Showing {startIndex + 1}-{Math.min(endIndex, filteredInventory.length)} of {filteredInventory.length} listings (Page {currentPage} of {totalPages})
                </div>

               {/* Pagination Controls */}
              {totalPages > 1 && (
                <div className="flex justify-center items-center gap-4 mt-6">
                  <Button
                    variant="outline"
                    onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                    disabled={currentPage === 1}
                  >
                    Previous
                  </Button>
                  <span className="text-sm text-muted-foreground">
                    Page {currentPage} of {totalPages}
                  </span>
                  <Button
                    variant="outline"
                    onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                    disabled={currentPage === totalPages}
                  >
                    Next
                  </Button>
                </div>
              )}
                </>
                )}
                  </div>
                </div>
              </>
            )}
          </div>
        </main>
        <Footer />

        {/* Label Print Dialog */}
        <LabelPrintDialog 
          open={labelDialogOpen}
          onOpenChange={setLabelDialogOpen}
          labels={labelsForPrint}
        />

        {/* ROI Calculator Dialog */}
        {selectedRoiItem && (
          <RoiCalculatorDialog
            open={roiDialogOpen}
            onOpenChange={setRoiDialogOpen}
            asin={selectedRoiItem.asin}
            unitCost={getListingUnitCost(selectedRoiItem)}
            productTitle={selectedRoiItem.title}
            imageUrl={selectedRoiItem.image_url}
            currentPrice={selectedRoiItem.price}
          />
        )}
        <EditListingDialog
          open={editDialogOpen}
          onOpenChange={setEditDialogOpen}
          item={editDialogItem}
          onSave={handleEditDialogSave}
        />
        {/* Purchase Details Dialog */}
        {purchaseDetailsItem && (
          <PurchaseDetailsDialog
            open={purchaseDetailsOpen}
            onOpenChange={setPurchaseDetailsOpen}
            listingId={purchaseDetailsItem.id}
            listingTitle={purchaseDetailsItem.title}
            listingAsin={purchaseDetailsItem.asin}
            listingImage={purchaseDetailsItem.image_url}
            onPurchasesChanged={() => fetchInventory(true)}
          />
        )}
        {/* Cost Override Dialog (manual cost versioning — affects P&L, Repricer, Inventory Valuation, Sales Report, and Mobile Live Sales) */}
        {costOverrideItem && (
          <CostOverrideDialog
            open={costOverrideOpen}
            onOpenChange={setCostOverrideOpen}
            asin={costOverrideItem.asin}
            productTitle={costOverrideItem.title}
            onAdded={() => {
              refreshOverriddenAsins();
            }}
          />
        )}
        {/* Confirm Add Purchase Dialog */}
        <Dialog open={confirmPurchaseOpen} onOpenChange={setConfirmPurchaseOpen}>
          <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Confirm new purchase</DialogTitle>
              <DialogDescription>
                Review the purchase details before saving. This creates a new dated purchase row like the Chrome extension.
              </DialogDescription>
            </DialogHeader>
            {pendingPurchaseItem && (() => {
              const tc = parseFloat(panelTotalCost) || 0;
              const u = parseInt(panelUnits) || 0;
              const cog = u > 0 ? tc / u : 0;
              const effective = panelEffectiveDate ? format(panelEffectiveDate, "yyyy-MM-dd") : format(new Date(), "yyyy-MM-dd");
              const today = format(new Date(), "yyyy-MM-dd");
              const isPast = effective < today;
              const isToday = effective === today;
              return (
                <div className="space-y-3 text-sm">
                  <div className="rounded border p-2 bg-muted/30">
                    <div className="font-mono text-xs">{pendingPurchaseItem.asin}</div>
                    <div className="text-xs text-muted-foreground line-clamp-2">{pendingPurchaseItem.title}</div>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <div className="rounded border p-2">
                      <div className="text-[10px] text-muted-foreground uppercase mb-1">Total Cost (whole lot)</div>
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        inputMode="decimal"
                        value={panelTotalCost}
                        onChange={(e) => setPanelTotalCost(e.target.value)}
                        className="h-8 text-sm"
                      />
                    </div>
                    <div className="rounded border p-2">
                      <div className="text-[10px] text-muted-foreground uppercase mb-1">Units</div>
                      <Input
                        type="number"
                        min="1"
                        step="1"
                        inputMode="numeric"
                        value={panelUnits}
                        onChange={(e) => setPanelUnits(e.target.value)}
                        className="h-8 text-sm"
                      />
                    </div>
                    <div className="rounded border p-2 bg-primary/5">
                      <div className="text-[10px] text-muted-foreground uppercase mb-1">COG (auto)</div>
                      <div className="h-8 flex items-center font-semibold">
                        {u > 0 && tc > 0 ? `$${cog.toFixed(2)}` : "—"}
                      </div>
                    </div>
                  </div>
                  {(u <= 0 || tc <= 0) && (
                    <div className="text-[11px] text-amber-700 dark:text-amber-400">
                      Enter a valid Total Cost and Units to continue.
                    </div>
                  )}

                  {/* Catch the per-unit-typed-into-total mistake at entry.
                      Offers the correction rather than only refusing, because
                      the right number is already on screen -- it is just in
                      the wrong box. */}
                  {(() => {
                    const chk = suspiciousUnitCost(tc, u, pendingPurchaseItem.price);
                    if (!chk.suspicious) return null;
                    return (
                      <div className="rounded border border-amber-500/40 bg-amber-500/10 p-3 space-y-2">
                        <div className="text-xs font-semibold text-amber-900 dark:text-amber-300">
                          That works out to ${chk.cog.toFixed(4)} per unit
                          {chk.pctOfPrice !== null && (
                            <> — {chk.pctOfPrice.toFixed(1)}% of the ${Number(pendingPurchaseItem.price).toFixed(2)} selling price</>
                          )}.
                        </div>
                        <div className="text-[11px] text-amber-900/90 dark:text-amber-200/90 leading-relaxed">
                          <strong>Total Cost</strong> is what the whole lot cost, not the price of one unit.
                          If ${tc.toFixed(2)} is what you paid <em>per unit</em>, the lot total for {u} units
                          is <strong>${chk.impliedTotal.toFixed(2)}</strong>.
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="default"
                            className="h-7 text-xs"
                            onClick={() => {
                              setPanelTotalCost(chk.impliedTotal.toFixed(2));
                              setPanelCog(tc.toFixed(2));
                              setCostSanityAck(false);
                            }}
                          >
                            ${tc.toFixed(2)} is the per-unit price — set total to ${chk.impliedTotal.toFixed(2)}
                          </Button>
                          <label className="flex items-center gap-1.5 text-[11px] cursor-pointer">
                            <Checkbox
                              checked={costSanityAck}
                              onCheckedChange={(v) => setCostSanityAck(!!v)}
                            />
                            <span>No, ${tc.toFixed(2)} really is the lot total</span>
                          </label>
                        </div>
                      </div>
                    );
                  })()}
                  <details className="rounded border bg-muted/10 group">
                    <summary className="cursor-pointer select-none px-3 py-2 text-xs font-semibold hover:bg-muted/30 rounded">
                      Advanced: backdate this cost for P&amp;L history
                      {!isToday && (
                        <span className="ml-2 text-amber-700 dark:text-amber-400 font-normal">
                          (effective {format(panelEffectiveDate, "MMM d, yyyy")})
                        </span>
                      )}
                    </summary>
                    <div className="p-3 pt-2 space-y-2 border-t">
                      <p className="text-[11px] text-muted-foreground leading-relaxed">
                        Only use this if this cost was already true on an earlier date. This affects cost history used by P&amp;L and repricer ROI floor. It does not change the purchase date or listing creation date.
                      </p>
                      <div className="flex items-center gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant={isToday ? "default" : "outline"}
                          onClick={() => setPanelEffectiveDate(new Date())}
                        >
                          Effective today (default)
                        </Button>
                        <Popover>
                          <PopoverTrigger asChild>
                            <Button
                              type="button"
                              size="sm"
                              variant={isToday ? "outline" : "default"}
                              className="font-normal"
                            >
                              <CalendarIcon className="mr-1 h-3 w-3" />
                              {isToday ? "Pick a past date" : format(panelEffectiveDate, "MMM d, yyyy")}
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent className="w-auto p-0" align="start">
                            <Calendar
                              mode="single"
                              selected={panelEffectiveDate}
                              onSelect={(d) => {
                                if (!d) return;
                                const picked = format(d, "yyyy-MM-dd");
                                const todayStr = format(new Date(), "yyyy-MM-dd");
                                if (picked < todayStr) {
                                  const ok = window.confirm(
                                    `You're backdating this cost to ${format(d, "MMM d, yyyy")}.\n\n` +
                                    `This will recompute P&L for any orders since that date that don't yet have a locked cost snapshot. ` +
                                    `Settled P&L stays frozen. Inventory valuation is unchanged.\n\nContinue?`
                                  );
                                  if (!ok) return;
                                }
                                setPanelEffectiveDate(d);
                              }}
                              disabled={(d) => d > new Date()}
                              initialFocus
                              className={cn("p-3 pointer-events-auto")}
                            />
                          </PopoverContent>
                        </Popover>
                      </div>
                      {isPast && (
                        <div className="text-[11px] text-amber-700 dark:text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded p-2">
                          ⚠ Backdated to {format(panelEffectiveDate, "MMM d, yyyy")}. New COG applies to orders since this date that don't have a saved cost snapshot. Settled P&amp;L stays frozen.
                        </div>
                      )}
                    </div>
                  </details>

                  <FbaReadinessTracker
                    eligibility={purchaseFbaElig.data}
                    loading={purchaseFbaElig.loading}
                    onRecheck={purchaseFbaElig.recheck}
                    onRunDryRun={purchaseFbaElig.runDryRun}
                    dryRunLoading={purchaseFbaElig.dryRunLoading}
                  />

                  {purchaseFbaBlocked && (
                    <label className="flex items-start gap-2 rounded border border-red-300 bg-red-50/60 dark:bg-red-950/30 p-2 text-xs cursor-pointer">
                      <Checkbox
                        checked={purchaseFbmAck}
                        onCheckedChange={(v) => setPurchaseFbmAck(!!v)}
                        className="mt-0.5"
                      />
                      <span>
                        I understand Amazon will reject FBA shipments for this ASIN.
                        Save this purchase as <strong>FBM-only</strong> (will be excluded from FBA shipment plans).
                      </span>
                    </label>
                  )}
                </div>
              );
            })()}
            <DialogFooter>
              <Button variant="ghost" onClick={() => setConfirmPurchaseOpen(false)} disabled={addingPurchase}>
                Cancel
              </Button>
              <Button
                onClick={async () => {
                  if (!pendingPurchaseItem) return;
                  setConfirmPurchaseOpen(false);
                  await handleAddPurchaseConfirm(pendingPurchaseItem);
                  setPendingPurchaseItem(null);
                }}
                disabled={
                  addingPurchase ||
                  !(parseFloat(panelTotalCost) > 0) ||
                  !(parseInt(panelUnits) > 0) ||
                  (purchaseFbaBlocked && !purchaseFbmAck) ||
                  // An implausible per-unit cost must be corrected or explicitly
                  // confirmed. Cheap goods exist, so this is a stop, not a ban.
                  (suspiciousUnitCost(
                    parseFloat(panelTotalCost) || 0,
                    parseInt(panelUnits) || 0,
                    pendingPurchaseItem?.price,
                  ).suspicious && !costSanityAck)
                }
                variant={purchaseFbaBlocked ? "destructive" : "default"}
              >
                {purchaseFbaBlocked ? "Save as FBM only" : "Confirm & save purchase"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Adding Purchase Loading Dialog */}
        <Dialog open={addingPurchase}>
          <DialogContent className="max-w-xs text-center" onPointerDownOutside={(e) => e.preventDefault()}>
            <DialogHeader className="sr-only">
              <DialogTitle>Adding purchase</DialogTitle>
              <DialogDescription>Saving the new dated purchase row.</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col items-center gap-3 py-4">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <p className="text-sm font-medium">Adding purchase...</p>
            </div>
          </DialogContent>
        </Dialog>
        {/* Inline ROI Results Dialog (uses same logic as CreateListing) */}
        {inlineRoiResult && (
          <Dialog open={inlineRoiDialogOpen} onOpenChange={setInlineRoiDialogOpen}>
            <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto bg-gradient-to-br from-blue-50 via-white to-purple-50 border-2 border-blue-200 shadow-2xl z-50">
              <DialogHeader className="border-b border-blue-200 pb-2">
                <DialogTitle className="flex items-center gap-2 text-base text-blue-900">
                  <Calculator className="h-4 w-4 text-blue-600" />
                  ROI Calculator (CreateListing Method)
                </DialogTitle>
              </DialogHeader>
              <div className="space-y-2">
                <div className="flex gap-2 p-2 border border-blue-200 rounded-lg bg-white shadow-sm">
                  {inlineRoiResult.imageUrl && (
                    <img src={inlineRoiResult.imageUrl} alt="" className="w-12 h-12 object-contain border rounded bg-white p-0.5" />
                  )}
                  <div className="flex-1 space-y-0.5">
                    <p className="font-semibold text-xs line-clamp-2">{inlineRoiResult.title}</p>
                    <p className="text-[10px] text-blue-600 font-medium">ASIN: {inlineRoiResult.asin}</p>
                    <p className="text-xs font-bold text-green-700">Price: ${inlineRoiResult.price.toFixed(2)}</p>
                  </div>
                </div>
                <div className="p-3 border border-green-200 rounded-lg bg-gradient-to-br from-green-50 via-white to-emerald-50 shadow-md space-y-2">
                  <h4 className="font-bold text-sm mb-2 text-green-900 border-b border-green-300 pb-1">💰 Results</h4>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="p-2 bg-gradient-to-br from-blue-100 to-blue-50 rounded border border-blue-300">
                      <p className="text-[10px] font-semibold text-blue-700 mb-0.5">Amazon Price</p>
                      <p className="text-sm font-bold text-blue-900">${inlineRoiResult.price.toFixed(2)}</p>
                    </div>
                    <div className="p-2 bg-gradient-to-br from-purple-100 to-purple-50 rounded border border-purple-300">
                      <p className="text-[10px] font-semibold text-purple-700 mb-0.5">Your Cost (COG)</p>
                      <p className="text-sm font-bold text-purple-900">${inlineRoiResult.unitCost.toFixed(2)}</p>
                    </div>
                    <div className="p-2 bg-gradient-to-br from-orange-100 to-orange-50 rounded border border-orange-300">
                      <p className="text-[10px] font-semibold text-orange-700 mb-0.5">Referral Fee</p>
                      <p className="text-sm font-bold text-orange-900">${inlineRoiResult.referralFee.toFixed(2)}</p>
                    </div>
                    <div className="p-2 bg-gradient-to-br from-red-100 to-red-50 rounded border border-red-300">
                      <p className="text-[10px] font-semibold text-red-700 mb-0.5">FBA Fee</p>
                      <p className="text-sm font-bold text-red-900">${inlineRoiResult.fbaFee.toFixed(2)}</p>
                    </div>
                    <div className="p-2 bg-gradient-to-br from-amber-100 to-amber-50 rounded border border-amber-300">
                      <p className="text-[10px] font-semibold text-amber-700 mb-0.5">Closing Fee</p>
                      <p className="text-sm font-bold text-amber-900">${inlineRoiResult.variableClosingFee.toFixed(2)}</p>
                    </div>
                    <div className="p-2 bg-gradient-to-br from-indigo-100 to-indigo-50 rounded border border-indigo-400">
                      <p className="text-[10px] font-semibold text-indigo-700 mb-0.5">Total Fees</p>
                      <p className="text-base font-bold text-indigo-900">${inlineRoiResult.totalFees.toFixed(2)}</p>
                    </div>
                    <div className="p-2 bg-gradient-to-br from-teal-100 to-teal-50 rounded border border-teal-300">
                      <p className="text-[10px] font-semibold text-teal-700 mb-0.5">Net Profit</p>
                      <p className={`text-sm font-bold ${inlineRoiResult.profit >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                        ${inlineRoiResult.profit.toFixed(2)}
                      </p>
                    </div>
                    <div className="col-span-2 border-t border-emerald-300 pt-2 mt-1">
                      <div className="grid grid-cols-2 gap-2">
                        <div className="p-3 bg-gradient-to-br from-emerald-200 to-emerald-100 rounded-lg border border-emerald-400">
                          <p className="text-[10px] font-bold text-emerald-800 mb-1">📈 ROI</p>
                          <p className={`text-xl font-black ${inlineRoiResult.roi >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                            {inlineRoiResult.roi.toFixed(2)}%
                          </p>
                        </div>
                        <div className="p-3 bg-gradient-to-br from-cyan-200 to-cyan-100 rounded-lg border border-cyan-400">
                          <p className="text-[10px] font-bold text-cyan-800 mb-1">💹 Margin</p>
                          <p className={`text-xl font-black ${inlineRoiResult.margin >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                            {inlineRoiResult.margin.toFixed(2)}%
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        )}
        {/* Delete Confirmation Dialog */}
        <Dialog open={!!deleteConfirmId} onOpenChange={(open) => { if (!open) setDeleteConfirmId(null); }}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-destructive">
                <Trash2 className="h-4 w-4" />
                Confirm Delete
              </DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              Are you sure you want to delete this item?
            </p>
            <p className="text-xs font-medium line-clamp-2">{deleteConfirmTitle}</p>
            <div className="flex justify-end gap-2 mt-2">
              <Button variant="outline" size="sm" onClick={() => setDeleteConfirmId(null)}>Cancel</Button>
              <Button variant="destructive" size="sm" onClick={confirmDelete}>Delete</Button>
            </div>
          </DialogContent>
        </Dialog>

        {/* Fix Synthetic SKUs Dialog */}
        <Dialog open={fixSkuOpen} onOpenChange={(o) => { setFixSkuOpen(o); if (!o) { setFixSkuPreview(null); setAutoFixCandidates(null); setAutoFixResult(null); } }}>
          <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Fix Synthetic SKUs</DialogTitle>
              <DialogDescription>
                Scans <strong>every</strong> ASIN in your created listings. Source of truth = your real Amazon SKU from <strong>inventory</strong> (if available), otherwise the <strong>earliest-created row's SKU</strong>. All sibling rows are rewritten to match.
              </DialogDescription>
            </DialogHeader>

            {/* AUTO-FIX ALL */}
            <div className="rounded-md border border-border bg-muted/30 p-3 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold">Auto-Fix All ASINs</div>
                  <div className="text-xs text-muted-foreground">First-created row per ASIN = source of truth.</div>
                </div>
                <Button size="sm" onClick={scanAutoFix} disabled={autoFixScanning || autoFixApplying}>
                  {autoFixScanning ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
                  {autoFixCandidates ? "Re-scan" : "Scan now"}
                </Button>
              </div>

              {autoFixCandidates && autoFixCandidates.length === 0 && !autoFixScanning && (
                <div className="text-xs text-muted-foreground">
                  No mismatched ASINs found — every ASIN already has a single consistent SKU.
                </div>
              )}

              {autoFixCandidates && autoFixCandidates.length > 0 && (
                <>
                  <div className="flex items-center justify-between text-xs">
                    <div>
                      <strong>{autoFixCandidates.length}</strong> ASIN(s) with mismatched SKUs.{" "}
                      <button
                        className="underline text-primary"
                        onClick={() => setAutoFixSelected(new Set(autoFixCandidates.map(c => c.asin)))}
                      >Select all</button>{" "}
                      ·{" "}
                      <button
                        className="underline text-primary"
                        onClick={() => setAutoFixSelected(new Set())}
                      >Clear</button>
                    </div>
                    <div className="text-muted-foreground">{autoFixSelected.size} selected</div>
                  </div>
                  <div className="max-h-[280px] overflow-y-auto rounded border border-border">
                    <table className="w-full text-xs">
                      <thead className="bg-muted/50 sticky top-0">
                        <tr>
                          <th className="p-1.5 text-left w-8"></th>
                          <th className="p-1.5 text-left">ASIN</th>
                          <th className="p-1.5 text-left">Source SKU (earliest)</th>
                          <th className="p-1.5 text-left">Other SKUs</th>
                          <th className="p-1.5 text-right">Rows</th>
                        </tr>
                      </thead>
                      <tbody>
                        {autoFixCandidates.map(c => (
                          <tr key={c.asin} className="border-t border-border">
                            <td className="p-1.5">
                              <input
                                type="checkbox"
                                checked={autoFixSelected.has(c.asin)}
                                onChange={(e) => {
                                  setAutoFixSelected(prev => {
                                    const n = new Set(prev);
                                    if (e.target.checked) n.add(c.asin); else n.delete(c.asin);
                                    return n;
                                  });
                                }}
                              />
                            </td>
                            <td className="p-1.5 font-mono">{c.asin}</td>
                            <td className="p-1.5 font-mono text-emerald-600 dark:text-emerald-400">
                              {c.sourceSku}
                              <span className={`ml-1 text-[10px] px-1 rounded ${c.source === 'inventory' ? 'bg-emerald-500/20' : 'bg-muted'}`}>
                                {c.source === 'inventory' ? 'Amazon' : 'earliest'}
                              </span>
                            </td>
                            <td className="p-1.5 font-mono text-muted-foreground break-all">{c.otherSkus.join(", ")}</td>
                            <td className="p-1.5 text-right">{c.rowsToUpdate}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <Button
                    size="sm"
                    onClick={applyAutoFix}
                    disabled={autoFixApplying || autoFixSelected.size === 0}
                  >
                    {autoFixApplying ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
                    Apply fix to {autoFixSelected.size} ASIN(s)
                  </Button>
                </>
              )}

              {autoFixResult && (
                <div className="rounded border border-border bg-background p-2 text-xs space-y-1">
                  <div>Fixed <strong>{autoFixResult.asinsFixed}</strong> ASIN(s), updated <strong>{autoFixResult.rowsUpdated}</strong> row(s).</div>
                  {autoFixResult.errors.length > 0 && (
                    <div className="text-destructive">
                      {autoFixResult.errors.length} error(s):
                      <ul className="list-disc pl-4">
                        {autoFixResult.errors.slice(0, 5).map((e, i) => <li key={i}>{e}</li>)}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* MANUAL FIX */}
            <div className="rounded-md border border-border p-3 space-y-3">
              <div className="text-sm font-semibold">Manual fix (one ASIN)</div>
              <div>
                <label className="text-xs font-semibold mb-1 block">ASIN</label>
                <Input
                  placeholder="B0XXXXXXXX"
                  value={fixSkuAsin}
                  onChange={(e) => { setFixSkuAsin(e.target.value); setFixSkuPreview(null); }}
                  className="font-mono"
                />
              </div>
              <div>
                <label className="text-xs font-semibold mb-1 block">Original SKU (will be applied to all rows)</label>
                <Input
                  placeholder="GHM-PXE-MX4Y"
                  value={fixSkuOriginal}
                  onChange={(e) => setFixSkuOriginal(e.target.value)}
                  className="font-mono"
                />
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={previewFixSku} disabled={!fixSkuAsin.trim()}>
                  Preview affected rows
                </Button>
                <Button
                  size="sm"
                  onClick={applyFixSku}
                  disabled={fixSkuBusy || !fixSkuAsin.trim() || !fixSkuOriginal.trim()}
                >
                  {fixSkuBusy ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
                  Apply to all rows
                </Button>
              </div>
              {fixSkuPreview && (
                <div className="rounded-md border border-border bg-muted/40 p-2 text-xs space-y-1">
                  <div><strong>{fixSkuPreview.count}</strong> row(s) found for this ASIN.</div>
                  {fixSkuPreview.current.length > 0 && (
                    <div className="break-all">
                      <span className="text-muted-foreground">Current SKUs:</span>{" "}
                      <span className="font-mono">{fixSkuPreview.current.join(", ")}</span>
                    </div>
                  )}
                </div>
              )}
            </div>

            <DialogFooter>
              <Button variant="outline" size="sm" onClick={() => setFixSkuOpen(false)} disabled={fixSkuBusy || autoFixApplying}>Close</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </>
  );
}
