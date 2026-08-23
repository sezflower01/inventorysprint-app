// auto-sync-dispositions-daily
// Daily fan-out: invokes sync-amazon-dispositions for every user with an Amazon connection.
// Scheduled via pg_cron. Uses 800ms inter-call delay to respect Supabase rate limits.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const INTER_CALL_DELAY_MS = 800;
const DEFAULT_DAYS_BACK = 7; // daily run only needs to look back a week (with overlap)

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  const startedAt = Date.now();
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, serviceKey);

  try {
    // seller_authorizations, NOT amazon_connections. There is no
    // amazon_connections table in this database and there never has been, so
    // this threw on the very first statement and the whole job aborted --
    // dispositions have never synced for any user. The only outward trace was
    // 'relation "public.amazon_connections" does not exist' in the Postgres log
    // at 08:15, when cron jobid 35 (auto-sync-dispositions-daily,
    // "15 8 * * *") fires.
    const { data: connections, error: connErr } = await supabase
      .from('seller_authorizations')
      .select('user_id, refresh_token, marketplace_id, is_active')
      .not('refresh_token', 'is', null);

    if (connErr) throw connErr;

    // ⚠️ ONE CALL PER USER, NOT PER MARKETPLACE.
    //
    // amazon_connections was evidently one row per user -- the loop below
    // defaults marketplace_id to ATVPDKIKX0DER when absent. seller_authorizations
    // is one row per (seller_id, marketplace_id), so a seller authorised in
    // US/CA/MX/BR yields four rows. Iterating them directly would quadruple
    // SP-API calls the first time this job ever succeeds, which is not a change
    // to make silently on a job that has never run.
    //
    // Prefer the US row, since that is the marketplace the original default
    // named; fall back to whatever the user has.
    const byUser = new Map<string, any>();
    for (const c of (connections || [])) {
      if (!c.refresh_token) continue;
      // Explicitly revoked authorizations are skipped; is_active is null on
      // older rows, so only an explicit false excludes.
      if (c.is_active === false) continue;
      const prev = byUser.get(c.user_id);
      if (!prev || (c.marketplace_id === 'ATVPDKIKX0DER' && prev.marketplace_id !== 'ATVPDKIKX0DER')) {
        byUser.set(c.user_id, c);
      }
    }
    const targets = [...byUser.values()];
    console.log(`[DISPO-DAILY] Found ${targets.length} connected users`);

    const stats = {
      total_users: targets.length,
      succeeded: 0,
      failed: 0,
      total_inserted: 0,
      total_skipped: 0,
      total_errors: 0,
      sample_failures: [] as Array<{ user_id: string; error: string }>,
    };

    for (const conn of targets) {
      try {
        const r = await fetch(`${supabaseUrl}/functions/v1/sync-amazon-dispositions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${serviceKey}`,
          },
          body: JSON.stringify({
            user_id: conn.user_id,
            refresh_token: conn.refresh_token,
            marketplace_id: conn.marketplace_id || 'ATVPDKIKX0DER',
            days_back: DEFAULT_DAYS_BACK,
          }),
        });

        const txt = await r.text();
        if (!r.ok) {
          stats.failed += 1;
          if (stats.sample_failures.length < 5) {
            stats.sample_failures.push({ user_id: conn.user_id, error: `${r.status}: ${txt.slice(0, 200)}` });
          }
          console.error(`[DISPO-DAILY] User ${conn.user_id} failed: ${r.status} ${txt.slice(0, 200)}`);
        } else {
          let body: any = {};
          try { body = JSON.parse(txt); } catch { /* */ }
          stats.succeeded += 1;
          stats.total_inserted += body.inserted || 0;
          stats.total_skipped += body.skipped_duplicates || 0;
          stats.total_errors += body.errors || 0;
        }
      } catch (e: any) {
        stats.failed += 1;
        if (stats.sample_failures.length < 5) {
          stats.sample_failures.push({ user_id: conn.user_id, error: String(e?.message || e) });
        }
      }

      // Rate-limit guard: 800ms between edge-function calls
      await new Promise((res) => setTimeout(res, INTER_CALL_DELAY_MS));
    }

    const elapsed_ms = Date.now() - startedAt;
    console.log(`[DISPO-DAILY] Completed in ${elapsed_ms}ms`, stats);

    return new Response(JSON.stringify({ success: true, elapsed_ms, ...stats }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e: any) {
    console.error('[DISPO-DAILY] fatal', e);
    return new Response(JSON.stringify({ success: false, error: String(e?.message || e) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
