// Edge function: lets regular users browse data scanned & saved by admins.
// No external API costs — pure DB read using service role, scoped to admin-owned rows.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface BrowseRequest {
  mode:
    | "store_scan"
    | "supplier_discovery"
    | "store_scan_suppliers"
    | "scan_categories";
  // store_scan filters
  supplier_domain?: string;
  category_id?: string;
  search?: string;
  min_roi_pct?: number;
  // supplier_discovery filters
  asin?: string;
  // pagination
  limit?: number;
  offset?: number;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

    // Verify caller is authenticated (any logged-in user is fine)
    const authHeader = req.headers.get("Authorization") || "";
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userRes } = await userClient.auth.getUser();
    if (!userRes?.user) {
      return new Response(JSON.stringify({ error: "unauthenticated" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = (await req.json().catch(() => ({}))) as BrowseRequest;
    const limit = Math.min(Math.max(body.limit ?? 100, 1), 5000);
    const offset = Math.max(body.offset ?? 0, 0);

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    // Get all admin user_ids — those are the data owners we expose
    const { data: adminRows } = await admin
      .from("user_roles")
      .select("user_id")
      .eq("role", "admin");
    const adminIds = (adminRows ?? []).map((r) => r.user_id as string);
    if (adminIds.length === 0) {
      return new Response(JSON.stringify({ items: [], total: 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ---------- MODE: scan_categories (admin-curated) ----------
    if (body.mode === "scan_categories") {
      let q = admin
        .from("scan_categories")
        .select("id, name, supplier_domain, urls, last_scanned_at, last_successful_scan_at")
        .eq("is_active", true)
        .order("supplier_domain", { ascending: true })
        .order("name", { ascending: true });

      if (body.supplier_domain) {
        q = q.eq("supplier_domain", body.supplier_domain);
      }
      const { data, error } = await q;
      if (error) throw error;

      // Group by supplier
      const suppliers = new Map<string, number>();
      for (const r of data ?? []) {
        suppliers.set(r.supplier_domain, (suppliers.get(r.supplier_domain) ?? 0) + 1);
      }
      return new Response(
        JSON.stringify({
          categories: data ?? [],
          suppliers: Array.from(suppliers.entries()).map(([domain, count]) => ({
            domain,
            count,
          })),
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ---------- MODE: list of suppliers admin has scanned ----------
    if (body.mode === "store_scan_suppliers") {
      const { data } = await admin
        .from("store_scan_items")
        .select("source_url")
        .in("user_id", adminIds)
        .not("matched_asin", "is", null)
        .limit(5000);
      const counts = new Map<string, number>();
      for (const r of data ?? []) {
        try {
          const host = new URL((r as any).source_url).hostname.replace(/^www\./, "");
          counts.set(host, (counts.get(host) ?? 0) + 1);
        } catch { /* skip */ }
      }
      const suppliers = Array.from(counts.entries())
        .map(([domain, count]) => ({ domain, count }))
        .sort((a, b) => b.count - a.count);
      return new Response(JSON.stringify({ suppliers }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ---------- MODE: store_scan items (matched products) ----------
    if (body.mode === "store_scan") {
      // If category_id provided: prefer directly linked runs, but fall back to
      // older admin runs on the same supplier/category URLs so newly created
      // categories can still surface existing scan data.
      let runIdsForCategory: string[] | null = null;
      if (body.category_id) {
        const { data: runs, error: runsError } = await admin
          .from("store_scan_runs")
          .select("id")
          .eq("category_id", body.category_id)
          .in("user_id", adminIds);
        if (runsError) throw runsError;

        runIdsForCategory = (runs ?? []).map((r: any) => r.id);

        if (runIdsForCategory.length === 0) {
          const { data: category, error: categoryError } = await admin
            .from("scan_categories")
            .select("supplier_domain, urls")
            .eq("id", body.category_id)
            .maybeSingle();
          if (categoryError) throw categoryError;

          if (category) {
            const normalizeScope = (raw: string | null | undefined): string => {
              if (!raw) return "";
              let v = String(raw).trim().toLowerCase();
              if (!v) return "";
              v = v.replace(/#.*$/, "");
              v = v.replace(/^https?:\/\//, "");
              v = v.replace(/^www\./, "");
              v = v.replace(/\?.*$/, "");
              v = v.replace(/\/+$/, "");
              return v;
            };
            const categoryUrls = new Set(
              ((category.urls ?? []) as string[])
                .map(normalizeScope)
                .filter(Boolean),
            );

            const { data: fallbackRuns, error: fallbackError } = await admin
              .from("store_scan_runs")
              .select("id, scope_urls")
              .ilike("supplier_domain", category.supplier_domain)
              .in("user_id", adminIds)
              .order("created_at", { ascending: false })
              .limit(200);
            if (fallbackError) throw fallbackError;

            runIdsForCategory = (fallbackRuns ?? [])
              .filter((run: any) =>
                Array.isArray(run.scope_urls) &&
                run.scope_urls.some((url: string) => categoryUrls.has(normalizeScope(url))),
              )
              .map((run: any) => run.id);
          }
        }

        if (runIdsForCategory.length === 0) {
          return new Response(JSON.stringify({ items: [], total: 0 }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }

      const wantsRoiFilter =
        typeof body.min_roi_pct === "number" && body.min_roi_pct > 0;

      // When a ROI filter is active, we must recompute ROI per-user using their
      // cached Amazon fees. Pull a wider window (capped) and post-filter so
      // pagination math stays consistent on the client.
      const fetchLimit = wantsRoiFilter ? Math.max(500, limit) : limit;
      const fetchOffset = wantsRoiFilter ? 0 : offset;

      // PostgREST caps a single request at 1000 rows. Paginate internally so
      // requested limits up to 5000 actually return the full dataset.
      const PG_PAGE = 1000;
      const normalizeSupplierKey = (raw: string | null | undefined): string => {
        if (!raw) return "";
        let v = String(raw).trim().toLowerCase();
        v = v.replace(/#.*$/, "");
        v = v.replace(/^https?:\/\//, "");
        v = v.replace(/^www\./, "");
        v = v.replace(/\?.*$/, "");
        v = v.replace(/\/+$/, "");
        return v;
      };

      const buildQuery = (from: number, to: number, withCount: boolean) => {
        let q = admin
          .from("store_scan_items")
          .select(
            "id, run_id, source_url, source_title, source_price, source_currency, source_image_url, source_availability, source_availability_status, matched_asin, amz_title, amz_price, amz_image_url, amz_candidates, match_score, match_method, match_confidence, roi, margin_pct, status, created_at",
            withCount ? { count: "exact" } : undefined,
          )
          .in("user_id", adminIds)
          .order("created_at", { ascending: false })
          // created_at is not unique, so it cannot order pages on its own:
          // a tie spanning a page boundary repeats or skips rows. id breaks it.
          .order("id", { ascending: true })
          .range(from, to);

        if (runIdsForCategory) q = q.in("run_id", runIdsForCategory);
        if (body.supplier_domain) q = q.ilike("source_url", `%${body.supplier_domain}%`);
        if (body.search && body.search.trim()) {
          const s = body.search.trim();
          // Search supplier title only (no ASIN, no Amazon title)
          q = q.ilike("source_title", `%${s}%`);
        }
        return q;
      };

      let collected: any[] = [];
      let totalCount: number | null = null;
      let cursor = fetchOffset;
      const end = fetchOffset + fetchLimit - 1;
      while (cursor <= end) {
        const pageEnd = Math.min(cursor + PG_PAGE - 1, end);
        const isFirst = cursor === fetchOffset;
        const { data, count, error } = await buildQuery(cursor, pageEnd, isFirst);
        if (error) throw error;
        if (isFirst) totalCount = count ?? null;
        const batch = data ?? [];
        collected = collected.concat(batch);
        if (batch.length < (pageEnd - cursor + 1)) break; // no more rows
        cursor = pageEnd + 1;
      }

      let items = collected;
      // Dedupe with a quality-aware preference order. The prior logic (newest
      // wins) let a failed/queued/blocked rescan overwrite an earlier verified
      // match — which is exactly what made GameStop matches "vanish". New rule:
      //   1. Prefer rows with matched_asin AND a usable amz_price (real opps)
      //   2. Then rows with matched_asin (identity confirmed, price pending)
      //   3. Then rows with status='matched'
      //   4. Then anything else (newest)
      // Within each tier the newest row still wins.
      const tierOf = (it: any): number => {
        const hasAsin = !!it.matched_asin;
        const price = Number(it.amz_price);
        const hasPrice = Number.isFinite(price) && price > 0;
        if (hasAsin && hasPrice) return 3;
        if (hasAsin) return 2;
        if ((it.status ?? "").toLowerCase() === "matched") return 1;
        return 0;
      };
      const tsOf = (it: any): number => {
        const t = Date.parse(it.created_at ?? "");
        return Number.isFinite(t) ? t : 0;
      };
      const deduped = new Map<string, any>();
      for (const item of items) {
        const key = [normalizeSupplierKey(item.source_url), (item.source_title ?? "").trim().toLowerCase()].join("::");
        const existing = deduped.get(key);
        if (!existing) { deduped.set(key, item); continue; }
        const newTier = tierOf(item);
        const oldTier = tierOf(existing);
        if (newTier > oldTier) { deduped.set(key, item); continue; }
        if (newTier === oldTier && tsOf(item) > tsOf(existing)) deduped.set(key, item);
      }
      items = Array.from(deduped.values());
      const count = totalCount;

      // ===== Attach cached AI verdicts (Layer 4 cache, shared) =====
      if (items.length > 0) {
        const normalizeUrl = (raw: string): string => {
          if (!raw) return "";
          let v = String(raw).trim().toLowerCase();
          v = v.replace(/#.*$/, "");
          v = v.replace(/^https?:\/\//, "");
          v = v.replace(/^www\./, "");
          v = v.replace(/\?.*$/, "");
          v = v.replace(/\/+$/, "");
          return v;
        };
        const norms = Array.from(
          new Set(items.map((it: any) => normalizeUrl(it.source_url)).filter(Boolean)),
        ) as string[];
        const asinsForVerdicts = Array.from(
          new Set(items.map((it: any) => (it.matched_asin ?? "").toUpperCase()).filter(Boolean)),
        ) as string[];
        if (norms.length > 0 && asinsForVerdicts.length > 0) {
          const { data: verdicts } = await admin
            .from("store_scan_ai_verifications")
            .select("source_url_norm, asin, verdict, confidence, reason, evidence, verified_at")
            .in("source_url_norm", norms)
            .in("asin", asinsForVerdicts);
          const vMap = new Map<string, any>();
          for (const v of verdicts ?? []) {
            vMap.set(`${v.source_url_norm}::${v.asin}`, v);
          }
          items = items.map((it: any) => {
            const v = vMap.get(`${normalizeUrl(it.source_url)}::${(it.matched_asin ?? "").toUpperCase()}`);
            return v
              ? {
                  ...it,
                  ai_verdict: v.verdict,
                  ai_confidence: v.confidence,
                  ai_reason: v.reason,
                  ai_evidence: v.evidence,
                  ai_verified_at: v.verified_at,
                }
              : it;
          });
        }
      }

      // ===== Per-user hybrid ROI recalculation =====
      // Use the calling user's asin_fee_cache when available; fall back to the
      // admin-stored ROI if we have no fee data for that ASIN.
      if (items.length > 0) {
        const userId = userRes.user.id;
        const asins = Array.from(
          new Set(items.map((it: any) => it.matched_asin).filter(Boolean)),
        ) as string[];

        // Pull cached fees for this user
        const { data: feeRows } = await admin
          .from("asin_fee_cache")
          .select("asin, referral_rate, fba_fee_fixed")
          .eq("user_id", userId)
          .in("asin", asins);

        const feeMap = new Map<
          string,
          { referralRate: number; fbaFeeFixed: number }
        >();
        for (const f of feeRows ?? []) {
          feeMap.set(f.asin as string, {
            referralRate: Number(f.referral_rate ?? 0.15),
            fbaFeeFixed: Number(f.fba_fee_fixed ?? 0),
          });
        }

        // Build FX map for any non-USD source currencies we encounter
        const currencies = Array.from(
          new Set(
            items
              .map((it: any) => (it.source_currency ?? "USD").toUpperCase())
              .filter((c: string) => c && c !== "USD"),
          ),
        ) as string[];

        const fxMap = new Map<string, number>([["USD", 1]]);
        if (currencies.length > 0) {
          const { data: fxRows } = await admin
            .from("fx_rates")
            .select("quote, rate")
            .eq("base", "USD")
            .in("quote", currencies);
          for (const r of fxRows ?? []) {
            const rate = Number(r.rate);
            if (rate > 0) fxMap.set(r.quote as string, rate);
          }
        }

        items = items.map((it: any) => {
          const sellPrice = Number(it.amz_price ?? 0);
          const sourcePriceRaw = Number(it.source_price ?? 0);
          const cur = (it.source_currency ?? "USD").toUpperCase();
          const fx = fxMap.get(cur) ?? 1; // 1 USD = fx <cur>
          const sourcePriceUsd = fx > 0 ? sourcePriceRaw / fx : sourcePriceRaw;

          const fee = feeMap.get(it.matched_asin);
          let recomputedRoi: number | null = null;
          let recomputedMargin: number | null = null;
          let roiSource: "user_fees" | "admin_stored" = "admin_stored";

          if (fee && sellPrice > 0 && sourcePriceUsd > 0) {
            const totalFees =
              fee.fbaFeeFixed + sellPrice * fee.referralRate;
            const netProceeds = sellPrice - totalFees;
            const profit = netProceeds - sourcePriceUsd;
            recomputedRoi = (profit / sourcePriceUsd) * 100;
            recomputedMargin = sellPrice > 0 ? (profit / sellPrice) * 100 : null;
            roiSource = "user_fees";
          }

          return {
            ...it,
            roi: recomputedRoi ?? it.roi,
            margin_pct: recomputedMargin ?? it.margin_pct,
            roi_source: roiSource,
          };
        });

        // Server-side ROI filter on recomputed values
        if (wantsRoiFilter) {
          const min = body.min_roi_pct as number;
          items = items.filter(
            (it: any) => typeof it.roi === "number" && it.roi >= min,
          );
        }
      }

      // When the ROI filter is active, paginate the post-filtered list
      const total = wantsRoiFilter ? items.length : count ?? 0;
      const paged = wantsRoiFilter
        ? items.slice(offset, offset + limit)
        : items;

      return new Response(JSON.stringify({ items: paged, total }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ---------- MODE: supplier_discovery (ASIN -> source candidates) ----------
    if (body.mode === "supplier_discovery") {
      const asin = (body.asin ?? "").trim().toUpperCase();
      if (!asin) {
        return new Response(
          JSON.stringify({ error: "asin required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const { data: runs } = await admin
        .from("source_discovery_runs")
        .select(
          "id, asin, amazon_title, brand, status, total_candidates, extracted_count, top_valid_price, top_valid_url, top_valid_domain, created_at, quality_badge",
        )
        .in("user_id", adminIds)
        .eq("asin", asin)
        .order("created_at", { ascending: false })
        .limit(5);

      if (!runs || runs.length === 0) {
        return new Response(
          JSON.stringify({ run: null, candidates: [], message: "No admin scan yet for this ASIN." }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const runIds = runs.map((r) => r.id);
      const { data: candidates } = await admin
        .from("source_candidates")
        .select(
          "id, run_id, source_url, domain, source_type, source_title, source_snippet, match_score, phase1_status, phase2_status, final_resolution, current_price, original_price, currency, availability, image_url, confidence_score, needs_review",
        )
        .in("run_id", runIds)
        .order("match_score", { ascending: false })
        .limit(200);

      return new Response(
        JSON.stringify({ run: runs[0], runs, candidates: candidates ?? [] }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(JSON.stringify({ error: "unknown mode" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? (err as Error).message : "unknown";
    console.error("[user-browse-admin-data] error:", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
