// Central FBA eligibility check.
// Called from web (create-listing flow, Created Listings, label printers,
// CreatePurchaseFromCostButton, shipment builder) AND from the Chrome extension
// before it lets the user Add Purchase or Print FNSKU.
//
// Returns { eligible, blockingIssues[], warnings[], fba_block_reason } and
// caches the result in `fba_eligibility_cache` for 10 minutes per
// (user, seller, marketplace, asin).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { waitForApiToken } from "../_shared/rate-limiter.ts";
import { mayUseOperatorCredentials, amazonNotConnectedResponse } from "../_shared/operator-credential-guard.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const FNSKU_RE = /^X[A-Z0-9]{9}$/;
const CACHE_TTL_SECONDS = 600;

// Phase B per-stage cache TTLs. Each stage caches independently so a slow
// hazmat lookup never blocks an otherwise-valid sellability decision.
const STAGE_TTL_SECONDS: Record<string, number> = {
  fba_eligibility: 6 * 3600,    // 6h — Amazon program eligibility rarely changes
  hazmat:          24 * 3600,   // 24h — catalog attributes effectively static
  prep:            24 * 3600,   // 24h — same
  inbound_dry_run: 30 * 60,     // 30m — written by separate on-demand fn
};

type StageStatus = "ok" | "warn" | "blocked" | "unknown";
interface StageResult {
  stage: string;
  status: StageStatus;
  reason?: string;
  raw?: Record<string, unknown>;
}

interface ReqBody {
  asin: string;
  marketplace?: string;       // 'US' | 'CA' | 'MX' | ...
  marketplaceId?: string;     // Amazon marketplace id
  condition?: string;         // Listings Restrictions conditionType, e.g. new_new
  force?: boolean;
}

const MARKETPLACE_TO_ID: Record<string, string> = {
  US: 'ATVPDKIKX0DER', CA: 'A2EUQ1WTGCTBG2', MX: 'A1AM78C64UM0Y8', BR: 'A2Q3Y263D00KWC',
  UK: 'A1F83G8C2ARO7P', DE: 'A1PA6795UKMFR9', FR: 'A13V1IB3VIYZZH', IT: 'APJ6JRA9NG5V4',
  ES: 'A1RKKUPIHCS9HS', NL: 'A1805IZSGTT6HS', SE: 'A2NODRKZP88ZB9', PL: 'A1C3SOZRARQ6R3',
  AU: 'A39IBJ37TRP1C6', JP: 'A1VC38T7YXB528', IN: 'A21TJRUUN4KGV', SG: 'A19VAU5U5O7RUS',
  AE: 'A2VIGQ35RCS4UG', SA: 'A17E79C6D8DWNP',
};

