import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { calculateReplenishQty } from "@/lib/replenishment";
import { isGhostRow } from "@/lib/ghostFilter";
import { ShoppingCart, ExternalLink, Loader2, Package, Search, RefreshCw, Copy } from "lucide-react";
import { toast } from "sonner";

// Ghost rows are filtered with the shared platform rule, not a local copy.
//
// This file used to carry its own isHiddenInSyncedInventory covering three of
// the four ghost conditions -- NOT_IN_CATALOG, DELETED and an "amzn.gr." SKU --
// and silently missed INACTIVE. Measured 2026-09-05: 10,348 zero-stock rows
// are INACTIVE against 1,175 NOT_IN_CATALOG, so the missing clause was most of
// the problem. Buy Again hid 1,434 rows where the shared rule hides 11,769.
//
// ghostFilter.ts already named "NeedBuyAgain + Repricer parity" in its own
// docstring; it simply was never imported here.

/** Fetch all rows, bypassing the 1000-row default limit */
async function fetchAllPaged(
  buildQuery: (from: number, to: number) => any
): Promise<any[]> {
  const PAGE = 1000;
  let all: any[] = [];
  let offset = 0;
  let hasMore = true;
  while (hasMore) {
    const { data, error } = await buildQuery(offset, offset + PAGE - 1);
    if (error) throw error;
    if (data && data.length > 0) {
      all = all.concat(data);
      offset += PAGE;
      hasMore = data.length === PAGE;
    } else {
      hasMore = false;
    }
  }
  return all;
}

interface ReplenishItem {
  asin: string;
  title: string;
  image_url: string | null;
  replenishQty: number;
  supplierLinks: Array<{ link: string; discount_code: string }>;
  available: number;
  inbound: number;
  reserved: number;
}

interface NeedBuyAgainDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
}

interface ReplenishDialogCache {
  items: ReplenishItem[];
  lastFetchedAt: string | null;
  searchQuery: string;
  scrollTop: number;
}

// Module-level cache so data and view state persist across dialog open/close
let cachedItems: ReplenishItem[] = [];
let cachedAt: Date | null = null;
let cachedUserId: string | null = null;
let cachedSearchQuery = "";
let cachedScrollTop = 0;

const getCacheKey = (userId: string) => `need-buy-again:${userId}`;

function readPersistedCache(userId: string): ReplenishDialogCache | null {
  if (!userId || typeof window === "undefined") return null;

  try {
    const raw = window.sessionStorage.getItem(getCacheKey(userId));
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.items)) return null;

    return {
      items: parsed.items,
      lastFetchedAt: typeof parsed.lastFetchedAt === "string" ? parsed.lastFetchedAt : null,
      searchQuery: typeof parsed.searchQuery === "string" ? parsed.searchQuery : "",
      scrollTop: typeof parsed.scrollTop === "number" ? parsed.scrollTop : 0,
    };
  } catch {
    return null;
  }
}

function writePersistedCache(userId: string, cache: ReplenishDialogCache) {
  if (!userId || typeof window === "undefined") return;

  try {
    window.sessionStorage.setItem(getCacheKey(userId), JSON.stringify(cache));
  } catch {
    // Ignore storage failures silently
  }
}

function getInitialDialogState(userId: string) {
  const persisted = readPersistedCache(userId);
  if (persisted) {
    return {
      items: persisted.items,
      lastFetchedAt: persisted.lastFetchedAt ? new Date(persisted.lastFetchedAt) : null,
      searchQuery: persisted.searchQuery,
      scrollTop: persisted.scrollTop,
    };
  }

  return {
    items: cachedUserId === userId ? cachedItems : [],
    lastFetchedAt: cachedUserId === userId ? cachedAt : null,
    searchQuery: cachedUserId === userId ? cachedSearchQuery : "",
    scrollTop: cachedUserId === userId ? cachedScrollTop : 0,
  };
}

