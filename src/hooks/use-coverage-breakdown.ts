import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

export interface CoverageBreakdown {
  /** Time-bucketed check counts */
  checkedLast15m: number;
  checkedLast1h: number;
  checkedLast4h: number;
  checkedLast24h: number;
  neverCheckedToday: number;
  /** ASINs checked more than once today */
  repeatedlyChecked: number;
  /** Average minutes between checks for ASINs checked 2+ times */
  avgMinutesBetweenChecks: number | null;
  /** Total active unique ASINs */
  totalActive: number;
  /** Top re-checked ASINs (potential hotspot hogs) */
  topRechecked: { asin: string; checkCount: number }[];
  loading: boolean;
}

export interface EmptySnapshotBreakdown {
  /** By source */
  bySource: { source: string; total: number; empty: number; pct: number }[];
  /** By marketplace */
  byMarketplace: { marketplace: string; total: number; empty: number; pct: number }[];
  /** Top ASINs with empty snapshots */
  topEmptyAsins: { asin: string; emptyCount: number; totalCount: number }[];
  /** Snapshots that were empty but later succeeded for same ASIN */
  recoveredCount: number;
  /** ASINs that are ALWAYS empty (never had a successful snapshot in 24h) */
  persistentEmptyCount: number;
  totalEmpty: number;
  totalSnapshots: number;
  loading: boolean;
}

export function useCoverageBreakdown(): CoverageBreakdown {
  const { user } = useAuth();
  const [data, setData] = useState<Omit<CoverageBreakdown, "loading">>({
    checkedLast15m: 0, checkedLast1h: 0, checkedLast4h: 0, checkedLast24h: 0,
    neverCheckedToday: 0, repeatedlyChecked: 0, avgMinutesBetweenChecks: null,
    totalActive: 0, topRechecked: [], 
  });
  const [loading, setLoading] = useState(true);

  const fetch_ = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const now = Date.now();
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
      const t15m = new Date(now - 15 * 60 * 1000);
      const t1h = new Date(now - 60 * 60 * 1000);
      const t4h = new Date(now - 4 * 60 * 60 * 1000);

      // Fetch all active assignments with last_sp_api_check_at
      let allAssignments: any[] = [];
      let page = 0;
      const PAGE = 1000;
      while (true) {
        const { data: batch } = await supabase
          .from("repricer_assignments")
          .select("asin, last_sp_api_check_at, status, is_enabled, marketplace")
          .eq("user_id", user.id)
          .eq("is_enabled", true)
          .eq("status", "active")
          .order("id", { ascending: true })
          .range(page * PAGE, (page + 1) * PAGE - 1);
        if (!batch || batch.length === 0) break;
        allAssignments = allAssignments.concat(batch);
        if (batch.length < PAGE) break;
        page++;
      }

      const latestCheckByAsin = new Map<string, number | null>();
      for (const assignment of allAssignments) {
        const asin = assignment.asin;
        if (!asin) continue;

        const nextTs = assignment.last_sp_api_check_at
          ? new Date(assignment.last_sp_api_check_at).getTime()
          : null;
        const prevTs = latestCheckByAsin.get(asin);

        if (prevTs === undefined || (nextTs !== null && (prevTs === null || nextTs > prevTs))) {
          latestCheckByAsin.set(asin, nextTs);
        } else if (prevTs === undefined) {
          latestCheckByAsin.set(asin, null);
        }
      }

      const totalActive = latestCheckByAsin.size;
      let c15 = 0, c1h = 0, c4h = 0, c24h = 0, never = 0;
      for (const ts of latestCheckByAsin.values()) {
        if (!ts) { never++; continue; }
        if (ts < todayStart.getTime()) { never++; continue; }
        c24h++;
        if (ts >= t4h.getTime()) { c4h++; }
        if (ts >= t1h.getTime()) { c1h++; }
        if (ts >= t15m.getTime()) { c15++; }
      }

      // Check action counts per ASIN today for repeated-check analysis
      const { data: actionCounts } = await supabase
        .from("repricer_price_actions")
        .select("asin")
        .eq("user_id", user.id)
        .gte("created_at", todayStart.toISOString());

      const asinCounts: Record<string, number> = {};
      for (const a of actionCounts || []) {
        asinCounts[a.asin] = (asinCounts[a.asin] || 0) + 1;
      }
      const repeated = Object.values(asinCounts).filter(c => c > 1).length;
      const topRechecked = Object.entries(asinCounts)
        .filter(([, c]) => c > 1)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([asin, checkCount]) => ({ asin, checkCount }));

      // Estimate avg interval from top rechecked
      let avgMin: number | null = null;
      if (repeated > 0 && c24h > 0) {
        const hoursElapsed = (now - todayStart.getTime()) / (1000 * 60 * 60);
        const totalChecks = Object.values(asinCounts).reduce((s, c) => s + c, 0);
        if (totalChecks > totalActive && hoursElapsed > 0) {
          avgMin = Math.round((hoursElapsed * 60 * totalActive) / totalChecks);
        }
      }

      setData({
        checkedLast15m: c15, checkedLast1h: c1h, checkedLast4h: c4h, checkedLast24h: c24h,
        neverCheckedToday: never, repeatedlyChecked: repeated,
        avgMinutesBetweenChecks: avgMin, totalActive, topRechecked,
      });
    } catch (e) {
      console.error("Coverage breakdown error:", e);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => { fetch_(); const i = setInterval(fetch_, 120_000); return () => clearInterval(i); }, [fetch_]);
  return { ...data, loading };
}