function hostFor(marketplace: string): string {
  const eu = ['UK','DE','FR','IT','ES','NL','SE','PL','TR','EG','SA','AE','IN'];
  const fe = ['JP','AU','SG'];
  if (eu.includes(marketplace)) return 'sellingpartnerapi-eu.amazon.com';
  if (fe.includes(marketplace)) return 'sellingpartnerapi-fe.amazon.com';
  return 'sellingpartnerapi-na.amazon.com';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const auth = req.headers.get('Authorization');
    if (!auth) return jsonResp(401, { error: 'No authorization' });
    const body: ReqBody & { user_id?: string } = await req.json().catch(() => ({} as ReqBody));

    // Service-role caller (e.g. listing-validation-worker) may pass body.user_id.
    let user: { id: string };
    const token = auth.replace('Bearer ', '');
    if (token === supabaseKey && body.user_id) {
      user = { id: body.user_id };
    } else {
      const { data: userData, error: userErr } = await supabase.auth.getUser(token);
      if (userErr || !userData.user) return jsonResp(401, { error: 'Unauthorized' });
      user = { id: userData.user.id };
    }

    const asin = (body.asin || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{10}$/.test(asin)) return jsonResp(400, { error: 'Invalid ASIN' });

    const marketplace = (body.marketplace || 'US').toUpperCase();
    const marketplaceId = body.marketplaceId || MARKETPLACE_TO_ID[marketplace] || MARKETPLACE_TO_ID.US;
    const conditionType = normalizeConditionType(body.condition);

    // Resolve seller_id (per-marketplace if user has SP-API auth, else env default)
    const { data: userAuth } = await supabase
      .from('seller_authorizations')
      .select('seller_id, refresh_token')
      .eq('user_id', user.id)
      .eq('marketplace_id', marketplaceId)
      .eq('is_active', true)
      .maybeSingle();

    // Gating is per seller account, so answering from the operator's seller_id
    // tells the user whether the OPERATOR is ungated -- and caches it under
    // that seller_id as though it were theirs. This is the most misleading
    // answer in the product: it reads as "you can sell this".
    if (!userAuth?.seller_id) {
      const may = await mayUseOperatorCredentials(supabase, {
        userId: user.id,
        internal: false, // no x-internal-secret path here
        fn: 'check-fba-listing-eligibility',
      });
      if (!may.allowed) return amazonNotConnectedResponse(may, corsHeaders);
    }

    const sellerId = userAuth?.seller_id
      || Deno.env.get(`SPAPI_SELLER_ID_${marketplace}`)
      || Deno.env.get('SPAPI_SELLER_ID')
      || 'unknown';

    // Cache check
    if (!body.force) {
      const { data: cached } = await supabase
        .from('fba_eligibility_cache')
        .select('*')
        .eq('user_id', user.id)
        .eq('seller_id', sellerId)
        .eq('marketplace_id', marketplaceId)
        .eq('asin', asin)
        .maybeSingle();
      const cachedCondition = String((cached?.raw as any)?.conditionType || '');
      if (cached && cachedCondition === conditionType && (Date.now() - new Date(cached.checked_at).getTime()) < CACHE_TTL_SECONDS * 1000) {
        const cachedIssues = [...(cached.blocking_issues || []), ...(cached.warnings || [])];
        const hasCachedSellabilityRestriction = cachedIssues.some((i: any) =>
          ["RESTRICTED", "NOT_ELIGIBLE", "APPROVAL_REQUIRED", "ASIN_NOT_ELIGIBLE", "BRAND_NOT_ELIGIBLE", "RESTRICTION"]
            .includes(String(i?.code || '').toUpperCase())
        );
        if (hasCachedSellabilityRestriction) {
          console.log(`[${asin}] Ignoring cached sellability restriction; rechecking New-condition restrictions live.`);
        } else {
        // Phase B: even on legacy cache hit, hydrate per-stage results from
        // the per-stage cache so the UI gets the 6-row tracker.
        const stageRows = await loadAllStageCaches(supabase, user.id, asin, marketplace);
        return jsonResp(200, {
          eligible: cached.eligible,
          blockingIssues: cached.blocking_issues || [],
          warnings: cached.warnings || [],
          infos: (cached.raw && (cached.raw as any).infos) || [],
          fba_block_reason: cached.fba_block_reason,
          stageStatuses: stageRows,
          cached: true,
          checked_at: cached.checked_at,
        });
        }
      }
    }

    const blockingIssues: any[] = [];
    const warnings: any[] = [];
    const infos: any[] = [];

    // 0) GHOST QUARANTINE — runs on EVERY call, regardless of eligibility outcome.
    // Identifies tombstoned/deleted SKUs with zero stock for this user+asin,
    // archives them to ghost_sku_quarantine, and removes their fnsku_map rows so
    // they cannot poison future eligibility checks (manufacturer-barcode-mode
    // false positives, ghost rows in shipment builder/add-purchase/print-label).
    const { data: invAllForAsin } = await supabase
      .from('inventory')
      .select('id, sku, fnsku, listing_status, available, reserved, inbound')
      .eq('user_id', user.id)
      .eq('asin', asin);

    const tombstonedSkus = new Set<string>();
    const ghostInvRows: any[] = [];
    for (const r of (invAllForAsin || [])) {
      const status = String((r as any).listing_status || '').toUpperCase();
      const avail = Number((r as any).available || 0);
      const resv = Number((r as any).reserved || 0);
      const inb = Number((r as any).inbound || 0);
      if (status === 'NOT_IN_CATALOG' || status === 'DELETED') {
        if ((r as any).sku) tombstonedSkus.add(String((r as any).sku));
        if (avail === 0 && resv === 0 && inb === 0) ghostInvRows.push(r);
      }
    }

    let quarantinedCount = 0;
    if (ghostInvRows.length > 0) {
      const archiveRows = ghostInvRows
        .filter((g) => g.sku)
        .map((g) => ({
          user_id: user.id,
          asin,
          seller_sku: String(g.sku),
          fnsku: g.fnsku || null,
          reason: 'tombstoned_zero_stock',
          previous_listing_status: g.listing_status || null,
          previous_available: g.available ?? 0,
          previous_reserved: g.reserved ?? 0,
          previous_inbound: g.inbound ?? 0,
          source_function: 'check-fba-listing-eligibility',
          raw: { detected_at: new Date().toISOString() },
        }));
      if (archiveRows.length > 0) {
        const { error: archErr } = await supabase
          .from('ghost_sku_quarantine')
          .upsert(archiveRows, { onConflict: 'user_id,asin,seller_sku,source_function', ignoreDuplicates: true });
        if (archErr) console.warn('[fba-eligibility] ghost archive failed:', archErr.message);
      }
      const ghostSkuList = ghostInvRows.map((g) => String(g.sku)).filter(Boolean);
      if (ghostSkuList.length > 0) {
        const { error: delErr } = await supabase
          .from('fnsku_map')
          .delete()
          .eq('seller_id', sellerId)
          .eq('marketplace_id', marketplaceId)
          .eq('asin', asin)
          .in('seller_sku', ghostSkuList);
        if (delErr) console.warn('[fba-eligibility] fnsku_map ghost delete failed:', delErr.message);
        quarantinedCount = ghostSkuList.length;
        // Bust cache so the next call recomputes against clean data.
        await supabase.from('fba_eligibility_cache').delete()
          .eq('user_id', user.id).eq('seller_id', sellerId)
          .eq('marketplace_id', marketplaceId).eq('asin', asin);
        console.log(`[fba-eligibility] quarantined ${quarantinedCount} ghost SKU(s) for ${asin}: ${ghostSkuList.join(', ')}`);
      }
    }

    // 1) fnsku_map probe — joined against inventory listing_status so that
    // tombstoned (NOT_IN_CATALOG / DELETED) SKUs do NOT poison the ASIN-level
    // eligibility decision. We block on the user's CURRENT ACTIVE SKU only,
    // never ASIN-wide because of leftover stale rows from a previously-deleted
    // listing.
    const { data: fnskuRowsRaw } = await supabase
      .from('fnsku_map')
      .select('seller_sku, fnsku, condition')
      .eq('seller_id', sellerId)
      .eq('marketplace_id', marketplaceId)
      .eq('asin', asin);

    const allRows = fnskuRowsRaw || [];
    const skuList = Array.from(new Set(allRows.map((r) => r.seller_sku).filter(Boolean)));

    // Active rows = rows whose seller_sku is NOT tombstoned. Rows with no
    // seller_sku stay in (legacy data); rows with tombstoned seller_sku are
    // ignored entirely for eligibility purposes.
    let rows = allRows.filter((r) => !r.seller_sku || !tombstonedSkus.has(String(r.seller_sku)));
    let manufacturerMode = rows.filter((r) => (r.fnsku || '').toUpperCase() === asin);
    let validFnskus = rows.filter((r) => FNSKU_RE.test((r.fnsku || '').toUpperCase()));

    // Determine whether the user has an ACTIVE listing for this ASIN. Brand-new
    // ASINs (no inventory row, no created_listings row) cannot have an FNSKU yet
    // — Amazon mints it AFTER the FBA listing is created. Surfacing INVALID_FNSKU
    // or MANUFACTURER_BARCODE_MODE for that case is a false alarm.
    const hasActiveInventory = (invAllForAsin || []).some((r: any) => {
      const status = String(r.listing_status || '').toUpperCase();
      return status !== 'NOT_IN_CATALOG' && status !== 'DELETED';
    });
    let hasActiveCreatedListing = false;
    let recentlyCreatedListing = false; // Fix 1: FNSKU-propagation grace window
    {
      const { data: clRows } = await supabase
        .from('created_listings')
        .select('created_at, validation_status')
        .eq('user_id', user.id)
        .eq('asin', asin)
        .order('created_at', { ascending: false })
        .limit(10);
      const actionableRows = (clRows || []).filter((r: any) => {
        const status = String(r.validation_status || 'ACTIVE').toUpperCase();
        return status === 'ACTIVE' || status === 'PENDING_VALIDATION';
      });
      if (actionableRows.length > 0) {
        hasActiveCreatedListing = actionableRows.some((r: any) => String(r.validation_status || 'ACTIVE').toUpperCase() === 'ACTIVE');
        const createdAt = new Date(actionableRows[0].created_at).getTime();
        // 24-hour propagation window — Amazon mints FNSKU asynchronously after
        // listing submit, sometimes minutes, sometimes a full day. During this
        // window, missing FNSKU is NORMAL, not a block.
        if (Number.isFinite(createdAt) && (Date.now() - createdAt) < 24 * 3600 * 1000) {
          recentlyCreatedListing = true;
        }
      }
    }
    // Repricer-assignment probe (per marketplace) — another seller-account proof
    // that this user is already selling this ASIN in this marketplace, hence
    // approved. Used to override generic catalog-level approval warnings.
    let hasRepricerAssignment = false;
    try {
      const { data: raRows } = await supabase
        .from('repricer_assignments')
        .select('id')
        .eq('user_id', user.id)
        .eq('asin', asin)
        .eq('marketplace', marketplace)
        .limit(1);
      hasRepricerAssignment = Array.isArray(raRows) && raRows.length > 0;
    } catch (_) { /* non-fatal */ }
    const hasActiveListing = hasActiveInventory || hasActiveCreatedListing || hasRepricerAssignment;
    // Seller-account verified-approval signal. If the seller already has an
    // active listing, created_listing, or repricer assignment for this ASIN in
    // this marketplace, Amazon has ALREADY allowed them to sell it — generic
    // catalog-level approval-required restrictions must NOT downgrade the
    // analyzer decision. Hard "NOT_ELIGIBLE / ASIN_NOT_ELIGIBLE / BRAND_NOT_ELIGIBLE"
    // blocks still apply (those mean Amazon revoked the ability to sell).
    const sellerVerifiedApproved = hasActiveListing;

    // If the only manufacturer-mode rows came from tombstoned SKUs AND we have
    // a valid FNSKU among the active rows, the ASIN is fine — short-circuit.
    if (manufacturerMode.length === 0 && validFnskus.length > 0 && tombstonedSkus.size > 0) {
      console.log(`[fba-eligibility] ${asin}: ignored ${tombstonedSkus.size} tombstoned SKU(s) — active SKU has valid FNSKU`);
    }

    // SELF-HEAL #1: stale MANUFACTURER_BARCODE_MODE rows + ghost SKUs.
    // If user previously had a UPC-only SKU but has since deleted/recreated the
    // listing, the old fnsku_map row may still have fnsku == asin. Before
    // surfacing the block, ask SP-API for the current live state. If Amazon
    // now reports a valid FNSKU, drop stale rows (manufacturer-mode AND any
    // seller_sku no longer present live = ghost SKUs) and skip the block.
    if (manufacturerMode.length > 0 && validFnskus.length === 0 && userAuth?.refresh_token) {
      try {
        const livePairs = await fetchLiveFnskuPairs({
          asin, marketplaceId, marketplace,
          refreshToken: userAuth.refresh_token,
        });
        const liveValid = livePairs.find((x) => FNSKU_RE.test(x.fnsku.toUpperCase()));
        if (liveValid) {
          // Drop stale manufacturer-mode rows
          await supabase.from('fnsku_map')
            .delete()
            .eq('seller_id', sellerId)
            .eq('marketplace_id', marketplaceId)
            .eq('asin', asin)
            .eq('fnsku', asin);
          // Drop fnsku_map rows for SKUs no longer present live (ghost SKUs)
          const liveSkuSet = new Set(livePairs.map((p) => p.sellerSku));
          const ghostSkus = rows
            .map((r: any) => r.seller_sku)
            .filter((sku: string) => sku && !liveSkuSet.has(sku));
          if (ghostSkus.length > 0) {
            await supabase.from('fnsku_map')
              .delete()
              .eq('seller_id', sellerId)
              .eq('marketplace_id', marketplaceId)
              .eq('asin', asin)
              .in('seller_sku', ghostSkus);
            // Tombstone matching inventory rows so the shipment builder/extension stop showing them
            await supabase.from('inventory')
              .update({ listing_status: 'NOT_IN_CATALOG', updated_at: new Date().toISOString() })
              .eq('user_id', user.id)
              .eq('asin', asin)
              .in('sku', ghostSkus);
            console.log(`[fba-eligibility] tombstoned ${ghostSkus.length} ghost SKUs for ${asin}: ${ghostSkus.join(', ')}`);
          }
          // Insert/refresh live (sku, fnsku) rows
          for (const p of livePairs) {
            await supabase.from('fnsku_map').upsert({
              seller_id: sellerId,
              marketplace_id: marketplaceId,
              asin,
              fnsku: p.fnsku.toUpperCase(),
              seller_sku: p.sellerSku,
              condition: 'NEW',
            }, { onConflict: 'seller_id,marketplace_id,asin,fnsku' });
          }
          console.log(`[fba-eligibility] healed stale MANUFACTURER_BARCODE_MODE for ${asin} → ${liveValid.fnsku}`);
          manufacturerMode = [];
          validFnskus = livePairs.map((p) => ({ seller_sku: p.sellerSku, fnsku: p.fnsku.toUpperCase(), condition: 'NEW' })) as any;
          rows = validFnskus;
        }
      } catch (e) {
        console.warn(`[fba-eligibility] manufacturer-mode self-heal failed for ${asin}:`, (e as Error).message);
      }
    }

    if (manufacturerMode.length > 0) {
      if (hasActiveListing) {
        blockingIssues.push({
          code: 'MANUFACTURER_BARCODE_MODE',
          severity: 'block',
          message: 'Listing is configured to use the manufacturer barcode (UPC/EAN). Amazon only allows this for registered brand owners.',
          remediation: 'In Seller Central, edit the listing → Offer → Barcode → switch to "Amazon barcode (FNSKU)", save, then click "Re-check FBA eligibility".',
          affected_skus: manufacturerMode.map((r) => r.seller_sku),
        });
      } else {
        // Stale fnsku_map row from a deleted/never-completed listing — not a real issue.
        console.log(`[fba-eligibility] ${asin}: ignoring MANUFACTURER_BARCODE_MODE — no active listing exists yet`);
      }
    }

    if (rows.length > 0 && validFnskus.length === 0 && manufacturerMode.length === 0) {
      // SELF-HEAL: try a live SP-API inventory summaries lookup before blocking.
      // Resolves false positives when fnsku_map has stale/incomplete rows.
      let healed = false;
      if (userAuth?.refresh_token) {
        try {
          const liveFnsku = await fetchLiveFnsku({
            asin, marketplaceId, marketplace,
            refreshToken: userAuth.refresh_token,
          });
          if (liveFnsku && FNSKU_RE.test(liveFnsku.toUpperCase())) {
            // Upsert into fnsku_map so future checks pass
            await supabase.from('fnsku_map').upsert({
              seller_id: sellerId,
              marketplace_id: marketplaceId,
              asin,
              fnsku: liveFnsku.toUpperCase(),
              seller_sku: rows[0]?.seller_sku || liveFnsku.toUpperCase(),
              condition: rows[0]?.condition || 'NEW',
            }, { onConflict: 'seller_id,marketplace_id,asin,fnsku' });
            healed = true;
            console.log(`[fba-eligibility] self-healed FNSKU for ${asin}: ${liveFnsku}`);
          }
        } catch (e) {
          console.warn(`[fba-eligibility] self-heal failed for ${asin}:`, (e as Error).message);
        }
      }
      if (!healed) {
        if (hasActiveListing && !recentlyCreatedListing) {
          // Existing, settled listing genuinely has no valid FNSKU — surface as warning.
          warnings.push({
            code: 'INVALID_FNSKU',
            severity: 'warn',
            message: 'No valid Amazon FNSKU (X**********) found yet for this ASIN.',
            remediation: 'FNSKU sync may be in progress. Print the FNSKU label or wait a few minutes, then re-check. If it persists, fix the SKU in Seller Central.',
          });
        } else if (recentlyCreatedListing) {
          // Fix 1: freshly-created listing — Amazon hasn't assigned/propagated
          // FNSKU yet. Not a problem, NOT a warning, NOT a block.
          infos.push({
            code: 'FNSKU_PROPAGATING',
            severity: 'info',
            message: 'Waiting for Amazon to assign FNSKU (typically 15 min – 24 h after listing creation). FBA shipments will work as soon as it appears.',
          });
        } else {
          // Brand-new ASIN — Amazon only mints an FNSKU AFTER the FBA listing is created. Not an error.
          infos.push({
            code: 'FNSKU_PENDING_LISTING_CREATION',
            severity: 'info',
            message: 'FNSKU will be assigned by Amazon after the FBA listing is created.',
          });
        }
      }
    }

    // 2) SP-API listings restrictions (best-effort; non-fatal on error)
    let restrictionsApiSucceeded = false;
    let restrictionsCount = 0;
    if (userAuth?.refresh_token) {
      try {
        const rawRestrictions = await checkRestrictions({
          asin, sellerId, marketplaceId, marketplace,
          conditionType,
          refreshToken: userAuth.refresh_token,
        });
        const restrictions = (rawRestrictions || []).filter((item: any) => isRestrictionForCondition(item, conditionType));
        restrictionsApiSucceeded = true;
        restrictionsCount = restrictions?.length || 0;
        if (restrictions?.length) {
          for (const r of restrictions) {
            const code = String(r?.reasonCode || '').toUpperCase();
            const blockCodes = new Set(['ASIN_NOT_ELIGIBLE', 'BRAND_NOT_ELIGIBLE', 'NOT_ELIGIBLE']);
            const isHardBlock = blockCodes.has(code);
            // Seller-account override: existing active listing / inventory /
            // repricer assignment in this marketplace proves Amazon already
            // approved this seller. Demote non-hard-block approval warnings
            // to info — DO NOT downgrade the analyzer decision.
            if (sellerVerifiedApproved && !isHardBlock) {
              infos.push({
                code: 'APPROVAL_VERIFIED_BY_EXISTING_LISTING',
                severity: 'info',
                message: `Amazon returned "${r?.message || code}" but you already have an active listing for this ASIN in ${marketplace} — approval is verified at the seller-account level.`,
              });
              continue;
            }
            const target = isHardBlock ? blockingIssues : warnings;
            target.push({
              code: code || 'RESTRICTION',
              severity: isHardBlock ? 'block' : 'warn',
              message: r?.message || `Amazon restriction: ${code || 'unknown'}`,
              remediation: r?.links?.[0]?.title || 'Check Seller Central for approval requirements.',
            });
          }
        }
      } catch (e) {
        warnings.push({
          code: 'RESTRICTIONS_API_UNAVAILABLE',
          severity: 'warn',
          message: 'Could not contact Amazon listings-restrictions API. Eligibility based on local data only.',
        });
      }
    }

    const eligible = blockingIssues.length === 0;
    const fbaBlockReason = eligible
      ? null
      : blockingIssues.map((i) => `[${i.code}] ${i.message}`).join(' | ');

    // Upsert cache
    await supabase.from('fba_eligibility_cache').upsert({
      user_id: user.id,
      seller_id: sellerId,
      marketplace_id: marketplaceId,
      asin,
      eligible,
      blocking_issues: blockingIssues,
      warnings,
      fba_block_reason: fbaBlockReason,
      raw: { fnsku_rows: rows.length, has_seller_auth: !!userAuth?.refresh_token, has_active_listing: hasActiveListing, infos, conditionType },
      checked_at: new Date().toISOString(),
    }, { onConflict: 'user_id,seller_id,marketplace_id,asin' });

    // SKU-scoped persistence — NEVER blanket-update by ASIN. We only flag the
    // specific active SKUs returned in `affected_skus` of the blocking issues.
    // Tombstoned/quarantined ghost SKUs are always cleared. Active SKUs that
    // are NOT in any blocking issue's affected_skus must NOT inherit the block.
    const affectedSkus = new Set<string>();
    for (const issue of blockingIssues) {
      for (const s of (issue.affected_skus || [])) {
        if (s) affectedSkus.add(String(s));
      }
    }

    if (!eligible && affectedSkus.size > 0) {
      const list = Array.from(affectedSkus);
      await supabase.from('inventory')
        .update({ fba_blocked: true, fba_block_reason: fbaBlockReason })
        .eq('user_id', user.id)
        .eq('asin', asin)
        .in('sku', list);
      await supabase.from('created_listings')
        .update({ fba_blocked: true, fba_block_reason: fbaBlockReason })
        .eq('user_id', user.id)
        .eq('asin', asin)
        .in('sku', list);
    }

    // ALWAYS clear fba_blocked on rows that are NOT in affected_skus for this
    // ASIN — covers eligible result AND the case where an old blanket-update
    // wrongly flagged the active SKU because of a stale ghost row.
    {
      const clearReq = supabase.from('inventory')
        .update({ fba_blocked: false, fba_block_reason: null })
        .eq('user_id', user.id)
        .eq('asin', asin)
        .eq('fba_blocked', true);
      if (affectedSkus.size > 0) {
        clearReq.not('sku', 'in', `(${Array.from(affectedSkus).map((s) => `"${s}"`).join(',')})`);
      }
      await clearReq;

      const clearReq2 = supabase.from('created_listings')
        .update({ fba_blocked: false, fba_block_reason: null })
        .eq('user_id', user.id)
        .eq('asin', asin)
        .eq('fba_blocked', true);
      if (affectedSkus.size > 0) {
        clearReq2.not('sku', 'in', `(${Array.from(affectedSkus).map((s) => `"${s}"`).join(',')})`);
      }
      await clearReq2;
    }

    // ── PHASE B: stages 3 (FBA eligibility), 4 (hazmat), 5 (prep) ──────
    // Each stage caches independently with its own TTL. UNKNOWN is the
    // fail-safe — we NEVER mark a stage as "ok" or "blocked" if the API
    // call itself failed.
    const stageResults: StageResult[] = [];

    // Stage 1 mirrors the exact New-condition restriction result. Do not carry
    // Used/Refurbished/Collectible application messages into a New listing.
    const sellBlock = blockingIssues.find((i) =>
      ["RESTRICTED", "NOT_ELIGIBLE", "APPROVAL_REQUIRED", "ASIN_NOT_ELIGIBLE", "BRAND_NOT_ELIGIBLE"]
        .includes(String(i.code || "").toUpperCase()),
    );
    const sellWarn = warnings.find((i) =>
      ["RESTRICTION", "APPROVAL_REQUIRED"].includes(String(i.code || "").toUpperCase()),
    );
    let sellabilityStage: StageResult;
    if (sellBlock) {
      sellabilityStage = { stage: "sellability", status: "blocked", reason: sellBlock.message };
    } else if (sellWarn) {
      sellabilityStage = {
        stage: "sellability",
        status: "warn",
        reason: `Amazon returned a restriction: ${sellWarn.message}. Verify on Amazon — approval may still be required at listing time.`,
      };
    } else if (restrictionsApiSucceeded && restrictionsCount === 0 && hasActiveListing) {
      sellabilityStage = {
        stage: "sellability",
        status: "ok",
        reason: "Approved — verified by Amazon (no listing restrictions, active listing on file).",
      };
    } else if (restrictionsApiSucceeded && restrictionsCount === 0) {
      sellabilityStage = {
        stage: "sellability",
        status: "ok",
        reason: "Approved for New condition — Amazon returned no New-condition listing restrictions.",
      };
    } else {
      // API didn't run (no auth) or threw — be honest, not optimistic.
      sellabilityStage = {
        stage: "sellability",
        status: "warn",
        reason: "Sellability not verified. Check Seller Central before sourcing this ASIN.",
      };
    }
    stageResults.push(sellabilityStage);

    const barcodeBlock = blockingIssues.find((i) => String(i.code || "").toUpperCase() === "MANUFACTURER_BARCODE_MODE");
    const fnskuWarn = warnings.find((i) => String(i.code || "").toUpperCase() === "INVALID_FNSKU");
    const fnskuPending = infos.find((i) => String(i.code || "").toUpperCase() === "FNSKU_PENDING_LISTING_CREATION");
    const fnskuPropagating = infos.find((i) => String(i.code || "").toUpperCase() === "FNSKU_PROPAGATING");
    stageResults.push(
      barcodeBlock
        ? { stage: "listing_creation", status: "blocked", reason: barcodeBlock.message }
        : fnskuWarn
          ? { stage: "listing_creation", status: "warn", reason: fnskuWarn.message }
          : fnskuPropagating
            ? { stage: "listing_creation", status: "ok", reason: fnskuPropagating.message }
            : fnskuPending
              ? { stage: "listing_creation", status: "ok", reason: "Amazon will assign FNSKU after listing creation." }
              : { stage: "listing_creation", status: "ok", reason: "Listing creation path is clear." },
    );
    // Persist 1+2 to per-stage cache so subsequent legacy-cache hits include them.
    await writeStageCache(supabase, user.id, asin, marketplace, stageResults[0]);
    await writeStageCache(supabase, user.id, asin, marketplace, stageResults[1]);

    // Stages 3, 4, 5 — try cache first, then live SP-API. Always falls back to
    // UNKNOWN on any failure so the UI never goes false-green.
    const stage3 = await resolveStage(supabase, user.id, asin, marketplace, "fba_eligibility", body.force,
      async () => {
        if (!userAuth?.refresh_token) {
          return { stage: "fba_eligibility", status: "unknown", reason: "No SP-API authorization for this marketplace." };
        }
        return await fetchFbaInboundEligibility(supabase, { asin, marketplaceId, marketplace, refreshToken: userAuth.refresh_token });
      });
    stageResults.push(stage3);

    // Stages 4 + 5 share a single Catalog API call to avoid duplicate cost.
    const stage4Cached = await readStageCache(supabase, user.id, asin, marketplace, "hazmat", body.force);
    const stage5Cached = await readStageCache(supabase, user.id, asin, marketplace, "prep", body.force);
    let stage4: StageResult | null = stage4Cached;
    let stage5: StageResult | null = stage5Cached;
    if ((!stage4 || !stage5) && userAuth?.refresh_token) {
      try {
        const cat = await fetchCatalogAttributes(supabase, { asin, marketplaceId, marketplace, refreshToken: userAuth.refresh_token });
        if (!stage4) {
          stage4 = classifyHazmat(cat);
          await writeStageCache(supabase, user.id, asin, marketplace, stage4);
        }
        if (!stage5) {
          stage5 = classifyPrep(cat);
          await writeStageCache(supabase, user.id, asin, marketplace, stage5);
        }
      } catch (e) {
        const raw = (e as Error).message || '';
        const friendly = /LWA\s*4\d\d/i.test(raw)
          ? 'Amazon catalog lookup temporarily unavailable (auth refresh). Try Re-check in a moment.'
          : `Catalog API unavailable: ${raw}`;
        if (!stage4) stage4 = { stage: "hazmat", status: "warn", reason: friendly };
        if (!stage5) stage5 = { stage: "prep",   status: "warn", reason: friendly };
      }
    }
    if (!stage4) stage4 = { stage: "hazmat", status: "warn", reason: "Hazmat could not be verified — confirm in Seller Central before shipping." };
    if (!stage5) stage5 = { stage: "prep",   status: "warn", reason: "Prep & labeling not verified — confirm at shipment-plan time." };
    stageResults.push(stage4, stage5);

    // Stage 6 — never run automatically. Read most recent cached result if any.
    // Honor `force` so the Re-check button clears stale dry-run results.
    const stage6Cached = await readStageCache(supabase, user.id, asin, marketplace, "inbound_dry_run", body.force);
    stageResults.push(
      stage6Cached || {
        stage: "inbound_dry_run",
        status: "unknown",
        reason: "Shipment precheck not run yet. Run it only after Amazon creates the listing and assigns an FNSKU.",
      },
    );

    return jsonResp(200, {
      eligible,
      blockingIssues,
      warnings,
      infos,
      fba_block_reason: fbaBlockReason,
      stageStatuses: stageResults,
      cached: false,
      quarantined_ghost_skus: quarantinedCount,
      tombstoned_skus: Array.from(tombstonedSkus),
    });
  } catch (e: any) {
    console.error('[check-fba-listing-eligibility]', e);
    return jsonResp(500, { error: e?.message || 'Internal error' });
  }
});

