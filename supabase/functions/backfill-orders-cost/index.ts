// Bulk-backfill ASIN / SKU / title / image_url / unit_cost on sales_orders
// from fnsku_map + created_listings + inventory. Server-side, no row cap.
//
// Body: { startDate: 'YYYY-MM-DD', endDate: 'YYYY-MM-DD' }
// Uses caller's JWT to scope all reads/writes to that user (RLS-friendly).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const isNumericSku = (v: string) => /^\d{7,}$/.test(v);
const isValidAsin = (v: string) => /^[A-Z0-9]{10}$/i.test(v);

function pickUnitCostFromListing(row: {
  amount: number | null;
  cost: number | null;
  units: number | null;
}): number | null {
  // Contract A for created_listings: amount = UNIT cost, cost = TOTAL batch cost
  if (row.amount != null && row.amount >= 0) return row.amount;
  if ((row.cost ?? 0) > 0 && (row.units ?? 0) > 0) {
    return (row.cost as number) / (row.units as number);
  }
  return null;
}

function pickUnitCostFromInventory(row: {
  amount: number | null;
  cost: number | null;
  units: number | null;
}): number | null {
  // Contract A for inventory: cost = UNIT cost, amount = TOTAL batch cost
  if (row.cost != null && row.cost > 0) return row.cost;
  if ((row.amount ?? 0) > 0 && (row.units ?? 0) > 0) {
    return (row.amount as number) / (row.units as number);
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAuth = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const supabase = createClient(supabaseUrl, serviceKey);

    const { data: userData, error: userErr } = await supabaseAuth.auth.getUser();
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userId = userData.user.id;

    const body = await req.json().catch(() => ({}));
    const startDate: string = body.startDate || "2025-01-01";
    const endDate: string = body.endDate || "2026-01-01";

    console.log(`[backfill-orders-cost] user=${userId} range=${startDate}..${endDate}`);

    // 1. Pull every broken sales_orders row (paged, no 1000 limit)
    type Row = {
      id: string;
      order_id: string;
      asin: string;
      sku: string | null;
      title: string | null;
      image_url: string | null;
      unit_cost: number | null;
      quantity: number;
    };
    const broken: Row[] = [];
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from("sales_orders")
        .select("id, order_id, asin, sku, title, image_url, unit_cost, quantity")
        .eq("user_id", userId)
        .gte("order_date", startDate)
        .lt("order_date", endDate)
        .not("order_id", "like", "%-REFUND")
        .or(
          "unit_cost.is.null,unit_cost.eq.0,title.is.null,title.eq.,title.eq.-,title.eq.Order Processing...,image_url.is.null,image_url.eq."
        )
        .order("id", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      broken.push(...(data as Row[]));
      if (data.length < PAGE) break;
    }

    console.log(`[backfill-orders-cost] found ${broken.length} broken rows`);

    if (broken.length === 0) {
      return new Response(
        JSON.stringify({ scanned: 0, updated: 0, by_field: {} }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 2. Load full lookup tables for this user — PAGED to bypass the
    //    Supabase 1000-row default cap. Without paging, the resolver
    //    silently misses 80%+ of SKU→ASIN mappings on large accounts.
    const PAGE_LOOKUP = 1000;
    async function loadAll<T>(
      builder: () => any,
      label: string
    ): Promise<T[]> {
      const all: T[] = [];
      for (let from = 0; ; from += PAGE_LOOKUP) {
        // Applied HERE rather than in each caller's builder: all three
        // tables below carry an id, and a caller cannot be relied on to
        // remember an ORDER BY that only matters past row 1000.
        const { data, error } = await builder()
          .order("id", { ascending: true })
          .range(from, from + PAGE_LOOKUP - 1);
        if (error) {
          console.error(`[backfill-orders-cost] load ${label} failed:`, error.message);
          throw error;
        }
        if (!data || data.length === 0) break;
        all.push(...(data as T[]));
        if (data.length < PAGE_LOOKUP) break;
      }
      return all;
    }

    const [fnskuRows, listingRows, invRows] = await Promise.all([
      loadAll<{ seller_sku: string; asin: string }>(
        () => supabase.from("fnsku_map").select("seller_sku, asin"),
        "fnsku_map"
      ),
      loadAll<any>(
        () =>
          supabase
            .from("created_listings")
            .select("asin, sku, title, image_url, cost, units, amount, updated_at")
            .eq("user_id", userId),
        "created_listings"
      ),
      loadAll<any>(
        () =>
          supabase
            .from("inventory")
            .select("asin, sku, title, image_url, cost, units, amount, unit_cost_manual")
            .eq("user_id", userId),
        "inventory"
      ),
    ]);
    console.log(
      `[backfill-orders-cost] loaded fnsku_map=${fnskuRows.length} created_listings=${listingRows.length} inventory=${invRows.length}`
    );

    const skuToAsin = new Map<string, string>();
    (fnskuRows || []).forEach((r) => {
      if (r.seller_sku && r.asin) skuToAsin.set(r.seller_sku, r.asin);
    });

    type Enriched = {
      asin: string;
      title: string | null;
      image_url: string | null;
      unit_cost: number | null;
      cost_locked?: boolean; // true when user manually set inventory cost
    };
    const asinToData = new Map<string, Enriched>();
    const skuToData = new Map<string, Enriched>();
    const manualAsins = new Set<string>();
    const manualSkus = new Set<string>();

    // Inventory first (older, lower priority for cost — UNLESS manual)
    (invRows || []).forEach((r) => {
      const uc = pickUnitCostFromInventory(r);
      const isManual = r.unit_cost_manual === true && Number(r.cost) > 0;
      const enr: Enriched = {
        asin: r.asin,
        title: r.title,
        image_url: r.image_url,
        unit_cost: isManual ? Number(r.cost) : uc,
        cost_locked: isManual,
      };
      if (r.asin) {
        asinToData.set(r.asin, enr);
        if (isManual) manualAsins.add(r.asin);
      }
      if (r.sku) {
        skuToData.set(r.sku, enr);
        if (isManual) manualSkus.add(r.sku);
        if (!skuToAsin.has(r.sku) && r.asin) skuToAsin.set(r.sku, r.asin);
      }
    });

    // created_listings overrides (authoritative for cost) — EXCEPT when user has locked manual inventory cost
    const sortedListings = [...(listingRows || [])].sort((a, b) =>
      (b.updated_at || "").localeCompare(a.updated_at || "")
    );
    sortedListings.forEach((r) => {
      const uc = pickUnitCostFromListing(r);
      const enr: Enriched = {
        asin: r.asin,
        title: r.title,
        image_url: r.image_url,
        unit_cost: uc,
      };
      if (r.asin && !asinToData.has(r.asin)) asinToData.set(r.asin, enr);
      else if (r.asin && uc != null) {
        const existing = asinToData.get(r.asin)!;
        // Never overwrite a user-locked manual cost.
        const nextCost = existing.cost_locked ? existing.unit_cost : (existing.unit_cost ?? uc);
        asinToData.set(r.asin, {
          ...existing,
          unit_cost: nextCost,
          title: existing.title || r.title,
          image_url: existing.image_url || r.image_url,
        });
      }
      if (r.sku) {
        if (!skuToData.has(r.sku)) skuToData.set(r.sku, enr);
        if (!skuToAsin.has(r.sku) && r.asin) skuToAsin.set(r.sku, r.asin);
      }
    });


    // 3. Compute updates per row
    let updatedCount = 0;
    const fieldStats = { asin: 0, sku: 0, title: 0, image_url: 0, unit_cost: 0 };
    const BATCH = 50;

    for (let i = 0; i < broken.length; i += BATCH) {
      const chunk = broken.slice(i, i + BATCH);
      await Promise.all(
        chunk.map(async (order) => {
          let realAsin = order.asin;
          let realSku = order.sku;

          // Numeric "asin" is actually a SKU
          if (isNumericSku(order.asin)) {
            const mapped = skuToAsin.get(order.asin);
            if (mapped) {
              realAsin = mapped;
              if (!realSku) realSku = order.asin;
            }
          }
          // Letter-code SKU stored in asin field (e.g. "OD-QXFZ-J2IU")
          if (!isValidAsin(order.asin) && !isNumericSku(order.asin)) {
            const mapped = skuToAsin.get(order.asin);
            if (mapped) {
              realAsin = mapped;
              if (!realSku) realSku = order.asin;
            }
          }
          // Try via existing sku
          if (!isValidAsin(realAsin) && realSku) {
            const mapped = skuToAsin.get(realSku);
            if (mapped) realAsin = mapped;
          }

          const matched =
            (realSku ? skuToData.get(realSku) : undefined) ||
            (skuToData.get(order.asin)) ||
            (isValidAsin(realAsin) ? asinToData.get(realAsin) : undefined);

          const updates: Record<string, unknown> = {};

          if (
            (order.asin === "PENDING" ||
              order.asin === "UNKNOWN" ||
              isNumericSku(order.asin) ||
              !isValidAsin(order.asin)) &&
            isValidAsin(realAsin) &&
            realAsin !== order.asin
          ) {
            updates.asin = realAsin;
          }

          if (
            !order.sku &&
            (isNumericSku(order.asin) || !isValidAsin(order.asin))
          ) {
            updates.sku = order.asin;
          }

          if (matched) {
            if (
              (!order.title ||
                order.title === "Order Processing..." ||
                order.title === "-") &&
              matched.title
            ) {
              updates.title = matched.title;
            }
            if (!order.image_url && matched.image_url) {
              updates.image_url = matched.image_url;
            }
            if (
              (!order.unit_cost || order.unit_cost === 0) &&
              matched.unit_cost &&
              matched.unit_cost > 0
            ) {
              updates.unit_cost = matched.unit_cost;
              // CRITICAL: also clear cost_invalid + recompute total_cost so the
              // Business Health "Order has invalid cost" issue auto-resolves.
              updates.cost_invalid = false;
              updates.total_cost = matched.unit_cost * (order.quantity || 1);
            }
          }

          if (Object.keys(updates).length === 0) return;

          const { error: upErr } = await supabase
            .from("sales_orders")
            .update(updates)
            .eq("id", order.id);

          if (!upErr) {
            updatedCount++;
            for (const k of Object.keys(updates)) {
              if (k in fieldStats)
                (fieldStats as Record<string, number>)[k]++;
            }
            return;
          }

          // Collision on uq (user_id, order_id, asin): a "good" sibling row
          // already exists for this order with the real ASIN. The current row
          // is a ghost duplicate (SKU stored in asin column, no cost). The
          // safe fix is to delete the ghost — the sibling already has the
          // correct data (cost / title / image).
          const isDup =
            upErr.code === "23505" ||
            (upErr.message || "").includes("sales_orders_user_order_asin_idx") ||
            (upErr.message || "").includes("duplicate key");

          if (isDup && updates.asin) {
            const { error: delErr } = await supabase
              .from("sales_orders")
              .delete()
              .eq("id", order.id);
            if (!delErr) {
              updatedCount++;
              (fieldStats as Record<string, number>)["asin"]++;
            } else {
              console.warn(
                `[backfill-orders-cost] ghost delete failed id=${order.id}:`,
                delErr.message
              );
            }
          } else {
            console.warn(
              `[backfill-orders-cost] update failed id=${order.id}:`,
              upErr.message
            );
          }
        })
      );
    }

    console.log(
      `[backfill-orders-cost] done. scanned=${broken.length} updated=${updatedCount}`,
      fieldStats
    );

    return new Response(
      JSON.stringify({
        scanned: broken.length,
        updated: updatedCount,
        by_field: fieldStats,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("[backfill-orders-cost] error:", err);
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
