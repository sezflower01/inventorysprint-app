import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { useHomeMarketplace } from "@/hooks/use-home-marketplace";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Download, RefreshCw } from "lucide-react";
import Navbar from "@/components/Navbar";

// Use user's local timezone for day boundaries
const USER_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

// Get current year from computer
const CURRENT_YEAR = new Date().getFullYear();

// ============================================================
// SIMPLE DATE UTILITIES - User timezone based, ISO format for DB
// ============================================================

function getTodayLocalDate(): string {
  const now = new Date();
  const localString = now.toLocaleString("en-US", { timeZone: USER_TIMEZONE });
  const local = new Date(localString);
  const y = local.getFullYear();
  const m = String(local.getMonth() + 1).padStart(2, "0");
  const d = String(local.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function addDaysISO(dateStr: string, delta: number): string {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() + delta);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function getWeekBoundsISO(dateStr: string): { start: string; end: string } {
  const d = new Date(dateStr + "T12:00:00");
  const dayOfWeek = d.getDay();
  const startDate = addDaysISO(dateStr, -dayOfWeek);
  const endDate = addDaysISO(dateStr, 6 - dayOfWeek);
  return { start: startDate, end: endDate };
}

function getMonthBoundsISO(dateStr: string): { start: string; end: string } {
  const d = new Date(dateStr + "T12:00:00");
  const y = d.getFullYear();
  const m = d.getMonth();
  const lastDay = new Date(y, m + 1, 0).getDate();
  return {
    start: `${y}-${String(m + 1).padStart(2, "0")}-01`,
    end: `${y}-${String(m + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`
  };
}

function displayUS(dateISO: string): string {
  if (!dateISO) return "";
  const [y, m, d] = dateISO.split("-");
  return `${m}-${d}-${y}`;
}

interface SalesOrder {
  id: string;
  order_id: string;
  asin: string;
  sku: string | null;
  title: string | null;
  image_url: string | null;
  quantity: number;
  sold_price: number;
  total_sale_amount: number;
  referral_fee: number;
  fba_fee: number;
  closing_fee: number;
  total_fees: number;
  unit_cost: number | null;
  total_cost: number | null;
  refund_quantity: number | null;
  refund_amount: number | null;
  roi: number | null;
  order_date: string;
  marketplace: string | null;
  status?: string | null;
}

const MARKETPLACE_OPTIONS = [
  { value: 'US', label: 'USA', flag: '🇺🇸' },
  { value: 'MX', label: 'Mexico', flag: '🇲🇽' },
  { value: 'CA', label: 'Canada', flag: '🇨🇦' },
  { value: 'BR', label: 'Brazil', flag: '🇧🇷' },
];

export default function ReportsAccounting() {
  const { user } = useAuth();
  const { homeMarketplace, isAdmin } = useHomeMarketplace();
  const [sales, setSales] = useState<SalesOrder[]>([]);
  const [dispositionLossByType, setDispositionLossByType] = useState<{
    removal: number;
    disposal: number;
    liquidation: number;
    mfn_return: number;
    other: number;
    total: number;
    units: number;
  }>({ removal: 0, disposal: 0, liquidation: 0, mfn_return: 0, other: 0, total: 0, units: 0 });
  const [loading, setLoading] = useState(false);
  const [dateFilter, setDateFilter] = useState("today");
  const [customStartDate, setCustomStartDate] = useState("");
  const [customEndDate, setCustomEndDate] = useState("");
  const [selectedMarketplaces, setSelectedMarketplaces] = useState<string[]>(['US', 'MX', 'CA', 'BR']);
  const [asinSearch, setAsinSearch] = useState("");

  // DATA-LAYER ISOLATION: Non-admin users see US + NA Remote Fulfillment (CA/MX/BR).
  // Non-NA marketplaces stay admin-only until the multi-currency expansion ships
  // — see .lovable/future-currency-unification.md.
  useEffect(() => {
    if (!isAdmin) {
      const NA_ALLOWED = ["US", "CA", "MX", "BR"];
      if (NA_ALLOWED.includes(homeMarketplace)) {
        setSelectedMarketplaces(NA_ALLOWED);
      } else {
        setSelectedMarketplaces([homeMarketplace]);
      }
    }
  }, [isAdmin, homeMarketplace]);
  
  const topScrollRef = useRef<HTMLDivElement>(null);
  const tableScrollRef = useRef<HTMLDivElement>(null);
  
  // Sorting state
  const [sortField, setSortField] = useState<'date' | 'cost' | 'qty' | 'refund'>('date');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  
  const handleSort = (field: 'date' | 'cost' | 'qty' | 'refund') => {
    if (sortField === field) {
      setSortDirection(prev => prev === 'desc' ? 'asc' : 'desc');
    } else {
      setSortField(field);
      setSortDirection('desc');
    }
  };

  // Sync scroll between top scrollbar and table container
  useEffect(() => {
    const topScroll = topScrollRef.current;
    const tableScroll = tableScrollRef.current;

    if (!topScroll || !tableScroll) return;

    const handleTopScroll = () => {
      tableScroll.scrollLeft = topScroll.scrollLeft;
    };

    const handleTableScroll = () => {
      topScroll.scrollLeft = tableScroll.scrollLeft;
    };

    topScroll.addEventListener('scroll', handleTopScroll);
    tableScroll.addEventListener('scroll', handleTableScroll);

    return () => {
      topScroll.removeEventListener('scroll', handleTopScroll);
      tableScroll.removeEventListener('scroll', handleTableScroll);
    };
  }, [sales]);

  const getDateRange = (): { startDate: string; endDate: string } | null => {
    const today = getTodayLocalDate();
    
    let fromDate = today;
    let toDate = today;

    switch (dateFilter) {
      case "today":
        fromDate = today;
        toDate = today;
        break;
      case "yesterday":
        fromDate = addDaysISO(today, -1);
        toDate = fromDate;
        break;
      case "this_week": {
        const { start } = getWeekBoundsISO(today);
        fromDate = start;
        toDate = today;
        break;
      }
      case "last_week": {
        const lastWeekDate = addDaysISO(today, -7);
        const { start, end } = getWeekBoundsISO(lastWeekDate);
        fromDate = start;
        toDate = end;
        break;
      }
      case "this_month": {
        const { start } = getMonthBoundsISO(today);
        fromDate = start;
        toDate = today;
        break;
      }
      case "last_month": {
        const lastMonthDate = addDaysISO(today, -new Date(today + "T12:00:00").getDate());
        const { start, end } = getMonthBoundsISO(lastMonthDate);
        fromDate = start;
        toDate = end;
        break;
      }
      case "this_year": {
        fromDate = `${CURRENT_YEAR}-01-01`;
        toDate = today;
        break;
      }
      case "year_2024":
      case "year_2025":
      case "year_2026":
      case "year_2027":
      case "year_2028": {
        const y = dateFilter.replace("year_", "");
        fromDate = `${y}-01-01`;
        toDate = `${y}-12-31`;
        break;
      }
      case "custom":
        if (!customStartDate || !customEndDate) return null;
        fromDate = customStartDate;
        toDate = customEndDate;
        break;
      default:
        fromDate = today;
        toDate = today;
        break;
    }

    return { startDate: fromDate, endDate: toDate };
  };

  const fetchSalesData = useCallback(async () => {
    if (!user) return;

    const dateRange = getDateRange();
    if (!dateRange) return;

    console.log(`[ReportsAccounting] Fetching settled orders from ${dateRange.startDate} to ${dateRange.endDate}`);

    setLoading(true);
    try {
      // Fetch ALL settled orders using pagination (Supabase defaults to 1000 limit)
      const PAGE_SIZE = 1000;
      let allSales: SalesOrder[] = [];
      let offset = 0;
      let hasMore = true;

      while (hasMore) {
        // Build base query with all filters applied before range
        let query = supabase
          .from("sales_orders")
          .select("*")
          .eq("user_id", user.id)
          .eq("status", "settled")
          .gte("order_date", dateRange.startDate)
          .lte("order_date", dateRange.endDate);
        
        // Apply ASIN filter if provided
        if (asinSearch.trim()) {
          query = query.ilike("asin", `%${asinSearch.trim()}%`);
        }
        
        // Apply marketplace filter - use .in() for cleaner filtering
        if (selectedMarketplaces.length > 0 && selectedMarketplaces.length < 4) {
          if (selectedMarketplaces.includes('US')) {
            // US includes null marketplace (legacy data)
            query = query.or(`marketplace.in.(${selectedMarketplaces.join(',')}),marketplace.is.null`);
          } else {
            query = query.in("marketplace", selectedMarketplaces);
          }
        }
        
        // Apply ordering and pagination last
        const { data, error } = await query
          .order("order_date", { ascending: false })
          // order_date is not unique, so it cannot order pages on its own:
          // a tie spanning a page boundary repeats or skips rows. id breaks it.
          .order("id", { ascending: true })
          .range(offset, offset + PAGE_SIZE - 1);

        if (error) throw error;
        
        if (data && data.length > 0) {
          const pageRefunds = data.reduce((sum, s) => sum + (s.refund_amount || 0), 0);
          console.log(`[ReportsAccounting] Page ${Math.floor(offset / PAGE_SIZE) + 1}: ${data.length} records, $${pageRefunds.toFixed(2)} refunds`);
          allSales = [...allSales, ...data];
          offset += PAGE_SIZE;
          hasMore = data.length === PAGE_SIZE;
        } else {
          console.log(`[ReportsAccounting] No more data at offset ${offset}`);
          hasMore = false;
        }
      }
      
      const totalRefunds = allSales.reduce((sum, s) => sum + (s.refund_amount || 0), 0);
      console.log(`[ReportsAccounting] TOTAL: ${allSales.length} orders, $${totalRefunds.toFixed(2)} in refunds from ${dateRange.startDate} to ${dateRange.endDate}`);
      setSales(allSales);

      // Fetch Inventory Disposition Loss for the same period.
      // Loss combines:
      //   • Amazon-reported loss (unsellable × cost − recovery), excluded when business outcome takes over
      //   • Business loss for removed/restricted batches with an outcome of disposed/sold_elsewhere/
      //     partial_recovery/restricted_unsold — full batch cost net of recovery.
      // Only accepted/adjusted rows count toward the P&L.
      try {
        const { data: dispRows, error: dispErr } = await supabase
          .from("inventory_dispositions")
          .select("disposition_type, sellable_qty, unsellable_qty, unit_cost, recovery_amount, status, outcome")
          .eq("user_id", user.id)
          .gte("disposition_date", dateRange.startDate)
          .lte("disposition_date", dateRange.endDate)
          .in("status", ["accepted", "adjusted"]);

        if (dispErr) throw dispErr;

        const businessOutcomes = new Set(["sold_elsewhere", "disposed", "partial_recovery", "restricted_unsold"]);
        const acc = { removal: 0, disposal: 0, liquidation: 0, mfn_return: 0, other: 0, total: 0, units: 0 };
        (dispRows || []).forEach((r: any) => {
          const sellable = Number(r.sellable_qty || 0);
          const unsellable = Number(r.unsellable_qty || 0);
          const cost = Number(r.unit_cost || 0);
          const recovery = Number(r.recovery_amount || 0);
          const outcome = String(r.outcome || "pending");

          let loss = 0;
          let countedUnits = 0;
          if (businessOutcomes.has(outcome)) {
            // Whole batch is the loss (net of any recovery).
            loss = Math.max(0, (sellable + unsellable) * cost - recovery);
            countedUnits = sellable + unsellable;
          } else {
            // Standard Amazon-reported loss (unsellable only, net of recovery).
            loss = Math.max(0, unsellable * cost - recovery);
            countedUnits = unsellable;
          }

          const t = String(r.disposition_type || "").toLowerCase();
          if (t === "removal") acc.removal += loss;
          else if (t === "disposal") acc.disposal += loss;
          else if (t === "liquidation") acc.liquidation += loss;
          else if (t === "mfn_return") acc.mfn_return += loss;
          else acc.other += loss;
          acc.total += loss;
          acc.units += countedUnits;
        });
        setDispositionLossByType(acc);
        console.log(`[ReportsAccounting] Disposition Loss total: $${acc.total.toFixed(2)} across ${acc.units} units`);
      } catch (e) {
        console.warn("[ReportsAccounting] Could not load disposition losses:", e);
        setDispositionLossByType({ removal: 0, disposal: 0, liquidation: 0, mfn_return: 0, other: 0, total: 0, units: 0 });
      }
    } catch (error) {
      console.error("Error fetching sales:", error);
      toast.error("Failed to fetch sales data");
    } finally {
      setLoading(false);
    }
  }, [user, dateFilter, customStartDate, customEndDate, selectedMarketplaces, asinSearch]);

  // Trigger fetch when dependencies change
  useEffect(() => {
    if (user) {
      fetchSalesData();
    }
  }, [fetchSalesData]);

  const exportToCSV = () => {
    if (sales.length === 0) {
      toast.error("No sales data to export");
      return;
    }

    const headers = [
      "Order ID", "Date", "ASIN", "SKU", "Title", "Quantity",
      "Sold Price", "Total Sale", "Referral Fee", "FBA Fee", "Closing Fee",
      "Total Fees", "Unit Cost", "Total Cost", "Refund Qty", "Refund Amount", "ROI %",
    ];

    const rows = sales.map((sale) => [
      sale.order_id, sale.order_date, sale.asin, sale.sku || "",
      `"${(sale.title || "").replace(/"/g, '""')}"`, sale.quantity,
      sale.sold_price.toFixed(2), sale.total_sale_amount.toFixed(2),
      sale.referral_fee.toFixed(2), sale.fba_fee.toFixed(2), sale.closing_fee.toFixed(2),
      sale.total_fees.toFixed(2), sale.unit_cost?.toFixed(2) || "0.00",
      sale.total_cost?.toFixed(2) || "0.00", sale.refund_quantity || 0,
      sale.refund_amount?.toFixed(2) || "0.00", sale.roi?.toFixed(2) || "0.00",
    ]);

    // Add totals row
    const totals = sales.reduce(
      (acc, sale) => ({
        totalSales: acc.totalSales + sale.total_sale_amount,
        totalFees: acc.totalFees + sale.total_fees,
        totalCost: acc.totalCost + (sale.total_cost || 0),
        totalRefunds: acc.totalRefunds + (sale.refund_amount || 0),
        totalQuantity: acc.totalQuantity + sale.quantity,
      }),
      { totalSales: 0, totalFees: 0, totalCost: 0, totalRefunds: 0, totalQuantity: 0 }
    );
    const netProfit = totals.totalSales - totals.totalFees - totals.totalCost - totals.totalRefunds - dispositionLossByType.total;
    const overallRoi = totals.totalCost > 0 ? (netProfit / totals.totalCost) * 100 : 0;

    rows.push([
      "TOTALS", "", "", "", "", totals.totalQuantity.toString(),
      "", totals.totalSales.toFixed(2), "", "", "",
      totals.totalFees.toFixed(2), "",
      totals.totalCost.toFixed(2), "",
      totals.totalRefunds.toFixed(2), overallRoi.toFixed(2),
    ]);

    const csvContent = [headers, ...rows].map((row) => row.join(",")).join("\n");
    const blob = new Blob([csvContent], { type: "text/csv" });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `accounting-report-${getTodayLocalDate()}.csv`;
    a.click();
    window.URL.revokeObjectURL(url);
  };

  // Calculate totals for settled orders
  const totals = useMemo(() => sales.reduce(
    (acc, sale) => ({
      totalSales: acc.totalSales + sale.total_sale_amount,
      totalFees: acc.totalFees + sale.total_fees,
      totalCost: acc.totalCost + (sale.total_cost || 0),
      totalRefunds: acc.totalRefunds + (sale.refund_amount || 0),
      totalProfit: acc.totalProfit + (sale.total_sale_amount - sale.total_fees - (sale.total_cost || 0) - (sale.refund_amount || 0)),
    }),
    { totalSales: 0, totalFees: 0, totalCost: 0, totalRefunds: 0, totalProfit: 0 }
  ), [sales]);
  
  // Net Profit must subtract Inventory Disposition Loss as a standard P&L category
  const netProfitAfterDispositions = totals.totalProfit - dispositionLossByType.total;
  const overallRoi = totals.totalCost > 0 ? (netProfitAfterDispositions / totals.totalCost) * 100 : 0;

  // Memoize sorted sales to prevent re-sorting on every render
  const sortedSales = useMemo(() => {
    return [...sales].sort((a, b) => {
      if (sortField === 'cost') {
        const costA = a.unit_cost || 0;
        const costB = b.unit_cost || 0;
        return sortDirection === 'desc' ? costB - costA : costA - costB;
      }
      if (sortField === 'qty') {
        return sortDirection === 'desc' ? b.quantity - a.quantity : a.quantity - b.quantity;
      }
      if (sortField === 'refund') {
        const refundA = a.refund_amount || 0;
        const refundB = b.refund_amount || 0;
        return sortDirection === 'desc' ? refundB - refundA : refundA - refundB;
      }
      // Default: date
      const dateA = new Date(a.order_date).getTime();
      const dateB = new Date(b.order_date).getTime();
      return sortDirection === 'desc' ? dateB - dateA : dateA - dateB;
    });
  }, [sales, sortField, sortDirection]);

  return (
    <>
      <Navbar />
      <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h1 className="text-3xl font-bold">Reports & Accounting</h1>
          <span className="text-sm text-muted-foreground bg-green-500/20 text-green-500 px-2 py-1 rounded">
            Settled Orders Only
          </span>
        </div>
        <div className="flex gap-2 flex-wrap items-center">
          <Button onClick={fetchSalesData} disabled={loading} variant="outline">
            <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          
          <Button variant="outline" onClick={exportToCSV}>
            <Download className="mr-2 h-4 w-4" />
            Export CSV
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Date Filter</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-4 items-end flex-wrap">
            <div className="flex-1 min-w-[200px]">
              <label className="text-sm font-medium mb-2 block">Time Period</label>
              <Select value={dateFilter} onValueChange={setDateFilter}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="today">Today</SelectItem>
                  <SelectItem value="yesterday">Yesterday</SelectItem>
                  <SelectItem value="this_week">This Week</SelectItem>
                  <SelectItem value="last_week">Last Week</SelectItem>
                  <SelectItem value="this_month">This Month</SelectItem>
                  <SelectItem value="last_month">Last Month</SelectItem>
                  <SelectItem value="this_year">This Year ({CURRENT_YEAR})</SelectItem>
                  <SelectItem value="year_2024">Year 2024</SelectItem>
                  <SelectItem value="year_2025">Year 2025</SelectItem>
                  <SelectItem value="year_2026">Year 2026</SelectItem>
                  <SelectItem value="year_2027">Year 2027</SelectItem>
                  <SelectItem value="year_2028">Year 2028</SelectItem>
                  <SelectItem value="custom">Custom Range</SelectItem>
                </SelectContent>
              </Select>
            </div>
            
            {dateFilter === "custom" && (
              <>
                <div className="min-w-[150px]">
                  <label className="text-sm font-medium mb-2 block">Start Date</label>
                  <Input
                    type="date"
                    value={customStartDate}
                    onChange={(e) => setCustomStartDate(e.target.value)}
                  />
                </div>
                <div className="min-w-[150px]">
                  <label className="text-sm font-medium mb-2 block">End Date</label>
                  <Input
                    type="date"
                    value={customEndDate}
                    onChange={(e) => setCustomEndDate(e.target.value)}
                  />
                </div>
              </>
            )}
            
            <div className="min-w-[150px]">
              <label className="text-sm font-medium mb-2 block">Search ASIN</label>
              <Input
                placeholder="Enter ASIN..."
                value={asinSearch}
                onChange={(e) => setAsinSearch(e.target.value)}
              />
            </div>
            
            {isAdmin && (
            <div className="flex-1 min-w-[200px]">
              <label className="text-sm font-medium mb-2 block">Marketplaces</label>
              <div className="flex flex-wrap gap-2">
                {MARKETPLACE_OPTIONS.map((mp) => (
                  <label key={mp.value} className="flex items-center gap-1 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedMarketplaces.includes(mp.value)}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setSelectedMarketplaces([...selectedMarketplaces, mp.value]);
                        } else {
                          setSelectedMarketplaces(selectedMarketplaces.filter(m => m !== mp.value));
                        }
                      }}
                      className="w-4 h-4"
                    />
                    <span className="text-sm">{mp.flag} {mp.label}</span>
                  </label>
                ))}
              </div>
            </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Summary Card */}
      <Card className="border-green-500/50">
        <CardHeader className="pb-2">
          <CardTitle className="text-lg flex items-center gap-2">
            <span className="w-3 h-3 rounded-full bg-green-500"></span>
            Settled Orders Summary ({sales.length} orders)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-6 gap-4 text-sm">
            <div>
              <p className="text-muted-foreground">Total Sales</p>
              <p className="text-xl font-bold">${totals.totalSales.toFixed(2)}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Total Fees</p>
              <p className="text-xl font-bold text-red-500">${totals.totalFees.toFixed(2)}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Total Cost</p>
              <p className="text-xl font-bold text-orange-500">${totals.totalCost.toFixed(2)}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Total Refunds</p>
              <p className="text-xl font-bold text-purple-500">${totals.totalRefunds.toFixed(2)}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Net Profit</p>
              <p className={`text-xl font-bold ${netProfitAfterDispositions >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                {netProfitAfterDispositions >= 0 ? '' : '-'}${Math.abs(netProfitAfterDispositions).toFixed(2)}
              </p>
              {dispositionLossByType.total > 0 && (
                <p className="text-[10px] text-muted-foreground mt-1">
                  incl. -${dispositionLossByType.total.toFixed(2)} disposition loss
                </p>
              )}
            </div>
            <div>
              <p className="text-muted-foreground">ROI</p>
              <p className={`text-xl font-bold ${overallRoi >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                {overallRoi >= 0 ? '' : '-'}{Math.abs(overallRoi).toFixed(1)}%
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* P&L Statement (Standard Categories) */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-lg">Profit &amp; Loss Statement</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-1 text-sm font-mono max-w-xl">
            <div className="flex justify-between py-1">
              <span>Revenue</span>
              <span className="font-semibold">${totals.totalSales.toFixed(2)}</span>
            </div>
            <div className="flex justify-between py-1 text-orange-500">
              <span>– Cost of Goods Sold (COGS)</span>
              <span>-${totals.totalCost.toFixed(2)}</span>
            </div>
            <div className="flex justify-between py-1 border-t border-border pt-2">
              <span className="font-semibold">= Gross Profit</span>
              <span className="font-semibold">${(totals.totalSales - totals.totalCost).toFixed(2)}</span>
            </div>
            <div className="flex justify-between py-1 text-red-500 mt-2">
              <span>– Amazon Fees</span>
              <span>-${totals.totalFees.toFixed(2)}</span>
            </div>
            <div className="flex justify-between py-1 text-purple-500">
              <span>– Refunds</span>
              <span>-${totals.totalRefunds.toFixed(2)}</span>
            </div>

            {/* Inventory Disposition Loss — standard category with sub-breakdown */}
            <div className="mt-2 border border-red-500/30 rounded p-2 bg-red-500/5">
              <div className="flex justify-between font-semibold text-red-500">
                <span>– Inventory Disposition Loss</span>
                <span>-${dispositionLossByType.total.toFixed(2)}</span>
              </div>
              <div className="ml-4 mt-1 space-y-0.5 text-xs text-muted-foreground">
                <div className="flex justify-between"><span>• Removal Loss</span><span>-${dispositionLossByType.removal.toFixed(2)}</span></div>
                <div className="flex justify-between"><span>• Disposal Loss</span><span>-${dispositionLossByType.disposal.toFixed(2)}</span></div>
                <div className="flex justify-between"><span>• Liquidation Loss</span><span>-${dispositionLossByType.liquidation.toFixed(2)}</span></div>
                <div className="flex justify-between"><span>• MFN Return Loss</span><span>-${dispositionLossByType.mfn_return.toFixed(2)}</span></div>
                {dispositionLossByType.other > 0 && (
                  <div className="flex justify-between"><span>• Other</span><span>-${dispositionLossByType.other.toFixed(2)}</span></div>
                )}
                <div className="text-[10px] mt-1 italic">
                  Accepted/adjusted dispositions · {dispositionLossByType.units} units written off (Amazon-reported unsellable + business outcomes: disposed / sold elsewhere / restricted) · tax-deductible inventory write-off
                </div>
              </div>
            </div>

            <div className="flex justify-between py-2 border-t-2 border-border mt-2 text-base">
              <span className="font-bold">= Net Profit</span>
              <span className={`font-bold ${netProfitAfterDispositions >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                {netProfitAfterDispositions >= 0 ? '' : '-'}${Math.abs(netProfitAfterDispositions).toFixed(2)}
              </span>
            </div>
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>ROI</span>
              <span className={overallRoi >= 0 ? 'text-green-500' : 'text-red-500'}>
                {overallRoi >= 0 ? '' : '-'}{Math.abs(overallRoi).toFixed(1)}%
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Sales Table */}
      <Card>
        <CardHeader>
          <CardTitle>Settled Orders ({sales.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex justify-center items-center py-12">
              <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : sales.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">No settled orders found for the selected period</p>
          ) : (
            <>
              {/* Top scrollbar */}
              <div ref={topScrollRef} className="overflow-x-auto mb-2" style={{ height: '20px' }}>
                <div style={{ width: '2000px', height: '1px' }}></div>
              </div>
              
              <div ref={tableScrollRef} className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[80px]">Image</TableHead>
                      <TableHead>ASIN</TableHead>
                      <TableHead>Title</TableHead>
                      <TableHead 
                        className="text-right cursor-pointer hover:bg-muted/50"
                        onClick={() => handleSort('qty')}
                      >
                        Qty {sortField === 'qty' ? (sortDirection === 'desc' ? '↓' : '↑') : ''}
                      </TableHead>
                      <TableHead className="text-right">Price</TableHead>
                      <TableHead className="text-right">Fees</TableHead>
                      <TableHead 
                        className="text-right cursor-pointer hover:bg-muted/50"
                        onClick={() => handleSort('cost')}
                      >
                        Unit Cost {sortField === 'cost' ? (sortDirection === 'desc' ? '↓' : '↑') : ''}
                      </TableHead>
                      <TableHead className="text-right">ROI</TableHead>
                      <TableHead 
                        className="text-right cursor-pointer hover:bg-muted/50"
                        onClick={() => handleSort('refund')}
                      >
                        Refund {sortField === 'refund' ? (sortDirection === 'desc' ? '↓' : '↑') : ''}
                      </TableHead>
                      <TableHead 
                        className="text-center cursor-pointer hover:bg-muted/50"
                        onClick={() => handleSort('date')}
                      >
                        Date {sortField === 'date' ? (sortDirection === 'desc' ? '↓' : '↑') : ''}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sortedSales.map((sale) => (
                        <TableRow key={sale.id}>
                          <TableCell>
                            {sale.image_url ? (
                              <img
                                src={sale.image_url}
                                alt={sale.title || sale.asin}
                                className="w-12 h-12 object-contain rounded"
                              />
                            ) : (
                              <div className="w-12 h-12 bg-muted rounded flex items-center justify-center text-xs text-muted-foreground">
                                No img
                              </div>
                            )}
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            <a
                              href={`https://www.amazon.com/dp/${sale.asin}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="hover:underline text-blue-500"
                            >
                              {sale.asin}
                            </a>
                          </TableCell>
                          <TableCell className="max-w-[200px] truncate" title={sale.title || ''}>
                            {sale.title || 'N/A'}
                          </TableCell>
                          <TableCell className="text-right">{sale.quantity}</TableCell>
                          <TableCell className="text-right">${sale.sold_price.toFixed(2)}</TableCell>
                          <TableCell className="text-right text-red-500">${Math.abs(sale.total_fees).toFixed(2)}</TableCell>
                          <TableCell className="text-right">${sale.unit_cost?.toFixed(2) || '0.00'}</TableCell>
                          <TableCell className={`text-right font-medium ${(sale.roi || 0) >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                            {sale.roi?.toFixed(1) || '0.0'}%
                          </TableCell>
                          <TableCell className="text-right text-purple-500">
                            {(sale.refund_quantity || 0) > 0 ? (
                              <span>-{sale.refund_quantity} (${sale.refund_amount?.toFixed(2) || '0.00'})</span>
                            ) : (
                              '-'
                            )}
                          </TableCell>
                          <TableCell className="text-center text-xs">{displayUS(sale.order_date)}</TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>
      </div>
    </>
  );
}
