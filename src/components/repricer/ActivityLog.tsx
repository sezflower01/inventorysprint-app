import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RefreshCw, History, ArrowUp, ArrowDown, Minus, DollarSign, TrendingDown, TrendingUp, AlertCircle, Clock, KeyRound, Ban, HelpCircle, Calendar, ExternalLink, ChevronLeft, ChevronRight } from "lucide-react";
import { format } from "date-fns";
import { SafeguardBadge, humanizePriorityEval } from "./ActionLogDialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { translateErrorMessage } from "@/lib/errorTranslator";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

// Extract safeguard flags from reason string or intelligence_factors
function extractSafeguards(reason: string | null, factors: any): string[] {
  const safeguards: string[] = [];
  
  if (reason) {
    const reasonLower = reason.toLowerCase();
    if (reasonLower.includes("clamp") || reasonLower.includes("clamped")) {
      if (reasonLower.includes("max")) safeguards.push("CLAMPED_MAX");
      if (reasonLower.includes("min")) safeguards.push("CLAMPED_MIN");
    }
    if (reasonLower.includes("jump limit") || reasonLower.includes("jump_limit")) {
      safeguards.push("JUMP_LIMITED");
    }
    if (reasonLower.includes("step limit") || reasonLower.includes("max step") || reasonLower.includes("max_step")) {
      safeguards.push("STEP_LIMITED");
    }
    if (reasonLower.includes("cooldown")) {
      safeguards.push("COOLDOWN");
    }
    if (reasonLower.includes("abort") || reasonLower.includes("safety")) {
      safeguards.push("SAFETY_ABORT");
    }
    if (reasonLower.includes("profit guard") || reasonLower.includes("profit_guard")) {
      safeguards.push("PROFIT_GUARD");
    }
  }
  
  if (factors) {
    if (factors.guards_applied) {
      safeguards.push(...factors.guards_applied);
    }
    if (factors.finalClampMax || factors.final_clamp_max) safeguards.push("FINAL_CLAMP_MAX");
    if (factors.finalClampMin || factors.final_clamp_min) safeguards.push("FINAL_CLAMP_MIN");
    if (factors.jumpLimited || factors.jump_limited) safeguards.push("JUMP_LIMITED");
    if (factors.stepLimited || factors.step_limited) safeguards.push("STEP_LIMITED");
    if (factors.cooldownApplied || factors.cooldown_applied) safeguards.push("COOLDOWN");
  }
  
  return [...new Set(safeguards)];
}

interface PriceAction {
  id: string;
  asin: string;
  sku: string | null;
  marketplace: string;
  old_price: number | null;
  new_price: number | null;
  old_min_price: number | null;
  new_min_price: number | null;
  old_max_price: number | null;
  new_max_price: number | null;
  action_type: string;
  trigger_source: string;
  reason: string | null;
  intelligence_factors: any | null;
  success: boolean;
  error_message: string | null;
  amazon_response: any | null;
  created_at: string;
  error_type: string | null;
  amazon_error_code: string | null;
  update_method: string | null;
  feed_id: string | null;
}

const MARKETPLACE_DOMAINS: Record<string, string> = {
  US: "amazon.com",
  CA: "amazon.ca",
  MX: "amazon.com.mx",
  UK: "amazon.co.uk",
  DE: "amazon.de",
  FR: "amazon.fr",
  IT: "amazon.it",
  ES: "amazon.es",
  BR: "amazon.com.br",
  JP: "amazon.co.jp",
  AU: "amazon.com.au",
  IN: "amazon.in",
  NL: "amazon.nl",
  SE: "amazon.se",
  PL: "amazon.pl",
  BE: "amazon.com.be",
  SG: "amazon.sg",
};

function getAmazonLink(asin: string, marketplace: string): string {
  const domain = MARKETPLACE_DOMAINS[marketplace] || "amazon.com";
  return `https://www.${domain}/dp/${asin}`;
}

const PAGE_SIZE = 100;

