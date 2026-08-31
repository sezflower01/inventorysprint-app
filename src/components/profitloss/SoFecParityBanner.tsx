import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertTriangle,
  RefreshCw,
  CheckCircle2,
  Info,
  Clock,
  ChevronRight,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface ParityRow {
  check_date: string;
  marketplace: string;
  so_count: number;
  fec_count: number;
  gap_type: string;
}

interface ChunkRow {
  start: string;
  end: string;
  returned: number;
  inserted: number;
  error: string | null;
}

interface VerificationResult {
  inserted: number;
  updated: number;
  skipped: number;
  remainingGapDays: number;
  remainingMissingShipments: number;
  needsLiveSalesRefresh: boolean;
  startedAt: string;
  finishedAt: string;
  range: { start: string; end: string };
  // Amazon-side proof (from sales_sync_state.last_backfill_stats)
  amazonOrdersReturned: number | null;
  amazonOrdersInsertedNew: number | null;
  amazonApiError: string | null;
  syncStatus: string | null; // 'running' | 'complete' | 'timed_out' | null
  chunksTotal: number | null;
  chunksCompleted: number | null;
  ordersPerChunk: ChunkRow[];
  backendFinishedAt: string | null;
}

interface Props {
  userId: string;
  startDate: string; // YYYY-MM-DD
  endDate: string;   // YYYY-MM-DD
}

// NOTE: the "last backfill" stamp used to live in localStorage, keyed per user.
// That made it a statement about THIS BROWSER, not about the account -- it read
// "never" on a new browser or after clearing site data, regardless of what had
// actually run. Observed 2026-08-20: the banner said "never" while
// sales_sync_state held a real run from 2026-07-08. It now reads the server.

/**
 * SoFecParityBanner — Detects when the selected P&L period overlaps a
 * sales_orders sync gap (FEC has shipments but SO is missing the placement
 * rows). Explains the timing, offers a one-click backfill, and shows a
 * verification panel after the backfill so users can prove the repair worked.
 */