export function NeedBuyAgainDialog({ open, onOpenChange, userId }: NeedBuyAgainDialogProps) {
  const initialState = useMemo(() => getInitialDialogState(userId), [userId]);
  const [items, setItems] = useState<ReplenishItem[]>(initialState.items);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState(initialState.searchQuery);
  const [lastFetchedAt, setLastFetchedAt] = useState<Date | null>(initialState.lastFetchedAt);
  const scrollViewportRef = useRef<HTMLDivElement>(null);

  const persistState = ({
    nextItems = items,
    nextLastFetchedAt = lastFetchedAt,
    nextSearchQuery = searchQuery,
    nextScrollTop = cachedScrollTop,
  }: {
    nextItems?: ReplenishItem[];
    nextLastFetchedAt?: Date | null;
    nextSearchQuery?: string;
    nextScrollTop?: number;
  } = {}) => {
    if (!userId) return;

    cachedItems = nextItems;
    cachedAt = nextLastFetchedAt;
    cachedUserId = userId;
    cachedSearchQuery = nextSearchQuery;
    cachedScrollTop = nextScrollTop;

    writePersistedCache(userId, {
      items: nextItems,
      lastFetchedAt: nextLastFetchedAt ? nextLastFetchedAt.toISOString() : null,
      searchQuery: nextSearchQuery,
      scrollTop: nextScrollTop,
    });
  };

  useEffect(() => {
    const nextState = getInitialDialogState(userId);
    setItems(nextState.items);
    setSearchQuery(nextState.searchQuery);
    setLastFetchedAt(nextState.lastFetchedAt);
    cachedScrollTop = nextState.scrollTop;
  }, [userId]);

  useEffect(() => {
    if (!open || !scrollViewportRef.current) return;

    requestAnimationFrame(() => {
      if (!scrollViewportRef.current) return;
      scrollViewportRef.current.scrollTop = cachedScrollTop;
    });
  }, [open]);

  useEffect(() => {
    return () => {
      persistState();
    };
  }, [items, lastFetchedAt, searchQuery, userId]);

  const filteredItems = useMemo(() => {
    const q = searchQuery.trim().toUpperCase();
    if (!q) return items;
    return items.filter(
      (item) =>
        item.asin.toUpperCase().includes(q) ||
        item.title.toUpperCase().includes(q)
    );
  }, [items, searchQuery]);

  const handleSearchChange = (value: string) => {
    setSearchQuery(value);
    persistState({ nextSearchQuery: value });
  };

  const fetchReplenishData = async () => {
    if (!userId) return;

    setLoading(true);
    try {
      const today = new Date();
      const periodStartDate = new Date();
      periodStartDate.setDate(periodStartDate.getDate() - 30);
      const periodStartStr = periodStartDate.toISOString().split("T")[0];

      const [inventoryData, recentSalesData, historicalSalesData, listingsData] = await Promise.all([
        fetchAllPaged((from, to) =>
          supabase.from("inventory")
            .select("asin, title, image_url, available, inbound, reserved, unfulfilled, sku, listing_status")
            .eq("user_id", userId)
            .range(from, to)
        ),
        fetchAllPaged((from, to) =>
          supabase.from("sales_orders")
            .select("asin, quantity, order_date")
            .eq("user_id", userId)
            .gte("order_date", periodStartStr)
            .range(from, to)
        ),
        fetchAllPaged((from, to) =>
          supabase.from("sales_orders")
            .select("asin, quantity, order_date")
            .eq("user_id", userId)
            .range(from, to)
        ),
        fetchAllPaged((from, to) =>
          supabase.from("created_listings")
            .select("asin, sku, title, supplier_links, image_url")
            .eq("user_id", userId)
            .range(from, to)
        ),
      ]);

      const getDaysSince = (dateStr: string) => {
        const date = new Date(dateStr);
        const diffMs = today.getTime() - date.getTime();
        return Math.max(1, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
      };

      const recentSalesMap = new Map<string, { units: number; earliestOrderDate: string }>();
      for (const row of recentSalesData) {
        if (!row.asin || row.asin === "PENDING") continue;
        const qty = row.quantity || 1;
        const existing = recentSalesMap.get(row.asin);
        if (existing) {
          existing.units += qty;
          if (row.order_date < existing.earliestOrderDate) {
            existing.earliestOrderDate = row.order_date;
          }
        } else {
          recentSalesMap.set(row.asin, {
            units: qty,
            earliestOrderDate: row.order_date,
          });
        }
      }

      const historicalSalesMap = new Map<string, { totalUnits: number; earliestDate: string }>();
      for (const row of historicalSalesData) {
        if (!row.asin || row.asin === "PENDING") continue;
        const qty = row.quantity || 1;
        const existing = historicalSalesMap.get(row.asin);
        if (existing) {
          existing.totalUnits += qty;
          if (row.order_date < existing.earliestDate) {
            existing.earliestDate = row.order_date;
          }
        } else {
          historicalSalesMap.set(row.asin, {
            totalUnits: qty,
            earliestDate: row.order_date,
          });
        }
      }

      const supplierMap = new Map<string, Array<{ link: string; discount_code: string }>>();
      const listingImageMap = new Map<string, string>();
      for (const row of listingsData) {
        if (row.supplier_links && Array.isArray(row.supplier_links) && row.supplier_links.length > 0) {
          if (!supplierMap.has(row.asin)) {
            supplierMap.set(row.asin, row.supplier_links as Array<{ link: string; discount_code: string }>);
          }
        }
        if (row.image_url && !listingImageMap.has(row.asin)) {
          listingImageMap.set(row.asin, row.image_url);
        }
      }

      const inventorySkus = new Set(inventoryData.map((item) => item.sku).filter(Boolean));
      const inventoryAsins = new Set(inventoryData.map((item) => item.asin).filter(Boolean));

      const createdListingsToAdd = listingsData.filter((listing) =>
        listing.asin && !inventoryAsins.has(listing.asin) && !inventorySkus.has(listing.sku)
      );

      // Ghosts are dropped here, at the inventory branch only.
      //
      // NOT further down over the merged list: createdListingsToAdd rows are
      // synthesised with listing_status null and available 0, and the shared
      // rule counts "no stock and not ACTIVE" as a ghost -- so a blanket
      // filter would delete precisely the never-stocked listings this dialog
      // exists to surface. Ghosthood is a property of a real inventory row.
      //
      // Checked before adopting the shared rule: across all 12,087 inventory
      // rows the zero-stock clause hides nothing the status clause does not
      // already hide (11,769 either way), and zero rows are hidden by it
      // alone, so no live restock candidate is lost.
      const liveInventory = inventoryData.filter((item) => !isGhostRow(item));

      const combinedItems = [
        ...liveInventory.map((item) => ({
          asin: item.asin,
          sku: item.sku,
          listing_status: item.listing_status,
          title: item.title,
          image_url: item.image_url || listingImageMap.get(item.asin) || null,
          available: item.available ?? 0,
          inbound: item.inbound ?? 0,
          reserved: item.reserved ?? 0,
          supplierLinks: supplierMap.get(item.asin) || [],
        })),
        ...createdListingsToAdd.map((item) => ({
          asin: item.asin,
          sku: item.sku,
          listing_status: null,
          title: item.title,
          image_url: item.image_url || listingImageMap.get(item.asin) || null,
          available: 0,
          inbound: 0,
          reserved: 0,
          supplierLinks: supplierMap.get(item.asin) || [],
        })),
      ];

      const groupedItems = new Map<string, {
        asin: string;
        sku: string;
        title: string;
        image_url: string | null;
        available: number;
        inbound: number;
        reserved: number;
        listing_status?: string | null;
        supplierLinks: Array<{ link: string; discount_code: string }>;
      }>();

      for (const item of combinedItems) {
        const key = `${item.asin}::${item.sku}`;
        const existing = groupedItems.get(key);
        if (existing) {
          existing.available += item.available;
          existing.inbound += item.inbound;
          existing.reserved += item.reserved;
          if ((!existing.title || existing.title === "Untitled Product") && item.title) {
            existing.title = item.title;
          }
          if (!existing.image_url && item.image_url) {
            existing.image_url = item.image_url;
          }
          if (existing.supplierLinks.length === 0 && item.supplierLinks.length > 0) {
            existing.supplierLinks = item.supplierLinks;
          }
        } else {
          groupedItems.set(key, { ...item });
        }
      }

      const replenishItems: ReplenishItem[] = [];
      for (const item of groupedItems.values()) {
        const recentSales = recentSalesMap.get(item.asin);
        const actualSalesPeriod = recentSales
          ? Math.min(30, getDaysSince(recentSales.earliestOrderDate))
          : 30;
        const historicalSales = historicalSalesMap.get(item.asin);

        const qty = calculateReplenishQty({
          salesUnits: recentSales?.units ?? 0,
          salesPeriodDays: actualSalesPeriod,
          available: item.available,
          inbound: item.inbound,
          reserved: item.reserved,
          coverageDays: 30,
          historicalSalesUnits: historicalSales?.totalUnits,
          historicalDays: historicalSales ? getDaysSince(historicalSales.earliestDate) : undefined,
        });

        if (qty > 0) {
          replenishItems.push({
            asin: item.asin,
            title: item.title,
            image_url: item.image_url,
            replenishQty: qty,
            supplierLinks: item.supplierLinks,
            available: item.available,
            inbound: item.inbound,
            reserved: item.reserved,
          });
        }
      }

      replenishItems.sort((a, b) => b.replenishQty - a.replenishQty);
      const fetchedAt = new Date();
      setItems(replenishItems);
      setLastFetchedAt(fetchedAt);
      persistState({
        nextItems: replenishItems,
        nextLastFetchedAt: fetchedAt,
      });
    } catch (err) {
      console.error("Failed to fetch replenish data:", err);
    } finally {
      setLoading(false);
    }
  };

  const extractDomain = (url: string) => {
    try {
      return new URL(url).hostname.replace("www.", "");
    } catch {
      return url.slice(0, 30);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[95vw] max-w-5xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg">
            <ShoppingCart className="h-5 w-5 text-primary" />
            Need to Buy Again
            {!loading && (
              <span className="text-sm font-normal text-muted-foreground ml-2">
                ({items.length} items)
              </span>
            )}
          </DialogTitle>
          <div className="flex items-center gap-2 mt-1">
            {lastFetchedAt && (
              <span className="text-xs text-muted-foreground">
                Last refreshed: {lastFetchedAt.toLocaleTimeString()}
              </span>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={fetchReplenishData}
              disabled={loading}
              className="gap-1.5"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              Refresh Data
            </Button>
          </div>
        </DialogHeader>

        {!loading && items.length > 0 && (
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by ASIN or title..."
              value={searchQuery}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="pl-9"
            />
          </div>
        )}

        <div
          ref={scrollViewportRef}
          onScroll={(e) => {
            cachedScrollTop = e.currentTarget.scrollTop;
          }}
          className="overflow-y-auto flex-1 -mx-6 px-6"
        >
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <span className="ml-3 text-muted-foreground">Calculating replenishment...</span>
            </div>
          ) : items.length === 0 && !lastFetchedAt ? (
            <div className="flex flex-col items-center justify-center py-16">
              <Package className="h-12 w-12 mb-3 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground mb-4">Click below to calculate which products need restocking</p>
              <Button onClick={fetchReplenishData} className="gap-2">
                <ShoppingCart className="h-4 w-4" />
                Calculate Replenishment
              </Button>
            </div>
          ) : filteredItems.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <Package className="h-12 w-12 mb-3 opacity-40" />
              <p className="text-sm">{searchQuery ? "No items match your search" : "All products are sufficiently stocked!"}</p>
            </div>
          ) : (
            <div className="space-y-2">
              {filteredItems.map((item, index) => (
                <div
                  key={`${item.asin}-${index}`}
                  className="flex items-center gap-3 p-3 rounded-lg border border-border/60 bg-card/50 hover:bg-accent/30 transition-colors"
                >
                  <div className="w-14 h-14 flex-shrink-0 rounded-md overflow-hidden bg-muted/30 flex items-center justify-center">
                    {item.image_url ? (
                      <img
                        src={item.image_url}
                        alt={item.title}
                        className="w-full h-full object-contain"
                        loading="lazy"
                      />
                    ) : (
                      <Package className="h-6 w-6 text-muted-foreground/40" />
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate" title={item.title}>
                      {item.title}
                    </p>
                    <div className="flex items-center gap-3 mt-1">
                      <span className="inline-flex items-center gap-1">
                        <a
                          href={`https://www.amazon.com/dp/${item.asin}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs font-mono text-primary hover:underline"
                        >
                          {item.asin}
                        </a>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            navigator.clipboard.writeText(item.asin);
                            toast.success(`Copied ${item.asin}`);
                          }}
                          className="inline-flex items-center justify-center rounded p-0.5 hover:bg-muted transition-colors"
                          title="Copy ASIN"
                        >
                          <Copy className="h-3 w-3 text-muted-foreground hover:text-foreground" />
                        </button>
                      </span>
                      <span className="text-xs text-muted-foreground">
                        Stock: {item.available} avail / {item.inbound} inbound / {item.reserved} reserved
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 mt-1.5">
                      <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Supplier:</span>
                      {item.supplierLinks.length > 0 ? (
                        item.supplierLinks.map((sl, idx) => (
                          <a
                            key={idx}
                            href={sl.link}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                          >
                            {extractDomain(sl.link)}
                            <ExternalLink className="h-2.5 w-2.5" />
                          </a>
                        ))
                      ) : (
                        <span className="text-xs text-muted-foreground/60 italic">No supplier link</span>
                      )}
                    </div>
                  </div>

                  <div className="flex-shrink-0 text-center">
                    <div className="bg-destructive/10 text-destructive font-bold text-lg px-3 py-1 rounded-lg min-w-[60px]">
                      {item.replenishQty}
                    </div>
                    <span className="text-[10px] text-muted-foreground">to order</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
