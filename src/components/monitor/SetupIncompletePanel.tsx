import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { RefreshCw, AlertCircle, Loader2, Zap, Eye, Ban } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import BackfillReviewTable, { type BackfillPreviewRow } from "@/components/monitor/BackfillReviewTable";

interface MarketplaceBreakdown {
  marketplace: string;
  total: number;
  missingMin: number;
  missingRule: number;
}

interface BackfillPreviewResult {
  wouldUpdate: number;
  skipped: number;
  skipReasons: Record<string, number>;
  needsReviewCount: number;
  rows: BackfillPreviewRow[];
}

export default function SetupIncompletePanel({ marketplace }: { marketplace?: string } = {}) {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [totalManaged, setTotalManaged] = useState(0);
  const [incompleteCount, setIncompleteCount] = useState(0);
  const [eligibleCount, setEligibleCount] = useState(0);
  const [breakdowns, setBreakdowns] = useState<MarketplaceBreakdown[]>([]);
  const [topMissingMin, setTopMissingMin] = useState<{ asin: string; sku: string; marketplace: string; hasRule: boolean }[]>([]);

  const [previewing, setPreviewing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [disablingCA, setDisablingCA] = useState(false);
  const [preview, setPreview] = useState<BackfillPreviewResult | null>(null);

  const fetchData = async () => {
    if (!user) return;
    setLoading(true);
    try {
      const PAGE = 1000;
      let all: any[] = [];
      let page = 0;
      while (true) {
        const { data, error } = await supabase
          .from("repricer_assignments")
          .select("asin, sku, marketplace, rule_id, min_price_override, status, is_enabled")
          .eq("user_id", user.id)
          .eq("status", "active")
          .eq("is_enabled", true)
          .order("id", { ascending: true })
          .range(page * PAGE, (page + 1) * PAGE - 1);
        if (error || !data || data.length === 0) break;
        all = all.concat(data);
        if (data.length < PAGE) break;
        page++;
      }

      // Apply marketplace filter if provided
      const filtered = marketplace 
        ? all.filter(a => (a.marketplace || "US") === marketplace)
        : all;

      const usAsinsWithRule = new Set(
        all.filter(a => a.marketplace === "US" && a.rule_id).map(a => a.asin)
      );
      const usAsinsAll = new Set(
        all.filter(a => a.marketplace === "US").map(a => a.asin)
      );

      const managed = filtered.filter(a => {
        const hasRule = !!a.rule_id || (a.marketplace !== "US" && usAsinsWithRule.has(a.asin));
        const hasUsListing = a.marketplace === "US" || usAsinsAll.has(a.asin);
        return hasRule || hasUsListing;
      });

      // Use unique ASIN counts (consistent with top summary card)
      const incompleteUniqueAsins = new Set(
        managed.filter(a => !a.min_price_override || a.min_price_override <= 0).map(a => a.asin)
      );
      const eligibleUniqueAsins = new Set(
        managed.filter(a => a.min_price_override && a.min_price_override > 0).map(a => a.asin)
      );
      const incomplete = managed.filter(a => !a.min_price_override || a.min_price_override <= 0);

      setTotalManaged(managed.length);
      setIncompleteCount(incompleteUniqueAsins.size);
      setEligibleCount(eligibleUniqueAsins.size);

      const mktMap = new Map<string, { total: number; missingMin: number; missingRule: number }>();
      for (const a of incomplete) {
        const mkt = a.marketplace || "US";
        if (!mktMap.has(mkt)) mktMap.set(mkt, { total: 0, missingMin: 0, missingRule: 0 });
        const entry = mktMap.get(mkt)!;
        entry.total++;
        if (!a.min_price_override || a.min_price_override <= 0) entry.missingMin++;
        if (!a.rule_id && !(a.marketplace !== "US" && usAsinsWithRule.has(a.asin))) entry.missingRule++;
      }
      setBreakdowns(
        [...mktMap.entries()]
          .map(([marketplace, s]) => ({ marketplace, ...s }))
          .sort((a, b) => b.total - a.total)
      );

      setTopMissingMin(
        incomplete
          .filter(a => a.marketplace === "US")
          .slice(0, 15)
          .map(a => ({
            asin: a.asin,
            sku: a.sku || "—",
            marketplace: a.marketplace || "US",
            hasRule: !!a.rule_id,
          }))
      );
    } catch (err) {
      console.error("Setup incomplete fetch error:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleDryRun = async () => {
    setPreviewing(true);
    setPreview(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await supabase.functions.invoke("backfill-repricer-min-max", {
        body: { dryRun: true },
        headers: { Authorization: `Bearer ${session?.access_token}` },
      });
      if (res.error) throw new Error(res.error.message);
      setPreview(res.data);
      const reviewCount = res.data.needsReviewCount ?? 0;
      toast.success(
        reviewCount > 0
          ? `Preview ready: ${reviewCount} ASINs need manual review before applying`
          : `Preview ready: ${res.data.wouldUpdate} assignments look safe to review`
      );
    } catch (err: any) {
      toast.error(`Preview failed: ${err.message}`);
    } finally {
      setPreviewing(false);
    }
  };

  const handleApply = async () => {
    setApplying(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await supabase.functions.invoke("backfill-repricer-min-max", {
        body: { dryRun: false },
        headers: { Authorization: `Bearer ${session?.access_token}` },
      });
      if (res.error) throw new Error(res.error.message);
      toast.success(`Applied: ${res.data.applied} assignments updated, ${res.data.skipped} skipped`);
      setPreview(null);
      fetchData();
    } catch (err: any) {
      toast.error(`Apply failed: ${err.message}`);
    } finally {
      setApplying(false);
    }
  };

  const handleBulkDisableCA = async () => {
    if (!user) return;
    setDisablingCA(true);
    try {
      // Fetch CA assignments with no current price data
      const PAGE = 1000;
      let caNoPrice: any[] = [];
      let page = 0;
      while (true) {
        const { data, error } = await supabase
          .from("repricer_assignments")
          .select("id, asin, sku, last_applied_price")
          .eq("user_id", user.id)
          .eq("marketplace", "CA")
          .eq("status", "active")
          .eq("is_enabled", true)
          .is("last_applied_price", null)
          .order("id", { ascending: true })
          .range(page * PAGE, (page + 1) * PAGE - 1);
        if (error || !data || data.length === 0) break;
        caNoPrice = caNoPrice.concat(data);
        if (data.length < PAGE) break;
        page++;
      }

      if (caNoPrice.length === 0) {
        toast.info("No CA assignments with missing price found");
        setDisablingCA(false);
        return;
      }

      // Bulk disable in batches of 200
      let disabled = 0;
      const BATCH = 200;
      for (let i = 0; i < caNoPrice.length; i += BATCH) {
        const batch = caNoPrice.slice(i, i + BATCH);
        const ids = batch.map((a: any) => a.id);
        const { error: updateErr } = await supabase
          .from("repricer_assignments")
          .update({
            is_enabled: false,
            manual_paused: false,
            last_disabled_by: "user",
            last_disabled_reason: "Setup incomplete panel: CA with no current price",
            last_disabled_at: new Date().toISOString(),
          })
          .in("id", ids);
        if (!updateErr) disabled += ids.length;
      }

      toast.success(`Disabled ${disabled} CA assignments with no current price`);
      fetchData();
    } catch (err: any) {
      toast.error(`Bulk disable failed: ${err.message}`);
    } finally {
      setDisablingCA(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [user, marketplace]);

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  const readinessPct = totalManaged > 0 ? Math.round((eligibleCount / totalManaged) * 100) : 100;
  const readinessColor = readinessPct >= 80 ? "text-green-600" : readinessPct >= 50 ? "text-yellow-600" : "text-destructive";

  return (
    <Card className="border-orange-500/40 bg-orange-500/5">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-lg flex items-center gap-2">
          <AlertCircle className="h-5 w-5 text-orange-500" />
          Setup Readiness
          <Badge variant="outline" className="text-xs">
            {incompleteCount} incomplete
          </Badge>
        </CardTitle>
        <div className="flex gap-2 flex-wrap">
          <Button variant="outline" size="sm" onClick={handleDryRun} disabled={previewing || incompleteCount === 0}>
            {previewing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}
            <span className="ml-1">Preview Fill</span>
          </Button>
          <Button variant="destructive" size="sm" onClick={handleBulkDisableCA} disabled={disablingCA}>
            {disablingCA ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ban className="h-4 w-4" />}
            <span className="ml-1">Disable CA No-Price</span>
          </Button>
          <Button variant="outline" size="sm" onClick={fetchData}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="p-3 rounded-lg border bg-background text-center">
            <span className="text-xs text-muted-foreground">Managed (rule + active)</span>
            <div className="text-xl font-bold text-foreground">{totalManaged}</div>
          </div>
          <div className="p-3 rounded-lg border bg-green-500/10 text-center">
            <span className="text-xs text-muted-foreground">Eligible (rule + min_price)</span>
            <div className="text-xl font-bold text-green-600">{eligibleCount}</div>
          </div>
          <div className="p-3 rounded-lg border bg-orange-500/10 text-center">
            <span className="text-xs text-muted-foreground">Missing min_price</span>
            <div className="text-xl font-bold text-orange-600">{incompleteCount}</div>
          </div>
          <div className="p-3 rounded-lg border bg-background text-center">
            <span className="text-xs text-muted-foreground">Readiness %</span>
            <div className={`text-xl font-bold ${readinessColor}`}>{readinessPct}%</div>
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          Assignments missing <code className="text-[10px] bg-muted px-1 rounded">min_price</code> are skipped by the scheduler.
          Preview Fill now shows a full ASIN-by-ASIN review list with current price, reference price, cost basis, and any risky rows where the suggested min is above your live price.
        </p>

        {preview && (
          <div className="space-y-3 p-3 rounded-lg border border-primary/30 bg-primary/5">
            <div className="flex items-center justify-between gap-3">
              <h4 className="text-sm font-medium flex items-center gap-2">
                <Zap className="h-4 w-4 text-primary" />
                Backfill Preview
              </h4>
              <Button size="sm" onClick={handleApply} disabled={applying || preview.wouldUpdate === 0}>
                {applying ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Zap className="h-4 w-4 mr-1" />}
                Apply {preview.wouldUpdate} Updates
              </Button>
            </div>

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 text-center">
              <div className="p-2 rounded border bg-background">
                <div className="text-lg font-bold text-green-600">{preview.wouldUpdate}</div>
                <div className="text-[10px] text-muted-foreground">Would update</div>
              </div>
              <div className="p-2 rounded border bg-background">
                <div className="text-lg font-bold text-orange-600">{preview.skipped}</div>
                <div className="text-[10px] text-muted-foreground">Skipped</div>
              </div>
              <div className="p-2 rounded border bg-background">
                <div className="text-lg font-bold text-destructive">{preview.needsReviewCount}</div>
                <div className="text-[10px] text-muted-foreground">Need manual check</div>
              </div>
              <div className="p-2 rounded border bg-background">
                <div className="text-sm font-medium text-foreground break-words">
                  {Object.entries(preview.skipReasons).map(([reason, count]) => `${reason}: ${count}`).join(", ") || "—"}
                </div>
                <div className="text-[10px] text-muted-foreground">Skip reasons</div>
              </div>
            </div>

            {preview.needsReviewCount > 0 && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-muted-foreground">
                {preview.needsReviewCount} ASINs need manual verification because no live current price was found or the suggested min is above the current price.
              </div>
            )}

            <BackfillReviewTable rows={preview.rows} />
          </div>
        )}

        {breakdowns.length > 0 && (
          <div>
            <h4 className="text-sm font-medium mb-2">Incomplete by Marketplace</h4>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {breakdowns.map(b => (
                <div key={b.marketplace} className="p-2 rounded border bg-muted/30 text-center">
                  <div className="text-lg font-bold text-foreground">{b.missingMin}</div>
                  <div className="text-[10px] text-muted-foreground">{b.marketplace} — missing min</div>
                  {b.missingRule > 0 && (
                    <div className="text-[10px] text-orange-500">{b.missingRule} also no rule</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {topMissingMin.length > 0 && !preview && (
          <div>
            <h4 className="text-sm font-medium mb-2">Sample US Assignments Missing min_price</h4>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>ASIN</TableHead>
                    <TableHead>SKU</TableHead>
                    <TableHead>Has Rule</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {topMissingMin.map((r, i) => (
                    <TableRow key={`${r.asin}-${i}`}>
                      <TableCell className="font-mono text-xs">{r.asin}</TableCell>
                      <TableCell className="text-xs">{r.sku}</TableCell>
                      <TableCell>
                        <Badge variant={r.hasRule ? "outline" : "destructive"} className="text-xs">
                          {r.hasRule ? "Yes" : "No"}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
