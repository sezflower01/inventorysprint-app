/**
 * Bulk Eligibility Check — paste a list of ASINs, get one row each.
 *
 * ── WHY THIS PAGE EXISTS ─────────────────────────────────────────────────
 *
 * Lead lists arrive as a column of ASINs, and the question before spending
 * money is always the same: can I sell it, is it gated, is it restricted, is it
 * hazmat, does it need prep. That answer already existed per-ASIN on Product
 * Analyzer, one product at a time — useless for a list of forty.
 *
 * Both pages call the SAME edge function (check-fba-listing-eligibility), so
 * they can never disagree. It answers from Amazon's Listings Restrictions and
 * Item Preview APIs, not from a browser session, and it caches: FBA
 * eligibility 6 h, hazmat and prep 24 h. A re-paste of the same list is
 * therefore nearly free, which is why there is no "force" button here — use
 * Recheck on Product Analyzer when a single ASIN needs a fresh answer.
 *
 * ── THE INBOUND DRY-RUN IS NOT HERE, DELIBERATELY ────────────────────────
 *
 * Stage 6 (would Amazon accept this into a shipment) creates a real inbound
 * plan and cancels it. That is fine for one ASIN you are about to buy, and
 * wrong for forty you are still judging. Product Analyzer keeps it, on demand.
 *
 * ── PACING ───────────────────────────────────────────────────────────────
 *
 * Checks run a few at a time, not all at once: the underlying calls share
 * Amazon's per-account quota with the repricer and the analyser. Results stream
 * in as they land so a long list is readable while it works.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { Helmet } from "react-helmet-async";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, Copy, Download, Loader2, Play, ShieldAlert, XCircle } from "lucide-react";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import type { FbaEligibility, FbaStageKey, FbaStageStatus } from "@/hooks/use-fba-eligibility";

/** Highest number of ASINs accepted in one run. A lead list is tens, not
 *  thousands, and every ASIN costs Amazon calls shared with the repricer. */
const MAX_ASINS = 200;
/** Checks in flight at once. Kept low on purpose — see PACING above. */
const CONCURRENCY = 3;

type SellStatus = "sellable" | "needs_approval" | "restricted" | "unknown";

interface Row {
  asin: string;
  state: "queued" | "checking" | "done" | "error";
  sell: SellStatus;
  sellReason?: string;
  hazmat: "yes" | "no" | "unknown";
  hazmatReason?: string;
  prep: "yes" | "no" | "unknown";
  prepReason?: string;
  fba: "yes" | "no" | "unknown";
  error?: string;
}

const EMPTY_ROW = (asin: string): Row => ({
  asin,
  state: "queued",
  sell: "unknown",
  hazmat: "unknown",
  prep: "unknown",
  fba: "unknown",
});

/** Any separator sellers actually paste: newlines, commas, tabs, spaces. */
function parseAsins(raw: string): { asins: string[]; rejected: string[] } {
  const tokens = raw.split(/[\s,;]+/).map((t) => t.trim().toUpperCase()).filter(Boolean);
  const seen = new Set<string>();
  const asins: string[] = [];
  const rejected: string[] = [];
  for (const t of tokens) {
    if (!/^[A-Z0-9]{10}$/.test(t)) { rejected.push(t); continue; }
    if (seen.has(t)) continue;     // a list often repeats an ASIN; check it once
    seen.add(t);
    asins.push(t);
  }
  return { asins, rejected };
}

const stageOf = (stages: FbaStageStatus[] | undefined, key: FbaStageKey) =>
  (stages || []).find((s) => s.stage === key);

/**
 * Sellable / needs approval / restricted from the sellability stage plus the
 * blocking issues. APPROVAL_REQUIRED is NOT the same as RESTRICTED: gated is
 * worth sourcing if you intend to apply, restricted never is, and collapsing
 * them would hide leads that are actually available to this account.
 */
function readSell(resp: FbaEligibility): { sell: SellStatus; reason?: string } {
  const codes = (resp.blockingIssues || []).map((i) => (i.code || "").toUpperCase());
  const approval = (resp.blockingIssues || []).find((i) => (i.code || "").toUpperCase() === "APPROVAL_REQUIRED")
    || (resp.warnings || []).find((i) => (i.code || "").toUpperCase() === "APPROVAL_REQUIRED");
  if (codes.includes("RESTRICTED") || codes.includes("NOT_ELIGIBLE")) {
    const hit = (resp.blockingIssues || []).find((i) => ["RESTRICTED", "NOT_ELIGIBLE"].includes((i.code || "").toUpperCase()));
    return { sell: "restricted", reason: hit?.message };
  }
  if (approval) return { sell: "needs_approval", reason: approval.message };
  const stage = stageOf(resp.stageStatuses, "sellability");
  if (stage?.status === "ok") return { sell: "sellable" };
  if (stage?.status === "blocked") return { sell: "restricted", reason: stage.reason };
  // "warn" here means the backend could not verify it — say unknown rather
  // than implying the account is approved.
  return { sell: "unknown", reason: stage?.reason };
}