function jsonResp(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// ── Phase B: per-stage cache helpers ─────────────────────────────────

async function loadAllStageCaches(
  supabase: any, userId: string, asin: string, marketplace: string,
): Promise<StageResult[]> {
  const stages: StageResult["stage"][] | string[] = [
    "sellability", "listing_creation", "fba_eligibility", "hazmat", "prep", "inbound_dry_run",
  ];
  const out: StageResult[] = [];
  for (const stage of stages) {
    const c = await readStageCache(supabase, userId, asin, marketplace, stage as string, false);
    out.push(c || {
      stage: stage as string,
      status: "unknown",
      reason: stage === "inbound_dry_run"
        ? "Shipment precheck not run yet. Run it only after Amazon creates the listing and assigns an FNSKU."
        : "Re-check to refresh.",
    });
  }
  return out;
}

function normalizeStageResult(stage: string, row: StageResult): StageResult {
  const reason = String(row.reason || '');
  if (
    stage === 'inbound_dry_run' &&
    row.status === 'blocked' &&
    /no valid fnsku|no fnsku|listing has no fnsku|fnsku.*yet/i.test(reason)
  ) {
    return {
      ...row,
      status: 'warn',
      reason: 'No FNSKU on file yet. Amazon assigns the FNSKU after listing creation — re-run this precheck once the listing is live.',
    };
  }
  return row;
}


async function readStageCache(
  supabase: any, userId: string, asin: string, marketplace: string, stage: string, force?: boolean,
): Promise<StageResult | null> {
  if (force) return null;
  const ttl = STAGE_TTL_SECONDS[stage] ?? 3600;
  const { data } = await supabase
    .from('fba_readiness_cache')
    .select('status, reason, raw, checked_at')
    .eq('user_id', userId).eq('asin', asin).eq('marketplace', marketplace).eq('stage', stage)
    .maybeSingle();
  if (!data) return null;
  const ageMs = Date.now() - new Date(data.checked_at).getTime();
  if (ageMs > ttl * 1000) return null;
  return normalizeStageResult(stage, { stage, status: data.status, reason: data.reason || undefined, raw: data.raw || undefined });
}

async function writeStageCache(supabase: any, userId: string, asin: string, marketplace: string, r: StageResult) {
  const row = {
    user_id: userId, asin, marketplace, stage: r.stage,
    status: r.status, reason: r.reason || null, raw: r.raw || null,
    checked_at: new Date().toISOString(),
  };
  await supabase.from('fba_readiness_cache').upsert(row, { onConflict: 'user_id,asin,marketplace,stage' });
  await supabase.from('fba_readiness_audit').insert({
    user_id: userId, asin, marketplace, stage: r.stage,
    status: r.status, reason: r.reason || null, raw: r.raw || null,
    source: 'check-fba-listing-eligibility',
  });
}

async function resolveStage(
  supabase: any, userId: string, asin: string, marketplace: string, stage: string, force: boolean | undefined,
  fetcher: () => Promise<StageResult>,
): Promise<StageResult> {
  const cached = await readStageCache(supabase, userId, asin, marketplace, stage, force);
  if (cached) return cached;
  let result: StageResult;
  try {
    result = await fetcher();
  } catch (e) {
    const raw = (e as Error).message || '';
    const friendly = /LWA\s*4\d\d/i.test(raw)
      ? 'Amazon auth refresh temporarily unavailable. Try Re-check in a moment.'
      : `Live check failed: ${raw}`;
    result = { stage, status: "warn", reason: friendly };
  }
  // Only persist non-error results; warn-from-error stays uncached so the
  // next call retries. UNKNOWN-from-no-auth IS persisted briefly to avoid spam.
  if (result.status !== "warn" || /No SP-API/.test(result.reason || "")) {
    await writeStageCache(supabase, userId, asin, marketplace, result);
  }
  return result;
}

// ── Phase B: Stage 3 — FBA inbound eligibility (itemPreview) ─────────

async function fetchFbaInboundEligibility(supabase: any, p: {
  asin: string; marketplaceId: string; marketplace: string; refreshToken: string;
}): Promise<StageResult> {
  const accessToken = await getAccessToken(p.refreshToken);
  const host = hostFor(p.marketplace);
  const path = `/fba/inbound/v1/eligibility/itemPreview`;
  const qsObj: Record<string, string> = {
    asin: p.asin,
    program: 'INBOUND',
    marketplaceIds: p.marketplaceId,
  };
  const qs = Object.keys(qsObj).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(qsObj[k])}`).join('&');
  const url = `https://${host}${path}?${qs}`;
  await waitForApiToken(supabase, 'inbound_api');
  const res = await spApiSignedFetch({ method: 'GET', url, path, queryParams: qs, accessToken, host });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`itemPreview ${res.status}: ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  const item = data?.payload || {};
  const isEligible = item?.isEligibleForProgram === true || item?.isEligibleForProgram === 'true';
  const reasons: string[] = Array.isArray(item?.ineligibilityReasonList) ? item.ineligibilityReasonList : [];
  if (isEligible) {
    return { stage: "fba_eligibility", status: "ok", reason: "Amazon confirms ASIN is eligible for FBA inbound.", raw: item };
  }
  // Some reasons (FBA_INB_0004 = need approval) are warnings, others hard blocks.
  const hardBlocks = new Set(['FBA_INB_0004', 'FBA_INB_0009', 'FBA_INB_0010', 'FBA_INB_0011', 'FBA_INB_0050', 'FBA_INB_0053']);
  const isHardBlock = reasons.some((r) => hardBlocks.has(String(r).toUpperCase()));
  return {
    stage: "fba_eligibility",
    status: isHardBlock ? "blocked" : "warn",
    reason: reasons.length ? `Amazon flagged: ${reasons.join(', ')}` : "Amazon reports ASIN not eligible for FBA inbound.",
    raw: item,
  };
}

// ── Phase B: Stages 4 + 5 — Catalog attributes (hazmat + prep) ───────

async function fetchCatalogAttributes(supabase: any, p: {
  asin: string; marketplaceId: string; marketplace: string; refreshToken: string;
}): Promise<any> {
  const accessToken = await getAccessToken(p.refreshToken);
  const host = hostFor(p.marketplace);
  const path = `/catalog/2022-04-01/items/${encodeURIComponent(p.asin)}`;
  const qsObj: Record<string, string> = {
    marketplaceIds: p.marketplaceId,
    includedData: 'attributes,dimensions,productTypes,salesRanks,summaries',
  };
  const qs = Object.keys(qsObj).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(qsObj[k])}`).join('&');
  const url = `https://${host}${path}?${qs}`;
  await waitForApiToken(supabase, 'catalog_api');
  const res = await spApiSignedFetch({ method: 'GET', url, path, queryParams: qs, accessToken, host });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`catalog ${res.status}: ${txt.slice(0, 200)}`);
  }
  return await res.json();
}

