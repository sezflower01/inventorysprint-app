import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { applyPreset } from '../repricer-ai-evaluate/_presets.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const body = await req.json().catch(() => ({}));

    if (body?.action === 'verify_final_state') {
      const pairs: { asin: string; marketplace: string }[] = body.pairs || [];
      const results = [];
      for (const p of pairs) {
        const { data, error } = await supabase
          .from('repricer_assignments')
          .select('asin, sku, marketplace, is_enabled, sellability_review_hold, intl_listing_status, is_listing_inactive_not_buyable, marketplace_checked_at, updated_at')
          .eq('asin', p.asin)
          .eq('marketplace', p.marketplace);
        results.push({ asin: p.asin, marketplace: p.marketplace, rows: data, error: error?.message || null });
      }
      return new Response(JSON.stringify({ results }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (body?.action === 'scan_stale_not_found_but_enabled') {
      const { data, error } = await supabase
        .from('repricer_assignments')
        .select('asin, sku, marketplace, is_enabled, sellability_review_hold, intl_listing_status, marketplace_checked_at')
        .eq('user_id', body.user_id)
        .in('marketplace', ['BR', 'MX', 'CA'])
        .eq('intl_listing_status', 'NOT_FOUND')
        .eq('is_enabled', true);
      return new Response(JSON.stringify({ count: data?.length || 0, rows: data, error: error?.message || null }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (body?.action === 'disable_stale_not_found_but_enabled') {
      const nowIso = new Date().toISOString();
      const { data, error } = await supabase
        .from('repricer_assignments')
        .update({
          is_enabled: false,
          manual_paused: false,
          last_disabled_by: null,
          last_disabled_reason: 'Auto: retroactive fix — already confirmed NOT_FOUND but left is_enabled=true by the auto-assign-bulk restock re-enable bug (fixed 2026-08-13)',
          last_disabled_at: nowIso,
          marketplace_sellable: false,
        })
        .eq('user_id', body.user_id)
        .in('marketplace', ['BR', 'MX', 'CA'])
        .eq('intl_listing_status', 'NOT_FOUND')
        .eq('is_enabled', true)
        .eq('sellability_review_hold', false)
        .select('id');
      return new Response(JSON.stringify({ updated_count: data?.length || 0, error: error?.message || null }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (body?.action === 'scan_null_bounds_by_marketplace') {
      const { data, error } = await supabase
        .from('repricer_assignments')
        .select('asin, sku, marketplace, created_at, rule_id, last_error_type, last_disabled_by, last_disabled_reason')
        .eq('user_id', body.user_id)
        .eq('marketplace', body.marketplace)
        .eq('is_enabled', false)
        .is('min_price_override', null)
        .order('created_at', { ascending: true })
        .limit(30);
      return new Response(JSON.stringify({ rows: data, error: error?.message || null }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (body?.action === 'scan_null_bounds_invisible') {
      const pageSize = 1000;
      let from = 0;
      const allRows = [];
      while (true) {
        const { data: page, error: pageErr } = await supabase
          .from('repricer_assignments')
          .select('asin, sku, marketplace, created_at, is_enabled, status, min_price_override, max_price_override, rule_id, last_evaluated_at, last_error_type, last_error_message, manual_paused, last_disabled_by')
          .eq('user_id', body.user_id)
          .eq('is_enabled', false)
          .is('min_price_override', null)
          .order('asin', { ascending: true })
          .range(from, from + pageSize - 1);
        if (pageErr) {
          return new Response(JSON.stringify({ error: pageErr.message }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        allRows.push(...(page || []));
        if (!page || page.length < pageSize) break;
        from += pageSize;
      }
      const manuallyPaused = allRows.filter((r) => r.manual_paused === true || ['user','manual','seller','owner'].includes(String(r.last_disabled_by||'').toLowerCase()));
      const notManuallyPaused = allRows.filter((r) => !(r.manual_paused === true || ['user','manual','seller','owner'].includes(String(r.last_disabled_by||'').toLowerCase())));
      const neverEvaluated = notManuallyPaused.filter((r) => !r.last_evaluated_at);
      const byMarketplace = {};
      for (const r of notManuallyPaused) byMarketplace[r.marketplace] = (byMarketplace[r.marketplace]||0) + 1;
      const byErrorType = {};
      for (const r of notManuallyPaused) { const k = r.last_error_type || 'none'; byErrorType[k] = (byErrorType[k]||0)+1; }
      const now = Date.now();
      const ageDaysList = notManuallyPaused
        .filter(r => r.created_at)
        .map(r => (now - new Date(r.created_at).getTime()) / 86400000);
      ageDaysList.sort((a,b) => a-b);
      const median = ageDaysList.length ? ageDaysList[Math.floor(ageDaysList.length/2)] : null;
      const over7days = ageDaysList.filter(d => d > 7).length;
      const over30days = ageDaysList.filter(d => d > 30).length;
      return new Response(JSON.stringify({
        total_null_bounds_disabled: allRows.length,
        manually_paused_excluded: manuallyPaused.length,
        candidate_stuck_count: notManuallyPaused.length,
        never_evaluated_count: neverEvaluated.length,
        by_marketplace: byMarketplace,
        by_error_type: byErrorType,
        age_days_median: median,
        age_over_7days_count: over7days,
        age_over_30days_count: over30days,
        sample: notManuallyPaused.slice(0, 20),
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (body?.action === 'inspect_momentum_smart_rules') {
      const { data, error } = await supabase
        .from('repricer_rules')
        .select('id, name, smart_profile, min_floor_support_ratio, post_raise_cooldown_hours, created_at, updated_at')
        .eq('user_id', body.user_id)
        .eq('smart_profile', 'MOMENTUM_SMART');
      return new Response(JSON.stringify({ rows: data, error: error?.message || null }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (body?.action === 'time_matched_cohort_rpc1_single_rule') {
      const since = new Date(Date.now() - (body.days || 30) * 86400000).toISOString();
      const t0 = Date.now();
      const { data, error } = await supabase.rpc('repricer_asin_profile_days', {
        p_user_id: body.user_id, p_since: since, p_rule_id: body.rule_id,
        p_v2_cutover: body.v2_cutover || '2026-08-14T02:34:20.000Z',
      });
      return new Response(JSON.stringify({ ms: Date.now() - t0, rows: data?.length ?? null, sample: data?.slice(0, 3), error: error?.message || null }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (body?.action === 'time_probe_group_by_asin') {
      const since = new Date(Date.now() - (body.days || 30) * 86400000).toISOString();
      const t0 = Date.now();
      const { data, error } = await supabase.rpc('debug_probe_group_by_asin', { p_user_id: body.user_id, p_since: since, p_rule_id: body.rule_id });
      return new Response(JSON.stringify({ ms: Date.now() - t0, rows: data?.length ?? null, error: error?.message || null }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (body?.action === 'time_probe_group_by_asin_filters') {
      const since = new Date(Date.now() - (body.days || 30) * 86400000).toISOString();
      const t0 = Date.now();
      const { data, error } = await supabase.rpc('debug_probe_group_by_asin_filters', { p_user_id: body.user_id, p_since: since, p_rule_id: body.rule_id });
      return new Response(JSON.stringify({ ms: Date.now() - t0, rows: data?.length ?? null, error: error?.message || null }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (body?.action === 'time_probe_full_shape') {
      const since = new Date(Date.now() - (body.days || 30) * 86400000).toISOString();
      const t0 = Date.now();
      const { data, error } = await supabase.rpc('debug_probe_full_shape', {
        p_user_id: body.user_id, p_since: since, p_rule_id: body.rule_id,
        p_v2_cutover: body.v2_cutover || '2026-08-14T02:34:20.000Z',
      });
      return new Response(JSON.stringify({ ms: Date.now() - t0, rows: data?.length ?? null, error: error?.message || null }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (body?.action === 'time_probe_array_filter') {
      const since = new Date(Date.now() - (body.days || 30) * 86400000).toISOString();
      const t0 = Date.now();
      const { data, error } = await supabase.rpc('debug_probe_array_filter', { p_user_id: body.user_id, p_since: since, p_rule_ids: body.rule_ids });
      return new Response(JSON.stringify({ ms: Date.now() - t0, rows: data?.length ?? null, error: error?.message || null }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (body?.action === 'time_matched_cohort_full_chain') {
      const since = new Date(Date.now() - (body.days || 30) * 86400000).toISOString();
      const TARGET_PROFILES = ['MOMENTUM_BUILDER', 'SMART_MATCH', 'MOMENTUM_SMART'];
      const { data: rules } = await supabase.from('repricer_rules').select('id, smart_profile')
        .eq('user_id', body.user_id).in('smart_profile', TARGET_PROFILES);
      const ruleIds = (rules || []).map((r: any) => r.id);
      const timings: Record<string, any> = {};

      let t0 = Date.now();
      const profileDayRows: any[] = [];
      const perRuleErrors: string[] = [];
      for (const ruleId of ruleIds) {
        const r = await supabase.rpc('repricer_asin_profile_days', { p_user_id: body.user_id, p_since: since, p_rule_id: ruleId, p_v2_cutover: '2026-08-14T02:34:20.000Z' });
        if (r.error) perRuleErrors.push(r.error.message);
        else profileDayRows.push(...(r.data || []));
      }
      timings.profile_days = { ms: Date.now() - t0, errors: perRuleErrors, total_rows: profileDayRows.length };

      const asins = [...new Set(profileDayRows.map((row: any) => row.asin))];
      timings.candidate_asin_count = asins.length;

      t0 = Date.now();
      const salesRes = await supabase.rpc('repricer_asin_sales_days', { p_user_id: body.user_id, p_since: since, p_asins: asins });
      timings.sales_days = { ms: Date.now() - t0, rows: salesRes.data?.length ?? null, error: salesRes.error?.message || null };

      t0 = Date.now();
      const raisesRes = await supabase.rpc('repricer_asin_raises', { p_user_id: body.user_id, p_since: since, p_asins: asins });
      timings.raises = { ms: Date.now() - t0, rows: raisesRes.data?.length ?? null, error: raisesRes.error?.message || null };

      t0 = Date.now();
      const bbRes = await supabase.rpc('repricer_asin_bb_days', { p_user_id: body.user_id, p_since: since, p_asins: asins, p_seller_ids: { US: 'x' } });
      timings.bb_days = { ms: Date.now() - t0, rows: bbRes.data?.length ?? null, error: bbRes.error?.message || null };

      return new Response(JSON.stringify(timings), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (body?.action === 'count_ai_decisions_for_rules') {
      const since = new Date(Date.now() - (body.days || 30) * 86400000).toISOString();
      const { count, error } = await supabase.from('repricer_ai_decisions')
        .select('*', { count: 'exact', head: true })
        .in('rule_id', body.rule_ids).gte('created_at', since);
      return new Response(JSON.stringify({ count, error: error?.message || null }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (body?.action === 'time_matched_cohort_rpc1') {
      const since = new Date(Date.now() - (body.days || 30) * 86400000).toISOString();
      const { data: rules } = await supabase.from('repricer_rules').select('id, smart_profile')
        .eq('user_id', body.user_id).in('smart_profile', ['MOMENTUM_BUILDER', 'SMART_MATCH', 'MOMENTUM_SMART']);
      const ruleIds = (rules || []).map((r: any) => r.id);
      const t0 = Date.now();
      const { data, error } = await supabase.rpc('repricer_asin_profile_days', { p_user_id: body.user_id, p_since: since, p_rule_ids: ruleIds });
      return new Response(JSON.stringify({ rule_ids: ruleIds, ms: Date.now() - t0, rows: data?.length ?? null, error: error?.message || null }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (body?.action === 'time_rule_perf_rpcs') {
      const since = new Date(Date.now() - (body.days || 30) * 86400000).toISOString();
      const timings: Record<string, any> = {};
      for (const [label, fn, args] of [
        ['sales', 'repricer_rule_perf_sales', { p_user_id: body.user_id, p_since: since }],
        ['raises', 'repricer_rule_perf_raises', { p_user_id: body.user_id, p_since: since, p_limit: 500 }],
        ['raise_safety', 'repricer_rule_perf_raise_safety', { p_user_id: body.user_id, p_since: since }],
      ] as [string, string, any][]) {
        const t0 = Date.now();
        try {
          const { data, error } = await supabase.rpc(fn, args);
          timings[label] = { ms: Date.now() - t0, rows: data?.length ?? null, error: error?.message || null };
        } catch (e: any) {
          timings[label] = { ms: Date.now() - t0, error: String(e?.message || e) };
        }
      }
      return new Response(JSON.stringify({ timings }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (body?.action === 'inspect_recent_ai_decisions') {
      const { data, error } = await supabase
        .from('repricer_ai_decisions')
        .select('asin, marketplace, rule_id, mode, reason, cooldown_applied, max_step_applied, min_price_clamped, raise_blocked_cooldown, raise_rejected_floor_support, created_at')
        .eq('user_id', body.user_id)
        .order('created_at', { ascending: false })
        .limit(body.limit || 20);
      return new Response(JSON.stringify({ rows: data, error: error?.message || null }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (body?.action === 'find_momentum_smart_assignment') {
      const { data: rules, error: ruleErr } = await supabase
        .from('repricer_rules')
        .select('id')
        .eq('user_id', body.user_id)
        .eq('smart_profile', 'MOMENTUM_SMART');
      if (ruleErr) {
        return new Response(JSON.stringify({ row: null, error: ruleErr.message }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const ruleIds = (rules || []).map((r: any) => r.id);
      const { data, error } = await supabase
        .from('repricer_assignments')
        .select('id, rule_id, asin, sku, marketplace, last_applied_price, is_enabled, last_raise_at')
        .eq('user_id', body.user_id)
        .in('rule_id', ruleIds)
        .eq('is_enabled', true)
        .not('last_applied_price', 'is', null)
        .limit(1)
        .maybeSingle();
      return new Response(JSON.stringify({ row: data, error: error?.message || null }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (body?.action === 'get_assignment_id_and_rule') {
      const { data, error } = await supabase
        .from('repricer_assignments')
        .select('id, rule_id, asin, sku, marketplace, last_applied_price')
        .eq('user_id', body.user_id)
        .eq('asin', body.asin)
        .eq('marketplace', body.marketplace || 'US')
        .maybeSingle();
      return new Response(JSON.stringify({ row: data, error: error?.message || null }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (body?.action === 'set_assignment_rule') {
      const { data, error } = await supabase
        .from('repricer_assignments')
        .update({ rule_id: body.rule_id })
        .eq('id', body.assignment_id)
        .eq('user_id', body.user_id)
        .select('id, rule_id')
        .maybeSingle();
      return new Response(JSON.stringify({ row: data, error: error?.message || null }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (body?.action === 'run_repricer_ai_evaluate') {
      const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
      const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
      const resp = await fetch(`${supabaseUrl}/functions/v1/repricer-ai-evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${serviceKey}` },
        body: JSON.stringify({
          internal: true,
          dry_run: true,
          user_id: body.user_id,
          assignmentId: body.assignment_id || undefined,
          ruleId: body.assignment_id ? undefined : body.rule_id,
          asin: body.asin,
          sku: body.sku,
          marketplace: body.marketplace || 'US',
          currentPrice: body.current_price,
        }),
      });
      const json = await resp.json().catch((e: any) => ({ parse_error: String(e) }));
      return new Response(JSON.stringify({ status: resp.status, result: json }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (body?.action === 'set_last_raise_at') {
      const { data, error } = await supabase
        .from('repricer_assignments')
        .update({ last_raise_at: body.value })
        .eq('id', body.assignment_id)
        .eq('user_id', body.user_id)
        .select('id, last_raise_at')
        .maybeSingle();
      return new Response(JSON.stringify({ row: data, error: error?.message || null }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (body?.action === 'create_test_momentum_smart_rule') {
      // Apply the real MOMENTUM_SMART preset (same helper index.ts's own rule
      // save path uses) so this test rule actually carries enable_smart_raise,
      // require_market_supported_raise, min_floor_support_ratio,
      // post_raise_cooldown_hours, etc. -- not just the smart_profile label.
      const base = applyPreset(
        {
          user_id: body.user_id,
          name: '__TEST_MOMENTUM_SMART__ (safe to delete)',
          is_enabled: false,
          marketplaces: [body.marketplace || 'US'],
          strategy: 'AI_WIN_SALES_BOOSTER',
        },
        'MOMENTUM_SMART',
      );
      const { data, error } = await supabase
        .from('repricer_rules')
        .insert({ ...base, smart_profile: 'MOMENTUM_SMART' })
        .select('*')
        .maybeSingle();
      return new Response(JSON.stringify({ rule: data, error: error?.message || null }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (body?.action === 'delete_test_rule') {
      const { error } = await supabase.from('repricer_rules').delete().eq('id', body.rule_id).eq('user_id', body.user_id);
      return new Response(JSON.stringify({ deleted: !error, error: error?.message || null }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (body?.action === 'run_auto_assign_bulk') {
      const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
      const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
      const resp = await fetch(`${supabaseUrl}/functions/v1/auto-assign-bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${serviceKey}` },
        body: JSON.stringify({ user_id: body.user_id, marketplace: body.marketplace }),
      });
      const json = await resp.json().catch((e: any) => ({ parse_error: String(e) }));
      return new Response(JSON.stringify({ status: resp.status, result: json }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (body?.action === 'inspect_cron_jobs') {
      const { data, error } = await supabase.rpc('debug_cron_jobs');
      return new Response(JSON.stringify({ rows: data, error: error?.message || null }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (body?.action === 'inspect_cron_run_details') {
      const { data, error } = await supabase.rpc('debug_cron_run_details', { p_jobid: body.jobid, p_limit: body.limit || 30 });
      return new Response(JSON.stringify({ rows: data, error: error?.message || null }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (body?.action === 'inspect_activation_timeline') {
      const { data, error } = await supabase
        .from('repricer_assignments')
        .select('asin, sku, marketplace, created_at, is_enabled, status, min_price_override, max_price_override, rule_id, last_evaluated_at, bounds_synced_at, roi_range_updated_at, roi_at_min_percent, last_error_type, last_error_message, last_enabled_at, last_enabled_by, auto_activated_at, auto_activated_by')
        .eq('user_id', body.user_id)
        .eq('asin', body.asin)
        .eq('marketplace', body.marketplace);
      return new Response(JSON.stringify({ rows: data, error: error?.message || null }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (body?.action === 'scan_inverted_min_max') {
      const pageSize = 1000;
      let from = 0;
      const allRows = [];
      while (true) {
        const { data: page, error: pageErr } = await supabase
          .from('repricer_assignments')
          .select('asin, sku, marketplace, is_enabled, min_price_override, max_price_override')
          .eq('user_id', body.user_id)
          .not('min_price_override', 'is', null)
          .not('max_price_override', 'is', null)
          .order('asin', { ascending: true })
          .range(from, from + pageSize - 1);
        if (pageErr) {
          return new Response(JSON.stringify({ error: pageErr.message }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        allRows.push(...(page || []));
        if (!page || page.length < pageSize) break;
        from += pageSize;
      }
      const inverted = allRows.filter((r) => r.max_price_override < r.min_price_override);
      return new Response(JSON.stringify({
        total_checked: allRows.length,
        inverted_count: inverted.length,
        inverted_enabled_count: inverted.filter(r => r.is_enabled).length,
        sample: inverted.slice(0, 20),
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (body?.action === 'fix_inverted_min_max') {
      const { data: before } = await supabase
        .from('repricer_assignments')
        .select('id, asin, sku, marketplace, min_price_override, max_price_override')
        .eq('user_id', body.user_id)
        .eq('asin', body.asin)
        .eq('marketplace', body.marketplace)
        .maybeSingle();
      if (!before) {
        return new Response(JSON.stringify({ error: 'not found' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      if (before.max_price_override >= before.min_price_override) {
        return new Response(JSON.stringify({ message: 'already valid, no change made', row: before }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      // Same convention apply-min-roi uses when min exceeds max: raise max to min + $0.50.
      const newMax = Math.round((before.min_price_override + 0.5) * 100) / 100;
      const { data: after, error } = await supabase
        .from('repricer_assignments')
        .update({ max_price_override: newMax })
        .eq('id', before.id)
        .select('id, asin, sku, marketplace, min_price_override, max_price_override')
        .maybeSingle();
      return new Response(JSON.stringify({ before, after, error: error?.message || null }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (body?.action === 'scan_price_below_min_among_dead') {
      const pageSize = 1000;
      let from = 0;
      const allRows = [];
      while (true) {
        const { data: page, error: pageErr } = await supabase
          .from('repricer_assignments')
          .select('asin, sku, marketplace, created_at, min_price_override, max_price_override, last_applied_price, last_disabled_at, last_disabled_reason, intl_listing_status')
          .eq('user_id', body.user_id)
          .in('marketplace', ['BR', 'MX', 'CA'])
          .eq('is_enabled', false)
          .eq('intl_listing_status', 'NOT_FOUND')
          .not('min_price_override', 'is', null)
          .not('last_applied_price', 'is', null)
          .order('asin', { ascending: true })
          .range(from, from + pageSize - 1);
        if (pageErr) {
          return new Response(JSON.stringify({ error: pageErr.message }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        allRows.push(...(page || []));
        if (!page || page.length < pageSize) break;
        from += pageSize;
      }
      const belowMin = allRows.filter((r) => r.last_applied_price < r.min_price_override);
      const sample = belowMin.slice(0, 25).map((r) => ({
        asin: r.asin, sku: r.sku, marketplace: r.marketplace,
        created_at: r.created_at, last_disabled_at: r.last_disabled_at,
        min_price_override: r.min_price_override, max_price_override: r.max_price_override,
        last_applied_price: r.last_applied_price,
        pct_below_min: r.min_price_override ? Math.round((1 - r.last_applied_price / r.min_price_override) * 1000) / 10 : null,
        last_disabled_reason: r.last_disabled_reason,
      }));
      return new Response(JSON.stringify({
        total_checked: allRows.length,
        below_min_count: belowMin.length,
        below_min_pct: allRows.length ? Math.round((belowMin.length / allRows.length) * 1000) / 10 : 0,
        sample,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (body?.action === 'inspect_assignment_created') {
      const { data, error } = await supabase
        .from('repricer_assignments')
        .select('asin, sku, marketplace, created_at, min_price_override, max_price_override, last_applied_price, rule_id')
        .eq('user_id', body.user_id)
        .eq('asin', body.asin)
        .eq('marketplace', body.marketplace);
      return new Response(JSON.stringify({ rows: data, error: error?.message || null }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (body?.action === 'price_action_history') {
      let q = supabase
        .from('repricer_price_actions')
        .select('created_at, asin, sku, marketplace, old_price, new_price, old_min_price, new_min_price, old_max_price, new_max_price, reason, action_type, error_type, error_message')
        .eq('user_id', body.user_id)
        .eq('asin', body.asin)
        .eq('marketplace', body.marketplace);
      if (body.since) q = q.gte('created_at', body.since);
      if (body.until) q = q.lt('created_at', body.until);
      const { data, error } = await q.order('created_at', { ascending: true }).limit(1000);
      return new Response(JSON.stringify({ count: data?.length || 0, rows: data, error: error?.message || null }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (body?.action === 'run_pricing_suppression_check') {
      const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
      const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
      const resp = await fetch(`${supabaseUrl}/functions/v1/check-pricing-suppression-item`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${serviceKey}` },
        body: JSON.stringify({ user_id: body.user_id, sku: body.sku, marketplace: body.marketplace }),
      });
      const json = await resp.json().catch(() => ({}));
      return new Response(JSON.stringify({ status: resp.status, result: json }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (body?.action === 'inspect_pricing_suppression_flag') {
      const { data, error } = await supabase
        .from('repricer_assignments')
        .select('asin, sku, marketplace, is_enabled, is_pricing_suppression, pricing_suppression_detected_at, is_listing_inactive_not_buyable, intl_listing_status')
        .eq('asin', body.asin)
        .eq('marketplace', body.marketplace);
      return new Response(JSON.stringify({ rows: data, error: error?.message || null }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (body?.action === 'simulate_step7b') {
      const marketplace = body.marketplace;
      const { data: disabledWithStock, error: dwsErr } = await supabase
        .from('repricer_assignments')
        .select('id, asin, sku, rule_id, min_price_override, max_price_override, manual_paused, last_disabled_by, intl_listing_status, marketplace_sellable, is_listing_inactive_not_buyable')
        .eq('user_id', body.user_id)
        .eq('marketplace', marketplace)
        .eq('is_enabled', false);
      if (dwsErr) {
        return new Response(JSON.stringify({ error: dwsErr.message }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const { data: inventory } = await supabase
        .from('inventory')
        .select('asin, sku, available, reserved, inbound')
        .eq('user_id', body.user_id);
      const stockMap = new Map();
      for (const item of inventory || []) {
        if (item.asin && item.sku) {
          const avail = Number(item.available) || 0;
          const reserved = Number(item.reserved) || 0;
          const inbound = Number(item.inbound) || 0;
          if (avail + reserved > 0) stockMap.set(`${item.asin}:${item.sku}`, 'has_stock');
          else if (inbound > 0) stockMap.set(`${item.asin}:${item.sku}`, 'inbound_only');
        }
      }
      const confirmedDead = (da) => {
        if (marketplace === 'US') return false;
        if (da.intl_listing_status === 'NOT_FOUND') return true;
        if (da.marketplace_sellable === false) return true;
        if (da.is_listing_inactive_not_buyable === true) return true;
        return false;
      };
      const target = (disabledWithStock || []).find((r) => r.asin === body.target_asin);
      const results = (disabledWithStock || []).map((da) => {
        const tag = stockMap.get(`${da.asin}:${da.sku}`);
        const configured = !!da.rule_id && da.min_price_override != null && da.max_price_override != null;
        const manuallyPaused = da.manual_paused === true || ['user', 'manual', 'seller', 'owner'].includes(String(da.last_disabled_by || '').toLowerCase());
        const dead = confirmedDead(da);
        const wouldReenable = !!tag && configured && !manuallyPaused && !dead;
        return { asin: da.asin, sku: da.sku, tag, configured, manuallyPaused, dead, intl_listing_status: da.intl_listing_status, marketplace_sellable: da.marketplace_sellable, wouldReenable };
      });
      return new Response(JSON.stringify({
        disabled_candidate_count: disabledWithStock?.length || 0,
        would_reenable_count: results.filter(r => r.wouldReenable).length,
        target_row: target || null,
        target_result: results.find(r => r.asin === body.target_asin) || null,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (body?.action === 'inspect_reenable_audit') {
      const { data, error } = await supabase
        .from('repricer_assignments')
        .select('asin, sku, marketplace, is_enabled, manual_paused, intl_listing_status, marketplace_sellable, is_listing_inactive_not_buyable, last_enabled_by, last_enabled_at, auto_activated_at, auto_activated_by, auto_activated_reason, last_disabled_by, last_disabled_reason, last_disabled_at, updated_at')
        .eq('asin', body.asin)
        .eq('marketplace', body.marketplace);
      return new Response(JSON.stringify({ rows: data, error: error?.message || null }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (body?.action === 'inspect_row_owners') {
      const { data, error } = await supabase
        .from('repricer_assignments')
        .select('user_id, asin, sku, marketplace, is_enabled, sellability_review_hold, updated_at')
        .eq('asin', body.asin)
        .eq('marketplace', body.marketplace);
      return new Response(JSON.stringify({ rows: data, error: error?.message || null }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (body?.action === 'scan_duplicate_assignments') {
      const pageSize = 1000;
      let from = 0;
      const allRows = [];
      while (true) {
        const { data: page, error: pageErr } = await supabase
          .from('repricer_assignments')
          .select('asin, sku, marketplace, is_enabled, sellability_review_hold, intl_listing_status, updated_at')
          .eq('user_id', body.user_id)
          .order('asin', { ascending: true })
          .range(from, from + pageSize - 1);
        if (pageErr) {
          return new Response(JSON.stringify({ error: pageErr.message }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        allRows.push(...(page || []));
        if (!page || page.length < pageSize) break;
        from += pageSize;
      }
      const data = allRows;
      const groups = new Map();
      for (const row of data || []) {
        const key = `${row.asin}::${row.sku}::${row.marketplace}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
      }
      const dupes = [];
      let totalRows = data?.length || 0;
      const marketplaceCounts = {};
      for (const [key, rows] of groups) {
        if (rows.length > 1) {
          dupes.push({ key, rows });
          const mp = rows[0].marketplace;
          marketplaceCounts[mp] = (marketplaceCounts[mp] || 0) + 1;
        }
      }
      return new Response(JSON.stringify({
        total_rows: totalRows,
        total_distinct_keys: groups.size,
        duplicate_key_count: dupes.length,
        marketplace_breakdown: marketplaceCounts,
        duplicates: dupes,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (body?.action === 'clear_stale_lock') {
      const { error: clearErr } = await supabase
        .from('cron_run_locks')
        .delete()
        .eq('job_name', body.job_name);
      return new Response(JSON.stringify({ cleared: true, clearErr: clearErr?.message || null }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (body?.action === 'clear_seller_cache') {
      const { error: clearErr } = await supabase
        .from('keepa_seller_name_cache')
        .delete()
        .in('seller_id', body.seller_ids || [])
        .eq('marketplace', body.marketplace || 'US');
      return new Response(JSON.stringify({ cleared: true, clearErr: clearErr?.message || null }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (body?.action === 'inspect_assignment') {
      const { data: assignRows, error: assignErr } = await supabase
        .from('repricer_assignments')
        .select('asin, marketplace, is_priority, is_manual_priority, last_trigger_source, last_skip_lane, last_data_source, last_skip_reason, last_buybox_price, last_buybox_status, last_recommendation_reason, last_sp_api_check_at, last_evaluated_at, updated_at')
        .eq('asin', body.asin)
        .eq('marketplace', body.marketplace || 'US');
      return new Response(JSON.stringify({ assignment_rows: assignRows, assignErr: assignErr?.message || null }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (body?.action === 'scan_stale_activation_errors') {
      const { data: rows, error } = await supabase
        .from('repricer_assignments')
        .select('asin, sku, marketplace, last_error_type, last_error_message, status, roi_at_min_percent, roi_at_max_percent, min_price_override, max_price_override, updated_at, roi_range_updated_at')
        .eq('user_id', body.user_id)
        .not('last_error_type', 'is', null);
      const CLEARED_TYPES = new Set(['activation_needs_cost', 'activation_price_unavailable', 'activation_bounds_unavailable']);
      const stale = (rows || []).filter((r: any) => CLEARED_TYPES.has(r.last_error_type) && r.roi_at_min_percent != null && r.roi_at_max_percent != null);
      const genuinelyBlocked = (rows || []).filter((r: any) => !(CLEARED_TYPES.has(r.last_error_type) && r.roi_at_min_percent != null && r.roi_at_max_percent != null));
      const errorTypeCounts: Record<string, number> = {};
      for (const r of (rows || [])) errorTypeCounts[r.last_error_type] = (errorTypeCounts[r.last_error_type] || 0) + 1;
      return new Response(JSON.stringify({
        total_with_any_error: rows?.length || 0,
        error_type_counts: errorTypeCounts,
        stale_contradictory_count: stale.length,
        stale_rows: stale,
        genuinely_blocked_or_other_count: genuinelyBlocked.length,
        genuinely_blocked_rows: genuinelyBlocked,
        error: error?.message || null,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (body?.action === 'inspect_suppression_checks') {
      const { data, error } = await supabase
        .from('repricer_pricing_suppression_checks')
        .select('asin, sku, marketplace, http_status, summaries_non_empty, trust_gate_passed, issues_seen, action_taken, notes, checked_at')
        .eq('user_id', body.user_id)
        .in('asin', body.asins || [])
        .order('checked_at', { ascending: false })
        .limit(body.limit || 30);
      return new Response(JSON.stringify({ rows: data, error: error?.message || null }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (body?.action === 'scan_buyable_control') {
      const { data: rows, error } = await supabase
        .from('repricer_assignments')
        .select('asin, sku, marketplace, is_enabled, intl_listing_status, last_applied_price')
        .eq('user_id', body.user_id)
        .eq('marketplace', 'BR')
        .eq('is_enabled', true)
        .not('last_applied_price', 'is', null)
        .not('intl_listing_status', 'is', null);
      const buyable = (rows || []).filter((r: any) => {
        try {
          const parsed = JSON.parse(r.intl_listing_status);
          const statuses = Array.isArray(parsed) ? parsed.map((s: any) => String(s).toUpperCase()) : [];
          return statuses.includes('BUYABLE') || statuses.includes('ACTIVE');
        } catch { return false; }
      });
      return new Response(JSON.stringify({
        total_checked: rows?.length || 0,
        buyable_count: buyable.length,
        buyable_asins: buyable.map((r: any) => r.asin),
        error: error?.message || null,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (body?.action === 'check_real_sales') {
      const asins: string[] = body.asins || [];
      const marketplace = body.marketplace || 'BR';
      const sinceDays = body.since_days ?? 30;
      const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const { data, error } = await supabase
        .from('sales_orders')
        .select('order_id, asin, sku, marketplace, quantity, sold_price, order_date')
        .eq('user_id', body.user_id)
        .eq('marketplace', marketplace)
        .in('asin', asins)
        .gte('order_date', since)
        .order('order_date', { ascending: false });
      const byAsin: Record<string, any[]> = {};
      for (const r of (data || [])) {
        (byAsin[(r as any).asin] ||= []).push(r);
      }
      return new Response(JSON.stringify({
        since_date: since,
        total_orders_found: data?.length || 0,
        by_asin: byAsin,
        checked_asins: asins,
        error: error?.message || null,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (body?.action === 'set_review_hold') {
      const pairs: Array<{ asin: string; marketplace: string }> = body.pairs || [];
      const results: any[] = [];
      for (const p of pairs) {
        const { data, error } = await supabase
          .from('repricer_assignments')
          .update({ sellability_review_hold: true })
          .eq('user_id', body.user_id)
          .eq('asin', p.asin)
          .eq('marketplace', p.marketplace)
          .select('asin, marketplace, sellability_review_hold');
        results.push({ asin: p.asin, marketplace: p.marketplace, updated: data, error: error?.message || null });
      }
      return new Response(JSON.stringify({ results }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (body?.action === 'export_not_buyable_full') {
      const onlyEnabled = body.only_enabled !== false; // default true
      let from = 0;
      const pageSize = 1000;
      const collected: any[] = [];
      for (;;) {
        let q = supabase
          .from('repricer_assignments')
          .select('asin, sku, marketplace, is_enabled, status, intl_listing_status, marketplace_sellability_reason, marketplace_checked_at, last_applied_price, min_price_override, max_price_override, last_evaluated_at')
          .eq('user_id', body.user_id)
          .neq('marketplace', 'US')
          .not('intl_listing_status', 'is', null)
          .neq('intl_listing_status', 'NOT_FOUND')
          .order("id", { ascending: true })
          .range(from, from + pageSize - 1);
        if (onlyEnabled) q = q.eq('is_enabled', true);
        const { data: page, error } = await q;
        if (error) return new Response(JSON.stringify({ error: error.message }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        const rows = page || [];
        for (const r of rows as any[]) {
          let statuses: string[] = [];
          try {
            const parsed = JSON.parse(r.intl_listing_status);
            statuses = Array.isArray(parsed) ? parsed.map((s: any) => String(s).toUpperCase()) : [];
          } catch { statuses = [String(r.intl_listing_status || '').toUpperCase()]; }
          if (statuses.length > 0 && !statuses.includes('BUYABLE') && !statuses.includes('ACTIVE')) {
            collected.push(r);
          }
        }
        if (rows.length < pageSize) break;
        from += pageSize;
        if (from > 20000) break;
      }

      // Last real sale date per (asin, marketplace), via a server-side
      // MAX(order_date) GROUP BY -- NOT a client-side "order desc, take
      // first per key" over a raw select, which silently truncates once a
      // chunk's total matching rows exceed PostgREST's 1000-row cap (a real
      // bug caught during verification: busy ASINs in the same chunk pushed
      // older orders for slower-selling ASINs out of the returned page,
      // making genuinely-sold ASINs read back as "never sold").
      const lastSaleByKey: Record<string, string> = {};
      const uniqueAsins = [...new Set(collected.map((r) => r.asin))];
      for (let i = 0; i < uniqueAsins.length; i += 150) {
        const chunk = uniqueAsins.slice(i, i + 150);
        const { data: sales, error: salesErr } = await supabase.rpc('debug_last_sale_dates', {
          p_user_id: body.user_id,
          p_asins: chunk,
        });
        if (salesErr) console.error('[debug_last_sale_dates] error:', salesErr.message);
        for (const s of (sales || []) as any[]) {
          lastSaleByKey[`${s.asin}::${s.marketplace}`] = s.last_order_date;
        }
      }

      const enriched = collected.map((r) => ({
        asin: r.asin,
        sku: r.sku,
        marketplace: r.marketplace,
        is_enabled: r.is_enabled,
        status: r.status,
        last_applied_price: r.last_applied_price,
        min_price_override: r.min_price_override,
        max_price_override: r.max_price_override,
        marketplace_sellability_reason: r.marketplace_sellability_reason,
        marketplace_checked_at: r.marketplace_checked_at,
        last_evaluated_at: r.last_evaluated_at,
        last_real_sale_date: lastSaleByKey[`${r.asin}::${r.marketplace}`] || null,
      }));

      return new Response(JSON.stringify({
        count: enriched.length,
        rows: enriched,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (body?.action === 'count_not_buyable_total') {
      // Paginate through ALL non-US, non-NOT_FOUND assignments (no 1000 cap)
      // to get the true total, since JSON parsing of intl_listing_status
      // can't be done in SQL directly.
      let from = 0;
      const pageSize = 1000;
      let totalScanned = 0;
      let notBuyableTotal = 0;
      const enabledCount = { true: 0, false: 0 };
      for (;;) {
        const { data: page, error } = await supabase
          .from('repricer_assignments')
          .select('intl_listing_status, is_enabled')
          .eq('user_id', body.user_id)
          .neq('marketplace', 'US')
          .not('intl_listing_status', 'is', null)
          .neq('intl_listing_status', 'NOT_FOUND')
          .order("id", { ascending: true })
          .range(from, from + pageSize - 1);
        if (error) return new Response(JSON.stringify({ error: error.message }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        const rows = page || [];
        totalScanned += rows.length;
        for (const r of rows as any[]) {
          let statuses: string[] = [];
          try {
            const parsed = JSON.parse(r.intl_listing_status);
            statuses = Array.isArray(parsed) ? parsed.map((s: any) => String(s).toUpperCase()) : [];
          } catch { statuses = [String(r.intl_listing_status || '').toUpperCase()]; }
          if (statuses.length > 0 && !statuses.includes('BUYABLE') && !statuses.includes('ACTIVE')) {
            notBuyableTotal++;
            enabledCount[r.is_enabled ? 'true' : 'false']++;
          }
        }
        if (rows.length < pageSize) break;
        from += pageSize;
        if (from > 20000) break; // safety cap
      }
      return new Response(JSON.stringify({
        total_scanned: totalScanned,
        not_buyable_total: notBuyableTotal,
        enabled_true: enabledCount.true,
        enabled_false: enabledCount.false,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (body?.action === 'scan_not_buyable') {
      const { data: rows, error } = await supabase
        .from('repricer_assignments')
        .select('asin, sku, marketplace, is_enabled, status, intl_listing_status, marketplace_sellable, marketplace_sellability_reason, marketplace_checked_at, is_pricing_suppression, min_price_override, max_price_override, last_applied_price')
        .eq('user_id', body.user_id)
        .neq('marketplace', 'US')
        .not('intl_listing_status', 'is', null)
        .neq('intl_listing_status', 'NOT_FOUND');
      const notBuyable = (rows || []).filter((r: any) => {
        let statuses: string[] = [];
        try {
          const parsed = JSON.parse(r.intl_listing_status);
          statuses = Array.isArray(parsed) ? parsed.map((s: any) => String(s).toUpperCase()) : [];
        } catch {
          statuses = [String(r.intl_listing_status || '').toUpperCase()];
        }
        return statuses.length > 0 && !statuses.includes('BUYABLE') && !statuses.includes('ACTIVE');
      });
      return new Response(JSON.stringify({
        total_non_us_checked: rows?.length || 0,
        not_buyable_count: notBuyable.length,
        not_buyable_rows: notBuyable,
        error: error?.message || null,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (body?.action === 'inspect_inventory_row') {
      const { data, error } = await supabase
        .from('inventory')
        .select('*')
        .eq('sku', body.sku);
      return new Response(JSON.stringify({ inventory_rows: data, error: error?.message || null }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (body?.action === 'inspect_refresh_queue') {
      const { data, error } = await supabase
        .from('inventory_refresh_queue')
        .select('*')
        .eq('sku', body.sku)
        .order('created_at', { ascending: false })
        .limit(20);
      return new Response(JSON.stringify({ queue_rows: data, error: error?.message || null }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (body?.action === 'inspect_missing_review') {
      const { data, error } = await supabase
        .from('inventory_missing_review')
        .select('*')
        .eq('sku', body.sku)
        .order('last_missing_at', { ascending: false });
      return new Response(JSON.stringify({ missing_review_rows: data, error: error?.message || null }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (body?.action === 'inspect_suppression') {
      const { data, error } = await supabase
        .from('repricer_assignments')
        .select('asin, sku, marketplace, is_pricing_suppression, pricing_suppression_raw_code, pricing_suppression_raw_message, pricing_suppression_categories, pricing_suppression_severity, pricing_suppression_detected_at, pricing_suppression_pending_clear_at, listing_issue_unknown_flagged, listing_issue_unknown_categories, intl_listing_status, updated_at')
        .eq('asin', body.asin);
      return new Response(JSON.stringify({ rows: data, error: error?.message || null }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (body?.action === 'inspect_cost_state') {
      const asin = body.asin;
      const [assignRes, invRes, costMemRes, listingsRes] = await Promise.all([
        supabase.from('repricer_assignments')
          .select('asin, sku, marketplace, user_id, is_enabled, status, rule_id, min_price_override, max_price_override, roi_at_min_percent, roi_at_max_percent, last_error_type, last_error_message, last_applied_price, consecutive_failures, updated_at, amazon_bounds_synced_at')
          .eq('asin', asin),
        supabase.from('inventory')
          .select('asin, sku, cost, amount, units, my_price, price, amazon_price')
          .eq('asin', asin),
        supabase.from('mobile_scan_cost_memory')
          .select('asin, total_cost, units, sale_price_override, updated_at')
          .eq('asin', asin),
        supabase.from('created_listings')
          .select('asin, sku, cost, amount, units, price')
          .eq('asin', asin),
      ]);
      return new Response(JSON.stringify({
        assignment_rows: assignRes.data, assignErr: assignRes.error?.message || null,
        inventory_rows: invRes.data, invErr: invRes.error?.message || null,
        cost_memory_rows: costMemRes.data, costMemErr: costMemRes.error?.message || null,
        created_listings_rows: listingsRes.data, listingsErr: listingsRes.error?.message || null,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (body?.action === 'inspect_actions') {
      const { data: actionRows, error: actionErr } = await supabase
        .from('repricer_price_actions')
        .select('*')
        .eq('asin', body.asin)
        .eq('marketplace', body.marketplace || 'US')
        .order('created_at', { ascending: false })
        .limit(10);
      return new Response(JSON.stringify({ action_rows: actionRows, actionErr: actionErr?.message || null }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (body?.action === 'inspect_rate_limit') {
      const sinceMinutes2 = body?.since_minutes ?? 60;
      const since2 = new Date(Date.now() - sinceMinutes2 * 60 * 1000).toISOString();
      const { data: rateRows, error: rateErr } = await supabase
        .from('sp_api_rate_limit_state')
        .select('*')
        .gte('last_called_at', since2)
        .order('last_called_at', { ascending: false })
        .limit(50);
      return new Response(JSON.stringify({ rate_rows: rateRows, rateErr: rateErr?.message || null }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (body?.action === 'hourly_health') {
      const sinceMinutes3 = body?.since_minutes ?? 60;
      const since3 = new Date(Date.now() - sinceMinutes3 * 60 * 1000).toISOString();
      const userId = body.user_id;

      const { data: actions, error: actionsErr } = await supabase
        .from('repricer_price_actions')
        .select('asin, sku, marketplace, action_type, old_price, new_price, reason, created_at, trigger_source')
        .eq('user_id', userId)
        .gte('created_at', since3)
        .order('created_at', { ascending: false })
        .limit(1000);

      const { data: assignments, error: assignErr } = await supabase
        .from('repricer_assignments')
        .select('asin, marketplace, last_data_source, last_evaluated_at, oscillation_state, last_error_message, status, is_priority, last_recommendation_reason')
        .eq('user_id', userId)
        .gte('last_evaluated_at', since3)
        .limit(3000);

      const actionTypeCounts: Record<string, number> = {};
      const errorActionRows: any[] = [];
      for (const a of (actions || [])) {
        actionTypeCounts[a.action_type] = (actionTypeCounts[a.action_type] || 0) + 1;
        if (a.action_type === 'error') errorActionRows.push(a);
      }

      const dataSourceCounts: Record<string, number> = {};
      const oscillationCounts: Record<string, number> = {};
      const errorAssignments: any[] = [];
      for (const a of (assignments || [])) {
        const ds = a.last_data_source || 'null';
        dataSourceCounts[ds] = (dataSourceCounts[ds] || 0) + 1;
        const osc = a.oscillation_state || 'null';
        oscillationCounts[osc] = (oscillationCounts[osc] || 0) + 1;
        if (a.last_error_message) errorAssignments.push(a);
      }

      return new Response(JSON.stringify({
        window_minutes: sinceMinutes3,
        total_actions: actions?.length || 0,
        distinct_asins_actioned: new Set((actions || []).map((a: any) => a.asin)).size,
        action_type_counts: actionTypeCounts,
        error_action_rows: errorActionRows,
        total_assignments_evaluated: assignments?.length || 0,
        data_source_counts: dataSourceCounts,
        oscillation_state_counts: oscillationCounts,
        assignments_with_error_message: errorAssignments,
        actionsErr: actionsErr?.message || null,
        assignErr: assignErr?.message || null,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (body?.action === 'action_type_breakdown') {
      const sinceMinutes5 = body?.since_minutes ?? 60;
      const since5 = new Date(Date.now() - sinceMinutes5 * 60 * 1000).toISOString();
      const types = ['no_change', 'price_changed', 'price_change_failed', 'oscillation_guard', 'reposition_mode_active', 'minmax_change', 'price_and_minmax_change', 'error'];
      const counts: Record<string, number> = {};
      for (const t of types) {
        const { count } = await supabase
          .from('repricer_price_actions')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', body.user_id)
          .eq('action_type', t)
          .gte('created_at', since5);
        counts[t] = count || 0;
      }
      const { count: totalCount } = await supabase
        .from('repricer_price_actions')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', body.user_id)
        .gte('created_at', since5);
      return new Response(JSON.stringify({ window_minutes: sinceMinutes5, total: totalCount, counts }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (body?.action === 'inspect_action_types') {
      const sinceMinutes4 = body?.since_minutes ?? 60;
      const since4 = new Date(Date.now() - sinceMinutes4 * 60 * 1000).toISOString();
      const { count, error: countErr } = await supabase
        .from('repricer_price_actions')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', body.user_id)
        .gte('created_at', since4);

      const { data: rows, error: rowsErr } = await supabase
        .from('repricer_price_actions')
        .select('asin, sku, marketplace, action_type, old_price, new_price, reason, created_at')
        .eq('user_id', body.user_id)
        .eq('action_type', body.action_type)
        .gte('created_at', since4)
        .order('created_at', { ascending: false })
        .limit(20);

      return new Response(JSON.stringify({
        total_count: count,
        countErr: countErr?.message || null,
        rows,
        rowsErr: rowsErr?.message || null,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (body?.action === 'check_lock') {
      const { data: lockRows, error: lockErr } = await supabase
        .from('cron_run_locks')
        .select('*')
        .eq('job_name', body.job_name);
      return new Response(JSON.stringify({ lock_rows: lockRows, lockErr: lockErr?.message || null }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const sinceMinutes = body?.since_minutes ?? 45;
    const since = new Date(Date.now() - sinceMinutes * 60 * 1000).toISOString();

    const { data: load, error: loadErr } = await supabase
      .from('system_load_snapshot')
      .select('captured_at, active_connections, waiting_queries, avg_query_ms_5m')
      .gte('captured_at', since)
      .order('captured_at', { ascending: true });

    const spikes = (load || []).filter((r: any) => r.active_connections > 8 || r.waiting_queries > 0);

    return new Response(JSON.stringify({
      window_minutes: sinceMinutes,
      total_rows: load?.length || 0,
      loadErr: loadErr?.message || null,
      max_active_connections: load?.length ? Math.max(...load.map((r: any) => r.active_connections)) : null,
      max_waiting_queries: load?.length ? Math.max(...load.map((r: any) => r.waiting_queries)) : null,
      spikes,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message, stack: e.stack }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