export function useEmptySnapshotBreakdown(): EmptySnapshotBreakdown {
  const { user } = useAuth();
  const [data, setData] = useState<Omit<EmptySnapshotBreakdown, "loading">>({
    bySource: [], byMarketplace: [], topEmptyAsins: [], recoveredCount: 0, persistentEmptyCount: 0, totalEmpty: 0, totalSnapshots: 0,
  });
  const [loading, setLoading] = useState(true);

  const fetch_ = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      // Fetch snapshots with source + marketplace
      const { data: snaps } = await supabase
        .from("repricer_competitor_snapshots")
        .select("asin, source, marketplace, buybox_price, lowest_fba_price, lowest_overall_price, offers_json, fetched_at")
        .gte("fetched_at", twentyFourHoursAgo)
        .order("fetched_at", { ascending: false })
        .limit(1000);

      const snapshots = snaps || [];

      const isEmpty = (s: any) => {
        return !s.buybox_price && !s.lowest_fba_price && !s.lowest_overall_price &&
          (!s.offers_json || !Array.isArray(s.offers_json) || s.offers_json.length === 0);
      };

      // By source
      const sourceMap: Record<string, { total: number; empty: number }> = {};
      const mktMap: Record<string, { total: number; empty: number }> = {};
      const asinEmptyMap: Record<string, { empty: number; total: number }> = {};
      const asinHasSuccess: Set<string> = new Set();
      const emptyAsins: Set<string> = new Set();

      for (const s of snapshots) {
        const src = s.source || "unknown";
        const mkt = s.marketplace || "US";
        if (!sourceMap[src]) sourceMap[src] = { total: 0, empty: 0 };
        if (!mktMap[mkt]) mktMap[mkt] = { total: 0, empty: 0 };
        if (!asinEmptyMap[s.asin]) asinEmptyMap[s.asin] = { empty: 0, total: 0 };

        sourceMap[src].total++;
        mktMap[mkt].total++;
        asinEmptyMap[s.asin].total++;

        if (isEmpty(s)) {
          sourceMap[src].empty++;
          mktMap[mkt].empty++;
          asinEmptyMap[s.asin].empty++;
          emptyAsins.add(s.asin);
        } else {
          asinHasSuccess.add(s.asin);
        }
      }

      const totalEmpty = snapshots.filter(isEmpty).length;
      const recoveredCount = [...emptyAsins].filter(a => asinHasSuccess.has(a)).length;
      const persistentEmptyCount = [...emptyAsins].filter(a => !asinHasSuccess.has(a)).length;

      const bySource = Object.entries(sourceMap)
        .map(([source, v]) => ({ source, ...v, pct: v.total > 0 ? Math.round((v.empty / v.total) * 100) : 0 }))
        .sort((a, b) => b.empty - a.empty);

      const byMarketplace = Object.entries(mktMap)
        .map(([marketplace, v]) => ({ marketplace, ...v, pct: v.total > 0 ? Math.round((v.empty / v.total) * 100) : 0 }))
        .sort((a, b) => b.empty - a.empty);

      const topEmptyAsins = Object.entries(asinEmptyMap)
        .filter(([, v]) => v.empty > 0)
        .sort((a, b) => b[1].empty - a[1].empty)
        .slice(0, 10)
        .map(([asin, v]) => ({ asin, emptyCount: v.empty, totalCount: v.total }));

      setData({ bySource, byMarketplace, topEmptyAsins, recoveredCount, persistentEmptyCount, totalEmpty, totalSnapshots: snapshots.length });
    } catch (e) {
      console.error("Empty snapshot breakdown error:", e);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => { fetch_(); const i = setInterval(fetch_, 120_000); return () => clearInterval(i); }, [fetch_]);
  return { ...data, loading };
}
