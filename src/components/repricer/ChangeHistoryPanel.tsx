import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Search, RefreshCw, ArrowDown, ArrowUp, Filter, Trash2, Copy, Clock } from "lucide-react";
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
import { toast } from "sonner";
import { format } from "date-fns";

interface ChangeRecord {
  id: string;
  asin: string;
  sku: string | null;
  marketplace: string;
  field_changed: string;
  old_value: number | null;
  new_value: number | null;
  reason: string | null;
  source: string | null;
  device_info: string | null;
  created_at: string;
}

const FIELD_LABELS: Record<string, string> = {
  min_price: "Min Price",
  max_price: "Max Price",
  min_price_override: "Min Price",
  max_price_override: "Max Price",
  my_price: "Set Price",
  new_price: "New Price",
  min_roi_override: "Min ROI %",
};

const SOURCE_LABELS: Record<string, string> = {
  ui: "Manual Edit",
  bulk: "Bulk Update",
  retrieve_price: "Retrieve Price",
  retrieve_roi: "Retrieve ROI",
  set_price: "Set Price",
  auto_sync: "Auto Sync",
  save_to_amazon: "Save to Amazon",
};

interface UserOption {
  id: string;
  email: string;
}

export default function ChangeHistoryPanel() {
  const { user } = useAuth();
  const [changes, setChanges] = useState<ChangeRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [fieldFilter, setFieldFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [userFilter, setUserFilter] = useState("mine");
  const [availableUsers, setAvailableUsers] = useState<UserOption[]>([]);
  const [timeRange, setTimeRange] = useState<"12h" | "today" | "week" | "month">("today");
  const [deviceFilter, setDeviceFilter] = useState("all");
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;

  // Summary stats
  const [rangeCount, setRangeCount] = useState(0);
  const [uniqueAsinCount, setUniqueAsinCount] = useState(0);
  const [lastHourCount, setLastHourCount] = useState(0);
  const [deleting, setDeleting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [hoursWorked, setHoursWorked] = useState<{ email: string; hours: number; changes: number }[]>([]);

  // Fetch distinct users who have change records
  useEffect(() => {
    async function fetchUsers() {
      try {
        const { data, error } = await (supabase as any)
          .from("repricer_setting_changes")
          .select("user_id")
          .limit(1000);
        if (error) throw error;
        const uniqueIds = [...new Set((data || []).map((r: any) => r.user_id as string))] as string[];
        
        // Fetch emails from profiles if available, otherwise just show IDs
        const users: UserOption[] = [];
        if (uniqueIds.length > 0) {
          const { data: profiles } = await (supabase as any)
            .from("profiles")
            .select("id, email")
            .in("id", uniqueIds);
          
          const profileMap = new Map((profiles || []).map((p: any) => [p.id, p.email]));
          for (const uid of uniqueIds) {
            users.push({
              id: uid,
              email: (profileMap.get(uid) as string) || uid.substring(0, 8) + "…",
            });
          }
        }
        setAvailableUsers(users);
      } catch (e) {
        console.error("[ChangeHistory] Failed to fetch users:", e);
      }
    }
    fetchUsers();
  }, []);

  const getTimeRangeStart = useCallback((range: "12h" | "today" | "week" | "month") => {
    const now = new Date();
    if (range === "12h") {
      return new Date(now.getTime() - 12 * 60 * 60 * 1000);
    } else if (range === "today") {
      const d = new Date(now);
      d.setHours(0, 0, 0, 0);
      return d;
    } else if (range === "month") {
      const d = new Date(now.getFullYear(), now.getMonth(), 1);
      return d;
    } else {
      const d = new Date(now);
      d.setDate(d.getDate() - 7);
      return d;
    }
  }, []);

  // Fetch hours worked per device for selected time range
  const fetchHoursWorked = useCallback(async () => {
    try {
      const rangeStart = getTimeRangeStart(timeRange);
      const { data, error } = await (supabase as any)
        .from("repricer_setting_changes")
        .select("device_info, created_at")
        .gte("created_at", rangeStart.toISOString())
        .order("created_at", { ascending: true })
        .limit(5000);
      if (error) throw error;
      if (!data || data.length === 0) { setHoursWorked([]); return; }
      const byDevice = new Map<string, Date[]>();
      for (const row of data) {
        const device = (row.device_info as string) || "unknown";
        if (!byDevice.has(device)) byDevice.set(device, []);
        byDevice.get(device)!.push(new Date(row.created_at));
      }
      const results: { email: string; hours: number; changes: number }[] = [];
      const IDLE_GAP_MS = 15 * 60 * 1000;
      for (const [device, timestamps] of byDevice) {
        timestamps.sort((a, b) => a.getTime() - b.getTime());
        let activeMs = 0;
        for (let i = 1; i < timestamps.length; i++) {
          const gap = timestamps[i].getTime() - timestamps[i - 1].getTime();
          if (gap <= IDLE_GAP_MS) activeMs += gap;
        }
        if (timestamps.length === 1) activeMs = 60000;
        results.push({
          email: device,
          hours: Math.round((activeMs / 3600000) * 10) / 10,
          changes: timestamps.length,
        });
      }
      results.sort((a, b) => b.hours - a.hours);
      setHoursWorked(results);
    } catch (e) {
      console.error("[ChangeHistory] Failed to fetch hours worked:", e);
    }
  }, [timeRange, getTimeRangeStart]);

  useEffect(() => { fetchHoursWorked(); }, [fetchHoursWorked]);

  const fetchChanges = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const rangeStart = getTimeRangeStart(timeRange);
      const targetUserId = userFilter === "mine" ? user.id : userFilter === "all" ? null : userFilter;

      let query = (supabase as any)
        .from("repricer_setting_changes")
        .select("*")
        .gte("created_at", rangeStart.toISOString())
        .order("created_at", { ascending: false })
        // created_at is not unique, so it cannot order pages on its own:
        // a tie spanning a page boundary repeats or skips rows. id breaks it.
        .order("id", { ascending: true })
        .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

      if (targetUserId) {
        query = query.eq("user_id", targetUserId);
      }

      if (searchTerm) {
        query = query.or(`asin.ilike.%${searchTerm}%,sku.ilike.%${searchTerm}%`);
      }
      if (fieldFilter !== "all") {
        query = query.eq("field_changed", fieldFilter);
      }
      if (sourceFilter !== "all") {
        query = query.eq("source", sourceFilter);
      }
      if (deviceFilter !== "all") {
        query = query.eq("device_info", deviceFilter);
      }

      const { data, error } = await query;
      setChanges(data || []);

      // Fetch count for selected range + unique ASINs count + last hour count
      let countQuery = (supabase as any)
        .from("repricer_setting_changes")
        .select("id", { count: "exact", head: true })
        .gte("created_at", rangeStart.toISOString());
      if (targetUserId) countQuery = countQuery.eq("user_id", targetUserId);

      let asinQuery = (supabase as any)
        .from("repricer_setting_changes")
        .select("asin")
        .gte("created_at", rangeStart.toISOString())
        .limit(5000);
      if (targetUserId) asinQuery = asinQuery.eq("user_id", targetUserId);

      const lastHourStart = new Date(Date.now() - 3600000).toISOString();
      let lastHourQuery = (supabase as any)
        .from("repricer_setting_changes")
        .select("id", { count: "exact", head: true })
        .gte("created_at", lastHourStart);
      if (targetUserId) lastHourQuery = lastHourQuery.eq("user_id", targetUserId);

      const [countRes, asinRes, lastHourRes] = await Promise.all([countQuery, asinQuery, lastHourQuery]);

      setRangeCount(countRes.count || 0);
      setUniqueAsinCount(new Set((asinRes.data || []).map((r: any) => r.asin)).size);
      setLastHourCount(lastHourRes.count || 0);
    } catch (e) {
      console.error("[ChangeHistory] Error fetching:", e);
    } finally {
      setLoading(false);
    }
  }, [user, searchTerm, fieldFilter, sourceFilter, deviceFilter, userFilter, timeRange, page, getTimeRangeStart]);

  useEffect(() => {
    fetchChanges();
  }, [fetchChanges]);

  const handleDeleteSelected = async () => {
    if (selectedIds.size === 0) return;
    setDeleting(true);
    try {
      const ids = Array.from(selectedIds);
      const { error } = await (supabase as any)
        .from("repricer_setting_changes")
        .delete()
        .in("id", ids);
      if (error) throw error;
      toast.success(`Deleted ${ids.length} record(s)`);
      setSelectedIds(new Set());
      fetchChanges();
    } catch (e: any) {
      toast.error("Delete failed: " + e.message);
    } finally {
      setDeleting(false);
    }
  };

  const handleClearAll = async () => {
    if (!user) return;
    setDeleting(true);
    try {
      let query = (supabase as any)
        .from("repricer_setting_changes")
        .delete()
        .eq("user_id", user.id);

      if (searchTerm) {
        query = query.or(`asin.ilike.%${searchTerm}%,sku.ilike.%${searchTerm}%`);
      }
      if (fieldFilter !== "all") {
        query = query.eq("field_changed", fieldFilter);
      }
      if (sourceFilter !== "all") {
        query = query.eq("source", sourceFilter);
      }

      const { error } = await query;
      if (error) throw error;
      toast.success("History cleared");
      setSelectedIds(new Set());
      fetchChanges();
    } catch (e: any) {
      toast.error("Clear failed: " + e.message);
    } finally {
      setDeleting(false);
    }
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === changes.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(changes.map(c => c.id)));
    }
  };

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const formatValue = (value: number | null, field: string) => {
    if (value === null) return "—";
    if (field.includes("roi")) return `${value.toFixed(1)}%`;
    return `$${value.toFixed(2)}`;
  };

  const getChangeBadge = (oldVal: number | null, newVal: number | null) => {
    if (oldVal === null || newVal === null) return null;
    const diff = newVal - oldVal;
    const pct = oldVal !== 0 ? ((diff / oldVal) * 100).toFixed(1) : "∞";
    if (diff > 0) {
      return (
        <Badge variant="outline" className="text-green-600 border-green-300 text-xs">
          <ArrowUp className="h-3 w-3 mr-0.5" />+{pct}%
        </Badge>
      );
    }
    if (diff < 0) {
      return (
        <Badge variant="outline" className="text-red-600 border-red-300 text-xs">
          <ArrowDown className="h-3 w-3 mr-0.5" />{pct}%
        </Badge>
      );
    }
    return null;
  };

  return (
    <div className="space-y-4">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <Card>
          <CardContent className="pt-4 pb-3">
            <Select value={timeRange} onValueChange={(v: "12h" | "today" | "week" | "month") => { setTimeRange(v); setPage(0); }}>
              <SelectTrigger className="mb-1 h-7 text-xs w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="12h">Last 12 Hours</SelectItem>
                <SelectItem value="today">Today</SelectItem>
                <SelectItem value="week">This Week</SelectItem>
                <SelectItem value="month">This Month</SelectItem>
              </SelectContent>
            </Select>
            <div className="text-2xl font-bold text-foreground">{rangeCount}</div>
            <div className="text-xs text-muted-foreground">
              Changes {timeRange === "12h" ? "Last 12h" : timeRange === "today" ? "Today" : timeRange === "week" ? "This Week" : "This Month"}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-2xl font-bold text-foreground">
                  {uniqueAsinCount}
                </div>
                <div className="text-xs text-muted-foreground">Unique ASINs</div>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-8 px-2"
                onClick={() => {
                  const uniqueAsins = [...new Set(changes.map(c => c.asin))];
                  if (uniqueAsins.length === 0) return;
                  navigator.clipboard.writeText(uniqueAsins.join(", "));
                  toast.success(`Copied ${uniqueAsins.length} ASINs to clipboard`);
                }}
              >
                <Copy className="h-3.5 w-3.5 mr-1" />
                Copy
              </Button>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="text-2xl font-bold text-foreground">
              {lastHourCount}
            </div>
            <div className="text-xs text-muted-foreground">Last Hour</div>
          </CardContent>
        </Card>
        <Card className="col-span-2">
          <CardContent className="pt-4 pb-3">
            <div className="flex items-center gap-1.5 mb-1">
              <Clock className="h-4 w-4 text-primary" />
              <span className="text-xs font-medium text-muted-foreground">Hours Worked {timeRange === "12h" ? "Last 12h" : timeRange === "today" ? "Today" : timeRange === "week" ? "This Week" : "This Month"}</span>
            </div>
            {hoursWorked.length === 0 ? (
              <div className="text-sm text-muted-foreground">No activity</div>
            ) : (
              <div className="space-y-1">
                {hoursWorked.map((u) => {
                  return (
                  <div key={u.email} className={`flex items-center justify-between text-sm cursor-pointer rounded px-1 -mx-1 hover:bg-accent ${deviceFilter === u.email ? 'bg-accent ring-1 ring-primary' : ''}`}
                    onClick={() => { setDeviceFilter(deviceFilter === u.email ? "all" : u.email); setPage(0); }}>
                    <span className="truncate text-foreground font-medium" title={u.email}>{u.email}</span>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-foreground">{u.hours}h</span>
                      <Badge variant="secondary" className="text-xs">{u.changes}</Badge>
                    </div>
                   </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">Change History</CardTitle>
            <div className="flex gap-2">
              {selectedIds.size > 0 && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      const selectedAsins = [...new Set(
                        changes.filter(c => selectedIds.has(c.id)).map(c => c.asin)
                      )];
                      if (selectedAsins.length === 0) return;
                      navigator.clipboard.writeText(selectedAsins.join(", "));
                      toast.success(`Copied ${selectedAsins.length} ASINs from ${selectedIds.size} selected records`);
                    }}
                  >
                    <Copy className="h-4 w-4 mr-1" />
                    Copy {selectedIds.size} → ASINs
                  </Button>
                  <Button variant="destructive" size="sm" onClick={handleDeleteSelected} disabled={deleting}>
                    <Trash2 className="h-4 w-4 mr-1" />
                    Delete {selectedIds.size}
                  </Button>
                </>
              )}
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="outline" size="sm" className="text-destructive border-destructive/30 hover:bg-destructive/10">
                    <Trash2 className="h-4 w-4 mr-1" />
                    Clear {fieldFilter !== "all" || sourceFilter !== "all" || searchTerm ? "Filtered" : "All"}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Clear Change History?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will permanently delete {fieldFilter !== "all" || sourceFilter !== "all" || searchTerm
                        ? "all records matching your current filters"
                        : "ALL change history records"}. This action cannot be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={handleClearAll} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                      Delete
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              <Button variant="outline" size="sm" onClick={fetchChanges} disabled={loading}>
                <RefreshCw className={`h-4 w-4 mr-1 ${loading ? "animate-spin" : ""}`} />
                Refresh
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2 mb-4">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search ASIN or SKU..."
                value={searchTerm}
                onChange={e => { setSearchTerm(e.target.value); setPage(0); }}
                className="pl-8"
              />
            </div>
            <Select value={fieldFilter} onValueChange={v => { setFieldFilter(v); setPage(0); }}>
              <SelectTrigger className="w-[150px]">
                <Filter className="h-4 w-4 mr-1" />
                <SelectValue placeholder="Field" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Fields</SelectItem>
                <SelectItem value="min_price_override">Min Price</SelectItem>
                <SelectItem value="max_price_override">Max Price</SelectItem>
                <SelectItem value="my_price">Set Price</SelectItem>
                <SelectItem value="new_price">New Price</SelectItem>
                <SelectItem value="min_roi_override">Min ROI</SelectItem>
              </SelectContent>
            </Select>
            <Select value={sourceFilter} onValueChange={v => { setSourceFilter(v); setPage(0); }}>
              <SelectTrigger className="w-[160px]">
                <SelectValue placeholder="Source" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Sources</SelectItem>
                <SelectItem value="ui">Manual Edit</SelectItem>
                <SelectItem value="bulk">Bulk Update</SelectItem>
                <SelectItem value="retrieve_price">Retrieve Price</SelectItem>
                <SelectItem value="retrieve_roi">Retrieve ROI</SelectItem>
                <SelectItem value="set_price">Set Price</SelectItem>
                <SelectItem value="save_to_amazon">Save to Amazon</SelectItem>
              </SelectContent>
            </Select>
            {availableUsers.length > 0 && (
              <Select value={userFilter} onValueChange={v => { setUserFilter(v); setPage(0); }}>
                <SelectTrigger className="w-[180px]">
                  <SelectValue placeholder="User" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="mine">My Changes</SelectItem>
                  <SelectItem value="all">All Users</SelectItem>
                  {availableUsers.map(u => (
                    <SelectItem key={u.id} value={u.id}>{u.email}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {deviceFilter !== "all" && (
              <Badge variant="outline" className="cursor-pointer gap-1" onClick={() => { setDeviceFilter("all"); setPage(0); }}>
                🖥 {deviceFilter.split(" | ")[deviceFilter.split(" | ").length - 1]}
                <span className="text-destructive ml-1">✕</span>
              </Badge>
            )}
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">
                  <input
                    type="checkbox"
                    checked={changes.length > 0 && selectedIds.size === changes.length}
                    onChange={toggleSelectAll}
                    className="rounded border-border"
                  />
                </TableHead>
                <TableHead>Time</TableHead>
                <TableHead>ASIN</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead>Marketplace</TableHead>
                <TableHead>Field</TableHead>
                <TableHead className="text-right">Old Value</TableHead>
                <TableHead className="text-right">New Value</TableHead>
                <TableHead>Change</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Computer</TableHead>
                <TableHead>Reason</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {changes.length === 0 && !loading && (
                <TableRow>
                  <TableCell colSpan={12} className="text-center text-muted-foreground py-8">
                    No changes recorded yet
                  </TableCell>
                </TableRow>
              )}
              {loading && (
                <TableRow>
                  <TableCell colSpan={12} className="text-center text-muted-foreground py-8">
                    Loading...
                  </TableCell>
                </TableRow>
              )}
              {changes.map(c => (
                <TableRow key={c.id} className={selectedIds.has(c.id) ? "bg-muted/50" : ""}>
                  <TableCell>
                    <input
                      type="checkbox"
                      checked={selectedIds.has(c.id)}
                      onChange={() => toggleSelect(c.id)}
                      className="rounded border-border"
                    />
                  </TableCell>
                  <TableCell className="text-xs whitespace-nowrap">
                    {format(new Date(c.created_at), "MMM d, HH:mm:ss")}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{c.asin}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{c.sku || "—"}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-xs">{c.marketplace}</Badge>
                  </TableCell>
                  <TableCell className="text-xs">
                    {FIELD_LABELS[c.field_changed] || c.field_changed}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {formatValue(c.old_value, c.field_changed)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs font-semibold">
                    {formatValue(c.new_value, c.field_changed)}
                  </TableCell>
                  <TableCell>{getChangeBadge(c.old_value, c.new_value)}</TableCell>
                  <TableCell className="text-xs">
                    <Badge variant="secondary" className="text-xs">
                      {SOURCE_LABELS[c.source || "ui"] || c.source}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground max-w-[120px] truncate" title={c.device_info || ""}>
                    {c.device_info || "—"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground max-w-[150px] truncate">
                    {c.reason || "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {/* Pagination */}
          <div className="flex items-center justify-between mt-4">
            <div className="text-sm text-muted-foreground">
              Page {page + 1} · Showing {changes.length} records
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(p => p - 1)}>
                Previous
              </Button>
              <Button variant="outline" size="sm" disabled={changes.length < PAGE_SIZE} onClick={() => setPage(p => p + 1)}>
                Next
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