function rowFromResponse(asin: string, resp: FbaEligibility): Row {
  const { sell, reason } = readSell(resp);
  const haz = stageOf(resp.stageStatuses, "hazmat");
  const prep = stageOf(resp.stageStatuses, "prep");
  const fba = stageOf(resp.stageStatuses, "fba_eligibility");
  return {
    asin,
    state: "done",
    sell,
    sellReason: reason,
    // For hazmat the stage is inverted: "ok" means no dangerous goods found.
    hazmat: haz?.status === "ok" ? "no" : haz?.status === "unknown" || !haz ? "unknown" : "yes",
    hazmatReason: haz?.reason,
    prep: prep?.status === "ok" ? "no" : prep?.status === "unknown" || !prep ? "unknown" : "yes",
    prepReason: prep?.reason,
    fba: fba?.status === "ok" ? "yes" : fba?.status === "unknown" || !fba ? "unknown" : "no",
  };
}

const SELL_BADGE: Record<SellStatus, { label: string; cls: string }> = {
  sellable: { label: "Sellable", cls: "border-emerald-500 text-emerald-700 dark:text-emerald-400" },
  needs_approval: { label: "Needs approval", cls: "border-amber-500 text-amber-700 dark:text-amber-400" },
  restricted: { label: "Restricted", cls: "border-red-500 text-red-700 dark:text-red-400" },
  unknown: { label: "Not verified", cls: "text-muted-foreground" },
};

