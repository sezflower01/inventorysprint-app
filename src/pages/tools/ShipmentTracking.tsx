import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useModuleAccess } from "@/hooks/useModuleAccess";
import { invokeEdgeFunction } from "@/lib/edgeFunctionClient";
import { toast } from "sonner";
import Navbar from "@/components/Navbar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RefreshCw, Package, AlertTriangle, CheckCircle, Truck, Clock, XCircle, Trash2, DollarSign, ExternalLink, Loader2 } from "lucide-react";

interface Shipment {
  id: string;
  shipment_id: string;
  shipment_name: string | null;
  destination_fulfillment_center_id: string | null;
  shipment_status: string | null;
  created_at: string;
  updated_at: string;
}

interface ShipmentItem {
  id: string;
  shipment_id: string;
  seller_sku: string;
  fnsku: string | null;
  asin: string | null;
  title: string | null;
  image_url: string | null;
  quantity_shipped: number;
  quantity_received: number;
  quantity_in_case: number;
}

interface ShipmentProgress {
  shipped: number;
  received: number;
  pct: number;
  estimated?: boolean; // true when received count is unknown (draft fallback)
}

interface ShipmentProgressRow {
  shipment_id: string;
  quantity_shipped: number | null;
  quantity_received: number | null;
}

interface ShipmentDraftRow {
  payload: {
    shipmentId?: string;
    shipmentIds?: string[];
    shipmentName?: string;
    items?: Array<{ qtyToShip?: number | string; quantity?: number | string }>;
    boxQuantities?: unknown[] | boolean;
  } | null;
  shipment_name: string | null;
  amazon_shipment_id: string | null;
  updated_at: string | null;
}

const statusColors: Record<string, string> = {
  WORKING: "bg-blue-500",
  SHIPPED: "bg-purple-500",
  RECEIVING: "bg-yellow-500",
  CLOSED: "bg-green-500",
  CANCELLED: "bg-gray-500",
  DELETED: "bg-gray-500",
  ERROR: "bg-red-500",
};

const statusIcons: Record<string, React.ReactNode> = {
  WORKING: <Clock className="h-4 w-4" />,
  SHIPPED: <Truck className="h-4 w-4" />,
  RECEIVING: <Package className="h-4 w-4" />,
  CLOSED: <CheckCircle className="h-4 w-4" />,
  CANCELLED: <XCircle className="h-4 w-4" />,
  DELETED: <XCircle className="h-4 w-4" />,
  ERROR: <AlertTriangle className="h-4 w-4" />,
};