function classifyHazmat(cat: any): StageResult {
  const attrs = cat?.attributes || {};
  // Look across common Amazon hazmat / DG attribute keys.
  const flatten = JSON.stringify(attrs).toLowerCase();
  const hardSignals = [
    'dangerous_goods', 'hazmat', 'is_hazmat', 'unspsc_hazmat', 'lithium',
    'flammable', 'aerosol', 'hazardous_material', 'battery_type',
  ];
  const matched = hardSignals.filter((s) => flatten.includes(s));
  if (matched.length === 0) {
    return { stage: "hazmat", status: "ok", reason: "No hazmat / dangerous-goods signals in catalog data.", raw: { matched } };
  }
  // Presence alone doesn't mean restricted — could be "is_hazmat: false". We
  // surface as warn so the UI shows "needs human verification" rather than
  // false-blocking. True restriction comes from itemPreview ineligibility.
  return {
    stage: "hazmat",
    status: "warn",
    reason: `Catalog mentions hazmat-related attributes (${matched.slice(0, 3).join(', ')}). Verify before shipping.`,
    raw: { matched },
  };
}

function classifyPrep(cat: any): StageResult {
  const attrs = cat?.attributes || {};
  const flat = JSON.stringify(attrs).toLowerCase();
  // Common prep signals from catalog. If we see explicit prep_instructions /
  // package_type → known. Otherwise we can't claim "no prep needed", so we
  // mark prep as warn (not unknown) to keep the user honest.
  const explicitKnown = ['prep_instruction', 'item_package_quantity', 'package_type', 'unit_count'];
  const matched = explicitKnown.filter((s) => flat.includes(s));
  if (matched.length >= 2) {
    return { stage: "prep", status: "ok", reason: "Catalog provides packaging metadata; standard prep should apply.", raw: { matched } };
  }
  return {
    stage: "prep",
    status: "warn",
    reason: "Prep & labeling requirements not fully described in catalog. Confirm at shipment-plan time.",
    raw: { matched },
  };
}