export default function ActivityLog() {
  const { user } = useAuth();
  const [actions, setActions] = useState<PriceAction[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [dateFilter, setDateFilter] = useState<string>("today");
  const [page, setPage] = useState(0);
  const [totalCount, setTotalCount] = useState<number | null>(null);


  useEffect(() => {
    if (user) {
      setPage(0);
    }
  }, [user, dateFilter]);

  useEffect(() => {
    if (user) {
      fetchActions();
    }
  }, [user, dateFilter, page]);

  const getDateRange = () => {
    const now = new Date();
    switch (dateFilter) {
      case "today": {
        const start = new Date(now);
        start.setHours(0, 0, 0, 0);
        return start.toISOString();
      }
      case "yesterday": {
        const start = new Date(now);
        start.setDate(start.getDate() - 1);
        start.setHours(0, 0, 0, 0);
        return start.toISOString();
      }
      case "7days":
        return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      case "30days":
        return new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      case "all":
      default:
        return null;
    }
  };

  const fetchActions = async () => {
    try {
      setLoading(true);
      const from = page * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;

      let query = supabase
        .from("repricer_price_actions")
        .select("*", { count: "exact" })
        .order("created_at", { ascending: false })
        // created_at is not unique, so it cannot order pages on its own:
        // a tie spanning a page boundary repeats or skips rows. id breaks it.
        .order("id", { ascending: true })
        .range(from, to);

      const dateStart = getDateRange();
      if (dateStart) {
        query = query.gte("created_at", dateStart);
      }

      const { data, error, count } = await query;

      if (error) throw error;
      setActions((data || []) as PriceAction[]);
      setTotalCount(count);
    } catch (error: any) {
      console.error("Error fetching actions:", error);
    } finally {
      setLoading(false);
    }
  };

  const getStatusBadge = (action: PriceAction) => {
    const { success, action_type, update_method, feed_id } = action;
    
    // For FEED updates: check verification in intelligence_factors
    if (update_method === 'FEED' && success) {
      const verification = action.intelligence_factors?.verification;
      if (verification?.confirmed === true) {
        return <Badge className="bg-green-500">Verified ✓</Badge>;
      }
      if (verification?.confirmed === false) {
        return <Badge className="bg-yellow-500">Unverified</Badge>;
      }
      return <Badge className="bg-blue-500">Submitted (Feed)</Badge>;
    }
    
    if (!success) {
      return <Badge variant="destructive">Failed</Badge>;
    }
    
    switch (action_type) {
      case "price_change":
        return <Badge className="bg-green-500">Price Applied</Badge>;
      case "price_and_minmax_change":
        return <Badge className="bg-blue-500">Price + Bounds</Badge>;
      case "min_set":
      case "min_lower":
        return <Badge className="bg-orange-500">Min Changed</Badge>;
      case "max_set":
      case "max_raise":
        return <Badge className="bg-purple-500">Max Changed</Badge>;
      case "blocked_by_profit_guard":
        return <Badge className="bg-yellow-500">Blocked</Badge>;
      case "no_change":
        return <Badge variant="outline" className="text-muted-foreground">No Change</Badge>;
      default:
        return <Badge className="bg-green-500">Applied</Badge>;
    }
  };

  const getActionIcon = (actionType: string) => {
    switch (actionType) {
      case "min_lower":
        return <TrendingDown className="h-3 w-3 text-orange-500" />;
      case "max_raise":
        return <TrendingUp className="h-3 w-3 text-purple-500" />;
      case "blocked_by_profit_guard":
        return <Ban className="h-3 w-3 text-yellow-500" />;
      case "no_change":
        return <Minus className="h-3 w-3 text-muted-foreground" />;
      default:
        return <DollarSign className="h-3 w-3 text-green-500" />;
    }
  };

  const getPriceChangeIcon = (oldPrice: number | null, newPrice: number | null) => {
    if (oldPrice == null || newPrice == null) return null;
    if (newPrice > oldPrice) return <ArrowUp className="h-3 w-3 text-green-500" />;
    if (newPrice < oldPrice) return <ArrowDown className="h-3 w-3 text-red-500" />;
    return <Minus className="h-3 w-3 text-muted-foreground" />;
  };

  // Error type classification with icons and recommended actions
  const getErrorTypeInfo = (errorType: string | null, errorMessage: string | null) => {
    const type = errorType || inferErrorType(errorMessage);
    
    switch (type) {
      case 'profit_guard':
        return {
          icon: <Ban className="h-3 w-3 text-yellow-500" />,
          label: 'Profit Guard',
          color: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
          action: 'Increase min price target (profit floor), or fix unit cost/fees so the profit floor drops'
        };
      case 'rate_limit':
        return {
          icon: <Clock className="h-3 w-3 text-yellow-500" />,
          label: 'Rate Limited',
          color: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
          action: 'Wait 30s and retry automatically'
        };
      case 'auth_expired':
        return {
          icon: <KeyRound className="h-3 w-3 text-red-500" />,
          label: 'Auth Expired',
          color: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
          action: 'Re-authorize Amazon connection'
        };
      case 'min_max_mismatch':
        return {
          icon: <AlertCircle className="h-3 w-3 text-orange-500" />,
          label: 'Bounds Mismatch',
          color: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200',
          action: 'Sync Min/Max from Amazon'
        };
      case 'listing_suppressed':
        return {
          icon: <Ban className="h-3 w-3 text-purple-500" />,
          label: 'Listing Suppressed',
          color: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
          action: 'Check listing health in Seller Central'
        };
      case 'fair_pricing':
        return {
          icon: <AlertCircle className="h-3 w-3 text-red-500" />,
          label: 'Fair Pricing',
          color: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
          action: 'Reset to safe price or adjust bounds'
        };
      default:
        return errorMessage ? {
          icon: <HelpCircle className="h-3 w-3 text-muted-foreground" />,
          label: 'Error',
          color: 'bg-muted text-muted-foreground',
          action: 'Review error details'
        } : null;
    }
  };
  
  // Infer error type from error message if not classified
  const inferErrorType = (message: string | null): string | null => {
    if (!message) return null;
    const msg = message.toLowerCase();
    if (msg.includes('price_below_effective_floor') || msg.includes('profit_guard') || msg.includes('effective floor')) return 'profit_guard';
    if (msg.includes('429') || msg.includes('rate') || msg.includes('throttl')) return 'rate_limit';
    if (msg.includes('401') || msg.includes('403') || msg.includes('auth') || msg.includes('token')) return 'auth_expired';
    if (msg.includes('min') && msg.includes('max')) return 'min_max_mismatch';
    if (msg.includes('suppressed') || msg.includes('inactive')) return 'listing_suppressed';
    if (msg.includes('fair pricing') || msg.includes('policy')) return 'fair_pricing';
    return null;
  };

  const filteredActions = actions.filter((a) => {
    const matchesSearch =
      a.asin.toLowerCase().includes(searchTerm.toLowerCase()) ||
      a.sku?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      a.reason?.toLowerCase().includes(searchTerm.toLowerCase());

    const matchesStatus = 
      statusFilter === "all" || 
      (statusFilter === "success" && a.success && a.action_type !== 'no_change') ||
      (statusFilter === "failed" && !a.success) ||
      (statusFilter === "no_change" && a.action_type === 'no_change') ||
      (statusFilter === "changes_only" && a.success && a.action_type !== 'no_change');

    return matchesSearch && matchesStatus;
  });

  const formatMinMax = (action: PriceAction) => {
    const parts: string[] = [];
    
    if (action.new_min_price != null) {
      const oldMin = action.old_min_price != null ? `$${action.old_min_price.toFixed(2)}` : 'N/A';
      parts.push(`Min: ${oldMin} → $${action.new_min_price.toFixed(2)}`);
    }
    
    if (action.new_max_price != null) {
      const oldMax = action.old_max_price != null ? `$${action.old_max_price.toFixed(2)}` : 'N/A';
      parts.push(`Max: ${oldMax} → $${action.new_max_price.toFixed(2)}`);
    }
    
    return parts.join(' | ');
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-lg flex items-center gap-2">
          <History className="h-5 w-5" />
          Activity Log (Price Actions Audit Trail)
        </CardTitle>
        <Button variant="outline" size="sm" onClick={fetchActions}>
          <RefreshCw className="h-4 w-4" />
        </Button>
      </CardHeader>
      <CardContent>


        {/* Filters */}
        <div className="flex gap-2 mb-4 flex-wrap">
          <Input
            placeholder="Search ASIN, SKU, reason..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="max-w-xs"
          />
          <Select value={dateFilter} onValueChange={setDateFilter}>
            <SelectTrigger className="w-[140px]">
              <Calendar className="h-3.5 w-3.5 mr-1" />
              <SelectValue placeholder="Date Range" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="today">Today</SelectItem>
              <SelectItem value="yesterday">Yesterday</SelectItem>
              <SelectItem value="7days">Last 7 Days</SelectItem>
              <SelectItem value="30days">Last 30 Days</SelectItem>
              <SelectItem value="all">All Time</SelectItem>
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Actions</SelectItem>
              <SelectItem value="changes_only">Changes Only</SelectItem>
              <SelectItem value="no_change">No Change</SelectItem>
              <SelectItem value="success">Success</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground self-center ml-2">
            {totalCount != null ? `${totalCount} total` : `${filteredActions.length}`} record{(totalCount ?? filteredActions.length) !== 1 ? 's' : ''}
            {totalCount != null && totalCount > PAGE_SIZE && ` · Page ${page + 1} of ${Math.ceil(totalCount / PAGE_SIZE)}`}
          </span>
        </div>

        {loading ? (
          <div className="text-center py-8 text-muted-foreground">Loading...</div>
        ) : filteredActions.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            No price actions recorded yet
          </div>
        ) : (
          <>
          <div className="border rounded-lg overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>ASIN</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead className="text-right">Old</TableHead>
                  <TableHead className="text-right">New</TableHead>
                  <TableHead>Min/Max Changes</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Error Type</TableHead>
                  <TableHead>Safeguards</TableHead>
                  <TableHead>Reason / Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredActions.map((action) => {
                  const safeguards = extractSafeguards(action.reason, action.intelligence_factors);
                  const errorInfo = !action.success ? getErrorTypeInfo(action.error_type, action.error_message) : null;
                  
                  return (
                    <TableRow key={action.id} className={!action.success ? "bg-red-50 dark:bg-red-950/20" : ""}>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                        {format(new Date(action.created_at), "MMM d, HH:mm")}
                      </TableCell>
                      <TableCell>
                        <div className="font-mono text-sm">
                          <a
                            href={getAmazonLink(action.asin, action.marketplace)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-primary hover:underline inline-flex items-center gap-1"
                          >
                            {action.asin}
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        </div>
                        <div className="text-xs text-muted-foreground">{action.sku ? `${action.sku} · ${action.marketplace}` : action.marketplace}</div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1 text-xs">
                          {getActionIcon(action.action_type)}
                          <span className="capitalize">{action.trigger_source}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Badge variant={action.update_method === 'FEED' ? 'secondary' : 'outline'} className="text-xs">
                                {action.update_method || 'PATCH'}
                              </Badge>
                            </TooltipTrigger>
                            {action.feed_id && (
                              <TooltipContent className="max-w-xs">
                                <p className="font-mono text-xs">Feed: {action.feed_id}</p>
                              </TooltipContent>
                            )}
                          </Tooltip>
                        </TooltipProvider>
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {action.old_price != null ? `$${action.old_price.toFixed(2)}` : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          {getPriceChangeIcon(action.old_price, action.new_price)}
                          <span className="font-mono">
                            {action.new_price != null ? `$${action.new_price.toFixed(2)}` : "—"}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="text-xs max-w-[150px]">
                        {formatMinMax(action) || "—"}
                      </TableCell>
                      <TableCell>{getStatusBadge(action)}</TableCell>
                      <TableCell>
                        {errorInfo ? (
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <div className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded ${errorInfo.color}`}>
                                  {errorInfo.icon}
                                  <span>{errorInfo.label}</span>
                                </div>
                              </TooltipTrigger>
                              <TooltipContent className="max-w-xs">
                                <p className="font-medium mb-1">Recommended Action:</p>
                                <p className="text-muted-foreground">{errorInfo.action}</p>
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1 max-w-[120px]">
                          {safeguards.length > 0 ? (
                            safeguards.map((sg, idx) => (
                              <SafeguardBadge key={idx} type={sg} />
                            ))
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="max-w-[400px]">
                        <div className="text-xs whitespace-pre-wrap break-words">
                          {action.action_type === 'priority_eval' 
                            ? humanizePriorityEval(action.reason)
                            : (action.reason || "—")}
                        </div>
                        {action.intelligence_factors?.marketDropPct != null && (
                          <div className="text-xs mt-0.5">
                            <Badge variant="outline" className="text-[10px] px-1 py-0 font-mono">
                              BB ↓${action.intelligence_factors.marketDropAmount?.toFixed(2)} ({action.intelligence_factors.marketDropPct?.toFixed(1)}%)
                            </Badge>
                          </div>
                        )}
                        {action.error_message && (
                          <div className="text-xs text-destructive whitespace-pre-wrap break-words">
                            {translateErrorMessage(action.error_message)}
                          </div>
                        )}
                        {errorInfo && (
                          <div className="text-xs text-blue-600 dark:text-blue-400 mt-1">
                            💡 {errorInfo.action}
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          {/* Pagination */}
          {totalCount != null && totalCount > PAGE_SIZE && (
            <div className="flex items-center justify-between mt-4">
              <span className="text-xs text-muted-foreground">
                Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, totalCount)} of {totalCount}
              </span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(p => p - 1)}>
                  <ChevronLeft className="h-4 w-4 mr-1" /> Previous
                </Button>
                <Button variant="outline" size="sm" disabled={(page + 1) * PAGE_SIZE >= totalCount} onClick={() => setPage(p => p + 1)}>
                  Next <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              </div>
            </div>
          )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
