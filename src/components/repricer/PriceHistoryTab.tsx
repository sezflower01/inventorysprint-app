import { useState, useCallback, useEffect, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import {
  Download,
  ChevronLeft,
  ChevronRight,
  Filter,
  CalendarIcon,
  Search,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import PriceActionDetailDialog from "./PriceActionDetailDialog";
import { translateRepricerReasonShort, translateGuardBadge } from "@/lib/repricerReasonTranslator";

interface PriceAction {
  id: string;
  created_at: string;
  asin: string;
  sku: string | null;
  marketplace: string | null;
  old_price: number | null;
  new_price: number | null;
  old_min_price: number | null;
  new_min_price: number | null;
  old_max_price: number | null;
  new_max_price: number | null;
  action_type: string;
  trigger_source: string;
  reason: string | null;
  intelligence_factors: any;
  success: boolean | null;
  error_message: string | null;
  rule_name: string | null;
  update_method: string | null;
  intended_price: number | null;
  submitted_price: number | null;
  amazon_accepted_price: number | null;
  effective_floor_cents: number | null;
  overlay_tag: string | null;
  reconciliation_status: string | null;
  reconciliation_reason?: string | null;
  verified_live_price?: number | null;
  verified_at?: string | null;
}

const PAGE_SIZE = 50;

const MARKETPLACE_DOMAINS: Record<string, string> = {
  US: "www.amazon.com",
  CA: "www.amazon.ca",
  MX: "www.amazon.com.mx",
  BR: "www.amazon.com.br",
  UK: "www.amazon.co.uk",
  DE: "www.amazon.de",
  FR: "www.amazon.fr",
  IT: "www.amazon.it",
  ES: "www.amazon.es",
};

function getAmazonLink(asin: string, mkt: string | null): string {
  const domain = MARKETPLACE_DOMAINS[(mkt || "US").toUpperCase()] || "www.amazon.com";
  return `https://${domain}/dp/${asin}`;
}

const TIME_RANGES = [
  { label: "Last 24h", value: "24h" },
  { label: "Last 3 days", value: "3d" },
  { label: "Last 5 days", value: "5d" },
  { label: "Last 7 days", value: "7d" },
  { label: "Custom", value: "custom" },
];

export default function PriceHistoryTab({ marketplace }: { marketplace: string }) {
  const { user } = useAuth();
  const [rows, setRows] = useState<PriceAction[]>([]);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [totalHint, setTotalHint] = useState<number | null>(null);
  const [imageMap, setImageMap] = useState<Record<string, string>>({});

  // Filters
  const [filterAsin, setFilterAsin] = useState("");
  const [filterSku, setFilterSku] = useState("");
  const [filterTimeRange, setFilterTimeRange] = useState("24h");
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterRule, setFilterRule] = useState("all");
  const [onlyChanges, setOnlyChanges] = useState(false);
  const [showFilters, setShowFilters] = useState(true);
  const [customFrom, setCustomFrom] = useState<Date | undefined>();
  const [customTo, setCustomTo] = useState<Date | undefined>();

  // Detail dialog
  const [selectedAction, setSelectedAction] = useState<PriceAction | null>(null);

  // Rule names for filter dropdown
  const [ruleNames, setRuleNames] = useState<string[]>([]);

  useEffect(() => {
    if (!user) return;
    // Fetch all distinct rule names from repricer_rules table (authoritative source)
    // plus any rule names from price_actions that may no longer exist in rules
    Promise.all([
      supabase
        .from("repricer_rules")
        .select("name")
        .eq("user_id", user.id)
        .not("name", "is", null),
      supabase
        .from("repricer_price_actions")
        .select("rule_name")
        .eq("user_id", user.id)
        .not("rule_name", "is", null)
        .limit(1000),
    ]).then(([rulesRes, actionsRes]) => {
      const names = new Set<string>();
      rulesRes.data?.forEach((r: any) => r.name && names.add(r.name));
      actionsRes.data?.forEach((r: any) => r.rule_name && names.add(r.rule_name));
      setRuleNames([...names].sort());
    });
  }, [user]);
  

  const getTimeFilter = useCallback(() => {
    const now = new Date();
    if (filterTimeRange === "custom") {
      return {
        from: customFrom ? customFrom.toISOString() : new Date(now.getTime() - 86400000).toISOString(),
        to: customTo ? customTo.toISOString() : now.toISOString(),
      };
    }
    const hours: Record<string, number> = { "24h": 24, "3d": 72, "5d": 120, "7d": 168 };
    const h = hours[filterTimeRange] || 24;
    return {
      from: new Date(now.getTime() - h * 3600000).toISOString(),
      to: now.toISOString(),
    };
  }, [filterTimeRange, customFrom, customTo]);

  const fetchData = useCallback(async (pageNum: number) => {
    if (!user) return;
    setLoading(true);
    try {
      const { from, to } = getTimeFilter();
      let q = supabase
        .from("repricer_price_actions")
        .select("id,created_at,asin,sku,marketplace,old_price,new_price,old_min_price,new_min_price,old_max_price,new_max_price,action_type,trigger_source,reason,intelligence_factors,success,error_message,rule_name,update_method,intended_price,submitted_price,amazon_accepted_price,effective_floor_cents,overlay_tag,reconciliation_status,reconciliation_reason,verified_live_price,verified_at,recon_root_cause")
        .eq("user_id", user.id)
        .eq("marketplace", marketplace)
        .gte("created_at", from)
        .lte("created_at", to)
        .order("created_at", { ascending: false })
        // created_at is not unique, so it cannot order pages on its own:
        // a tie spanning a page boundary repeats or skips rows. id breaks it.
        .order("id", { ascending: true })
        .range(pageNum * PAGE_SIZE, (pageNum + 1) * PAGE_SIZE - 1);

      if (filterAsin.trim()) q = q.ilike("asin", `%${filterAsin.trim()}%`);
      if (filterSku.trim()) q = q.ilike("sku", `%${filterSku.trim()}%`);
      if (filterStatus === "changed") q = q.in("action_type", ["price_change", "price_changed", "price_and_minmax_change"]);
      else if (filterStatus === "no_change") q = q.eq("action_type", "no_change");
      else if (filterStatus === "blocked") q = q.in("action_type", ["blocked_by_profit_guard", "oscillation_guard"]);
      else if (filterStatus === "error") q = q.in("action_type", ["eval_error", "price_change_failed"]);
      if (filterRule !== "all") q = q.eq("rule_name", filterRule);
      if (onlyChanges) q = q.in("action_type", ["price_change", "price_changed", "price_and_minmax_change", "minmax_change"]);

      const { data, error } = await q;
      if (error) throw error;
      const results = (data as PriceAction[]) || [];
      setRows(results);
      setHasMore(results.length === PAGE_SIZE);

      // Fetch images for unique ASINs
      const uniqueAsins = [...new Set(results.map((r) => r.asin))];
      if (uniqueAsins.length > 0) {
        const { data: invData } = await supabase
          .from("inventory")
          .select("asin, image_url")
          .eq("user_id", user.id)
          .in("asin", uniqueAsins);
        if (invData) {
          const map: Record<string, string> = {};
          invData.forEach((item: any) => {
            if (item.image_url) map[item.asin] = item.image_url;
          });
          setImageMap((prev) => ({ ...prev, ...map }));
        }
      }
    } catch (err: any) {
      toast.error("Failed to load price history: " + err.message);
    } finally {
      setLoading(false);
    }
  }, [user, marketplace, filterAsin, filterSku, filterTimeRange, filterStatus, filterRule, onlyChanges, customFrom, customTo, getTimeFilter]);

  useEffect(() => {
    setPage(0);
    fetchData(0);
  }, [fetchData]);

  const handlePageChange = (dir: number) => {
    const next = page + dir;
    if (next < 0) return;
    setPage(next);
    fetchData(next);
  };

  const handleExportCsv = useCallback(() => {
    if (!rows.length) return toast.info("No data to export");
    const headers = ["Date", "ASIN", "SKU", "Marketplace", "Rule", "Action", "Old Price", "New Price", "Change $", "Change %", "Status", "Method", "Reason"];
    const csvRows = rows.map((r) => {
      const delta = r.new_price && r.old_price ? (r.new_price - r.old_price) : null;
      const pct = delta && r.old_price ? ((delta / r.old_price) * 100) : null;
      return [
        r.created_at,
        r.asin,
        r.sku || "",
        r.marketplace || "",
        r.rule_name || "",
        r.action_type,
        r.old_price?.toFixed(2) || "",
        r.new_price?.toFixed(2) || "",
        delta?.toFixed(2) || "",
        pct?.toFixed(2) || "",
        r.success === false ? "error" : r.action_type,
        r.update_method || "",
        (r.reason || "").replace(/,/g, ";"),
      ].join(",");
    });
    const csv = [headers.join(","), ...csvRows].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `price_history_${marketplace}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("CSV exported");
  }, [rows, marketplace]);

  const clearFilters = () => {
    setFilterAsin("");
    setFilterSku("");
    setFilterTimeRange("24h");
    setFilterStatus("all");
    setFilterRule("all");
    setOnlyChanges(false);
    setCustomFrom(undefined);
    setCustomTo(undefined);
  };

  return (
    <div className="space-y-4 text-white">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-white">Price Action History</h3>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="border-white/15 bg-white/5 text-white hover:bg-white/10 hover:text-white" onClick={() => setShowFilters(!showFilters)}>
            <Filter className="h-4 w-4 mr-1" />
            Filters
          </Button>
          <Button variant="outline" size="sm" className="border-white/15 bg-white/5 text-white hover:bg-white/10 hover:text-white" onClick={handleExportCsv}>
            <Download className="h-4 w-4 mr-1" />
            CSV
          </Button>
          <Button variant="outline" size="sm" className="border-white/15 bg-white/5 text-white hover:bg-white/10 hover:text-white" onClick={() => fetchData(page)}>
            Refresh
          </Button>
        </div>
      </div>

      {/* Filters */}
      {showFilters && (
        <div className="border border-white/10 rounded-lg p-4 space-y-3 bg-white/5 backdrop-blur-sm text-white">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <Label className="text-xs text-gray-300">ASIN</Label>
              <div className="relative">
                <Search className="absolute left-2 top-2.5 h-3.5 w-3.5 text-gray-400" />
                <Input
                  value={filterAsin}
                  onChange={(e) => setFilterAsin(e.target.value)}
                  placeholder="Search ASIN..."
                  className="pl-7 h-9 border-white/15 bg-white/5 text-white placeholder:text-gray-400"
                />
              </div>
            </div>
            <div>
              <Label className="text-xs text-gray-300">SKU</Label>
              <Input
                value={filterSku}
                onChange={(e) => setFilterSku(e.target.value)}
                placeholder="Search SKU..."
                className="h-9 border-white/15 bg-white/5 text-white placeholder:text-gray-400"
              />
            </div>
            <div>
              <Label className="text-xs text-gray-300">Time Range</Label>
              <Select value={filterTimeRange} onValueChange={setFilterTimeRange}>
                <SelectTrigger className="h-9 border-white/15 bg-white/5 text-white"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TIME_RANGES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs text-gray-300">Status</Label>
              <Select value={filterStatus} onValueChange={setFilterStatus}>
                <SelectTrigger className="h-9 border-white/15 bg-white/5 text-white"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="changed">Price Changed</SelectItem>
                  <SelectItem value="no_change">No Change</SelectItem>
                  <SelectItem value="blocked">Blocked / Guarded</SelectItem>
                  <SelectItem value="error">Errors</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 items-end">
            <div>
              <Label className="text-xs text-gray-300">Rule</Label>
              <Select value={filterRule} onValueChange={setFilterRule}>
                <SelectTrigger className="h-9 border-white/15 bg-white/5 text-white"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Rules</SelectItem>
                  {ruleNames.map((r) => (
                    <SelectItem key={r} value={r}>{r}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {filterTimeRange === "custom" && (
              <>
                <div>
                  <Label className="text-xs text-gray-300">From</Label>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button variant="outline" className={cn("h-9 w-full justify-start border-white/15 bg-white/5 text-left font-normal text-white hover:bg-white/10 hover:text-white", !customFrom && "text-gray-400")}>
                        <CalendarIcon className="mr-2 h-3.5 w-3.5" />
                        {customFrom ? format(customFrom, "PPP") : "Pick date"}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <Calendar mode="single" selected={customFrom} onSelect={setCustomFrom} className="p-3 pointer-events-auto" />
                    </PopoverContent>
                  </Popover>
                </div>
                <div>
                  <Label className="text-xs text-gray-300">To</Label>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button variant="outline" className={cn("h-9 w-full justify-start border-white/15 bg-white/5 text-left font-normal text-white hover:bg-white/10 hover:text-white", !customTo && "text-gray-400")}>
                        <CalendarIcon className="mr-2 h-3.5 w-3.5" />
                        {customTo ? format(customTo, "PPP") : "Pick date"}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <Calendar mode="single" selected={customTo} onSelect={setCustomTo} className="p-3 pointer-events-auto" />
                    </PopoverContent>
                  </Popover>
                </div>
              </>
            )}
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2 text-white">
                <Switch checked={onlyChanges} onCheckedChange={setOnlyChanges} id="only-changes" />
                <Label htmlFor="only-changes" className="text-xs text-gray-300">Only price changes</Label>
              </div>
              <Button variant="ghost" size="sm" className="text-gray-300 hover:bg-white/10 hover:text-white" onClick={clearFilters}>
                <X className="h-3.5 w-3.5 mr-1" />
                Clear
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Results count */}
      <div className="text-xs text-gray-400">
        Showing {rows.length} results · Page {page + 1}
        {loading && " · Loading..."}
      </div>

      {/* Table */}
      <div className="overflow-x-auto border border-white/10 bg-white/5 backdrop-blur-sm rounded-lg max-h-[600px] overflow-y-auto">
        <Table>
          <TableHeader className="sticky top-0 z-20 border-b border-white/10 bg-white/10 backdrop-blur-sm">
            <TableRow className="text-xs hover:bg-transparent">
              <TableHead className="w-[140px] text-gray-300">Date</TableHead>
              <TableHead className="w-[40px] text-gray-300"></TableHead>
              <TableHead className="text-gray-300">ASIN</TableHead>
              <TableHead className="text-gray-300">Mkt</TableHead>
              <TableHead className="text-gray-300">SKU</TableHead>
              <TableHead className="text-gray-300">Rule</TableHead>
              <TableHead className="text-right text-gray-300">Min</TableHead>
              <TableHead className="text-right text-gray-300">Max</TableHead>
              <TableHead className="text-right text-gray-300">BB Price</TableHead>
              <TableHead className="text-right text-gray-300">Lowest FBA</TableHead>
              <TableHead className="text-right text-gray-300">My Price</TableHead>
              <TableHead className="text-right text-gray-300">New Price</TableHead>
              <TableHead className="text-right text-gray-300">Δ</TableHead>
              <TableHead className="text-gray-300">Status</TableHead>
              <TableHead className="text-gray-300">Method</TableHead>
              <TableHead className="min-w-[200px] text-gray-300">Reason</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && !loading && (
              <TableRow>
              <TableCell colSpan={16} className="text-center py-8 text-gray-400">
                  No price actions found for the selected filters.
                </TableCell>
              </TableRow>
            )}
            {rows.map((r, idx) => {
              const intel = r.intelligence_factors || {};
              const trace = intel?.price_trace || {};
              const bbPrice = trace.buybox_price ?? null;
              const lowestFba = trace.lowest_fba ?? null;
              const delta = r.new_price != null && r.old_price != null ? r.new_price - r.old_price : null;
              const pct = delta != null && r.old_price ? (delta / r.old_price) * 100 : null;
              const bbSource = intel?.reason_codes?.bb_confidence || trace.bb_source || "";
              const floorClamped = trace.clamped_by === "floor" || (r.reason || "").includes("floor");
              const ceilClamped = trace.clamped_by === "ceiling" || (r.reason || "").includes("ceiling");
              const smartRaise = (r.reason || "").toLowerCase().includes("smart raise");
              const monopoly = (r.reason || "").toLowerCase().includes("monopoly");
              const guards = intel?.guards_applied || [];

              return (
                <TableRow
                  key={r.id}
                  className={`text-xs cursor-pointer border-b border-white/10 text-gray-100 hover:bg-white/10 transition-colors ${idx % 2 === 0 ? 'bg-white/[0.03]' : 'bg-white/[0.06]'}`}
                  onClick={() => setSelectedAction(r)}
                >
                  <TableCell className="font-mono text-[11px] text-gray-200">
                    {format(new Date(r.created_at), "MM/dd HH:mm:ss")}
                  </TableCell>
                  <TableCell className="p-1 w-[40px]">
                    {imageMap[r.asin] ? (
                      <img
                        src={imageMap[r.asin]}
                        alt={r.asin}
                        className="w-8 h-8 object-contain rounded"
                        loading="lazy"
                      />
                    ) : (
                      <div className="w-8 h-8 rounded bg-white/10 flex items-center justify-center text-[9px] text-gray-400">—</div>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-gray-100">
                    <a
                      href={getAmazonLink(r.asin, r.marketplace)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-400 hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {r.asin}
                    </a>
                  </TableCell>
                  <TableCell className="text-[11px] text-gray-200">
                    <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4 border-white/15 text-gray-200">
                      {r.marketplace || marketplace}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-[80px] truncate text-gray-100">{r.sku || "—"}</TableCell>
                  <TableCell className="max-w-[100px] truncate text-gray-100">{r.rule_name || "—"}</TableCell>
                  <TableCell className="text-right font-mono text-gray-100">
                    {r.effective_floor_cents != null ? `$${(r.effective_floor_cents / 100).toFixed(2)}` : r.old_min_price != null ? `$${r.old_min_price.toFixed(2)}` : "—"}
                  </TableCell>
                  <TableCell className="text-right font-mono text-gray-100">
                    {r.old_max_price != null ? `$${r.old_max_price.toFixed(2)}` : "—"}
                  </TableCell>
                  <TableCell className="text-right font-mono text-gray-100">
                    {bbPrice != null ? `$${Number(bbPrice).toFixed(2)}` : "—"}
                    {bbSource && (
                      <span className="ml-1 text-[10px] text-gray-400">
                        {bbSource === "missing" ? "⚠" : bbSource === "cached" ? "📦" : ""}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-mono text-gray-100">
                    {lowestFba != null ? `$${Number(lowestFba).toFixed(2)}` : "—"}
                  </TableCell>
                  <TableCell className="text-right font-mono text-gray-100">
                    {r.old_price != null ? `$${r.old_price.toFixed(2)}` : "—"}
                  </TableCell>
                  <TableCell className="text-right font-mono font-semibold text-white">
                    {r.new_price != null ? `$${r.new_price.toFixed(2)}` : "—"}
                  </TableCell>
                  <TableCell className="text-right font-mono text-gray-100">
                    {delta != null ? (
                      <span className={delta > 0 ? "text-green-400" : delta < 0 ? "text-red-400" : "text-gray-400"}>
                        {delta > 0 ? "+" : ""}{delta.toFixed(2)}
                        {pct != null && <span className="text-[10px] ml-0.5">({pct.toFixed(1)}%)</span>}
                      </span>
                    ) : "—"}
                  </TableCell>
                  <TableCell>
                    <StatusBadge action={r} />
                  </TableCell>
                  <TableCell className="text-[11px] text-gray-200">
                    {r.update_method || "—"}
                  </TableCell>
                  <TableCell className="text-[11px] max-w-[280px] text-gray-100">
                    <div className="truncate" title={translateRepricerReasonShort(r.reason)}>
                      {translateRepricerReasonShort(r.reason)}
                    </div>
                    <div className="flex gap-0.5 mt-0.5 flex-wrap">
                      {floorClamped && <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 border-amber-500 text-amber-400">Floor</Badge>}
                      {ceilClamped && <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 border-blue-500 text-blue-400">Ceiling</Badge>}
                      {smartRaise && <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 border-green-500 text-green-400">Smart Raise</Badge>}
                      {monopoly && <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 border-purple-500 text-purple-400">Monopoly</Badge>}
                      {guards.length > 0 && guards.map((g: string) => (
                        <Badge key={g} variant="outline" className="text-[9px] px-1 py-0 h-4 border-white/15 text-gray-200">{translateGuardBadge(g)}</Badge>
                      ))}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between">
        <Button variant="outline" size="sm" className="border-white/15 bg-white/5 text-white hover:bg-white/10 hover:text-white" onClick={() => handlePageChange(-1)} disabled={page === 0}>
          <ChevronLeft className="h-4 w-4 mr-1" />
          Previous
        </Button>
        <span className="text-xs text-gray-400">Page {page + 1}</span>
        <Button variant="outline" size="sm" className="border-white/15 bg-white/5 text-white hover:bg-white/10 hover:text-white" onClick={() => handlePageChange(1)} disabled={!hasMore}>
          Next
          <ChevronRight className="h-4 w-4 ml-1" />
        </Button>
      </div>

      {/* Detail Dialog */}
      <PriceActionDetailDialog
        action={selectedAction}
        open={!!selectedAction}
        onOpenChange={(open) => !open && setSelectedAction(null)}
      />
    </div>
  );
}

function StatusBadge({ action }: { action: PriceAction }) {
  const at = action.action_type;
  const actuallyChanged = action.old_price != null && action.new_price != null && Math.abs(action.new_price - action.old_price) >= 0.005;

  if (at === "eval_error" || at === "price_change_failed" || action.success === false) {
    return <Badge variant="destructive" className="text-[10px] px-1.5 py-0 h-4">Error</Badge>;
  }
  if (at === "price_change" || at === "price_changed" || at === "price_and_minmax_change") {
    if (!actuallyChanged) {
      return <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4">Hold</Badge>;
    }
    return <Badge className="text-[10px] px-1.5 py-0 h-4 bg-green-600">Changed</Badge>;
  }
  if (at === "minmax_change") {
    return <Badge className="text-[10px] px-1.5 py-0 h-4 bg-blue-600">Bounds</Badge>;
  }
  if (at === "blocked_by_profit_guard") {
    return <Badge variant="outline" className="text-[10px] px-1.5 py-0.5 whitespace-nowrap border-amber-500 text-amber-400">Profit Guard</Badge>;
  }
  if (at === "oscillation_guard") {
    return <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 border-amber-500 text-amber-600">Oscillation</Badge>;
  }
  if (at === "safe_mode_activated") {
    return <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 border-red-500 text-red-600">Safe Mode</Badge>;
  }
  if (at === "priority_eval" || at === "anomaly_eval_only") {
    return <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4">Eval</Badge>;
  }
  if (at === "no_change") {
    const reason = (action.reason || "").toLowerCase();
    if (reason.includes("blocked") || reason.includes("guard") || reason.includes("floor") || reason.includes("constrained")) {
      return <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 border-amber-500 text-amber-600">Blocked</Badge>;
    }
    return <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4">No Change</Badge>;
  }
  return <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4">{at.replace(/_/g, " ")}</Badge>;
}
