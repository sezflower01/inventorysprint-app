import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { checkModuleAccess } from '../_shared/module-access-guard.ts';
import { loadRepricerCostMap, repricerCostKey } from '../_shared/cog-for-repricer.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * Backfill min/max prices for setup-incomplete repricer assignments.
 *
 * Strategy:
 * - min_price = MAX(cost * 1.15, reference_price * 0.70)
 * - max_price = GREATEST(reference_price * 1.20, min_price * 1.35)
 * - current live price is reported separately so risky suggestions can be reviewed manually
 * - skips rows where both price and cost data are missing
 */

type InventoryRow = {
  asin: string;
  sku: string;
  cost: number | null;
  amazon_price: number | null;
  my_price: number | null;
  price: number | null;
  amount: number | null;
  units: number | null;
};

const pickPositive = (...values: Array<number | null | undefined>) => {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return value;
    }
  }
  return null;
};

const roundMoney = (value: number) => Math.round(value * 100) / 100;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) throw new Error('No authorization header');

    const token = authHeader.replace('Bearer ', '');
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser(token);
    if (userError || !user) throw new Error('Unauthorized');

    // MODULE ACCESS GUARD: backfilling min/max overrides modifies repricer config = repricer:edit
    const access = await checkModuleAccess(supabase, user.id, 'repricer', 'edit');
    if (!access.allowed) {
      console.warn(`[backfill-min-max] MODULE BLOCKED user=${user.id} reason=${access.reason}`);
      return new Response(
        JSON.stringify({ success: false, error: access.reason }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const body = await req.json().catch(() => ({}));
    const dryRun = body.dryRun === true;
    const marketplace = body.marketplace || null;
    const minMarginPct = body.minMarginPct ?? 10;
    const maxCeilingPct = body.maxCeilingPct ?? 20;
    const floorPctOfRef = body.floorPctOfRef ?? 0.85; // more aggressive: 85% of ref instead of 70%

    console.log(
      `[backfill-min-max] user=${user.id} dryRun=${dryRun} marketplace=${marketplace ?? 'ALL'} margin=${minMarginPct}% ceiling=${maxCeilingPct}%`,
    );

    const PAGE = 1000;
    let allAssignments: any[] = [];
    let page = 0;

    while (true) {
      let query = supabase
        .from('repricer_assignments')
        .select('id, asin, sku, marketplace, min_price_override, max_price_override, last_applied_price')
        .eq('user_id', user.id)
        .eq('status', 'active')
        .is('min_price_override', null)
        .range(page * PAGE, (page + 1) * PAGE - 1);

      if (marketplace) {
        query = query.eq('marketplace', marketplace);
      }

      const { data, error } = await query;
      if (error) {
        console.error('Assignment fetch error:', error);
        break;
      }
      if (!data || data.length === 0) break;

      allAssignments = allAssignments.concat(data);
      if (data.length < PAGE) break;
      page++;
    }

    console.log(`[backfill-min-max] Found ${allAssignments.length} assignments missing min_price`);

    if (allAssignments.length === 0) {
      return new Response(
        JSON.stringify({ success: true, updated: 0, skipped: 0, message: 'No setup-incomplete assignments found' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const asins = [...new Set(allAssignments.map((assignment: any) => assignment.asin))];
    let allInventory: InventoryRow[] = [];

    for (let i = 0; i < asins.length; i += 200) {
      const chunk = asins.slice(i, i + 200);
      const { data: inventoryRows } = await supabase
        .from('inventory')
        .select('asin, sku, cost, amazon_price, my_price, price, amount, units')
        .eq('user_id', user.id)
        .in('asin', chunk);

      if (inventoryRows) {
        allInventory = allInventory.concat(inventoryRows as InventoryRow[]);
      }
    }

    // Unit cost precedence (since 2026-09-16), same as every other repricer
    // path: asin_cost_overrides -> COG on record -> the inventory-derived cost
    // below. This function WRITES min prices, so it starts from the number the
    // seller maintains on the COG page. Placeholder COGs ($1.00 import lots,
    // unreviewed) are excluded by the asin_cog_for_repricer view.
    //
    // The inventory fallback below is kept as it was, but note it divides
    // inventory.cost by units -- inventory.cost is already a UNIT cost under
    // the cost contract (inventory and created_listings swap cost/amount), so
    // that path under-states cost whenever units > 1. COG-first bypasses it
    // for every ASIN with a usable COG.
    const repricerCostMap = await loadRepricerCostMap(supabase, [user.id], asins);

    const invMap = new Map<string, InventoryRow>();
    for (const row of allInventory) {
      invMap.set(`${row.asin}::${row.sku}`, row);
      if (!invMap.has(row.asin)) invMap.set(row.asin, row);
    }

    const updates: Array<{
      id: string;
      asin: string;
      sku: string;
      marketplace: string;
      minPrice: number;
      maxPrice: number;
      source: string;
      refPrice: number | null;
      currentPrice: number | null;
      unitCost: number | null;
      priceGap: number | null;
      needsReview: boolean;
      reviewReason: string | null;
      isInvalidSuggestion: boolean;
    }> = [];
    let skipped = 0;
    const skipReasons: Record<string, number> = {};

    for (const assignment of allAssignments) {
      const inv = invMap.get(`${assignment.asin}::${assignment.sku}`) || invMap.get(assignment.asin);

      let unitCost: number | null = repricerCostMap.get(repricerCostKey(user.id, assignment.asin))?.unitCost ?? null;
      if (unitCost == null && inv) {
        if (pickPositive(inv.cost) && pickPositive(inv.units)) {
          unitCost = inv.cost! / inv.units!;
        } else if (pickPositive(inv.amount) && (inv.amount ?? 0) < 500) {
          unitCost = inv.amount!;
        }
      }

      const currentPrice = pickPositive(assignment.last_applied_price, inv?.my_price, inv?.price);
      const currentSource = pickPositive(assignment.last_applied_price)
        ? 'last_applied_price'
        : pickPositive(inv?.my_price)
          ? 'inventory.my_price'
          : pickPositive(inv?.price)
            ? 'inventory.price'
            : null;
      const refPrice = pickPositive(inv?.amazon_price, currentPrice);
      const refSource = pickPositive(inv?.amazon_price) ? 'inventory.amazon_price' : currentSource;

      if ((refPrice ?? 0) <= 0 && (unitCost ?? 0) <= 0) {
        skipped++;
        skipReasons.no_price_or_cost = (skipReasons.no_price_or_cost || 0) + 1;
        continue;
      }

      const costFloor = unitCost && unitCost > 0 ? unitCost * (1 + minMarginPct / 100) : 0;
      const priceFloor = refPrice && refPrice > 0 ? refPrice * floorPctOfRef : 0;
      const minPrice = Math.max(costFloor, priceFloor);

      if (minPrice <= 0) {
        skipped++;
        skipReasons.calculated_min_zero = (skipReasons.calculated_min_zero || 0) + 1;
        continue;
      }

      const roundedMin = roundMoney(minPrice);
      const rawMax = refPrice && refPrice > 0 ? refPrice * (1 + maxCeilingPct / 100) : roundedMin * 2;
      const maxPrice = roundMoney(Math.max(rawMax, roundedMin * 1.35));

      if (roundedMin >= maxPrice) {
        skipped++;
        skipReasons.min_gte_max = (skipReasons.min_gte_max || 0) + 1;
        continue;
      }

      // ── SAFETY RULES ──
      // NEVER set min_price if current_price is unknown → invalid_suggestion
      // NEVER set min_price > current_price → invalid_suggestion
      let reviewReason: string | null = null;
      let isInvalidSuggestion = false;

      if (!currentPrice) {
        reviewReason = 'missing_current_price';
        isInvalidSuggestion = true; // Cannot verify safety without current price
      } else if (roundedMin > currentPrice) {
        reviewReason = 'min_above_current_price';
        isInvalidSuggestion = true; // Would set floor above live price — dangerous
      }

      const sourceParts = [unitCost && unitCost > 0 ? 'cost' : null, refSource].filter(Boolean);
      const priceGap = currentPrice ? roundMoney(roundedMin - currentPrice) : null;

      updates.push({
        id: assignment.id,
        asin: assignment.asin,
        sku: assignment.sku,
        marketplace: assignment.marketplace,
        minPrice: roundedMin,
        maxPrice,
        source: sourceParts.join(' + ') || 'unknown',
        refPrice,
        currentPrice,
        unitCost: unitCost ? roundMoney(unitCost) : null,
        priceGap,
        needsReview: !!reviewReason,
        reviewReason,
        isInvalidSuggestion,
      });
    }

    updates.sort((a, b) => {
      if (a.needsReview !== b.needsReview) return a.needsReview ? -1 : 1;
      return (b.priceGap ?? Number.NEGATIVE_INFINITY) - (a.priceGap ?? Number.NEGATIVE_INFINITY);
    });

    const needsReviewCount = updates.filter((row) => row.needsReview).length;

    console.log(
      `[backfill-min-max] Calculated: ${updates.length} updates, ${skipped} skipped, ${needsReviewCount} need review. Skip reasons:`,
      skipReasons,
    );

    if (dryRun) {
      return new Response(
        JSON.stringify({
          success: true,
          dryRun: true,
          wouldUpdate: updates.length,
          skipped,
          skipReasons,
          needsReviewCount,
          rows: updates,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // SAFETY: Filter out invalid suggestions before applying
    const safeUpdates = updates.filter(u => !u.isInvalidSuggestion);
    const invalidCount = updates.length - safeUpdates.length;

    if (invalidCount > 0) {
      console.log(`[backfill-min-max] SAFETY: ${invalidCount} invalid suggestions excluded from apply (min > current_price or missing current_price)`);
    }

    let applied = 0;
    let errors = 0;
    const BATCH = 50;

    for (let i = 0; i < safeUpdates.length; i += BATCH) {
      const batch = safeUpdates.slice(i, i + BATCH);

      for (const update of batch) {
        const { error: assignErr } = await supabase
          .from('repricer_assignments')
          .update({
            min_price_override: update.minPrice,
            max_price_override: update.maxPrice,
            updated_at: new Date().toISOString(),
          })
          .eq('id', update.id);

        if (assignErr) {
          console.error(`[backfill-min-max] assignment update error for ${update.asin}:`, assignErr);
          errors++;
          continue;
        }

        // NOTE: Do NOT sync min/max to shared 'inventory' table — it has no
        // marketplace column, so CA/MX values would overwrite US values.
        // The 'repricer_assignments' table is the authoritative source.

        applied++;
      }
    }

    // Push applied bounds to Amazon (fire-and-forget, best effort)
    let amazonPushed = 0;
    let amazonPushErrors = 0;
    if (applied > 0) {
      console.log(`[backfill-min-max] Pushing ${applied} bounds to Amazon...`);
      for (const update of safeUpdates) {
        try {
          const resp = await fetch(`${supabaseUrl}/functions/v1/update-amazon-price`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${supabaseKey}` },
            body: JSON.stringify({
              user_id: user.id,
              asin: update.asin,
              sku: update.sku,
              marketplace: update.marketplace,
              newMinPrice: update.minPrice,
              newMaxPrice: update.maxPrice,
              updateMinMaxOnly: true,
              internal: true,
            }),
          });
          const result = await resp.json().catch(() => null);
          if (resp.ok && result?.success) {
            amazonPushed++;
            await supabase.from('repricer_assignments').update({ bounds_synced_at: new Date().toISOString() }).eq('id', update.id);
          } else {
            amazonPushErrors++;
          }
        } catch {
          amazonPushErrors++;
        }
        // Throttle to avoid SP-API rate limits
        if (amazonPushed % 5 === 0 && amazonPushed > 0) {
          await new Promise(r => setTimeout(r, 500));
        }
      }
      console.log(`[backfill-min-max] Amazon push: ${amazonPushed} success, ${amazonPushErrors} errors`);
    }

    console.log(`[backfill-min-max] Complete: ${applied} applied, ${errors} errors, ${skipped} skipped, ${amazonPushed} pushed to Amazon`);

    return new Response(
      JSON.stringify({
        success: true,
        applied,
        errors,
        skipped,
        invalidExcluded: invalidCount,
        skipReasons,
        amazonPushed,
        amazonPushErrors,
        total: allAssignments.length,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (error: any) {
    console.error('[backfill-min-max] Error:', error);
    return new Response(JSON.stringify({ success: false, error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