export default function SoFecParityBanner({ userId, startDate, endDate }: Props) {
  const [gaps, setGaps] = useState<ParityRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [progressMsg, setProgressMsg] = useState<string | null>(null);
  const [verification, setVerification] = useState<VerificationResult | null>(null);
  const [lastBackfillAt, setLastBackfillAt] = useState<string | null>(null);
  /** true when the stored run never wrote finished_at, so the stamp is a start time. */
  const [lastBackfillIncomplete, setLastBackfillIncomplete] = useState(false);
  /**
   * What the nightly repair job knows about each gap day.
   *
   * A gap is one of three things, and conflating them is what makes this banner
   * either alarming or dishonest:
   *   unknown    -- the job has not seen it yet; genuinely actionable now
   *   pending    -- under the attempt cap; being retried nightly, no action needed
   *   permanent  -- cap reached, Amazon never returned those rows; nothing to do
   *
   * Read-only and failure-tolerant on purpose: if order_gap_repair_attempts does
   * not exist yet, every gap simply reads as `unknown` and the banner behaves
   * exactly as it did before. A missing table must not blank the warning.
   */
  const [attemptsByDate, setAttemptsByDate] = useState<Map<string, { attempts: number; status: string }>>(new Map());
  /**
   * Date range proven clear by a completed backfill, so the warning can hide
   * itself. Scoped to the repaired range on purpose: dismissing everything
   * would mask gaps on days the repair never touched.
   */
  const [verifiedClearRange, setVerifiedClearRange] = useState<{ start: string; end: string } | null>(null);
  const [placementRange, setPlacementRange] = useState<{ min: string; max: string } | null>(null);

  // Hydrate "last backfill" from sales_sync_state -- the account's own record.
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("sales_sync_state")
        .select("last_backfill_stats")
        .eq("user_id", userId)
        .maybeSingle();
      if (cancelled) return;
      const stats = (data as { last_backfill_stats?: Record<string, unknown> } | null)?.last_backfill_stats;
      if (!stats) { setLastBackfillAt(null); return; }
      const finished = typeof stats.finished_at === "string" ? stats.finished_at : null;
      const started = typeof stats.started_at === "string" ? stats.started_at : null;
      // A run that completed every chunk but never wrote finished_at is still a
      // real backfill -- report its start time and say the record is incomplete
      // rather than claiming it never happened.
      setLastBackfillAt(finished ?? started ?? null);
      setLastBackfillIncomplete(!finished && !!started);
    })();
    return () => { cancelled = true; };
  }, [userId]);

  // Hydrate the nightly job's verdict per gap day.
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("order_gap_repair_attempts")
        .select("check_date, attempts, status")
        .eq("user_id", userId);
      if (cancelled) return;
      // Tolerate the table not existing: fall back to "unknown" for everything.
      if (error || !data) { setAttemptsByDate(new Map()); return; }
      const m = new Map<string, { attempts: number; status: string }>();
      for (const r of data as Array<{ check_date: string; attempts: number; status: string }>) {
        m.set(r.check_date, { attempts: r.attempts, status: r.status });
      }
      setAttemptsByDate(m);
    })();
    return () => { cancelled = true; };
  }, [userId]);

  // A new period is a fresh question: nothing is proven clear until re-verified.
  useEffect(() => {
    setVerifiedClearRange(null);
  }, [startDate, endDate]);

  // How far back check_sync_parity is allowed to look. Was a hard-coded 60,
  // which silently capped the banner at the last two months no matter which
  // period the P&L was showing: with all of 2026 selected it still scanned only
  // 60 days, so 39 of the 44 real gap days were invisible and the banner
  // reported healthy. Measured 2026-08-31 -- 1,327 orders present in Financial
  // Events and absent from sales_orders, worst in January, none of them
  // reachable from this component.
  const SCAN_MAX_DAYS = 400;

  // The REPAIR window stays narrow even though the SCAN is wide, and the two
  // must not be confused. Gaps span January to August; handing that whole range
  // to sync-sales-orders would be a 225-day Orders API sweep in one request,
  // which is exactly the shape that times out with nothing written.
  // backfill-order-gaps caps itself at 14 days per run for this reason
  // (MAX_RANGE_DAYS) and it is the right precedent: repair the oldest window,
  // report what is left, let the user click again.
  const REPAIR_MAX_DAYS = 14;

  const fetchGaps = useCallback(async () => {
    if (!userId || !startDate || !endDate) return;
    setLoading(true);
    try {
      const start = new Date(startDate);
      const today = new Date();
      const daysFromStart = Math.max(
        1,
        Math.min(SCAN_MAX_DAYS, Math.ceil((today.getTime() - start.getTime()) / 86400000) + 1)
      );

      const { data, error } = await supabase.rpc("check_sync_parity", {
        p_user_id: userId,
        p_days: daysFromStart,
      });

      if (error) {
        console.warn("[SoFecParityBanner] check_sync_parity error:", error.message);
        setGaps([]);
        return;
      }

      const rows = (data as ParityRow[] | null) ?? [];
      const inWindow = rows.filter(
        (r) =>
          r.gap_type === "so_missing" &&
          r.check_date >= startDate &&
          r.check_date <= endDate
      );
      setGaps(inWindow);
    } finally {
      setLoading(false);
    }
  }, [userId, startDate, endDate]);

  const fetchPlacementRange = useCallback(async () => {
    if (!userId || gaps.length === 0) return;
    const dates = gaps.map((g) => g.check_date).sort();
    const gStart = dates[0];
    const gEnd = dates[dates.length - 1];

    const { data: fec } = await supabase
      .from("financial_events_cache")
      .select("amazon_order_id")
      .eq("user_id", userId)
      .eq("event_type", "shipment")
      .gte("event_date", gStart)
      .lte("event_date", gEnd)
      .not("amazon_order_id", "is", null)
      .limit(1000);

    const orderIds = Array.from(
      new Set((fec ?? []).map((r: any) => r.amazon_order_id).filter(Boolean))
    );
    if (orderIds.length === 0) {
      setPlacementRange(null);
      return;
    }

    const { data: orders } = await supabase
      .from("sales_orders")
      .select("order_date")
      .eq("user_id", userId)
      .in("order_id", orderIds.slice(0, 500));

    if (!orders || orders.length === 0) {
      setPlacementRange(null);
      return;
    }

    const placementDates = orders
      .map((o: any) => String(o.order_date).slice(0, 10))
      .filter(Boolean)
      .sort();
    setPlacementRange({
      min: placementDates[0],
      max: placementDates[placementDates.length - 1],
    });
  }, [userId, gaps]);

  useEffect(() => { fetchGaps(); }, [fetchGaps]);
  useEffect(() => { fetchPlacementRange(); }, [fetchPlacementRange]);

  // ---- Snapshot helpers used to compute insert/update/skipped deltas ----
  type RowSnap = { order_id: string; updated_at: string | null };

  async function snapshotOrderRows(start: string, end: string): Promise<Map<string, string | null>> {
    const map = new Map<string, string | null>();
    const PAGE = 1000;
    let from = 0;
    // Cap to ~5000 rows per range — gap windows are small.
    for (let i = 0; i < 5; i++) {
      const { data, error } = await supabase
        .from("sales_orders")
        .select("order_id, updated_at")
        .eq("user_id", userId)
        .gte("order_date", start)
        .lte("order_date", end)
        .range(from, from + PAGE - 1);
      if (error || !data || data.length === 0) break;
      for (const r of data as RowSnap[]) {
        map.set(r.order_id, r.updated_at ?? null);
      }
      if (data.length < PAGE) break;
      from += PAGE;
    }
    return map;
  }

  async function pollForCompletion(
    rangeStart: string,
    rangeEnd: string,
    beforeCount: number
  ): Promise<number> {
    // Poll up to ~30s for new rows to land. Background sync usually finishes
    // in <10s for a 2-3 day window.
    const t0 = Date.now();
    let last = beforeCount;
    let stableTicks = 0;
    while (Date.now() - t0 < 30_000) {
      await new Promise((r) => setTimeout(r, 3000));
      const { count } = await supabase
        .from("sales_orders")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .gte("order_date", rangeStart)
        .lte("order_date", rangeEnd);
      const cur = count ?? 0;
      setProgressMsg(`Sync running… ${cur - beforeCount} new rows so far`);
      if (cur === last) {
        stableTicks++;
        if (stableTicks >= 2 && cur > beforeCount) break; // stable + made progress
      } else {
        stableTicks = 0;
        last = cur;
      }
    }
    return last;
  }

  const triggerRepair = async () => {
    setRepairing(true);
    setVerification(null);
    setProgressMsg("Snapshotting current sales_orders rows…");
    const startedAt = new Date().toISOString();

    try {
      // Determine the repair window: prefer detected gap days; otherwise use
      // the currently selected P&L period so the user can always force a check.
      let repairStart: string;
      let repairEnd: string;
      if (gaps.length > 0) {
        const dates = gaps.map((g) => g.check_date).sort();
        repairStart = dates[0];
        const repairEndDate = new Date(dates[dates.length - 1]);
        repairEndDate.setDate(repairEndDate.getDate() + 1);
        // Never ask for more than REPAIR_MAX_DAYS in one call, however wide the
        // gaps are spread. Oldest first, because the oldest data is the closest
        // to ageing out of Amazon's retention.
        const capDate = new Date(repairStart);
        capDate.setDate(capDate.getDate() + REPAIR_MAX_DAYS);
        repairEnd = (capDate < repairEndDate ? capDate : repairEndDate).toISOString().slice(0, 10);
      } else {
        repairStart = startDate;
        repairEnd = endDate;
      }
      console.log("[SoFecParityBanner] Backfill triggered", { repairStart, repairEnd, gapCount: gaps.length });

      // BEFORE snapshot
      const before = await snapshotOrderRows(repairStart, repairEnd);
      const beforeCount = before.size;

      setProgressMsg(`Calling Orders API for ${repairStart} → ${repairEnd}…`);
      toast.info(`Backfilling Orders API for ${repairStart} → ${repairEnd}…`);

      const { error } = await supabase.functions.invoke("sync-sales-orders", {
        body: {
          startDate: repairStart,
          endDate: repairEnd,
          include_orders: true,
        },
      });
      if (error) throw error;

      // The function returns immediately (background:true). Poll until rows
      // stabilize or 30s elapse, then take the AFTER snapshot.
      setProgressMsg("Waiting for background sync to land rows…");
      await pollForCompletion(repairStart, repairEnd, beforeCount);

      const after = await snapshotOrderRows(repairStart, repairEnd);

      // Compute deltas
      let inserted = 0;
      let updated = 0;
      let skipped = 0;
      for (const [orderId, afterUpdated] of after.entries()) {
        if (!before.has(orderId)) {
          inserted++;
        } else {
          const beforeUpdated = before.get(orderId) ?? null;
          if (beforeUpdated !== afterUpdated) updated++;
          else skipped++;
        }
      }

      // Re-run parity check to see if any gap remains
      setProgressMsg("Re-running parity check…");
      const { data: postGaps } = await supabase.rpc("check_sync_parity", {
        p_user_id: userId,
        p_days: SCAN_MAX_DAYS,
      });
      const stillMissing = ((postGaps as ParityRow[] | null) ?? []).filter(
        (g) =>
          g.gap_type === "so_missing" &&
          g.check_date >= repairStart &&
          g.check_date <= repairEnd
      );
      const remainingGapDays = stillMissing.length;
      const remainingMissingShipments = stillMissing.reduce(
        (acc, g) => acc + Math.max(0, Number(g.fec_count) - Number(g.so_count)),
        0
      );


      // Pull Amazon-side proof from sales_sync_state.last_backfill_stats.
      // Poll a few extra times if status=='running' so we don't show a stale
      // "running" label after the background job has actually completed.
      let amazonOrdersReturned: number | null = null;
      let amazonOrdersInsertedNew: number | null = null;
      let amazonApiError: string | null = null;
      let syncStatus: string | null = null;
      let chunksTotal: number | null = null;
      let chunksCompleted: number | null = null;
      let ordersPerChunk: ChunkRow[] = [];
      let backendFinishedAt: string | null = null;

      const readStats = async () => {
        const { data: stateRow } = await supabase
          .from("sales_sync_state")
          .select("last_backfill_stats")
          .eq("user_id", userId)
          .maybeSingle();
        const stats: any = (stateRow as any)?.last_backfill_stats ?? null;
        if (stats && typeof stats === "object") {
          amazonOrdersReturned =
            typeof stats.orders_api_returned === "number" ? stats.orders_api_returned : null;
          amazonOrdersInsertedNew =
            typeof stats.orders_inserted_new === "number" ? stats.orders_inserted_new : null;
          amazonApiError = stats.orders_api_error ?? null;
          syncStatus = stats.status ?? null;
          chunksTotal = typeof stats.chunks_total === "number" ? stats.chunks_total : null;
          chunksCompleted = typeof stats.chunks_completed === "number" ? stats.chunks_completed : null;
          ordersPerChunk = Array.isArray(stats.orders_per_chunk) ? stats.orders_per_chunk : [];
          backendFinishedAt = stats.finished_at ?? null;
        }
      };

      try {
        await readStats();
        // If still 'running', wait briefly and re-poll up to 4× (~16s) so we
        // surface 'complete' as soon as the background job lands.
        for (let i = 0; i < 4 && syncStatus === "running"; i++) {
          await new Promise((r) => setTimeout(r, 4000));
          setProgressMsg(
            chunksTotal
              ? `Background sync running… ${chunksCompleted ?? 0}/${chunksTotal} chunks`
              : "Background sync still running…"
          );
          await readStats();
        }
      } catch {
        /* non-fatal */
      }

      const finishedAt = new Date().toISOString();

      // Derive chunks completed from orders_per_chunk array when present —
      // this is the authoritative source (each entry = one finished chunk).
      if (Array.isArray(ordersPerChunk) && ordersPerChunk.length > 0) {
        const derived = ordersPerChunk.length;
        if (chunksCompleted === null || derived > chunksCompleted) {
          chunksCompleted = derived;
        }
        if (chunksTotal === null || chunksTotal < derived) {
          chunksTotal = derived;
        }
      }

      const allChunksDone =
        chunksTotal !== null && chunksCompleted !== null && chunksCompleted >= chunksTotal;

      // Final guard: if backend reports finished_at OR all chunks done,
      // status is COMPLETE — never show background/running after that.
      if (backendFinishedAt || allChunksDone) {
        syncStatus = "complete";
        // Snap counters so the UI shows e.g. 7/7 instead of 0/7.
        if (chunksTotal !== null) {
          chunksCompleted = chunksTotal;
        }
      } else if (syncStatus === "running") {
        // Genuinely still running past our poll window.
        syncStatus = "background";
      }

      const result: VerificationResult = {
        inserted,
        updated,
        skipped,
        remainingGapDays,
        remainingMissingShipments,
        needsLiveSalesRefresh: inserted > 0 || updated > 0,
        startedAt,
        finishedAt,
        range: { start: repairStart, end: repairEnd },
        amazonOrdersReturned,
        amazonOrdersInsertedNew,
        amazonApiError,
        syncStatus,
        chunksTotal,
        chunksCompleted,
        ordersPerChunk,
        backendFinishedAt,
      };
      setVerification(result);

      setLastBackfillAt(finishedAt);
      setLastBackfillIncomplete(false);

      // Dismiss the warning ONLY on evidence, never on the click.
      //
      // Both halves are required. remainingGapDays === 0 is the parity check
      // re-run against the repaired range; syncStatus === 'complete' is Amazon's
      // own record (finished_at, or every chunk done). Hiding on either alone
      // would clear the warning while the background job was still landing rows,
      // which is indistinguishable from a repair that silently did nothing.
      if (remainingGapDays === 0 && syncStatus === "complete") {
        setVerifiedClearRange({ start: repairStart, end: repairEnd });
      } else {
        setVerifiedClearRange(null);
      }

      if (remainingGapDays === 0) {
        toast.success(`Backfill verified: +${inserted} new, ${updated} updated. No gaps remain.`);
      } else {
        toast.warning(
          `Backfill landed +${inserted} new, ${updated} updated — but ${remainingGapDays} day(s) still show a gap. Amazon may not have those orders indexed yet.`
        );
      }
      await fetchGaps();
    } catch (err: any) {
      toast.error(err?.message || "Backfill failed");
    } finally {
      setRepairing(false);
      setProgressMsg(null);
    }
  };

  const formatStamp = (iso: string | null) => {
    if (!iso) return "never";
    try {
      return new Date(iso).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    } catch {
      return iso;
    }
  };

  // ALWAYS render a status row so the user can see "Last backfill" and
  // manually trigger a check, even when no gap is currently detected.
  // Gaps still outstanding after any verified repair. A repair proves only the
  // days it covered, so days outside that range stay visible.
  const outstandingGaps = verifiedClearRange
    ? gaps.filter(
        (g) => !(g.check_date >= verifiedClearRange.start && g.check_date <= verifiedClearRange.end),
      )
    : gaps;
  const hasGaps = outstandingGaps.length > 0;

  // Split by what the nightly job has established. `permanent` days are still
  // SHOWN -- they are a fact about the data, and hiding them would be the same
  // mistake as the old copy that promised an auto-repair which did not exist.
  // They just stop being presented as something to act on.
  const permanentGaps = outstandingGaps.filter(
    (g) => attemptsByDate.get(g.check_date)?.status === "permanent",
  );
  const activeGaps = outstandingGaps.filter(
    (g) => attemptsByDate.get(g.check_date)?.status !== "permanent",
  );
  const allPermanent = hasGaps && activeGaps.length === 0;
  if (loading) return null;

  if (!hasGaps) {
    // Compact "all clear" status row — always visible, with a manual backfill
    // button that runs against the currently selected P&L period.
    return (
      <div className="mb-4 rounded-md border border-green-500/30 bg-green-500/5 px-3 py-2 text-xs space-y-2">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 text-green-700 dark:text-green-400">
            <CheckCircle2 className="h-3.5 w-3.5" />
            <span className="font-medium">Sales orders are in sync with Financial Events.</span>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <Clock className="h-3 w-3" />
              <span>
                Last Orders API backfill: <strong>{formatStamp(lastBackfillAt)}</strong>
                {lastBackfillIncomplete && (
                  <span className="ml-1 text-amber-600">(started, never recorded finishing)</span>
                )}
              </span>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={triggerRepair}
              disabled={repairing}
              className="h-7 text-[11px] border-green-500/40"
            >
              {repairing ? (
                <RefreshCw className="h-3 w-3 mr-1.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3 mr-1.5" />
              )}
              {repairing ? "Checking…" : "Run backfill check"}
            </Button>
          </div>
        </div>

        {repairing && progressMsg && (
          <div className="text-[11px] text-muted-foreground italic flex items-center gap-1.5">
            <RefreshCw className="h-3 w-3 animate-spin" />
            {progressMsg}
          </div>
        )}

        {verification && <VerificationPanel verification={verification} formatStamp={formatStamp} />}
      </div>
    );
  }

  // Every gap here is settled: retried to the cap and still missing. One muted
  // line, no button, no alert styling. Visible because the data really is
  // incomplete and the reader should know; quiet because there is nothing to do.
  if (allPermanent) {
    const days = permanentGaps.map((g) => g.check_date).join(", ");
    const missing = permanentGaps.reduce(
      (acc, g) => acc + Math.max(0, g.fec_count - g.so_count),
      0,
    );
    return (
      <div className="mb-4 flex items-start gap-2 rounded-md border border-muted bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
        <Clock className="h-3 w-3 mt-0.5 shrink-0" />
        <span>
          <strong className="font-medium">Known data gap, permanent.</strong>{" "}
          Amazon's Orders API never returned placement rows for {days}
          {missing > 0 && <> ({missing} shipment{missing === 1 ? "" : "s"})</>}. Retried
          automatically and still missing, so it is not being retried again. Profit &amp; Loss
          above is unaffected — it reports settled revenue from Financial Events. Only the
          Live Sales chart, which counts by placement date, shows these days as zero.
        </span>
      </div>
    );
  }

  const totalMissingShipments = outstandingGaps.reduce(
    (acc, g) => acc + Math.max(0, g.fec_count - g.so_count),
    0
  );
  const dateList = activeGaps.map((g) => g.check_date).join(", ");
  const permanentList = permanentGaps.map((g) => g.check_date).join(", ");

  return (
    <Alert className="mb-4 border-yellow-500/50 bg-yellow-500/5">
      <AlertTriangle className="h-4 w-4 text-yellow-600" />
      <AlertTitle className="text-yellow-700 dark:text-yellow-400 flex items-center justify-between gap-2 flex-wrap">
        <span>Order placement gap detected in this period</span>
        <span className="text-[10px] font-normal text-muted-foreground flex items-center gap-1">
          <Clock className="h-3 w-3" />
          Last Orders API backfill: <strong>{formatStamp(lastBackfillAt)}</strong>
        </span>
      </AlertTitle>
      <AlertDescription className="space-y-2">
        <p className="text-sm">
          The Profit &amp; Loss above is correct — it reports{" "}
          <strong>shipped/settled</strong> revenue from Amazon Financial Events.
          But the <strong>Live Sales chart</strong> (which counts orders by{" "}
          <em>placement date</em>) shows zero for{" "}
          <strong>{dateList}</strong> because the Orders API never returned the
          original placement rows for those days.
        </p>

        {/* Mixed case: some days still being retried, others already given up
            on. The settled ones are named rather than folded into the count --
            "4 gaps" reads as four fixable problems when two of them are simply
            facts about the data. */}
        {permanentList && (
          <p className="text-[11px] text-muted-foreground">
            Also permanently missing, retried to the limit and not retried again:{" "}
            <strong>{permanentList}</strong>. Profit &amp; Loss is unaffected; only the
            Live Sales placement counts show these as zero.
          </p>
        )}

        {placementRange && (
          <p className="text-sm flex items-start gap-1.5">
            <Info className="h-3.5 w-3.5 mt-0.5 shrink-0 text-blue-500" />
            <span>
              The {totalMissingShipments} shipments settled in this window come
              from orders actually <strong>placed between{" "}
              {placementRange.min} and {placementRange.max}</strong> — they
              shipped late, which is normal for FBA.
            </span>
          </p>
        )}

        <div className="flex items-center gap-2 pt-1 flex-wrap">
          <Button
            variant="outline"
            size="sm"
            onClick={triggerRepair}
            disabled={repairing}
            className="border-yellow-500/50"
          >
            {repairing ? (
              <RefreshCw className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />
            )}
            {repairing ? "Backfilling…" : "Backfill missing orders now"}
          </Button>
          {/* HISTORY, because this line has been wrong before. It once read
              "Auto-repair also runs nightly at 04:30 UTC", which was false
              twice over: the 04:30 migration schedules nightly-ghost-cleanup,
              which contains no parity or backfill code, and that job was not in
              cron.job at all. It was replaced 2026-08-20 with "nothing repairs
              these automatically", which was true at the time.

              As of 2026-08-22 it is automated for real: backfill-order-gaps
              runs daily (cron jobid 164, 05:37 UTC), retries each gap day up to
              3 times, then marks it permanent and stops. Verified against the
              live scheduler, not assumed -- that is the whole reason the
              previous version of this sentence was wrong.

              The button stays: it repairs NOW rather than tonight, and Amazon
              occasionally backfills its own history, so a manual retry on a day
              the job gave up on is still worth offering. */}
          <span className="text-[11px] text-muted-foreground">
            Retried automatically each night (up to 3 attempts, then left alone). Use this to
            repair now rather than waiting.
          </span>
        </div>

        {repairing && progressMsg && (
          <div className="text-[11px] text-muted-foreground italic flex items-center gap-1.5 pt-1">
            <RefreshCw className="h-3 w-3 animate-spin" />
            {progressMsg}
          </div>
        )}

        {verification && <VerificationPanel verification={verification} formatStamp={formatStamp} />}
      </AlertDescription>
    </Alert>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "positive" | "neutral" | "muted" | "warning";
}) {
  const toneClass =
    tone === "positive"
      ? "text-green-600"
      : tone === "warning"
      ? "text-orange-600"
      : tone === "muted"
      ? "text-muted-foreground"
      : "text-foreground";
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className={cn("text-base font-bold tabular-nums", toneClass)}>{value}</span>
    </div>
  );
}