// ── SP-API live FNSKU lookup (self-heal path) ────────────────────────

interface LiveSkuPair { sellerSku: string; fnsku: string }

async function fetchLiveFnskuPairs(p: {
  asin: string; marketplaceId: string; marketplace: string; refreshToken: string;
}): Promise<LiveSkuPair[]> {
  const accessToken = await getAccessToken(p.refreshToken);
  const host = hostFor(p.marketplace);
  const path = `/fba/inventory/v1/summaries`;
  const upperAsin = p.asin.toUpperCase();
  const out: LiveSkuPair[] = [];
  let nextToken: string | undefined;
  for (let page = 0; page < 5; page++) {
    const qsObj: Record<string, string> = {
      details: 'true',
      granularityType: 'Marketplace',
      granularityId: p.marketplaceId,
      marketplaceIds: p.marketplaceId,
    };
    if (nextToken) qsObj.nextToken = nextToken;
    const qs = Object.keys(qsObj).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(qsObj[k])}`).join('&');
    const url = `https://${host}${path}?${qs}`;
    const res = await spApiSignedFetch({ method: 'GET', url, path, queryParams: qs, accessToken, host });
    if (!res.ok) { await res.text(); throw new Error(`summaries ${res.status}`); }
    const data = await res.json();
    const items = data?.payload?.inventorySummaries || [];
    for (const it of items) {
      if ((it?.asin || '').toUpperCase() === upperAsin && it?.fnSku && it?.sellerSku) {
        out.push({ sellerSku: String(it.sellerSku), fnsku: String(it.fnSku) });
      }
    }
    nextToken = data?.payload?.nextToken;
    if (!nextToken) break;
  }
  return out;
}

