import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";
import { Download, Search, RefreshCw, TrendingUp, ShieldAlert, CheckCircle2, XCircle, Minus, Copy } from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";

/* ─── types ─── */
interface CheckRecord {
  id: string;
  asin: string;
  sku: string | null;
  marketplace: string | null;
  actionType: string;
  triggerSource: string;
  oldPrice: number | null;
  newPrice: number | null;
  reason: string | null;
  success: boolean | null;
  errorMessage: string | null;
  errorType: string | null;
  ruleName: string | null;
  overlayTag: string | null;
  createdAt: string;
  updateMethod: string | null;
  // joined from inventory
  title: string | null;
  imageUrl: string | null;
  myPrice: number | null;
  // from snapshot context in reason/intelligence
  floorBreakdown: any;
}

type TimeWindow = "1h" | "4h" | "8h" | "24h" | "1w" | "1m";
type OutcomeFilter = "all" | "changed" | "no_change" | "blocked" | "error" | "raised" | "profit_extract" | "raise_match" | "raise_undercut";
const MKT_FLAGS: Record<string, string> = {
  US: "🇺🇸", CA: "🇨🇦", MX: "🇲🇽", BR: "🇧🇷", UK: "🇬🇧", DE: "🇩🇪", FR: "🇫🇷", IT: "🇮🇹", ES: "🇪🇸",
};
const windowHours: Record<TimeWindow, number> = { "1h": 1, "4h": 4, "8h": 8, "24h": 24, "1w": 168, "1m": 720 };
const ROW_PAGE_SIZE = 1000;
const ROW_FETCH_CAP = 5000; // max rows to download client-side

/* ─── outcome helpers ─── */
function getOutcome(r: CheckRecord): "changed" | "no_change" | "blocked" | "error" {
  if (r.errorMessage || r.errorType || r.actionType === "price_change_failed") return "error";
  if (r.actionType === "price_changed" && r.success) return "changed";
  // True blocks: profit guard, skip, cooldown — real constraints prevented action
  if (r.actionType === "blocked_by_profit_guard" || r.actionType === "skip" || r.actionType === "skipped" || r.actionType === "cooldown") return "blocked";
  // no_change = evaluation ran, nothing to do (already optimal, delta too small, etc.)
  if (r.actionType === "no_change") return "no_change";
  if (r.actionType === "priority_eval") {
    if (r.newPrice != null && r.oldPrice != null && Math.abs(r.newPrice - r.oldPrice) >= 0.01) return "changed";
    return "no_change";
  }
  return "no_change";
}

function outcomeBadge(r: CheckRecord) {
  const o = getOutcome(r);
  switch (o) {
    case "changed": return <Badge className="bg-emerald-600 text-primary-foreground text-[10px]">Changed</Badge>;
    case "no_change": return <Badge variant="secondary" className="text-[10px]">No Change</Badge>;
    case "blocked": return <Badge className="bg-amber-600 text-primary-foreground text-[10px]">Blocked</Badge>;
    case "error": return <Badge variant="destructive" className="text-[10px]">Error</Badge>;
  }
}

function sourceBadge(source: string) {
  const s = source.toLowerCase();
  if (s.includes("manual")) return <Badge variant="outline" className="text-[10px] border-primary text-primary">Manual</Badge>;
  if (s.includes("priority")) return <Badge className="bg-destructive/80 text-destructive-foreground text-[10px]">Priority</Badge>;
  if (s.includes("sweep")) return <Badge variant="outline" className="text-[10px]">Sweep</Badge>;
  return <Badge variant="secondary" className="text-[10px]">{source}</Badge>;
}

/* ─── main component ─── */
interface SummaryCounts {
  total: number;
  changed: number;
  noChange: number;
  blocked: number;
  errors: number;
}