export default function ShipmentTracking() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { isAdmin } = useModuleAccess();
  const [cleaning, setCleaning] = useState(false);
  const CACHE_KEY = 'shipmentTracking.cache.v1';
  const SCROLL_KEY = 'shipmentTracking.scroll.v1';
  const cachedInit = (() => {
    try {
      const raw = typeof window !== 'undefined' ? sessionStorage.getItem(CACHE_KEY) : null;
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  })();
  const [shipments, setShipments] = useState<Shipment[]>(cachedInit?.shipments ?? []);
  const [shipmentItems, setShipmentItems] = useState<Record<string, ShipmentItem[]>>(cachedInit?.shipmentItems ?? {});
  const [shipmentProgress, setShipmentProgress] = useState<Record<string, ShipmentProgress>>(cachedInit?.shipmentProgress ?? {});
  const [loading, setLoading] = useState(!cachedInit);
  const [syncing, setSyncing] = useState(false);
  const [syncingMissing, setSyncingMissing] = useState(false);
  const [addingById, setAddingById] = useState(false);
  const [missingIdsInput, setMissingIdsInput] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [dateFilter, setDateFilter] = useState<string>("ALL");
  
  const [sortBy, setSortBy] = useState<"updated" | "created">("updated");
  const [expandedShipments, setExpandedShipments] = useState<string[]>(cachedInit?.expandedShipments ?? []);
  const [searchQuery, setSearchQuery] = useState("");
  const [loadingShipmentIds, setLoadingShipmentIds] = useState<Set<string>>(new Set());
  
  const [asinMatchedShipmentIds, setAsinMatchedShipmentIds] = useState<Set<string> | null>(null);
  const [searchingAsin, setSearchingAsin] = useState(false);

  // Dedicated ASIN Finder (separate from main search)
  const [asinFinderQuery, setAsinFinderQuery] = useState("");
  const [asinFinderLoading, setAsinFinderLoading] = useState(false);
  const [asinFinderResults, setAsinFinderResults] = useState<Array<{
    shipment_id: string;
    shipment_name: string | null;
    shipment_status: string | null;
    seller_sku: string | null;
    fnsku: string | null;
    asin: string | null;
    quantity_shipped: number;
    quantity_received: number;
  }> | null>(null);

  const productKey = (value: string | null | undefined) => (value || "").trim().toUpperCase();
  const withTimeout = async <T,>(promise: PromiseLike<T>, ms = 8000): Promise<T> => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error("Request timed out")), ms);
    });
    try {
      return await Promise.race([Promise.resolve(promise), timeout]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  };

  const progressFromTotals = (shipped: number, received: number): ShipmentProgress | null => {
    if (shipped <= 0) return null;
    return { shipped, received, pct: Math.min(100, Math.round((received / shipped) * 100)) };
  };

  const progressFromItems = (items: ShipmentItem[]): ShipmentProgress | null => {
    const shipped = items.reduce((s, i) => s + (i.quantity_shipped || 0), 0);
    const received = items.reduce((s, i) => s + (i.quantity_received || 0), 0);
    return progressFromTotals(shipped, received);
  };

  const fetchShipmentProgress = async (rows: Shipment[]) => {
    const ids = Array.from(new Set(rows.map(s => s.shipment_id).filter(Boolean)));
    if (!user?.id || ids.length === 0) {
      setShipmentProgress({});
      return;
    }

    const totals: Record<string, { shipped: number; received: number }> = {};
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      let from = 0;
      while (true) {
        const { data, error } = await supabase
          .from("fba_shipment_items")
          .select("shipment_id, quantity_shipped, quantity_received")
          .eq("user_id", user.id)
          .in("shipment_id", chunk)
          .order("id", { ascending: true })
          .range(from, from + 999);
        if (error) throw error;
        ((data || []) as ShipmentProgressRow[]).forEach((item) => {
          const key = item.shipment_id;
          if (!totals[key]) totals[key] = { shipped: 0, received: 0 };
          totals[key].shipped += item.quantity_shipped || 0;
          totals[key].received += item.quantity_received || 0;
        });
        if (!data || data.length < 1000) break;
        from += 1000;
      }
    }

    const next: Record<string, ShipmentProgress> = {};
    Object.entries(totals).forEach(([shipmentId, total]) => {
      const progress = progressFromTotals(total.shipped, total.received);
      if (progress) next[shipmentId] = progress;
    });

    const closedWithoutTotals = rows.filter((shipment) => {
      const raw = (shipment.shipment_status || "").toUpperCase();
      return raw === "CLOSED" && !next[shipment.shipment_id];
    });

    if (closedWithoutTotals.length > 0) {
      const { data: drafts } = await supabase
        .from("shipment_builder_drafts")
        .select("payload, shipment_name, amazon_shipment_id, updated_at")
        .eq("user_id", user.id)
        .order("updated_at", { ascending: false })
        .limit(100);

      const draftRows = (drafts || []) as ShipmentDraftRow[];
      closedWithoutTotals.forEach((shipment) => {
        const shipmentFc = (shipment.destination_fulfillment_center_id || "").trim().toUpperCase();
        const shipmentName = (shipment.shipment_name || "").trim();
        const matchedDraft = draftRows.find((row) => {
          const payload = row?.payload || {};
          const draftIds = [row?.amazon_shipment_id, payload?.shipmentId, ...(Array.isArray(payload?.shipmentIds) ? payload.shipmentIds : [])]
            .filter(Boolean)
            .map((id) => String(id).toUpperCase());
          if (draftIds.includes(shipment.shipment_id.toUpperCase())) return true;
          const draftName = String(row?.shipment_name || payload?.shipmentName || "").trim();
          if (shipmentName && draftName && (shipmentName.includes(draftName) || draftName.includes(shipmentName))) return true;
          if (shipmentFc && Array.isArray(payload?.boxQuantities) === false) {
            return shipmentName.includes(`-${shipmentFc}`) && String(row?.updated_at || "").slice(0, 10) === shipment.updated_at.slice(0, 10);
          }
          return false;
        });

        const payloadItems = Array.isArray(matchedDraft?.payload?.items) ? matchedDraft.payload.items : [];
        const shipped = payloadItems.reduce((sum, item) => {
          return sum + Math.max(0, Math.floor(Number(item?.qtyToShip || item?.quantity || 0)));
        }, 0);
        const progress = progressFromTotals(shipped, 0);
        if (progress) next[shipment.shipment_id] = { ...progress, estimated: true };
      });
    }

    setShipmentProgress(next);
  };

  useEffect(() => {
    if (!user) {
      navigate("/login");
      return;
    }
    // If we have cached data, refresh silently in background; otherwise show spinner.
    fetchShipments(!!cachedInit);
  }, [user, navigate]);

  // Persist data cache for instant re-hydration on next visit
  useEffect(() => {
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({
        shipments,
        shipmentItems,
        shipmentProgress,
        expandedShipments,
      }));
    } catch {}
  }, [shipments, shipmentItems, shipmentProgress, expandedShipments]);

  // Restore scroll position after hydration; save on scroll & unmount
  useEffect(() => {
    const saved = sessionStorage.getItem(SCROLL_KEY);
    if (saved) {
      const y = Number(saved);
      requestAnimationFrame(() => window.scrollTo(0, y));
    }
    const onScroll = () => {
      try { sessionStorage.setItem(SCROLL_KEY, String(window.scrollY)); } catch {}
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      try { sessionStorage.setItem(SCROLL_KEY, String(window.scrollY)); } catch {}
    };
  }, []);

  const fetchShipments = async (silent = false) => {
    try {
      if (!silent) setLoading(true);
      // Paginate to bypass Supabase's default 1000-row cap so ASIN search
      // can find matches in older shipments too.
      const pageSize = 1000;
      let from = 0;
      const all: any[] = [];
      while (true) {
        const { data, error } = await supabase
          .from("fba_shipments")
          .select("*")
          .eq("user_id", user?.id)
          .order("updated_at", { ascending: false })
          // updated_at is not unique, so it cannot order pages on its own:
          // a tie spanning a page boundary repeats or skips rows. id breaks it.
          .order("id", { ascending: true })
          .range(from, from + pageSize - 1);
        if (error) throw error;
        const batch = data || [];
        all.push(...batch);
        if (batch.length < pageSize) break;
        from += pageSize;
      }
      setShipments(all);
      await fetchShipmentProgress(all);
    } catch (error: any) {
      console.error("Error fetching shipments:", error);
      if (!silent) toast.error("Failed to load shipments");
    } finally {
      if (!silent) setLoading(false);
    }
  };

  const fetchShipmentItems = async (shipmentId: string, force = false) => {
    if (!force && shipmentItems[shipmentId]) {
      // Even when items are cached, ensure missing details get hydrated
      // (older shipments often have NULL asin/title/image_url rows).
      void hydrateMissingItemDetails(shipmentId, shipmentItems[shipmentId]);
      return;
    }

    try {
      const { data, error } = await withTimeout(
        supabase
          .from("fba_shipment_items")
          .select("*")
          .eq("shipment_id", shipmentId)
          .eq("user_id", user?.id),
        8000
      );

      if (error) throw error;
      const items = (data || []) as ShipmentItem[];
      setShipmentItems(prev => ({ ...prev, [shipmentId]: items }));
      // Hydrate missing image/asin/title from inventory / created_listings / fnsku_map / SP-API,
      // mirroring the Shipment Builder logic so older shipments don't show blank rows.
      void hydrateMissingItemDetails(shipmentId, items);
    } catch (error: any) {
      console.error("Error fetching shipment items:", error);
      setShipmentItems(prev => ({ ...prev, [shipmentId]: [] }));
    }
  };

  const hydrateMissingItemDetails = async (shipmentId: string, items: ShipmentItem[]) => {
    if (!user?.id || !items.length) return;
    const isMissing = (it: ShipmentItem) =>
      !(it.image_url && String(it.image_url).trim()) ||
      !(it.asin && String(it.asin).trim()) ||
      !(it.title && String(it.title).trim());
    const missing = items.filter(isMissing);
    if (missing.length === 0) return;

    try {
      const skus = Array.from(new Set(missing.map(i => (i.seller_sku || "").trim()).filter(Boolean)));
      const fnskus = Array.from(new Set(missing.map(i => (i.fnsku || "").trim()).filter(Boolean)));
      const initialAsins = Array.from(new Set(missing.map(i => (i.asin || "").trim()).filter(Boolean)));

      // Maps keyed by sku/fnsku/asin → resolved fields
      const bySku = new Map<string, { asin?: string; title?: string; image_url?: string }>();
      const byFnsku = new Map<string, { asin?: string; title?: string; image_url?: string }>();
      const byAsin = new Map<string, { title?: string; image_url?: string }>();

      const mergeSku = (sku: string, patch: { asin?: string; title?: string; image_url?: string }) => {
        const cur = bySku.get(sku) || {};
        bySku.set(sku, {
          asin: cur.asin || (patch.asin || undefined),
          title: cur.title || (patch.title || undefined),
          image_url: cur.image_url || (patch.image_url || undefined),
        });
      };
      const mergeFnsku = (fnsku: string, patch: { asin?: string; title?: string; image_url?: string }) => {
        const cur = byFnsku.get(fnsku) || {};
        byFnsku.set(fnsku, {
          asin: cur.asin || (patch.asin || undefined),
          title: cur.title || (patch.title || undefined),
          image_url: cur.image_url || (patch.image_url || undefined),
        });
      };
      const mergeAsin = (asin: string, patch: { title?: string; image_url?: string }) => {
        const cur = byAsin.get(asin) || {};
        byAsin.set(asin, {
          title: cur.title || (patch.title || undefined),
          image_url: cur.image_url || (patch.image_url || undefined),
        });
      };

      // 1) Inventory by SKU
      if (skus.length > 0) {
        const { data } = await supabase
          .from("inventory")
          .select("sku, fnsku, asin, title, image_url")
          .eq("user_id", user.id)
          .in("sku", skus);
        for (const r of (data || []) as any[]) {
          if (r.sku) mergeSku(r.sku, { asin: r.asin, title: r.title, image_url: r.image_url });
          if (r.fnsku) mergeFnsku(r.fnsku, { asin: r.asin, title: r.title, image_url: r.image_url });
          if (r.asin) mergeAsin(r.asin, { title: r.title, image_url: r.image_url });
        }
      }

      // 2) Inventory by FNSKU (catches items where SKU differs from inventory)
      if (fnskus.length > 0) {
        const { data } = await supabase
          .from("inventory")
          .select("sku, fnsku, asin, title, image_url")
          .eq("user_id", user.id)
          .in("fnsku", fnskus);
        for (const r of (data || []) as any[]) {
          if (r.fnsku) mergeFnsku(r.fnsku, { asin: r.asin, title: r.title, image_url: r.image_url });
          if (r.sku) mergeSku(r.sku, { asin: r.asin, title: r.title, image_url: r.image_url });
          if (r.asin) mergeAsin(r.asin, { title: r.title, image_url: r.image_url });
        }
      }

      // 3) created_listings by SKU and FNSKU
      if (skus.length > 0) {
        const { data } = await supabase
          .from("created_listings")
          .select("sku, fnsku, asin, title, image_url")
          .eq("user_id", user.id)
          .in("sku", skus);
        for (const r of (data || []) as any[]) {
          if (r.sku) mergeSku(r.sku, { asin: r.asin, title: r.title, image_url: r.image_url });
          if (r.fnsku) mergeFnsku(r.fnsku, { asin: r.asin, title: r.title, image_url: r.image_url });
          if (r.asin) mergeAsin(r.asin, { title: r.title, image_url: r.image_url });
        }
      }
      if (fnskus.length > 0) {
        const { data } = await supabase
          .from("created_listings")
          .select("sku, fnsku, asin, title, image_url")
          .eq("user_id", user.id)
          .in("fnsku", fnskus);
        for (const r of (data || []) as any[]) {
          if (r.fnsku) mergeFnsku(r.fnsku, { asin: r.asin, title: r.title, image_url: r.image_url });
          if (r.sku) mergeSku(r.sku, { asin: r.asin, title: r.title, image_url: r.image_url });
          if (r.asin) mergeAsin(r.asin, { title: r.title, image_url: r.image_url });
        }
      }

      // 4) fnsku_map for any FNSKU still missing an ASIN
      const fnskusNeedingAsin = fnskus.filter(f => !(byFnsku.get(f)?.asin));
      if (fnskusNeedingAsin.length > 0) {
        const { data } = await supabase
          .from("fnsku_map")
          .select("fnsku, asin")
          .in("fnsku", fnskusNeedingAsin);
        for (const r of (data || []) as any[]) {
          if (r.fnsku && r.asin) mergeFnsku(r.fnsku, { asin: r.asin });
        }
      }

      // Resolve each item's effective ASIN now (from item, sku map, or fnsku map)
      const resolveAsin = (it: ShipmentItem): string => {
        const direct = (it.asin || "").trim();
        if (direct) return direct;
        const viaSku = bySku.get((it.seller_sku || "").trim())?.asin;
        if (viaSku) return viaSku;
        const viaFnsku = byFnsku.get((it.fnsku || "").trim())?.asin;
        return viaFnsku || "";
      };

      // 5) inventory by resolved ASIN to fill title/image gaps
      const allAsins = Array.from(new Set([
        ...initialAsins,
        ...missing.map(resolveAsin).filter(Boolean),
      ]));
      const asinsNeedingMore = allAsins.filter(a => {
        const ent = byAsin.get(a);
        return !ent || !ent.image_url || !ent.title;
      });
      if (asinsNeedingMore.length > 0) {
        const { data } = await supabase
          .from("inventory")
          .select("asin, title, image_url")
          .eq("user_id", user.id)
          .in("asin", asinsNeedingMore);
        for (const r of (data || []) as any[]) {
          if (r.asin) mergeAsin(r.asin, { title: r.title, image_url: r.image_url });
        }
      }

      // 6) SP-API fallback for any ASIN still missing image/title (capped)
      const fallbackAsins = Array.from(new Set(
        missing
          .map(resolveAsin)
          .filter(a => /^[A-Z0-9]{10}$/.test(a))
          .filter(a => {
            const ent = byAsin.get(a);
            return !ent || !ent.image_url || !ent.title;
          })
      )).slice(0, 25);
      for (const asin of fallbackAsins) {
        try {
          const { data, error } = await supabase.functions.invoke("import-asin-from-seller-central", { body: { asin } });
          if (!error && data) {
            const d = data as any;
            mergeAsin(asin, { title: d.title || d.product_name, image_url: d.image_url });
          }
        } catch (err) {
          console.warn("[tracker-sync-details] SP-API lookup failed for", asin, err);
        }
      }

      // Build enriched items + persist updates
      const updates: Array<{ id: string; patch: { asin?: string; title?: string; image_url?: string } }> = [];
      const enriched = items.map(it => {
        if (!isMissing(it)) return it;
        const sku = (it.seller_sku || "").trim();
        const fnsku = (it.fnsku || "").trim();
        const skuEnt = bySku.get(sku) || {};
        const fnskuEnt = byFnsku.get(fnsku) || {};
        const finalAsin = (it.asin && it.asin.trim()) || skuEnt.asin || fnskuEnt.asin || "";
        const asinEnt = finalAsin ? (byAsin.get(finalAsin) || {}) : {};
        const finalTitle = (it.title && it.title.trim()) || asinEnt.title || skuEnt.title || fnskuEnt.title || "";
        const finalImage = (it.image_url && it.image_url.trim()) || asinEnt.image_url || skuEnt.image_url || fnskuEnt.image_url || "";

        const patch: { asin?: string; title?: string; image_url?: string } = {};
        if (!it.asin && finalAsin) patch.asin = finalAsin;
        if (!it.title && finalTitle) patch.title = finalTitle;
        if (!it.image_url && finalImage) patch.image_url = finalImage;
        if (Object.keys(patch).length === 0) return it;
        updates.push({ id: it.id, patch });
        return {
          ...it,
          asin: patch.asin ?? it.asin,
          title: patch.title ?? it.title,
          image_url: patch.image_url ?? it.image_url,
        };
      });

      if (updates.length === 0) return;
      setShipmentItems(prev => ({ ...prev, [shipmentId]: enriched }));
      for (const u of updates) {
        await supabase
          .from("fba_shipment_items")
          .update(u.patch)
          .eq("id", u.id)
          .eq("user_id", user.id);
      }
    } catch (err) {
      console.warn("[tracker-sync-details] hydration failed", err);
    }
  };

  const hydrateShipmentItemsFromDraft = async (shipment: Shipment): Promise<ShipmentItem[]> => {
    const shipmentFc = (shipment.destination_fulfillment_center_id || "").trim().toUpperCase();
    const shipmentName = (shipment.shipment_name || "").trim();
    const { data: drafts, error } = await supabase
      .from("shipment_builder_drafts")
      .select("payload, shipment_name, amazon_shipment_id, updated_at")
      .eq("user_id", user?.id)
      .order("updated_at", { ascending: false })
      .limit(100);

    if (error) {
      console.warn("[ShipmentTracking] draft fallback failed:", error);
      return [];
    }

    const matchedDraft = (drafts || []).find((row: any) => {
      const payload = row?.payload || {};
      const ids = [row?.amazon_shipment_id, payload?.shipmentId, ...(Array.isArray(payload?.shipmentIds) ? payload.shipmentIds : [])]
        .filter(Boolean)
        .map((id: string) => String(id).toUpperCase());
      if (ids.includes(shipment.shipment_id.toUpperCase())) return true;
      const draftName = String(row?.shipment_name || payload?.shipmentName || "").trim();
      if (shipmentName && draftName && (shipmentName.includes(draftName) || draftName.includes(shipmentName))) return true;
      if (shipmentFc && Array.isArray(payload?.boxQuantities) === false) {
        return shipmentName.includes(`-${shipmentFc}`) && String(row?.updated_at || "").slice(0, 10) === shipment.updated_at.slice(0, 10);
      }
      return false;
    });

    const payloadItems = Array.isArray((matchedDraft as any)?.payload?.items) ? (matchedDraft as any).payload.items : [];
    if (payloadItems.length === 0) return [];

    const rows = payloadItems
      .map((item: any) => ({
        user_id: user?.id,
        shipment_id: shipment.shipment_id,
        seller_sku: item?.sku || item?.seller_sku || item?.msku,
        fnsku: item?.fnsku || null,
        asin: item?.asin || null,
        title: item?.title || null,
        image_url: item?.imageUrl || item?.image_url || null,
        quantity_shipped: Math.max(0, Math.floor(Number(item?.qtyToShip || item?.quantity || 0))),
        quantity_received: 0,
        quantity_in_case: 0,
      }))
      .filter((row: any) => row.seller_sku && row.quantity_shipped > 0);

    if (rows.length === 0) return [];
    const { data: saved, error: saveError } = await supabase
      .from("fba_shipment_items")
      .upsert(rows as any, { onConflict: "user_id,shipment_id,seller_sku" })
      .select("*");
    if (saveError) throw saveError;
    return (saved || []) as ShipmentItem[];
  };

  const syncShipments = async () => {
    try {
      setSyncing(true);
      toast.info("Syncing shipments from Amazon...");

      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        toast.error("Please log in first");
        return;
      }

      const response = await supabase.functions.invoke("sync-fba-shipments", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });

      if (response.error) throw new Error(response.error.message);

      toast.success(`Synced ${response.data.shipmentCount} shipments`);
      await fetchShipments();
      setShipmentItems({}); // Clear cached items to refresh
    } catch (error: any) {
      console.error("Error syncing shipments:", error);
      toast.error(error.message || "Failed to sync shipments");
    } finally {
      setSyncing(false);
    }
  };

  const syncMissingShipments = async () => {
    try {
      setSyncingMissing(true);
      toast.info("Scanning Amazon for shipments updated in the last 18 months (this may take a minute)...");

      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        toast.error("Please log in first");
        return;
      }

      // Capture existing IDs to compute new vs updated
      const beforeIds = new Set(shipments.map(s => s.shipment_id));

      const response = await supabase.functions.invoke("sync-fba-shipments", {
        headers: { Authorization: `Bearer ${session.access_token}` },
        body: { lookbackDays: 540, headersOnly: true },
      });

      if (response.error) throw new Error(response.error.message);

      const found = response.data?.shipmentsFound ?? response.data?.shipmentCount ?? 0;

      // Refresh and diff
      const { data: refreshed } = await supabase
        .from("fba_shipments")
        .select("*")
        .eq("user_id", user?.id)
        .order("updated_at", { ascending: false });

      const newRows = (refreshed || []).filter(r => !beforeIds.has(r.shipment_id));
      const updatedRows = found - newRows.length;

      setShipments(refreshed || []);
      setShipmentItems({});

      toast.success(
        `Found ${found} shipments • ${newRows.length} new, ${Math.max(updatedRows, 0)} updated. Run regular Sync to load item details.`
      );
    } catch (error: any) {
      console.error("Error syncing missing shipments:", error);
      toast.error(error.message || "Failed to sync missing shipments");
    } finally {
      setSyncingMissing(false);
    }
  };

  const addShipmentsById = async () => {
    const ids = missingIdsInput
      .split(/[\s,;\n]+/)
      .map(s => s.trim().toUpperCase())
      .filter(s => s.startsWith("FBA"));

    if (ids.length === 0) {
      toast.error("Enter one or more FBA shipment IDs (e.g. FBA19CBDJV9W)");
      return;
    }

    try {
      setAddingById(true);
      toast.info(`Fetching ${ids.length} shipment${ids.length > 1 ? "s" : ""} from Amazon...`);

      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        toast.error("Please log in first");
        return;
      }

      let success = 0;
      let failed = 0;
      for (const id of ids) {
        try {
          const response = await supabase.functions.invoke("sync-fba-shipments", {
            headers: { Authorization: `Bearer ${session.access_token}` },
            body: { shipmentId: id },
          });
          if (response.error) throw new Error(response.error.message);
          success++;
        } catch (err: any) {
          console.error(`Failed to add ${id}:`, err);
          failed++;
        }
      }

      if (success > 0) toast.success(`Added ${success} shipment${success > 1 ? "s" : ""}`);
      if (failed > 0) toast.error(`Failed to add ${failed} shipment${failed > 1 ? "s" : ""}`);

      setMissingIdsInput("");
      await fetchShipments();
      setShipmentItems({});
    } catch (error: any) {
      console.error("Error adding shipments by ID:", error);
      toast.error(error.message || "Failed to add shipments");
    } finally {
      setAddingById(false);
    }
  };

  const handleAccordionChange = (values: string[]) => {
    const newlyOpened = values.filter(v => !expandedShipments.includes(v));
    console.log("[ShipmentTracking] accordion change", { values, prev: expandedShipments, newlyOpened });
    setExpandedShipments(values);
    newlyOpened.forEach(async (shipmentId) => {
      const shipment = shipments.find(s => s.shipment_id === shipmentId);
      if (!shipment) return;
      if (shipmentItems[shipmentId]) return;
      setLoadingShipmentIds(prev => new Set([...prev, shipmentId]));
      try {
        // 1) Try DB first
        const { data: dbItems, error: dbErr } = await withTimeout(
          supabase
            .from("fba_shipment_items")
            .select("*")
            .eq("shipment_id", shipmentId)
            .eq("user_id", user?.id),
          8000
        );
        if (dbErr) throw dbErr;
        console.log("[ShipmentTracking] DB items:", shipmentId, dbItems?.length ?? 0);
        if (dbItems && dbItems.length > 0) {
          setShipmentItems(prev => ({ ...prev, [shipmentId]: dbItems }));
          const progress = progressFromItems(dbItems as ShipmentItem[]);
          if (progress) setShipmentProgress(prev => ({ ...prev, [shipmentId]: progress }));
          return;
        }

        // 2) Show local draft/listing data immediately, then refresh Amazon in the background.
        const draftItems = await withTimeout(hydrateShipmentItemsFromDraft(shipment), 8000);
        setShipmentItems(prev => ({ ...prev, [shipmentId]: draftItems }));
        const draftProgress = progressFromItems(draftItems as ShipmentItem[]);
        if (draftProgress) setShipmentProgress(prev => ({ ...prev, [shipmentId]: draftProgress }));
        setLoadingShipmentIds(prev => {
          const next = new Set(prev);
          next.delete(shipmentId);
          return next;
        });

        invokeEdgeFunction<{ itemsCount?: number }>({
            functionName: "sync-fba-shipments",
            body: { shipmentId },
            maxRetries: 0,
            context: { shipmentId },
          })
          .then(async (response) => {
          console.log("[ShipmentTracking] sync-fba-shipments response:", response);
            if (!response.ok) return;
          const { data: refreshed } = await supabase
            .from("fba_shipment_items")
            .select("*")
            .eq("shipment_id", shipmentId)
            .eq("user_id", user?.id);
            if (refreshed && refreshed.length > 0) {
              setShipmentItems(prev => ({ ...prev, [shipmentId]: refreshed as ShipmentItem[] }));
              const progress = progressFromItems(refreshed as ShipmentItem[]);
              if (progress) setShipmentProgress(prev => ({ ...prev, [shipmentId]: progress }));
          }
          })
          .catch((err) => console.warn("[ShipmentTracking] background Amazon refresh failed:", err));
      } catch (err: any) {
        console.error("[ShipmentTracking] fetch failed:", err);
        toast.error(err.message || "Failed to load items");
        setShipmentItems(prev => ({ ...prev, [shipmentId]: [] }));
      } finally {
        setLoadingShipmentIds(prev => {
          const next = new Set(prev);
          next.delete(shipmentId);
          return next;
        });
      }
    });
  };

  const cleanDeadListings = async () => {
    setCleaning(true);
    try {
      const { data, error } = await supabase.rpc("admin_clean_dead_inventory");
      if (error) throw error;
      const count = Array.isArray(data) && data[0]?.deleted_count ? Number(data[0].deleted_count) : 0;
      toast.success(`Cleaned ${count} dead listing${count === 1 ? "" : "s"}`);
    } catch (e: any) {
      toast.error(e.message ?? "Cleanup failed");
    } finally {
      setCleaning(false);
    }
  };


  const dateCutoff = (() => {
    const now = Date.now();
    switch (dateFilter) {
      case "24H": return now - 24 * 60 * 60 * 1000;
      case "7D": return now - 7 * 24 * 60 * 60 * 1000;
      case "30D": return now - 30 * 24 * 60 * 60 * 1000;
      case "90D": return now - 90 * 24 * 60 * 60 * 1000;
      case "6M": return now - 180 * 24 * 60 * 60 * 1000;
      case "12M": return now - 365 * 24 * 60 * 60 * 1000;
      case "18M": return now - 540 * 24 * 60 * 60 * 1000;
      default: return null;
    }
  })();

  const trimmedQuery = searchQuery.trim();
  const upperQuery = trimmedQuery.toUpperCase();
  const looksLikeAsin = /^B0[A-Z0-9]{8}$/.test(upperQuery);
  const looksLikeShipmentId = /^FBA[A-Z0-9]{8,}$/.test(upperQuery);

  // Shipment-ID auto-lookup: if user types an FBA ID we don't have locally, fetch it from Amazon directly
  const [autoFetchingId, setAutoFetchingId] = useState<string | null>(null);
  const [autoFetchedIds, setAutoFetchedIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!user || !looksLikeShipmentId) return;
    if (autoFetchedIds.has(upperQuery)) return;
    if (autoFetchingId === upperQuery) return;
    // Already in local DB → no fetch needed
    if (shipments.some(s => (s.shipment_id || "").toUpperCase() === upperQuery)) return;

    let cancelled = false;
    const t = setTimeout(async () => {
      if (cancelled) return;
      setAutoFetchingId(upperQuery);
      toast.info(`Searching Amazon for ${upperQuery}...`);
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) return;
        const response = await supabase.functions.invoke("sync-fba-shipments", {
          headers: { Authorization: `Bearer ${session.access_token}` },
          body: { shipmentId: upperQuery },
        });
        if (cancelled) return;
        if (response.error) throw new Error(response.error.message);
        toast.success(`Found ${upperQuery} — added to your shipments`);
        setAutoFetchedIds(prev => new Set([...prev, upperQuery]));
        await fetchShipments();
      } catch (err: any) {
        if (!cancelled) {
          console.error(`Auto-fetch failed for ${upperQuery}:`, err);
          toast.error(`Could not find ${upperQuery} on Amazon`);
          setAutoFetchedIds(prev => new Set([...prev, upperQuery]));
        }
      } finally {
        if (!cancelled) setAutoFetchingId(null);
      }
    }, 700);

    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upperQuery, looksLikeShipmentId, user?.id, shipments.length]);

  // ASIN lookup: when query looks like an ASIN, find matching shipment IDs from items
  useEffect(() => {
    if (!user) return;
    if (!looksLikeAsin) {
      setAsinMatchedShipmentIds(null);
      return;
    }
    let cancelled = false;
    (async () => {
      setSearchingAsin(true);
      try {
        // 1) Direct ASIN match on items
        const { data: directRows, error: directErr } = await supabase
          .from("fba_shipment_items")
          .select("shipment_id")
          .eq("user_id", user.id)
          .eq("asin", upperQuery)
          .limit(2000);
        if (directErr) throw directErr;

        // 2) Resolve SKU/FNSKU candidates from inventory for this ASIN (items often have NULL asin)
        const { data: invRows } = await supabase
          .from("inventory")
          .select("sku, fnsku")
          .eq("user_id", user.id)
          .eq("asin", upperQuery)
          .limit(500);

        const skus = Array.from(new Set((invRows || []).map((r: any) => r.sku).filter(Boolean)));
        const fnskus = Array.from(new Set((invRows || []).map((r: any) => r.fnsku).filter(Boolean)));

        // Only match by SKU/FNSKU when the item's ASIN is NULL or equals our target.
        // This prevents false positives when a SKU/FNSKU was historically reused
        // for a different ASIN.
        let skuRows: any[] = [];
        let fnskuRows: any[] = [];
        if (skus.length > 0) {
          const { data } = await supabase
            .from("fba_shipment_items")
            .select("shipment_id, asin")
            .eq("user_id", user.id)
            .in("seller_sku", skus)
            .or(`asin.is.null,asin.eq.${upperQuery}`)
            .limit(2000);
          skuRows = data || [];
        }
        if (fnskus.length > 0) {
          const { data } = await supabase
            .from("fba_shipment_items")
            .select("shipment_id, asin")
            .eq("user_id", user.id)
            .in("fnsku", fnskus)
            .or(`asin.is.null,asin.eq.${upperQuery}`)
            .limit(2000);
          fnskuRows = data || [];
        }

        if (cancelled) return;
        const ids = new Set<string>([
          ...(directRows || []).map((r: any) => r.shipment_id),
          ...skuRows.map((r: any) => r.shipment_id),
          ...fnskuRows.map((r: any) => r.shipment_id),
        ]);
        setAsinMatchedShipmentIds(ids);
        const idArr = Array.from(ids);
        if (idArr.length > 0) {
          setExpandedShipments(prev => Array.from(new Set([...prev, ...idArr])));
          idArr.forEach(id => fetchShipmentItems(id));
        }
      } catch (e: any) {
        console.error("ASIN search failed:", e);
        toast.error("ASIN search failed");
      } finally {
        if (!cancelled) setSearchingAsin(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upperQuery, looksLikeAsin, user?.id]);

  // Dedicated ASIN Finder: searches fba_shipment_items for an ASIN and returns
  // a flat list of matching item rows across all shipments.
  const runAsinFinder = async () => {
    if (!user) return;
    const q = asinFinderQuery.trim().toUpperCase();
    if (!/^B0[A-Z0-9]{8}$/.test(q)) {
      toast.error("Enter a valid ASIN (e.g. B0XXXXXXXX)");
      return;
    }
    setAsinFinderLoading(true);
    setAsinFinderResults(null);
    try {
      const { data: directRows, error: directErr } = await supabase
        .from("fba_shipment_items")
        .select("shipment_id, seller_sku, fnsku, asin, quantity_shipped, quantity_received")
        .eq("user_id", user.id)
        .eq("asin", q)
        .limit(5000);
      if (directErr) throw directErr;

      const { data: invRows } = await supabase
        .from("inventory")
        .select("sku, fnsku")
        .eq("user_id", user.id)
        .eq("asin", q)
        .limit(500);
      const skus = Array.from(new Set((invRows || []).map((r: any) => r.sku).filter(Boolean)));
      const fnskus = Array.from(new Set((invRows || []).map((r: any) => r.fnsku).filter(Boolean)));

      let extra: any[] = [];
      if (skus.length > 0) {
        const { data } = await supabase
          .from("fba_shipment_items")
          .select("shipment_id, seller_sku, fnsku, asin, quantity_shipped, quantity_received")
          .eq("user_id", user.id)
          .in("seller_sku", skus)
          .or(`asin.is.null,asin.eq.${q}`)
          .limit(5000);
        extra = extra.concat(data || []);
      }
      if (fnskus.length > 0) {
        const { data } = await supabase
          .from("fba_shipment_items")
          .select("shipment_id, seller_sku, fnsku, asin, quantity_shipped, quantity_received")
          .eq("user_id", user.id)
          .in("fnsku", fnskus)
          .or(`asin.is.null,asin.eq.${q}`)
          .limit(5000);
        extra = extra.concat(data || []);
      }

      const seen = new Set<string>();
      const merged: any[] = [];
      for (const r of [...(directRows || []), ...extra]) {
        const key = `${r.shipment_id}|${r.seller_sku || ""}|${r.fnsku || ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(r);
      }

      const shipMap = new Map(shipments.map(s => [s.shipment_id, s]));
      const missing = merged.map(m => m.shipment_id).filter(id => !shipMap.has(id));
      let extraShipments: any[] = [];
      if (missing.length > 0) {
        const { data } = await supabase
          .from("fba_shipments")
          .select("shipment_id, shipment_name, shipment_status")
          .eq("user_id", user.id)
          .in("shipment_id", Array.from(new Set(missing)));
        extraShipments = data || [];
      }
      const extraMap = new Map(extraShipments.map(s => [s.shipment_id, s]));

      const results = merged.map(r => {
        const sh: any = shipMap.get(r.shipment_id) || extraMap.get(r.shipment_id) || {};
        return {
          shipment_id: r.shipment_id,
          shipment_name: sh.shipment_name ?? null,
          shipment_status: sh.shipment_status ?? null,
          seller_sku: r.seller_sku ?? null,
          fnsku: r.fnsku ?? null,
          asin: r.asin ?? null,
          quantity_shipped: Number(r.quantity_shipped || 0),
          quantity_received: Number(r.quantity_received || 0),
        };
      });

      setAsinFinderResults(results);
      if (results.length === 0) toast.info(`No shipment items found for ${q}`);
    } catch (e: any) {
      console.error("ASIN finder failed:", e);
      toast.error("ASIN finder failed");
    } finally {
      setAsinFinderLoading(false);
    }
  };

  const getShipmentProgress = (shipmentId: string) => {
    // Prefer the pre-loaded totals (stable for the whole session) so the badge
    // computed by getDisplayStatus does NOT change when the user expands a row
    // and items load. Only fall back to live items when no preload exists.
    const preloaded = shipmentProgress[shipmentId];
    if (preloaded) return preloaded;
    const items = shipmentItems[shipmentId];
    if (items && items.length > 0) return progressFromItems(items);
    return null;
  };

  const getShipmentDeviationPct = (shipmentId: string): number | null => {
    const prog = getShipmentProgress(shipmentId);
    if (!prog || prog.estimated || prog.shipped <= 0) return null;
    return Math.max(0, Math.min(100, 100 - prog.pct));
  };

  // Display badge: if Amazon marks a shipment CLOSED but units are still
  // pending receipt, show it as SHIPPED to reflect real-world state.
  // Computed from pre-loaded totals so the badge is correct on first render
  // (before the user expands the row) and never flips on expand.
  const getDisplayStatus = (shipment: Shipment): string => {
    const raw = (shipment.shipment_status || "").toUpperCase();
    if (raw === "CLOSED") {
      const progress = getShipmentProgress(shipment.shipment_id);
      if (progress && progress.received < progress.shipped) return "SHIPPED";
    }
    return raw || "UNKNOWN";
  };

  const filteredShipments = shipments
    .filter(s => {
      // Filter by display status so a CLOSED-but-still-shipping row appears
      // under SHIPPED (its real state) and does not show under CLOSED.
      // Display status is derived from pre-loaded totals so it doesn't change
      // on expand → row stays in the filtered list and won't collapse.
      if (statusFilter !== "ALL" && getDisplayStatus(s) !== statusFilter) return false;
      if (dateCutoff !== null && new Date(s.created_at).getTime() < dateCutoff) return false;
      if (trimmedQuery) {
        if (looksLikeAsin) {
          if (!asinMatchedShipmentIds || !asinMatchedShipmentIds.has(s.shipment_id)) return false;
        } else {
          const q = upperQuery;
          const idMatch = (s.shipment_id || "").toUpperCase().includes(q);
          const nameMatch = (s.shipment_name || "").toUpperCase().includes(q);
          if (!idMatch && !nameMatch) return false;
        }
      }
      return true;
    })
    .sort((a, b) => {
      const field = sortBy === "created" ? "created_at" : "updated_at";
      const aTs = a[field] ? new Date(a[field]).getTime() : 0;
      const bTs = b[field] ? new Date(b[field]).getTime() : 0;
      return bTs - aTs;
    });

  const totalShipped = Object.values(shipmentProgress).reduce((sum, p) => sum + (p?.shipped || 0), 0);
  const totalReceived = Object.values(shipmentProgress).reduce((sum, p) => sum + (p?.received || 0), 0);
  const closedShipments = shipments.filter(s => getDisplayStatus(s) === "CLOSED").length;

  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      <div className="container mx-auto px-4 py-8 pt-24">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-6">
          <div>
            <h1 className="text-3xl font-bold text-foreground">Shipment Tracking</h1>
            <p className="text-muted-foreground mt-1">Track your FBA inbound shipments and quantity deviations</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={() => navigate("/tools/shipment-accounting")}>
              <DollarSign className="h-4 w-4 mr-2" />
              Accounting
            </Button>
            {isAdmin && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="outline" disabled={cleaning}>
                    <Trash2 className={`h-4 w-4 mr-2 ${cleaning ? "animate-pulse" : ""}`} />
                    {cleaning ? "Cleaning…" : "Clean Dead Listings"}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Hard-delete dead inventory rows?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This permanently removes inventory rows where stock is fully zero
                      (available + reserved + inbound) AND the listing status is terminal
                      (NOT_IN_CATALOG, DELETED, INACTIVE).
                      <br /><br />
                      <strong>Shipment history is preserved.</strong> This will not touch
                      fba_shipments, fba_shipment_items, or fba_inbound_fees.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={cleanDeadListings}>Delete dead rows</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
            <Button onClick={syncMissingShipments} disabled={syncingMissing} variant="outline">
              <Package className={`h-4 w-4 mr-2 ${syncingMissing ? "animate-pulse" : ""}`} />
              {syncingMissing ? "Scanning..." : "Sync Missing (18mo)"}
            </Button>
            <Button onClick={syncShipments} disabled={syncing}>
              <RefreshCw className={`h-4 w-4 mr-2 ${syncing ? "animate-spin" : ""}`} />
              {syncing ? "Syncing..." : "Sync Shipments"}
            </Button>
          </div>
        </div>

        {/* Add missing shipments by ID */}
        <div className="flex flex-col sm:flex-row gap-2 mb-6 p-3 rounded-md border bg-muted/30">
          <div className="flex-1">
            <Input
              placeholder="Paste missing FBA IDs (e.g. FBA19CBDJV9W, FBA19CB9B39M)"
              value={missingIdsInput}
              onChange={(e) => setMissingIdsInput(e.target.value)}
              disabled={addingById}
            />
            <p className="text-xs text-muted-foreground mt-1">
              Use this when bulk Sync misses a shipment. Separate IDs with commas, spaces, or new lines.
            </p>
          </div>
          <Button onClick={addShipmentsById} disabled={addingById || !missingIdsInput.trim()}>
            {addingById ? "Adding..." : "Add by ID"}
          </Button>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Actually Closed</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{closedShipments}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Units Shipped</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{totalShipped.toLocaleString()}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Units Received</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-500">{totalReceived.toLocaleString()}</div>
            </CardContent>
          </Card>
        </div>


        {/* Search */}
        <div className="flex items-center gap-2 mb-3">
          <Input
            placeholder="Search by Shipment ID, name, or ASIN (e.g. B0XXXXXXXX)"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="max-w-xl"
          />
          {searchQuery && (
            <Button variant="ghost" size="sm" onClick={() => setSearchQuery("")}>Clear</Button>
          )}
          {looksLikeAsin && (
            <span className="text-xs text-muted-foreground">
              {searchingAsin
                ? "Searching ASIN…"
                : asinMatchedShipmentIds
                  ? `${asinMatchedShipmentIds.size} shipment(s) contain this ASIN`
                  : ""}
            </span>
          )}
        </div>

        {/* Dedicated ASIN Finder */}
        <Card className="mb-4">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">ASIN Finder</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <Input
                placeholder="Find any ASIN across all shipments (e.g. B0GGMLFGPG)"
                value={asinFinderQuery}
                onChange={(e) => setAsinFinderQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") runAsinFinder(); }}
                className="max-w-xl"
              />
              <Button onClick={runAsinFinder} disabled={asinFinderLoading}>
                {asinFinderLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Find"}
              </Button>
              {asinFinderResults && (
                <Button variant="ghost" size="sm" onClick={() => { setAsinFinderResults(null); setAsinFinderQuery(""); }}>
                  Clear
                </Button>
              )}
            </div>
            {asinFinderResults && (
              <div className="mt-3">
                {asinFinderResults.length > 0 && (() => {
                  const totalShipped = asinFinderResults.reduce((s, r) => s + (Number(r.quantity_shipped) || 0), 0);
                  const totalReceived = asinFinderResults.reduce((s, r) => s + (Number(r.quantity_received) || 0), 0);
                  const shipmentCount = new Set(asinFinderResults.map(r => r.shipment_id)).size;
                  const inTransit = Math.max(0, totalShipped - totalReceived);
                  return (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                      <div className="rounded-lg border bg-gradient-to-br from-primary/10 to-primary/5 p-3">
                        <div className="text-xs uppercase tracking-wide text-muted-foreground">Total Shipped</div>
                        <div className="text-2xl font-bold tabular-nums text-primary">{totalShipped.toLocaleString()}</div>
                        <div className="text-[11px] text-muted-foreground mt-0.5">units across all shipments</div>
                      </div>
                      <div className="rounded-lg border bg-gradient-to-br from-emerald-500/10 to-emerald-500/5 p-3">
                        <div className="text-xs uppercase tracking-wide text-muted-foreground">Total Received</div>
                        <div className="text-2xl font-bold tabular-nums text-emerald-600 dark:text-emerald-400">{totalReceived.toLocaleString()}</div>
                        <div className="text-[11px] text-muted-foreground mt-0.5">units checked-in by Amazon</div>
                      </div>
                      <div className="rounded-lg border bg-gradient-to-br from-amber-500/10 to-amber-500/5 p-3">
                        <div className="text-xs uppercase tracking-wide text-muted-foreground">In Transit / Pending</div>
                        <div className="text-2xl font-bold tabular-nums text-amber-600 dark:text-amber-500">{inTransit.toLocaleString()}</div>
                        <div className="text-[11px] text-muted-foreground mt-0.5">shipped − received</div>
                      </div>
                      <div className="rounded-lg border bg-muted/40 p-3">
                        <div className="text-xs uppercase tracking-wide text-muted-foreground">Shipments</div>
                        <div className="text-2xl font-bold tabular-nums">{shipmentCount.toLocaleString()}</div>
                        <div className="text-[11px] text-muted-foreground mt-0.5">{asinFinderResults.length} row(s) total</div>
                      </div>
                    </div>
                  );
                })()}
                <div className="text-sm text-muted-foreground mb-2">
                  Found {asinFinderResults.length} item row(s) across {new Set(asinFinderResults.map(r => r.shipment_id)).size} shipment(s).
                </div>
                {asinFinderResults.length > 0 && (
                  <div className="border rounded max-h-[280px] overflow-y-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Shipment ID</TableHead>
                          <TableHead>Name</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>SKU</TableHead>
                          <TableHead>FNSKU</TableHead>
                          <TableHead>ASIN</TableHead>
                          <TableHead className="text-right">Shipped</TableHead>
                          <TableHead className="text-right">Received</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {asinFinderResults.map((r, i) => (
                          <TableRow key={`${r.shipment_id}-${i}`}>
                            <TableCell className="font-mono text-sm">
                              <div className="flex items-center gap-1.5">
                                <button
                                  className="text-primary hover:underline"
                                  onClick={() => {
                                    setSearchQuery(r.shipment_id);
                                    setExpandedShipments(prev => Array.from(new Set([...prev, r.shipment_id])));
                                    fetchShipmentItems(r.shipment_id);
                                  }}
                                >
                                  {r.shipment_id}
                                </button>
                                <a
                                  href={`https://sellercentral.amazon.com/fba/inbound-shipment/summary/${r.shipment_id}/contents`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-muted-foreground hover:text-primary"
                                  title="Open in Seller Central"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <ExternalLink className="h-3.5 w-3.5" />
                                </a>
                              </div>
                            </TableCell>
                            <TableCell className="max-w-[280px] truncate">{r.shipment_name || "—"}</TableCell>
                            <TableCell>{r.shipment_status || "—"}</TableCell>
                            <TableCell className="font-mono text-xs">{r.seller_sku || "—"}</TableCell>
                            <TableCell className="font-mono text-xs">{r.fnsku || "—"}</TableCell>
                            <TableCell className="font-mono text-xs">{r.asin || "—"}</TableCell>
                            <TableCell className="text-right">{r.quantity_shipped}</TableCell>
                            <TableCell className="text-right">{r.quantity_received}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Status Filter */}
        <div className="flex items-center gap-4 mb-4">
          <span className="text-sm text-muted-foreground">Filter by status:</span>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All Statuses</SelectItem>
              <SelectItem value="WORKING">Working</SelectItem>
              <SelectItem value="SHIPPED">Shipped</SelectItem>
              <SelectItem value="RECEIVING">Receiving</SelectItem>
              <SelectItem value="CLOSED">Closed</SelectItem>
              <SelectItem value="CANCELLED">Cancelled</SelectItem>
              <SelectItem value="ERROR">Error</SelectItem>
            </SelectContent>
          </Select>
          <span className="text-sm text-muted-foreground ml-2">Filter by date:</span>
          <Select value={dateFilter} onValueChange={setDateFilter}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All Time</SelectItem>
              <SelectItem value="24H">Last 24 hours</SelectItem>
              <SelectItem value="7D">Last week</SelectItem>
              <SelectItem value="30D">Last month</SelectItem>
              <SelectItem value="90D">Last 90 days</SelectItem>
              <SelectItem value="6M">Last 6 months</SelectItem>
              <SelectItem value="12M">Last 12 months</SelectItem>
              <SelectItem value="18M">Last 18 months</SelectItem>
            </SelectContent>
          </Select>

          <Select value={sortBy} onValueChange={(v) => setSortBy(v as "updated" | "created")}>
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="updated">Sort: Last Updated</SelectItem>
              <SelectItem value="created">Sort: Last Created</SelectItem>
            </SelectContent>
          </Select>

        </div>

        {/* Shipments List */}
        {loading ? (
          <div className="text-center py-12 text-muted-foreground">Loading shipments...</div>
        ) : filteredShipments.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <Package className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium mb-2">No shipments found</h3>
              <p className="text-muted-foreground mb-4">
                {shipments.length === 0
                  ? "Click 'Sync Shipments' to fetch your FBA inbound shipments from Amazon."
                  : "No shipments match the selected status filter."}
              </p>
            </CardContent>
          </Card>
        ) : (
          <Accordion
            type="multiple"
            value={expandedShipments}
            onValueChange={handleAccordionChange}
            className="space-y-2"
          >
            {filteredShipments.map(shipment => (
              <AccordionItem
                key={shipment.shipment_id}
                value={shipment.shipment_id}
                className="border rounded-lg px-4 bg-card"
              >
                <AccordionTrigger className="hover:no-underline">
                  <div className="flex items-center justify-between w-full pr-4">
                    <div className="flex items-center gap-4">
                      {(() => {
                        const displayStatus = getDisplayStatus(shipment);
                        return (
                          <Badge className={`${statusColors[displayStatus] || "bg-gray-500"} text-white`}>
                            <span className="mr-1">{statusIcons[displayStatus]}</span>
                            {displayStatus || "Unknown"}
                          </Badge>
                        );
                      })()}
                      <div className="text-left">
                        <div className="font-medium flex items-center gap-2">
                          {shipment.shipment_name || shipment.shipment_id}
                          <a
                            href={`https://sellercentral.amazon.com/fba/inbound-shipment/summary/${shipment.shipment_id}/contents`}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            title="Open in Seller Central"
                            className="inline-flex items-center justify-center h-6 w-6 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </a>
                        </div>
                        <div className="text-sm text-muted-foreground">
                          ID: {shipment.shipment_id}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      {(() => {
                        const prog = getShipmentProgress(shipment.shipment_id);
                        if (!prog) return null;
                        const isFull = prog.pct >= 100;
                        const deviationPct = getShipmentDeviationPct(shipment.shipment_id);
                        const barColor = "bg-green-500";
                        const trackColor = "bg-muted";
                        const visibleWidth = isFull ? 100 : Math.max(prog.pct, 3);
                        return (
                          <div className="flex items-center gap-2 min-w-[180px]">
                            <div className={`flex-1 h-2 ${trackColor} rounded-full overflow-hidden`}>
                              <div
                                className={`h-full ${barColor} transition-all`}
                                style={{ width: `${visibleWidth}%` }}
                              />
                            </div>
                            <span className={`text-xs font-semibold tabular-nums ${isFull ? "text-green-600" : "text-muted-foreground"}`}>
                              {prog.estimated ? `${prog.shipped} sent` : `${prog.received}/${prog.shipped} (${prog.pct}%)`}
                            </span>
                            {prog.estimated && (
                              <span className="text-xs text-muted-foreground italic whitespace-nowrap">
                                sync items to see deviation
                              </span>
                            )}
                          </div>
                        );
                      })()}
                      <div className="text-right text-sm text-muted-foreground">
                        <div>FC: {shipment.destination_fulfillment_center_id || "N/A"}</div>
                        <div>Updated: {new Date(shipment.updated_at).toLocaleDateString()}</div>
                      </div>
                    </div>
                  </div>
                </AccordionTrigger>
                <AccordionContent>
                  <div className="pt-4">
                    {loadingShipmentIds.has(shipment.shipment_id) ? (
                      <div className="text-center py-4 text-muted-foreground">
                        Loading items...
                      </div>
                    ) : !shipmentItems[shipment.shipment_id] ? null : shipmentItems[shipment.shipment_id].length === 0 ? null : (() => {
                      // Group items by the FC code embedded in seller_sku.
                      // Pattern: "FBA STA (...)-{FC4}{actual_sku}" where FC4 is the 4-char FC code (e.g. IND9, FWA4, TEB9, FTW1).
                      const items = shipmentItems[shipment.shipment_id];
                      const groups = new Map<string, { fc: string; items: typeof items }>();
                      items.forEach(item => {
                        const sku = item.seller_sku || "";
                        // Find the prefix split: everything up to and including the last ")-"
                        const m = sku.match(/^(.*\)-)([A-Z0-9]{4})(.*)$/);
                        const fc = m ? m[2] : "OTHER";
                        const cleanSku = m ? m[3] : sku;
                        const groupKey = fc;
                        if (!groups.has(groupKey)) groups.set(groupKey, { fc, items: [] });
                        groups.get(groupKey)!.items.push({ ...item, _displaySku: cleanSku } as any);
                      });
                      const groupList = Array.from(groups.values()).sort((a, b) => a.fc.localeCompare(b.fc));

                       return (
                        <div className="w-full space-y-4">
                          {groupList.map(group => {
                            const totalShipped = group.items.reduce((s, i) => s + (i.quantity_shipped || 0), 0);
                            const totalReceived = group.items.reduce((s, i) => s + (i.quantity_received || 0), 0);
                            const groupDeviation = totalReceived - totalShipped;
                            return (
                              <div key={group.fc} className="rounded-md border bg-background/40">
                                <div className="flex items-center justify-between gap-4 px-4 py-3 border-b">
                                  <div className="flex items-center gap-3">
                                    <span className="font-mono font-semibold text-sm bg-muted px-2 py-1 rounded">{group.fc}</span>
                                    <span className="text-sm text-muted-foreground">{group.items.length} item{group.items.length !== 1 ? 's' : ''}</span>
                                  </div>
                                  <div className="flex items-center gap-4 text-sm">
                                    <span>Shipped: <strong>{totalShipped}</strong></span>
                                    <span>Received: <strong>{totalReceived}</strong></span>
                                    {groupDeviation !== 0 && (
                                      <span className={groupDeviation < 0 ? "text-red-500 font-bold" : "text-green-500 font-bold"}>
                                        {groupDeviation > 0 ? `+${groupDeviation}` : groupDeviation}
                                      </span>
                                    )}
                                  </div>
                                </div>
                                <div>
                                  <Table>
                                    <TableHeader>
                                      <TableRow>
                                        <TableHead>Image</TableHead>
                                        <TableHead>ASIN</TableHead>
                                        <TableHead>Title</TableHead>
                                        <TableHead>SKU</TableHead>
                                        <TableHead>FNSKU</TableHead>
                                        <TableHead className="text-right">Shipped</TableHead>
                                        <TableHead className="text-right">Received</TableHead>
                                        <TableHead className="text-right">Deviation</TableHead>
                                      </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                      {group.items.map(item => {
                                        const deviation = item.quantity_received - item.quantity_shipped;
                                        const hasDeviation = item.quantity_shipped > 0 && deviation !== 0;
                                        const displayAsin = item.asin || "";
                                        const displayTitle = item.title || "";
                                        const displayImageUrl = item.image_url || "";
                                        return (
                                          <TableRow key={item.id} className={hasDeviation ? "bg-orange-500/10" : ""}>
                                            <TableCell>
                                              {displayImageUrl ? (
                                                <img src={displayImageUrl} alt="" className="w-12 h-12 min-w-12 min-h-12 object-cover rounded" />
                                              ) : (
                                                <div className="w-12 h-12 bg-muted rounded flex items-center justify-center">
                                                  <Package className="h-5 w-5 text-muted-foreground" />
                                                </div>
                                              )}
                                            </TableCell>
                                            <TableCell className="font-mono text-sm">{displayAsin || "—"}</TableCell>
                                            <TableCell className="max-w-xs truncate">{displayTitle || "—"}</TableCell>
                                            <TableCell className="font-mono text-sm">{(item as any)._displaySku || item.seller_sku}</TableCell>
                                            <TableCell className="font-mono text-sm">{item.fnsku || "—"}</TableCell>
                                            <TableCell className="text-right">{item.quantity_shipped}</TableCell>
                                            <TableCell className="text-right">{item.quantity_received}</TableCell>
                                            <TableCell className={`text-right font-bold ${hasDeviation ? (deviation < 0 ? "text-red-500" : "text-green-500") : ""}`}>
                                              {deviation === 0 ? "—" : deviation > 0 ? `+${deviation}` : deviation}
                                            </TableCell>
                                          </TableRow>
                                        );
                                      })}
                                    </TableBody>
                                  </Table>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      );
                    })()}
                  </div>
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        )}
      </div>
    </div>
  );
}