async function fetchLiveFnsku(p: {
  asin: string; marketplaceId: string; marketplace: string; refreshToken: string;
}): Promise<string | null> {
  const pairs = await fetchLiveFnskuPairs(p);
  const valid = pairs.find((x) => FNSKU_RE.test(x.fnsku.toUpperCase()));
  return valid?.fnsku || null;
}

// ── SP-API listings restrictions (signed v4) ─────────────────────────

async function checkRestrictions(p: {
  asin: string; sellerId: string; marketplaceId: string; marketplace: string; conditionType: string; refreshToken: string;
}): Promise<any[]> {
  const accessToken = await getAccessToken(p.refreshToken);
  const host = hostFor(p.marketplace);
  const path = `/listings/2021-08-01/restrictions`;
  const qs = `asin=${encodeURIComponent(p.asin)}&sellerId=${encodeURIComponent(p.sellerId)}&marketplaceIds=${p.marketplaceId}&conditionType=${encodeURIComponent(p.conditionType)}&reasonLocale=en_US`;
  const url = `https://${host}${path}?${qs}`;
  const res = await spApiSignedFetch({ method: 'GET', url, path, queryParams: qs, accessToken, host });
  if (!res.ok) {
    await res.text();
    throw new Error(`restrictions ${res.status}`);
  }
  const data = await res.json();
  const out: any[] = [];
  for (const r of (data?.restrictions || [])) {
    for (const reason of (r?.reasons || [])) {
      out.push({
        conditionType: r?.conditionType,
        reasonCode: reason?.reasonCode,
        message: reason?.message,
        links: reason?.links,
      });
    }
  }
  return out;
}

