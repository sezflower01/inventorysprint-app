import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { isInternalCaller } from '../_shared/require-internal.ts';
import { loadRepricerCostMap, repricerCostKey } from '../_shared/cog-for-repricer.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface ApplyMinRoiRequest {
  rule_id: string;
  marketplace: string;
  min_roi_percent: number;
  asins?: string[]; // optional: restrict to a specific subset of ASINs (per-row trigger)
  internal?: boolean; // cron/fanout calls: skip user-JWT auth, use user_id below
  user_id?: string;
}

function getCreatedListingUnitCost(row: any): number | null {
  const amount = Number(row?.amount);
  if (Number.isFinite(amount) && amount > 0) return amount;

  const cost = Number(row?.cost);
  const units = Number(row?.units);
  if (Number.isFinite(cost) && cost > 0 && Number.isFinite(units) && units > 0) {
    return cost / units;
  }

  return null;
}

function sortNewestCreatedListingFirst(a: any, b: any): number {
  const ad = a?.date_created || '';
  const bd = b?.date_created || '';
  if (ad !== bd) {
    if (!ad) return 1;
    if (!bd) return -1;
    return String(bd).localeCompare(String(ad));
  }

  const ac = a?.created_at || '';
  const bc = b?.created_at || '';
  if (ac !== bc) return String(bc).localeCompare(String(ac));

  return String(b?.id || '').localeCompare(String(a?.id || ''));
}