export default function BulkEligibilityCheck() {
  const { user } = useAuth();
  const [raw, setRaw] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [running, setRunning] = useState(false);
  const cancelRef = useRef(false);

  const parsed = useMemo(() => parseAsins(raw), [raw]);
  const overLimit = parsed.asins.length > MAX_ASINS;

  const counts = useMemo(() => {
    const done = rows.filter((r) => r.state === "done");
    return {
      total: rows.length,
      done: done.length,
      sellable: done.filter((r) => r.sell === "sellable").length,
      gated: done.filter((r) => r.sell === "needs_approval").length,
      restricted: done.filter((r) => r.sell === "restricted").length,
      hazmat: done.filter((r) => r.hazmat === "yes").length,
      errors: rows.filter((r) => r.state === "error").length,
    };
  }, [rows]);

  const run = useCallback(async () => {
    if (!user) { toast.error("Sign in first"); return; }
    const { asins } = parsed;
    if (asins.length === 0) { toast.error("Paste at least one valid ASIN"); return; }
    if (overLimit) { toast.error(`Too many — ${MAX_ASINS} ASINs at a time`); return; }

    cancelRef.current = false;
    setRunning(true);
    setRows(asins.map(EMPTY_ROW));

    const update = (asin: string, patch: Partial<Row>) =>
      setRows((prev) => prev.map((r) => (r.asin === asin ? { ...r, ...patch } : r)));

    let cursor = 0;
    const worker = async () => {
      while (!cancelRef.current) {
        const i = cursor++;
        if (i >= asins.length) return;
        const asin = asins[i];
        update(asin, { state: "checking" });
        try {
          const { data, error } = await supabase.functions.invoke("check-fba-listing-eligibility", {
            body: { asin, marketplace: "US", condition: "new_new" },
          });
          if (error) throw new Error(error.message);
          if ((data as { error?: string })?.error) throw new Error((data as { error?: string }).error);
          update(asin, rowFromResponse(asin, data as FbaEligibility));
        } catch (e) {
          update(asin, { state: "error", error: e instanceof Error ? e.message : "Check failed" });
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, asins.length) }, worker));
    setRunning(false);
    if (cancelRef.current) toast.info("Stopped");
  }, [parsed, overLimit, user]);

  const copySellable = () => {
    const list = rows.filter((r) => r.sell === "sellable").map((r) => r.asin);
    if (!list.length) { toast.error("No sellable ASINs to copy"); return; }
    void navigator.clipboard.writeText(list.join("\n"));
    toast.success(`Copied ${list.length} sellable ASIN${list.length === 1 ? "" : "s"}`);
  };

  const downloadCsv = () => {
    const header = "asin,sellable,hazmat,prep_required,fba_eligible,note";
    const body = rows.map((r) => [
      r.asin,
      r.state === "error" ? "error" : SELL_BADGE[r.sell].label,
      r.hazmat,
      r.prep,
      r.fba,
      (r.error || r.sellReason || "").replace(/[",\n]/g, " ").trim(),
    ].join(","));
    const blob = new Blob([[header, ...body].join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `eligibility-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <Helmet>
        <title>Bulk Eligibility Check · InventorySprint</title>
        <meta name="description" content="Paste a list of ASINs and see which are sellable, gated, restricted, hazmat or need prep — before you buy." />
      </Helmet>
      <Navbar />

      <main className="flex-1 container mx-auto px-4 py-6 space-y-4 max-w-5xl">
        <div>
          <h1 className="text-2xl font-bold">Bulk Eligibility Check</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Paste the ASINs from a lead list. Each one is checked against your own Amazon account:
            can you sell it, is it gated, is it restricted, is it hazmat, does it need prep.
            For one ASIN in full detail — including an inbound shipment test — use{" "}
            <Link to="/tools/product-analyzer" className="underline">Product Analyzer</Link>.
          </p>
        </div>

        <Card className="p-4 space-y-3">
          <Textarea
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            placeholder={"B0ABC12345\nB0DEF67890\nB0GHI24680"}
            className="min-h-[140px] font-mono text-xs"
            spellCheck={false}
          />
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>
              {parsed.asins.length} ASIN{parsed.asins.length === 1 ? "" : "s"} ready
              {parsed.rejected.length > 0 && ` · ${parsed.rejected.length} ignored (not a 10-character ASIN)`}
            </span>
            {overLimit && (
              <span className="text-destructive font-medium">
                Over the limit — {MAX_ASINS} at a time.
              </span>
            )}
            <div className="ml-auto flex items-center gap-2">
              {running ? (
                <Button type="button" variant="outline" size="sm" onClick={() => { cancelRef.current = true; }}>
                  Stop
                </Button>
              ) : null}
              <Button type="button" size="sm" onClick={run} disabled={running || parsed.asins.length === 0 || overLimit}>
                {running ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Play className="h-3.5 w-3.5 mr-1" />}
                {running ? `Checking ${counts.done}/${counts.total}…` : `Check ${parsed.asins.length || ""}`.trim()}
              </Button>
            </div>
          </div>
        </Card>

        {rows.length > 0 && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Badge variant="outline" className="border-emerald-500 text-emerald-700 dark:text-emerald-400">
                <CheckCircle2 className="h-3 w-3 mr-1" />{counts.sellable} sellable
              </Badge>
              <Badge variant="outline" className="border-amber-500 text-amber-700 dark:text-amber-400">
                <AlertTriangle className="h-3 w-3 mr-1" />{counts.gated} need approval
              </Badge>
              <Badge variant="outline" className="border-red-500 text-red-700 dark:text-red-400">
                <XCircle className="h-3 w-3 mr-1" />{counts.restricted} restricted
              </Badge>
              {counts.hazmat > 0 && (
                <Badge variant="outline" className="border-orange-500 text-orange-700 dark:text-orange-400">
                  <ShieldAlert className="h-3 w-3 mr-1" />{counts.hazmat} hazmat
                </Badge>
              )}
              {counts.errors > 0 && <Badge variant="outline">{counts.errors} failed</Badge>}
              <div className="ml-auto flex gap-2">
                <Button type="button" variant="outline" size="sm" onClick={copySellable}>
                  <Copy className="h-3.5 w-3.5 mr-1" />Copy sellable
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={downloadCsv}>
                  <Download className="h-3.5 w-3.5 mr-1" />CSV
                </Button>
              </div>
            </div>

            <Card className="overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>ASIN</TableHead>
                    <TableHead>Can I sell it?</TableHead>
                    <TableHead>Hazmat</TableHead>
                    <TableHead>Prep</TableHead>
                    <TableHead>FBA</TableHead>
                    <TableHead>Why</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.asin}>
                      <TableCell className="font-mono text-xs">
                        <a
                          href={`https://www.amazon.com/dp/${r.asin}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="underline"
                        >
                          {r.asin}
                        </a>
                      </TableCell>
                      <TableCell>
                        {r.state === "checking" ? (
                          <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
                            <Loader2 className="h-3 w-3 animate-spin" />checking
                          </span>
                        ) : r.state === "queued" ? (
                          <span className="text-xs text-muted-foreground">waiting</span>
                        ) : r.state === "error" ? (
                          <Badge variant="outline">Failed</Badge>
                        ) : (
                          <Badge variant="outline" className={`text-[11px] ${SELL_BADGE[r.sell].cls}`}>
                            {SELL_BADGE[r.sell].label}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">
                        {r.hazmat === "yes"
                          ? <span className="text-orange-600 dark:text-orange-400 font-medium">Yes</span>
                          : r.hazmat === "no" ? "No" : <span className="text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell className="text-xs">
                        {r.prep === "yes"
                          ? <span className="text-amber-600 dark:text-amber-400">Required</span>
                          : r.prep === "no" ? "None" : <span className="text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell className="text-xs">
                        {r.fba === "yes" ? "Eligible" : r.fba === "no" ? "Not eligible" : <span className="text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground max-w-[280px] truncate" title={r.error || r.sellReason || r.hazmatReason || r.prepReason || ""}>
                        {r.error || r.sellReason || r.hazmatReason || r.prepReason || ""}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>

            <p className="text-[11px] text-muted-foreground">
              Answers come from Amazon's own APIs for your account, not a browser session, and are cached
              (FBA eligibility 6 hours, hazmat and prep 24 hours) — so re-checking the same list costs almost nothing.
              "Not verified" means Amazon did not give a clear answer; check that one in Seller Central before buying.
            </p>
          </>
        )}
      </main>
      <Footer />
    </div>
  );
}