function isRestrictionForCondition(restriction: any, requestedConditionType: string): boolean {
  const returnedCondition = String(restriction?.conditionType || '').trim().toLowerCase();
  if (returnedCondition && returnedCondition !== requestedConditionType) return false;

  if (requestedConditionType === 'new_new') {
    const text = JSON.stringify(restriction || {}).toLowerCase();
    const mentionsOtherConditions = /\b(used|refurbished|collectible)\b/.test(text);
    const explicitlyMentionsNew = /\bnew\b/.test(text);
    if (mentionsOtherConditions && !explicitlyMentionsNew) return false;
  }
  return true;
}

function normalizeConditionType(value?: string | null): string {
  const v = String(value || 'new_new').trim().toLowerCase();
  const allowed = new Set(['new_new', 'used_like_new', 'used_very_good', 'used_good', 'used_acceptable', 'collectible_like_new', 'collectible_very_good', 'collectible_good', 'collectible_acceptable']);
  return allowed.has(v) ? v : 'new_new';
}

async function getAccessToken(refreshToken: string): Promise<string> {
  const id = Deno.env.get('LWA_CLIENT_ID') ?? Deno.env.get('SPAPI_LWA_CLIENT_ID');
  const secret = Deno.env.get('LWA_CLIENT_SECRET') ?? Deno.env.get('SPAPI_LWA_CLIENT_SECRET');
  if (!id || !secret) throw new Error('LWA credentials missing');
  const r = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: id,
      client_secret: secret,
    }),
  });
  if (!r.ok) throw new Error(`LWA ${r.status}`);
  return (await r.json()).access_token;
}