// International marketplaces need aggressive protection (customs, duties, currency risk)
const INTL_MARKETPLACES = ['CA', 'MX', 'BR'];

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const body: ApplyMinRoiRequest = await req.json();
    const { rule_id, marketplace, min_roi_percent, asins } = body;

    // Auth check — cron/fanout calls pass internal:true + user_id and
    // authenticate via the shared internal-caller guard (service-role Bearer
    // or x-internal-secret); the frontend "Apply now" / Dry run path keeps
    // authenticating via a real user JWT.
    let userId: string;
    if (body.internal && body.user_id && isInternalCaller(req)) {
      userId = body.user_id;
    } else {
      const authHeader = req.headers.get('Authorization');
      if (!authHeader) throw new Error('No authorization header');
      const token = authHeader.replace('Bearer ', '');
      const { data: { user } } = await supabase.auth.getUser(token);
      if (!user) throw new Error('Unauthorized');
      userId = user.id;
    }

    if (!rule_id || !marketplace || min_roi_percent == null) {
      throw new Error('rule_id, marketplace, and min_roi_percent are required');
    }

    const isInternational = INTL_MARKETPLACES.includes(marketplace);

    console.log(`[apply-min-roi] User ${userId} applying ${min_roi_percent}% ROI to rule ${rule_id} for ${marketplace}${asins?.length ? ` asins=${asins.join(',')}` : ''}`);

    // 1. Get all enabled assignments for this rule + marketplace (optionally filtered to a subset of ASINs)
    let query = supabase
      .from('repricer_assignments')
      .select('id, asin, sku, min_price_override, max_price_override, roi_at_min_percent, manual_min_price')
      .eq('rule_id', rule_id)
      .eq('marketplace', marketplace)
      .eq('user_id', userId)
      .eq('is_enabled', true);
    if (asins && asins.length > 0) query = query.in('asin', asins);
    const { data: assignments, error: assignError } = await query;

    if (assignError) throw assignError;
    if (!assignments || assignments.length === 0) {
      return new Response(JSON.stringify({ updated: 0, skipped: 0, message: 'No active assignments found for this rule and marketplace' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const skus = [...new Set(assignments.map(a => a.sku))];

    // 2. Batch-fetch inventory cost data BY SKU to prevent cross-marketplace contamination
    // Each assignment has a specific SKU tied to its marketplace — use that for cost lookup
    const { data: inventoryData } = await supabase
      .from('inventory')
      .select('asin, sku, cost, my_price, amazon_price, price')
      .eq('user_id', userId)
      .in('sku', skus);

    // Match the repricer UI cost source: newest created_listings unit cost wins,
    // then fall back to inventory cost by SKU. This keeps the saved ROI floor and
    // displayed ROI-at-min on the same cost basis.
    const uniqueAsins = [...new Set(assignments.map(a => a.asin))];
    const { data: createdListingRows } = await supabase
      .from('created_listings')
      .select('id, asin, cost, units, amount, date_created, created_at')
      .eq('user_id', userId)
      .in('asin', uniqueAsins);

    const createdCostByAsinMap: Record<string, number> = {};
    const createdRowsByAsin: Record<string, any[]> = {};
    for (const row of createdListingRows || []) {
      if (!row?.asin) continue;
      (createdRowsByAsin[row.asin] ||= []).push(row);
    }
    for (const [asin, rows] of Object.entries(createdRowsByAsin)) {
      for (const row of rows.slice().sort(sortNewestCreatedListingFirst)) {
        const unitCost = getCreatedListingUnitCost(row);
        if (unitCost != null && unitCost > 0) {
          createdCostByAsinMap[asin] = unitCost;
          break;
        }
      }
    }

    // Unit cost precedence (since 2026-09-16), same as the Repricer page, the
    // AI evaluator and repricer-auto-lower-min: asin_cost_overrides -> COG on
    // record -> newest created_listings -> inventory.cost. This function WRITES
    // min prices from that cost, so it must use the number the seller maintains
    // on the COG page -- not whichever purchase lot happened to be newest.
    // Placeholder COGs ($1.00 import lots, unreviewed) are excluded by the
    // asin_cog_for_repricer view and fall through to the old sources.
    const repricerCostMap = await loadRepricerCostMap(supabase, [userId], uniqueAsins);

    // Map by SKU (not ASIN) for marketplace-safe cost resolution
    const costBySkuMap: Record<string, number> = {};
    const priceBySkuMap: Record<string, number> = {};
    for (const inv of inventoryData || []) {
      if (inv.cost && inv.cost > 0) {
        costBySkuMap[inv.sku] = inv.cost;
      }
      const p = Number(inv.my_price ?? inv.amazon_price ?? inv.price) || 0;
      if (p > 0) priceBySkuMap[inv.sku] = p;
    }

    // 3. Call calculate-roi-floor for each ASIN using LIVE SP-API fees
    let updated = 0;
    let skipped = 0;
    const results: Array<{
      asin: string; sku: string;
      old_min: number | null; new_min: number;
      old_max: number | null; new_max: number | null;
      actual_roi?: number; reason?: string;
    }> = [];

    // Group assignments by ASIN to avoid duplicate API calls
    const asinAssignments: Record<string, typeof assignments> = {};
    for (const a of assignments) {
      if (!asinAssignments[a.asin]) asinAssignments[a.asin] = [];
      asinAssignments[a.asin].push(a);
    }

    for (const [asin, asinGroup] of Object.entries(asinAssignments)) {
      // Resolve cost per-SKU (marketplace-safe) to prevent cross-marketplace contamination
      const recorded = repricerCostMap.get(repricerCostKey(userId, asin));
      let costUsd: number | undefined = recorded?.unitCost ?? createdCostByAsinMap[asin];
      const costSourceLabel = recorded
        ? recorded.source
        : (createdCostByAsinMap[asin] ? 'created_listings' : 'inventory');
      for (const a of asinGroup) {
        if (costUsd) break;
        if (costBySkuMap[a.sku]) { costUsd = costBySkuMap[a.sku]; break; }
      }
      if (!costUsd) {
        for (const assignment of asinGroup) {
          skipped++;
          results.push({
            asin, sku: assignment.sku,
            old_min: assignment.min_price_override, new_min: 0,
            old_max: assignment.max_price_override, new_max: null,
            reason: 'no_cost_data',
          });
        }
        console.log(`[apply-min-roi] SKIP ${asin}: no cost found in created_listings or inventory SKUs ${asinGroup.map(a => a.sku).join(',')}`);
        continue;
      }

      console.log(`[apply-min-roi] COST ${asin}: using ${costSourceLabel} unit cost ${costUsd}`);

      // Call calculate-roi-floor with live SP-API fees
      let floorResult: { min_price: number; actual_roi: number } | null = null;
      try {
        const floorResp = await fetch(`${supabaseUrl}/functions/v1/calculate-roi-floor`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${Deno.env.get('SUPABASE_ANON_KEY')}`,
            'x-internal-secret': Deno.env.get('INTERNAL_SYNC_SECRET') || '',
          },
          body: JSON.stringify({
            asin,
            marketplace,
            cost_home: costUsd,
            target_roi_percent: min_roi_percent,
            user_id: userId,
          }),
        });

        if (floorResp.ok) {
          floorResult = await floorResp.json();
        } else {
          const errBody = await floorResp.text();
          console.warn(`[apply-min-roi] calculate-roi-floor failed for ${asin}: ${floorResp.status} ${errBody}`);
        }
      } catch (e: any) {
        console.warn(`[apply-min-roi] calculate-roi-floor error for ${asin}:`, (e as Error).message);
      }

      if (!floorResult || !floorResult.min_price) {
        // Live calculation failed — do NOT fall back to cached/approximate math
        skipped += asinGroup.length;
        for (const assignment of asinGroup) {
          results.push({
            asin,
            sku: assignment.sku,
            old_min: assignment.min_price_override,
            new_min: assignment.min_price_override ?? 0,
            old_max: assignment.max_price_override,
            new_max: assignment.max_price_override,
            reason: 'live_roi_floor_failed',
          });
        }
        continue;
      }

      const roiFloor = floorResult.min_price;
      const manualFloor = Math.max(0, ...asinGroup.map((a: any) => Number(a?.manual_min_price) || 0));
      const newMinPrice = Math.max(roiFloor, manualFloor);

      if (manualFloor > 0 && manualFloor > roiFloor) {
        console.log(`[apply-min-roi] MANUAL_FLOOR_PROTECTED ${asin}: ROI floor $${roiFloor} < manual floor $${manualFloor} → using $${newMinPrice}`);
      }


      // Apply to all assignments for this ASIN
      for (const assignment of asinGroup) {
        const currentMin = assignment.min_price_override;
        const currentRoiAtMin = assignment.roi_at_min_percent;

        // ── DIRECTIONAL GUARD ──
        // Only lower min if rule ROI < assignment's current ROI (relaxing protection)
        // Only raise min if rule ROI > assignment's current ROI (tightening protection)
        // Skip if already matching (within $0.01)
        if (currentMin != null && currentMin > 0 && currentRoiAtMin != null) {
          const isAlreadyMatching = Math.abs(newMinPrice - currentMin) < 0.01;
          const isLowering = newMinPrice < currentMin;
          const isRaising = newMinPrice > currentMin;
          const ruleWantsLower = min_roi_percent < currentRoiAtMin;
          const ruleWantsHigher = min_roi_percent > currentRoiAtMin;

          if (isAlreadyMatching) {
            skipped++;
            results.push({
              asin, sku: assignment.sku,
              old_min: currentMin, new_min: currentMin,
              old_max: assignment.max_price_override, new_max: null,
              actual_roi: currentRoiAtMin, reason: 'already_matching',
            });
            continue;
          }

          // Prevent lowering min when rule ROI is higher (should raise instead)
          if (isLowering && ruleWantsHigher) {
            console.log(`[apply-min-roi] GUARD ${asin}: rule wants ${min_roi_percent}% > current ${currentRoiAtMin}% but floor $${newMinPrice} < current min $${currentMin} — skipping`);
            skipped++;
            results.push({
              asin, sku: assignment.sku,
              old_min: currentMin, new_min: currentMin,
              old_max: assignment.max_price_override, new_max: null,
              actual_roi: currentRoiAtMin, reason: 'directional_guard_blocked_lower',
            });
            continue;
          }

          // Prevent raising min when rule ROI is lower (should lower instead)
          if (isRaising && ruleWantsLower) {
            console.log(`[apply-min-roi] GUARD ${asin}: rule wants ${min_roi_percent}% < current ${currentRoiAtMin}% but floor $${newMinPrice} > current min $${currentMin} — skipping`);
            skipped++;
            results.push({
              asin, sku: assignment.sku,
              old_min: currentMin, new_min: currentMin,
              old_max: assignment.max_price_override, new_max: null,
              actual_roi: currentRoiAtMin, reason: 'directional_guard_blocked_raise',
            });
            continue;
          }
        }

        const updateData: Record<string, any> = {
          min_price_override: newMinPrice,
          min_roi_override: null, // Clear per-assignment override so rule's ROI takes effect
          roi_at_min_percent: floorResult.actual_roi, // Update displayed ROI to match new floor
          bounds_synced_at: null, // Reset so push-bounds-to-amazon re-syncs to Amazon
          bounds_sync_status: 'pending',
          bounds_sync_attempts: 0,
          last_bounds_sync_error: null,
          bounds_last_requested_at: new Date().toISOString(),
        };
        let newMax: number | null = null;
        let reason: string | undefined = (manualFloor > 0 && manualFloor > roiFloor) ? 'manual_floor_protected' : undefined;

        const currentMax = assignment.max_price_override;

        if (currentMax != null && newMinPrice > currentMax) {
          // Auto-raise max to protect margin — applies to every marketplace now
          // (previously US alone left min > max unresolved, flagged only as
          // 'roi_exceeds_max'; CA/MX/BR already auto-raised). Losing BB is
          // better than being stuck with an invalid min > max assignment.
          newMax = parseFloat((newMinPrice + 0.50).toFixed(2));
          updateData.max_price_override = newMax;
          reason = isInternational ? 'intl_max_raised_for_roi_protection' : 'max_raised_for_roi_protection';
          console.log(`[apply-min-roi] ${marketplace} ${asin}: ROI floor $${newMinPrice} > max $${currentMax} → auto-raising max to $${newMax}`);
        }

        const { error: upErr } = await supabase
          .from('repricer_assignments')
          .update(updateData)
          .eq('id', assignment.id);

        if (upErr) {
          console.error(`[apply-min-roi] Failed to update ${asin}:`, upErr);
          skipped++;
          results.push({
            asin, sku: assignment.sku,
            old_min: assignment.min_price_override, new_min: newMinPrice,
            old_max: assignment.max_price_override, new_max: newMax,
            actual_roi: floorResult.actual_roi, reason: 'db_error',
          });
        } else {
          updated++;

          // Push updated bounds to Amazon immediately (min-only is OK)
          const effectiveMax = newMax ?? assignment.max_price_override;
          try {
            const pushBody: Record<string, any> = {
              user_id: userId,
              asin,
              sku: assignment.sku,
              marketplace,
              newMinPrice: newMinPrice,
              updateMinMaxOnly: true,
              internal: true,
            };
            if (effectiveMax != null) {
              pushBody.newMaxPrice = effectiveMax;
            }
            const pushResp = await fetch(`${supabaseUrl}/functions/v1/update-amazon-price`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${supabaseKey}`,
              },
              body: JSON.stringify(pushBody),
            });
            const pushResult = await pushResp.json().catch(() => null);
            if (pushResp.ok && pushResult?.success) {
              await supabase
                .from('repricer_assignments')
                .update({
                  bounds_synced_at: new Date().toISOString(),
                  bounds_sync_status: 'synced',
                  bounds_sync_attempts: 0,
                  last_bounds_sync_error: null,
                })
                .eq('id', assignment.id);
              console.log(`[apply-min-roi] PUSHED bounds to Amazon for ${asin}/${assignment.sku}: min=$${newMinPrice} max=${effectiveMax ?? 'none'}`);
            } else {
              const errMsg = pushResult?.error || `HTTP ${pushResp.status}`;
              await supabase
                .from('repricer_assignments')
                .update({
                  bounds_sync_status: 'failed',
                  last_bounds_sync_error: errMsg.slice(0, 500),
                  bounds_sync_attempts: 1,
                  next_bounds_sync_at: new Date(Date.now() + 60_000).toISOString(),
                })
                .eq('id', assignment.id);
              console.warn(`[apply-min-roi] Bounds push failed for ${asin}: ${errMsg}`);
            }
          } catch (pushErr: any) {
            await supabase
              .from('repricer_assignments')
              .update({
                bounds_sync_status: 'failed',
                last_bounds_sync_error: (pushErr.message || 'unknown').slice(0, 500),
                bounds_sync_attempts: 1,
                next_bounds_sync_at: new Date(Date.now() + 60_000).toISOString(),
              })
              .eq('id', assignment.id);
            console.warn(`[apply-min-roi] Bounds push error for ${asin}:`, pushErr.message);
          }
          // NOTE: We intentionally do NOT auto-push the listing price up to the new min here.
          // The UI copies the new min into the "Set Price" input so the user can review and
          // push it manually via the price toggle.

          // Throttle to avoid rate limits
          await new Promise(r => setTimeout(r, 800));

          results.push({
            asin, sku: assignment.sku,
            old_min: assignment.min_price_override, new_min: newMinPrice,
            old_max: assignment.max_price_override, new_max: newMax,
            actual_roi: floorResult.actual_roi,
            reason,
          });
        }
      }

      // Small delay between ASINs to respect SP-API rate limits
      if (Object.keys(asinAssignments).length > 1) {
        await new Promise(r => setTimeout(r, 250));
      }
    }

    console.log(`[apply-min-roi] Done: ${updated} updated, ${skipped} skipped`);

    return new Response(JSON.stringify({ updated, skipped, total: assignments.length, results }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('[apply-min-roi] Error:', error);
    return new Response(
      JSON.stringify({ error: (error as Error).message || 'Failed to apply min ROI' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