function VerificationPanel({
  verification,
  formatStamp,
}: {
  verification: VerificationResult;
  formatStamp: (iso: string | null) => string;
}) {
  return (
    <div
      className={cn(
        "mt-2 rounded-md border p-2.5 text-xs",
        verification.remainingGapDays === 0
          ? "border-green-500/40 bg-green-500/5"
          : "border-orange-500/40 bg-orange-500/5"
      )}
    >
      <div className="flex items-center gap-1.5 font-semibold mb-1.5">
        {verification.remainingGapDays === 0 ? (
          <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
        ) : (
          <AlertTriangle className="h-3.5 w-3.5 text-orange-600" />
        )}
        Backfill verification — {verification.range.start} → {verification.range.end}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        <Stat label="Inserted" value={verification.inserted} tone="positive" />
        <Stat label="Updated" value={verification.updated} tone="neutral" />
        <Stat label="Skipped (no change)" value={verification.skipped} tone="muted" />
        <Stat
          label="Days still missing"
          value={verification.remainingGapDays}
          tone={verification.remainingGapDays === 0 ? "positive" : "warning"}
        />
        <Stat
          label="Shipments still unmatched"
          value={verification.remainingMissingShipments}
          tone={verification.remainingMissingShipments === 0 ? "positive" : "warning"}
        />
      </div>

      <div className="mt-2 pt-2 border-t border-border/50">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
          Amazon Orders API response
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          <Stat
            label="Orders Amazon returned"
            value={verification.amazonOrdersReturned ?? 0}
            tone={
              verification.amazonOrdersReturned === null
                ? "muted"
                : verification.amazonOrdersReturned > 0
                ? "positive"
                : "warning"
            }
          />
          <Stat
            label="New rows from Amazon"
            value={verification.amazonOrdersInsertedNew ?? 0}
            tone={(verification.amazonOrdersInsertedNew ?? 0) > 0 ? "positive" : "muted"}
          />
          <div className="flex flex-col">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Sync status
            </span>
            <span
              className={cn(
                "text-base font-bold tabular-nums capitalize",
                verification.syncStatus === "complete"
                  ? "text-green-600"
                  : verification.syncStatus === "background"
                  ? "text-blue-600"
                  : verification.syncStatus === "running"
                  ? "text-orange-600"
                  : "text-foreground"
              )}
            >
              {verification.syncStatus ?? "unknown"}
            </span>
            {verification.chunksTotal !== null && (
              <span className="text-[10px] text-muted-foreground tabular-nums">
                {verification.chunksCompleted ?? 0}/{verification.chunksTotal} chunks
              </span>
            )}
          </div>
        </div>

        {(verification.ordersPerChunk?.length ?? 0) > 0 && (
          <div className="mt-2">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
              Per-chunk Orders API results
            </div>
            <div className="max-h-44 overflow-y-auto rounded border border-border/40">
              <table className="w-full text-[11px]">
                <thead className="bg-muted/50 sticky top-0">
                  <tr>
                    <th className="text-left px-2 py-1 font-medium">Window</th>
                    <th className="text-right px-2 py-1 font-medium">Returned</th>
                    <th className="text-right px-2 py-1 font-medium">New</th>
                    <th className="text-left px-2 py-1 font-medium">Note</th>
                  </tr>
                </thead>
                <tbody>
                  {(verification.ordersPerChunk ?? []).map((c, i) => (
                    <tr key={i} className="odd:bg-background even:bg-muted/20">
                      <td className="px-2 py-1 font-mono">
                        {c.start.slice(0, 10)} → {c.end.slice(0, 10)}
                      </td>
                      <td
                        className={cn(
                          "px-2 py-1 text-right tabular-nums",
                          c.returned > 0 ? "text-green-600 font-semibold" : "text-muted-foreground"
                        )}
                      >
                        {c.returned}
                      </td>
                      <td
                        className={cn(
                          "px-2 py-1 text-right tabular-nums",
                          c.inserted > 0 ? "text-blue-600 font-semibold" : "text-muted-foreground"
                        )}
                      >
                        {c.inserted}
                      </td>
                      <td className="px-2 py-1 text-[10px] text-muted-foreground">
                        {c.error ? <span className="text-red-600">err: {c.error}</span> : c.returned === 0 ? "no rows" : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {verification.amazonApiError && (
          <p className="mt-2 text-[11px] text-red-600 flex items-start gap-1.5">
            <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
            <span>
              Orders API error: <code className="font-mono">{verification.amazonApiError}</code>
            </span>
          </p>
        )}
        {!verification.amazonApiError &&
          verification.amazonOrdersReturned === 0 &&
          (verification.syncStatus === "complete" || verification.syncStatus === "background") && (
            <p className="mt-2 text-[11px] text-orange-600 flex items-start gap-1.5">
              <Info className="h-3 w-3 mt-0.5 shrink-0" />
              <span>
                {verification.syncStatus === "complete" ? (
                  <><strong>Complete — Amazon returned zero orders for all chunks.</strong>{" "}</>
                ) : (
                  <>Amazon returned <strong>zero orders</strong> across all{" "}
                  {verification.chunksTotal ?? "the"} chunks for this range.{" "}</>
                )}
                The connection works — Amazon simply has no placement records indexed for these
                days. Older months sometimes age out of the Orders API even when Financial Events
                still hold the shipment records.
              </span>
            </p>
          )}
        {!verification.amazonApiError &&
          (verification.amazonOrdersReturned ?? 0) > 0 &&
          verification.inserted === 0 && (
            <p className="mt-2 text-[11px] text-muted-foreground flex items-start gap-1.5">
              <Info className="h-3 w-3 mt-0.5 shrink-0" />
              <span>
                Amazon returned {verification.amazonOrdersReturned} orders, but all of them already
                exist locally — no new rows needed.
              </span>
            </p>
          )}
        {verification.syncStatus === "background" && (
          <p className="mt-2 text-[11px] text-blue-600 flex items-start gap-1.5">
            <RefreshCw className="h-3 w-3 mt-0.5 shrink-0 animate-spin" />
            <span>
              Backfill is still running in the background ({verification.chunksCompleted ?? 0}/
              {verification.chunksTotal ?? "?"} chunks done). Re-open this period in a minute to see
              the final counts.
            </span>
          </p>
        )}
      </div>

      <div className="flex items-center justify-between mt-2 pt-2 border-t border-border/50">
        <span className="text-[10px] text-muted-foreground">
          Started {formatStamp(verification.startedAt)} · Finished {formatStamp(verification.finishedAt)}
        </span>
        {verification.needsLiveSalesRefresh && (
          <Badge variant="outline" className="text-[10px] gap-1 border-blue-500/40 text-blue-600">
            Refresh Live Sales to see new rows
            <ChevronRight className="h-3 w-3" />
          </Badge>
        )}
      </div>
    </div>
  );
}