async function spApiSignedFetch(p: {
  method: string; url: string; path: string; queryParams: string; accessToken: string; host: string;
}): Promise<Response> {
  const ak = Deno.env.get('AWS_ACCESS_KEY_ID')!;
  const sk = Deno.env.get('AWS_SECRET_ACCESS_KEY')!;
  const hostToRegion: Record<string, string> = {
    'sellingpartnerapi-na.amazon.com': 'us-east-1',
    'sellingpartnerapi-eu.amazon.com': 'eu-west-1',
    'sellingpartnerapi-fe.amazon.com': 'us-west-2',
  };
  const region = hostToRegion[p.host] || 'us-east-1';
  const ts = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = ts.slice(0, 8);
  const enc = new TextEncoder();
  const canonHeaders = `host:${p.host}\nx-amz-date:${ts}\n`;
  const signedHeaders = 'host;x-amz-date';
  const payloadHash = await sha256Hex(enc.encode(''));
  const canonReq = `${p.method}\n${p.path}\n${p.queryParams}\n${canonHeaders}\n${signedHeaders}\n${payloadHash}`;
  const canonHash = await sha256Hex(enc.encode(canonReq));
  const scope = `${date}/${region}/execute-api/aws4_request`;
  const sts = `AWS4-HMAC-SHA256\n${ts}\n${scope}\n${canonHash}`;
  const kDate = await hmacSha256(enc.encode('AWS4' + sk), enc.encode(date));
  const kRegion = await hmacSha256(kDate, enc.encode(region));
  const kSvc = await hmacSha256(kRegion, enc.encode('execute-api'));
  const kSign = await hmacSha256(kSvc, enc.encode('aws4_request'));
  const sig = await hmacSha256Hex(kSign, enc.encode(sts));
  return await fetch(p.url, {
    method: p.method,
    headers: {
      Authorization: `AWS4-HMAC-SHA256 Credential=${ak}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}`,
      'x-amz-access-token': p.accessToken,
      'x-amz-date': ts,
      host: p.host,
    },
  });
}

async function sha256Hex(d: Uint8Array): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', d as any);
  return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function hmacSha256(k: ArrayBuffer | Uint8Array, d: Uint8Array): Promise<ArrayBuffer> {
  const ck = await crypto.subtle.importKey('raw', k as any, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return await crypto.subtle.sign('HMAC', ck, d as any);
}
async function hmacSha256Hex(k: ArrayBuffer | Uint8Array, d: Uint8Array): Promise<string> {
  const s = await hmacSha256(k, d);
  return Array.from(new Uint8Array(s)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