export default function CheckedRecentlyPanel() {
  const { user } = useAuth();
  const [rows, setRows] = useState<CheckRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [timeWindow, setTimeWindow] = useState<TimeWindow>("4h");
  const [searchQuery, setSearchQuery] = useState("");
  const [marketplaceFilter, setMarketplaceFilter] = useState("all");
  const [outcomeFilter, setOutcomeFilter] = useState<OutcomeFilter>("all");
  const [selectedRow, setSelectedRow] = useState<CheckRecord | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [summaryCounts, setSummaryCounts] = useState<SummaryCounts | null>(null);
  const [currentPage, setCurrentPage] = useState(1);

  const normalizedSearch = searchQuery.trim();
  const isExactIdentifierSearch = normalizedSearch.length >= 8 && !normalizedSearch.includes(" ");

  const fetchData = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const hours = windowHours[timeWindow];
      const since = new Date(Date.now() - hours * 3600_000).toISOString();
      const mktActive = marketplaceFilter !== "all";
      const escapedSearch = normalizedSearch.replace(/,/g, "\\,");

      const withMkt = (q: any) => (mktActive ? q.eq("marketplace", marketplaceFilter) : q);
      const withIdentifier = (q: any) => (
        isExactIdentifierSearch ? q.or(`asin.eq.${escapedSearch},sku.eq.${escapedSearch}`) : q
      );
      const rowSelect = "id, asin, sku, marketplace, action_type, trigger_source, old_price, new_price, reason, success, error_message, error_type, rule_name, overlay_tag, created_at, update_method, floor_breakdown_json";

      const totalCountRes = await withIdentifier(
        withMkt(
          supabase
            .from("repricer_price_actions")
            .select("id", { count: "exact", head: true })
            .gte("created_at", since)
            .eq("user_id", user.id)
        )
      );

      const total = totalCountRes.count ?? 0;

      if (total === 0) {
        setSummaryCounts({ total: 0, changed: 0, noChange: 0, blocked: 0, errors: 0 });
        setRows([]);
        return;
      }

      const fetchableRows = isExactIdentifierSearch ? total : Math.min(total, ROW_FETCH_CAP);
      const pageCount = Math.ceil(fetchableRows / ROW_PAGE_SIZE);
      // Fetch pages sequentially to avoid overwhelming the database under pressure
      const actions: any[] = [];
      for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
        const res = await withIdentifier(
          withMkt(
            supabase
              .from("repricer_price_actions")
              .select(rowSelect)
              .gte("created_at", since)
              .eq("user_id", user.id)
          )
        )
          .order("created_at", { ascending: false })
          // created_at is not unique, so it cannot order pages on its own:
          // a tie spanning a page boundary repeats or skips rows. id breaks it.
          .order("id", { ascending: true })
          .range(pageIndex * ROW_PAGE_SIZE, (pageIndex + 1) * ROW_PAGE_SIZE - 1);

        if (res.error) {
          console.error(`[CheckedRecently] Page ${pageIndex} error:`, res.error);
          throw res.error;
        }
        if (res.data?.length) {
          actions.push(...res.data);
        } else {
          console.warn(`[CheckedRecently] Page ${pageIndex} returned empty (total=${total})`);
        }
      }
      if (!actions.length) {
        console.warn(`[CheckedRecently] All pages returned empty despite total=${total}. Possible timeout.`);
        setSummaryCounts({ total, changed: 0, noChange: 0, blocked: 0, errors: 0 });
        setRows([]);
        return;
      }

      let changed = 0;
      let blocked = 0;
      let errors = 0;
      for (const a of actions) {
        if (a.error_message || a.error_type || a.action_type === "price_change_failed") errors++;
        else if (a.action_type === "price_changed" && a.success) changed++;
        else if (["blocked_by_profit_guard", "skip", "skipped", "cooldown"].includes(a.action_type)) blocked++;
      }
      const noChange = Math.max(0, actions.length - changed - blocked - errors);
      setSummaryCounts({
        total,
        changed: fetchableRows === total ? changed : Math.min(changed, total),
        noChange: fetchableRows === total ? noChange : Math.min(noChange, total),
        blocked: fetchableRows === total ? blocked : Math.min(blocked, total),
        errors: fetchableRows === total ? errors : Math.min(errors, total),
      });

      const asins = [...new Set(actions.map((a) => a.asin))] as string[];
      const skus = [...new Set(actions.map((a) => a.sku).filter(Boolean))] as string[];
      const inventoryResponses = await Promise.all([
        asins.length
          ? supabase
              .from("inventory")
              .select("asin, sku, title, image_url, my_price")
              .in("asin", asins)
              .eq("user_id", user.id)
          : Promise.resolve({ data: [] }),
        skus.length
          ? supabase
              .from("inventory")
              .select("asin, sku, title, image_url, my_price")
              .in("sku", skus)
              .eq("user_id", user.id)
          : Promise.resolve({ data: [] }),
      ]);

      const invByAsin = new Map<string, any>();
      const invBySku = new Map<string, any>();
      for (const response of inventoryResponses) {
        for (const i of response.data || []) {
          if (!invByAsin.has(i.asin)) invByAsin.set(i.asin, i);
          if (i.sku && !invBySku.has(i.sku)) invBySku.set(i.sku, i);
        }
      }

      const merged: CheckRecord[] = actions.map((a) => {
        const inv = (a.sku ? invBySku.get(a.sku) : null) || invByAsin.get(a.asin);
        return {
          id: a.id,
          asin: a.asin,
          sku: a.sku,
          marketplace: a.marketplace,
          actionType: a.action_type,
          triggerSource: a.trigger_source,
          oldPrice: a.old_price,
          newPrice: a.new_price,
          reason: a.reason,
          success: a.success,
          errorMessage: a.error_message,
          errorType: a.error_type,
          ruleName: a.rule_name,
          overlayTag: a.overlay_tag,
          createdAt: a.created_at,
          updateMethod: a.update_method,
          title: inv?.title || null,
          imageUrl: inv?.image_url || null,
          myPrice: inv?.my_price ?? a.new_price ?? a.old_price ?? null,
          floorBreakdown: a.floor_breakdown_json,
        };
      });

      setRows(merged);
    } catch (err: any) {
      console.error("CheckedRecently fetch error:", err);
      toast.error("Failed to load recent checks");
    } finally {
      setLoading(false);
    }
  }, [user, timeWindow, marketplaceFilter, normalizedSearch, isExactIdentifierSearch]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    setCurrentPage(1);
  }, [timeWindow, marketplaceFilter, outcomeFilter, searchQuery]);

  /* ─── Realtime subscription for live updates ─── */
  const invCacheRef = useRef(new Map<string, any>());

  useEffect(() => {
    const cache = invCacheRef.current;
    for (const r of rows) {
      if (r.title && !cache.has(r.asin)) {
        cache.set(r.asin, { title: r.title, image_url: r.imageUrl, my_price: r.myPrice });
      }
      if (r.sku && r.title && !cache.has(r.sku)) {
        cache.set(r.sku, { title: r.title, image_url: r.imageUrl, my_price: r.myPrice });
      }
    }
  }, [rows]);

  // Realtime channel scoping: user-scoped. See docs/realtime-channels.md.
  // Previous shared name ("checked-recently-realtime") delivered wake-ups to
  // every subscribed user; RLS filtered payloads correctly but the socket
  // fan-out itself was cross-tenant. Now scoped per user.
  useEffect(() => {
    if (!user) return;

    const channel = supabase
      .channel(`checked-recently-${user.id}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "repricer_price_actions",
          filter: `user_id=eq.${user.id}`,
        },
        async (payload) => {
          const a = payload.new as any;
          if (!a) return;

          const hours = windowHours[timeWindow];
          const since = new Date(Date.now() - hours * 3600_000).toISOString();
          if (a.created_at < since) return;
          if (marketplaceFilter !== "all" && a.marketplace !== marketplaceFilter) return;
          if (isExactIdentifierSearch && a.asin !== normalizedSearch && a.sku !== normalizedSearch) return;

          let inv = invCacheRef.current.get(a.sku || a.asin);
          if (!inv) {
            let invQuery = supabase
              .from("inventory")
              .select("asin, sku, title, image_url, my_price")
              .eq("user_id", user.id);
            if (a.sku) {
              invQuery = invQuery.eq("sku", a.sku);
            } else {
              invQuery = invQuery.eq("asin", a.asin);
            }
            const { data } = await invQuery.limit(1).maybeSingle();
            if (data) {
              inv = data;
              invCacheRef.current.set(a.sku || a.asin, data);
            }
          }

          const newRecord: CheckRecord = {
            id: a.id,
            asin: a.asin,
            sku: a.sku,
            marketplace: a.marketplace,
            actionType: a.action_type,
            triggerSource: a.trigger_source,
            oldPrice: a.old_price,
            newPrice: a.new_price,
            reason: a.reason,
            success: a.success,
            errorMessage: a.error_message,
            errorType: a.error_type,
            ruleName: a.rule_name,
            overlayTag: a.overlay_tag,
            createdAt: a.created_at,
            updateMethod: a.update_method,
            title: inv?.title || null,
            imageUrl: inv?.image_url || null,
            myPrice: inv?.my_price ?? a.new_price ?? a.old_price ?? null,
            floorBreakdown: a.floor_breakdown_json,
          };

          setRows((prev) => [newRecord, ...prev.filter((r) => r.id !== newRecord.id && r.createdAt >= since)]);
        }
      )
      .subscribe();

    // Realtime above keeps rows fresh; this is just a visibility-gated safety net
    // (was 60s → 300s) for missed events / inventory join drift.
    const pollInterval = setInterval(() => {
      if (document.hidden) return;
      fetchData();
    }, 300_000);

    return () => {
      supabase.removeChannel(channel);
      clearInterval(pollInterval);
    };
  }, [user, timeWindow, marketplaceFilter, normalizedSearch, isExactIdentifierSearch, fetchData]);

  /* ─── filtering ─── */
  const filtered = useMemo(() => {
    let result = rows;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter((r) =>
        r.asin.toLowerCase().includes(q) ||
        (r.sku || "").toLowerCase().includes(q) ||
        (r.title || "").toLowerCase().includes(q)
      );
    }
    if (marketplaceFilter !== "all") {
      result = result.filter((r) => r.marketplace === marketplaceFilter);
    }
    if (outcomeFilter === "raised") {
      result = result.filter((r) => {
        const delta = (r.newPrice ?? 0) - (r.oldPrice ?? 0);
        return delta > 0.005 && getOutcome(r) === "changed";
      });
    } else if (outcomeFilter === "profit_extract") {
      result = result.filter((r) => {
        const reason = (r.reason || "").toLowerCase();
        return reason.includes("profit extraction") || reason.includes("profit_extraction") || reason.includes("smart_raise") || reason.includes("profit_max") || reason.includes("snap_raise");
      });
    } else if (outcomeFilter === "raise_match") {
      result = result.filter((r) => (r.reason || "").toLowerCase().includes("raise_offset_match"));
    } else if (outcomeFilter === "raise_undercut") {
      result = result.filter((r) => (r.reason || "").toLowerCase().includes("raise_offset_undercut"));
    } else if (outcomeFilter !== "all") {
      result = result.filter((r) => getOutcome(r) === outcomeFilter);
    }
    return result;
  }, [rows, searchQuery, marketplaceFilter, outcomeFilter]);

  const filteredSummary = useMemo(() => {
    let changed = 0;
    let noChange = 0;
    let blocked = 0;
    let errors = 0;

    for (const r of filtered) {
      const outcome = getOutcome(r);
      if (outcome === "changed") changed++;
      else if (outcome === "no_change") noChange++;
      else if (outcome === "blocked") blocked++;
      else if (outcome === "error") errors++;
    }

    return { total: filtered.length, changed, noChange, blocked, errors };
  }, [filtered]);

  const baseSummary = summaryCounts ?? filteredSummary;
  const hasClientFilters = outcomeFilter !== "all" || (normalizedSearch.length > 0 && !isExactIdentifierSearch);
  const summary = hasClientFilters ? filteredSummary : baseSummary;
  const hasAnyFilters = marketplaceFilter !== "all" || outcomeFilter !== "all" || normalizedSearch.length > 0;
  const emptyStateMessage = loading
    ? "Loading…"
    : hasAnyFilters
      ? "No checks match the current filters"
      : "No checks recorded in this window";

  const DISPLAY_PAGE_SIZE = 250;
  const totalPages = Math.max(1, Math.ceil(filtered.length / DISPLAY_PAGE_SIZE));
  const safeCurrentPage = Math.min(currentPage, totalPages);

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  const paginatedRows = useMemo(() => {
    const startIndex = (safeCurrentPage - 1) * DISPLAY_PAGE_SIZE;
    return filtered.slice(startIndex, startIndex + DISPLAY_PAGE_SIZE);
  }, [filtered, safeCurrentPage]);

  const visibleStart = filtered.length === 0 ? 0 : (safeCurrentPage - 1) * DISPLAY_PAGE_SIZE + 1;
  const visibleEnd = filtered.length === 0 ? 0 : Math.min(filtered.length, safeCurrentPage * DISPLAY_PAGE_SIZE);

  const exportCsv = () => {
    const headers = ["Time", "ASIN", "SKU", "MKT", "Title", "Action", "Source", "Old Price", "New Price", "Outcome", "Reason", "Rule", "Method"];
    const csvRows = [headers.join(",")];
    for (const r of filtered) {
      csvRows.push([
        r.createdAt,
        r.asin,
        r.sku || "",
        r.marketplace || "",
        `"${(r.title || "").replace(/"/g, '""')}"`,
        r.actionType,
        r.triggerSource,
        r.oldPrice ?? "",
        r.newPrice ?? "",
        getOutcome(r),
        `"${(r.reason || "").replace(/"/g, '""')}"`,
        r.ruleName || "",
        r.updateMethod || "",
      ].join(","));
    }
    const blob = new Blob([csvRows.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `check_history_${timeWindow}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Exported ${filtered.length} rows`);
  };

  const marketplaces = [...new Set(rows.map((r) => r.marketplace).filter(Boolean))].sort();

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <SummaryCard icon={<CheckCircle2 className="h-4 w-4 text-primary" />} label={`Checks (${timeWindow})`} value={summary.total.toLocaleString()} />
        <SummaryCard icon={<TrendingUp className="h-4 w-4 text-emerald-500" />} label="Price Changed" value={summary.changed.toLocaleString()} />
        <SummaryCard icon={<Minus className="h-4 w-4 text-muted-foreground" />} label="No Change" value={summary.noChange.toLocaleString()} />
        <SummaryCard icon={<ShieldAlert className="h-4 w-4 text-amber-500" />} label="Blocked" value={summary.blocked.toLocaleString()} />
        <SummaryCard icon={<XCircle className="h-4 w-4 text-destructive" />} label="Errors" value={summary.errors.toLocaleString()} />
      </div>

      <div className="flex flex-wrap items-center gap-2 bg-muted/50 rounded-lg p-2 border border-border">
        <div className="flex rounded-md border border-border overflow-hidden">
          {(["1h", "4h", "8h", "24h", "1w", "1m"] as TimeWindow[]).map((w) => (
            <button
              key={w}
              onClick={() => setTimeWindow(w)}
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${timeWindow === w ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-muted"}`}
            >
              {w}
            </button>
          ))}
        </div>

        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input placeholder="Search ASIN, SKU, title…" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="pl-7 h-8 text-xs bg-background text-foreground border-border" />
        </div>

        <Select value={marketplaceFilter} onValueChange={setMarketplaceFilter}>
          <SelectTrigger className="w-[100px] h-8 text-xs bg-background text-foreground border-border"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All MKT</SelectItem>
            {marketplaces.map((m) => (
              <SelectItem key={m!} value={m!}>{MKT_FLAGS[m!] || ""} {m}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={outcomeFilter} onValueChange={(v) => setOutcomeFilter(v as OutcomeFilter)}>
          <SelectTrigger className="w-[150px] h-8 text-xs bg-background text-foreground border-border"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Outcomes</SelectItem>
            <SelectItem value="changed">Changed</SelectItem>
            <SelectItem value="raised">↑ Raised</SelectItem>
            <SelectItem value="profit_extract">💰 Profit Extract</SelectItem>
            <SelectItem value="raise_match">= Match ($0.00)</SelectItem>
            <SelectItem value="raise_undercut">↓ Undercut ($0.01)</SelectItem>
            <SelectItem value="no_change">No Change</SelectItem>
            <SelectItem value="blocked">Blocked</SelectItem>
            <SelectItem value="error">Error</SelectItem>
          </SelectContent>
        </Select>

        <Button variant="outline" size="sm" className="h-8 gap-1 text-xs bg-background text-foreground border-border" onClick={fetchData} disabled={loading}>
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
        <Button variant="outline" size="sm" className="h-8 gap-1 text-xs bg-background text-foreground border-border" onClick={exportCsv}>
          <Download className="h-3.5 w-3.5" /> CSV
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1 text-xs bg-background text-foreground border-border"
          onClick={() => {
            const uniqueAsins = [...new Set(filtered.map((r) => r.asin))];
            if (!uniqueAsins.length) {
              toast.info("No ASINs to copy");
              return;
            }
            navigator.clipboard.writeText(uniqueAsins.join(","));
            toast.success(`Copied ${uniqueAsins.length} ASINs to clipboard`);
          }}
        >
          <Copy className="h-3.5 w-3.5" /> Copy ASINs
        </Button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          Showing {visibleStart.toLocaleString()}–{visibleEnd.toLocaleString()} of {filtered.length.toLocaleString()} rows
        </span>
        <span>
          {hasClientFilters
            ? `Filtered from ${baseSummary.total.toLocaleString()} total checks in this window`
            : `Loaded ${rows.length.toLocaleString()} / ${baseSummary.total.toLocaleString()} checks for this window`}
        </span>
      </div>

      {filtered.length > DISPLAY_PAGE_SIZE && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
          <span>Page {safeCurrentPage.toLocaleString()} of {totalPages.toLocaleString()}</span>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" className="h-8 px-2 text-xs" onClick={() => setCurrentPage(1)} disabled={safeCurrentPage === 1}>First</Button>
            <Button variant="outline" size="sm" className="h-8 px-2 text-xs" onClick={() => setCurrentPage((page) => Math.max(1, page - 1))} disabled={safeCurrentPage === 1}>Prev</Button>
            <Button variant="outline" size="sm" className="h-8 px-2 text-xs" onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))} disabled={safeCurrentPage === totalPages}>Next</Button>
            <Button variant="outline" size="sm" className="h-8 px-2 text-xs" onClick={() => setCurrentPage(totalPages)} disabled={safeCurrentPage === totalPages}>Last</Button>
          </div>
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-background">
              <TableRow>
                <TableHead className="w-[40px]"></TableHead>
                <TableHead className="min-w-[180px]">Title / ASIN</TableHead>
                <TableHead>MKT</TableHead>
                <TableHead>Time</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Old Price</TableHead>
                <TableHead>New Price</TableHead>
                <TableHead>Decision / Reason</TableHead>
                <TableHead>Rule</TableHead>
                <TableHead>Method</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={11} className="text-center text-muted-foreground py-8">
                    <div className="flex flex-col items-center gap-2">
                      <span>{emptyStateMessage}</span>
                      {!loading && hasAnyFilters && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-8 text-xs"
                          onClick={() => {
                            setSearchQuery("");
                            setMarketplaceFilter("all");
                            setOutcomeFilter("all");
                          }}
                        >
                          Clear filters
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              )}
              {paginatedRows.map((r) => (
                <TableRow key={r.id} className="cursor-pointer hover:bg-muted/70" onClick={() => { setSelectedRow(r); setDetailOpen(true); }}>
                  <TableCell>
                    {r.imageUrl ? (
                      <img src={r.imageUrl} alt={r.title || r.asin} className="h-8 w-8 rounded object-contain bg-muted" />
                    ) : (
                      <div className="h-8 w-8 rounded bg-muted" />
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="text-xs font-medium truncate max-w-[220px]">{r.title || "—"}</div>
                    <div className="text-[10px] text-muted-foreground font-mono">{r.asin}{r.sku ? ` · ${r.sku}` : ""}</div>
                  </TableCell>
                  <TableCell className="text-xs">{MKT_FLAGS[r.marketplace || ""] || ""} {r.marketplace || "—"}</TableCell>
                  <TableCell className="text-[10px] text-muted-foreground whitespace-nowrap">
                    {format(new Date(r.createdAt), "HH:mm:ss")}
                  </TableCell>
                  <TableCell>{outcomeBadge(r)}</TableCell>
                  <TableCell>{sourceBadge(r.triggerSource)}</TableCell>
                  <TableCell className="text-xs font-mono">{r.oldPrice != null ? `$${r.oldPrice.toFixed(2)}` : "—"}</TableCell>
                  <TableCell className="text-xs font-mono">
                    {r.newPrice != null ? (
                      <span className={r.oldPrice != null && r.newPrice !== r.oldPrice ? (r.newPrice > r.oldPrice ? "text-emerald-500" : "text-destructive") : ""}>
                        ${r.newPrice.toFixed(2)}
                      </span>
                    ) : "—"}
                  </TableCell>
                  <TableCell>
                    <div className="text-[10px] text-muted-foreground truncate max-w-[250px]">
                      {r.reason || "—"}
                    </div>
                  </TableCell>
                  <TableCell className="text-[10px] text-muted-foreground">{r.ruleName || "—"}</TableCell>
                  <TableCell className="text-[10px] text-muted-foreground">{r.updateMethod || "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {filtered.length > DISPLAY_PAGE_SIZE && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>
            Showing {visibleStart.toLocaleString()}–{visibleEnd.toLocaleString()} of {filtered.length.toLocaleString()} rows
          </span>
          <span>Use Prev / Next to browse all checks in the selected window.</span>
        </div>
      )}

      <Sheet open={detailOpen} onOpenChange={setDetailOpen}>
        <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
          {selectedRow && <DetailPanel row={selectedRow} />}
        </SheetContent>
      </Sheet>
    </div>
  );
}

/* ─── Summary Card ─── */
function SummaryCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string | number }) {
  return (
    <Card>
      <CardContent className="p-3 flex items-center gap-2">
        {icon}
        <div>
          <div className="text-lg font-bold leading-none">{value}</div>
          <div className="text-[10px] text-muted-foreground">{label}</div>
        </div>
      </CardContent>
    </Card>
  );
}

/* ─── Detail Panel ─── */
function DetailPanel({ row }: { row: CheckRecord }) {
  const flag = MKT_FLAGS[row.marketplace || ""] || "";

  const MKT_DOMAINS: Record<string, string> = {
    US: "amazon.com",
    CA: "amazon.ca",
    MX: "amazon.com.mx",
    BR: "amazon.com.br",
  };
  const amazonListingUrl = (asin: string, mkt?: string) => {
    const domain = MKT_DOMAINS[mkt || "US"] || "amazon.com";
    return `https://www.${domain}/dp/${asin}`;
  };

  const section = (title: string, items: [string, string | React.ReactNode | null | undefined][]) => (
    <div className="space-y-1">
      <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{title}</h4>
      <div className="grid grid-cols-[140px_1fr] gap-y-0.5 text-xs">
        {items.map(([k, v], i) => (
          <div key={i} className="contents">
            <span className="text-muted-foreground">{k}</span>
            <span className="font-mono break-all">{typeof v === "string" || typeof v === "number" ? (v || "—") : (v ?? "—")}</span>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div className="space-y-5">
      <SheetHeader>
        <SheetTitle className="flex items-center gap-2 text-sm">
          {row.imageUrl && <img src={row.imageUrl} className="h-10 w-10 rounded object-contain bg-muted" />}
          <div>
            <div className="font-semibold">{row.title || row.asin}</div>
            <a href={amazonListingUrl(row.asin, row.marketplace)} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline font-mono cursor-pointer">{row.asin} ↗ · {flag}{row.marketplace || ""}</a>
          </div>
        </SheetTitle>
      </SheetHeader>

      {section("Check Details", [
        ["Time", format(new Date(row.createdAt), "MMM d, yyyy HH:mm:ss")],
        ["ASIN", <a href={amazonListingUrl(row.asin, row.marketplace)} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline cursor-pointer">{row.asin} ↗</a>],
        ["SKU", row.sku],
        ["Marketplace", `${flag} ${row.marketplace || ""}`],
        ["Action Type", row.actionType],
        ["Trigger Source", row.triggerSource],
        ["Outcome", getOutcome(row)],
        ["Success", row.success != null ? (row.success ? "✅ Yes" : "❌ No") : null],
      ])}

      {section("Pricing", [
        ["Old Price", row.oldPrice != null ? `$${row.oldPrice.toFixed(2)}` : null],
        ["New Price", row.newPrice != null ? `$${row.newPrice.toFixed(2)}` : null],
        ["Current My Price", row.myPrice != null ? `$${row.myPrice.toFixed(2)}` : null],
      ])}

      {section("Decision", [
        ["Reason", row.reason],
        ["Rule", row.ruleName],
        ["Overlay", row.overlayTag],
        ["Update Method", row.updateMethod],
        ["AI Osc Mode", (() => {
          const match = row.reason?.match(/\[osc_mode:(\w+)\]/);
          if (match) {
            const mode = match[1];
            return mode === 'safe' ? '🔴 Safe (Price War)' :
                   mode === 'balanced' ? '🟡 Balanced (Volatile)' :
                   mode === 'aggressive' ? '🟢 Aggressive (Stable)' : mode;
          }
          // Check for oscillation_guard actions
          if (row.actionType === 'oscillation_guard') {
            const modeMatch = row.reason?.match(/mode:\s*(\w+)/);
            const scoreMatch = row.reason?.match(/score:\s*(\d+)/);
            const flagsMatch = row.reason?.match(/flags:\s*([^|]+)/);
            return `${modeMatch?.[1] || '?'} (score: ${scoreMatch?.[1] || '?'}, flags: ${flagsMatch?.[1]?.trim() || 'none'})`;
          }
          return null;
        })()],
      ])}

      {(row.errorMessage || row.errorType) && section("Errors", [
        ["Error Type", row.errorType],
        ["Error Message", row.errorMessage],
      ])}

      {row.floorBreakdown && (
        <div className="space-y-1">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Floor Breakdown</h4>
          <pre className="text-[10px] bg-muted p-2 rounded overflow-auto max-h-40">
            {JSON.stringify(row.floorBreakdown, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
