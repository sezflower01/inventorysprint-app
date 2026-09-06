// Admin-only one-click VACUUM FULL via direct DB connection.
// Runs OUTSIDE Supabase SQL Editor's transaction wrapper so VACUUM FULL works.
// Logs before/after size to database_maintenance_jobs.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { Client } from 'https://deno.land/x/postgres@v0.19.3/mod.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const ALLOWED_TABLES = new Set([
  'public.repricer_price_actions',
  'cron.job_run_details',
]);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return json({ error: 'Unauthorized' }, 401);
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const dbUrl = Deno.env.get('DB_DIRECT_URL');

    if (!dbUrl) {
      return json({ error: 'DB_DIRECT_URL secret is not configured' }, 500);
    }

    // Verify caller is admin
    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return json({ error: 'Unauthorized' }, 401);
    const userId = userData.user.id;
    const userEmail = userData.user.email ?? null;

    const admin = createClient(supabaseUrl, serviceKey);
    const { data: isAdmin } = await admin.rpc('has_role', { _user_id: userId, _role: 'admin' });
    if (!isAdmin) return json({ error: 'Admin only' }, 403);

    const body = await req.json().catch(() => ({}));
    const action = body.action ?? 'run';

    // Status query for polling
    if (action === 'status') {
      const jobId = body.job_id;
      if (!jobId) return json({ error: 'job_id required' }, 400);
      const { data, error } = await admin
        .from('database_maintenance_jobs')
        .select('id, action, status, started_at, finished_at, duration_ms, before_total_bytes, after_total_bytes, error_message')
        .eq('id', jobId)
        .maybeSingle();
      if (error) return json({ error: error.message }, 500);
      return json({ job: data });
    }

    // Run VACUUM FULL
    const table = body.table as string;
    const confirm = body.confirm as string;

    if (confirm !== 'CONFIRM VACUUM FULL') {
      return json({ error: 'Missing or invalid confirmation phrase' }, 400);
    }
    if (!table || !ALLOWED_TABLES.has(table)) {
      return json({ error: `Table not allowed. Allowed: ${[...ALLOWED_TABLES].join(', ')}` }, 400);
    }

    // Insert job row with status='running'
    const actionName = `vacuum_full:${table}`;
    const { data: jobRow, error: jobErr } = await admin
      .from('database_maintenance_jobs')
      .insert({
        action: actionName,
        status: 'running',
        triggered_by: userId,
        triggered_by_email: userEmail,
        started_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    if (jobErr || !jobRow) return json({ error: jobErr?.message ?? 'Failed to create job' }, 500);
    const jobId = jobRow.id;

    // Background work
    const work = async () => {
      const startedAt = Date.now();
      const client = new Client(dbUrl);
      let beforeBytes: number | null = null;
      let afterBytes: number | null = null;
      try {
        await client.connect();

        // Lift the statement timeout BEFORE the vacuum.
        //
        // This connection inherits a ~2 minute ceiling. That was invisible
        // while the tables were small -- 2026-05-12 reclaimed
        // repricer_price_actions from 2,938 MB to 214 MB in 24.9s -- but the
        // table is 7,022 MB now, and 2026-09-06 died at 132.5s with
        // "canceling statement due to statement timeout", having reclaimed
        // nothing. VACUUM FULL rewrites the heap AND rebuilds every index
        // (thirteen here, 1,106 MB of them), so the work grows with the table
        // while the ceiling does not.
        //
        // 30 minutes rather than 0: this is a deliberate admin action behind a
        // typed confirmation, but an unbounded statement holding an ACCESS
        // EXCLUSIVE lock is a worse failure than a slow one that ends.
        await client.queryArray(`SET statement_timeout = '30min'`);

        // Fail fast if the lock cannot be taken, instead of queueing behind a
        // writer and blocking every other writer that arrives meanwhile.
        // VACUUM FULL needs ACCESS EXCLUSIVE, so anything still writing to the
        // table will block it -- pause the repricer first and this returns
        // promptly with a clear error rather than stalling the table.
        await client.queryArray(`SET lock_timeout = '60s'`);

        const sizeRes1 = await client.queryObject<{ b: bigint }>(
          `SELECT pg_total_relation_size('${table}'::regclass)::bigint AS b`
        );
        beforeBytes = Number(sizeRes1.rows[0]?.b ?? 0);

        // VACUUM cannot run inside a transaction. The deno-postgres driver
        // sends each queryArray as its own simple query, so this works.
        await client.queryArray(`VACUUM (FULL, ANALYZE) ${table}`);

        const sizeRes2 = await client.queryObject<{ b: bigint }>(
          `SELECT pg_total_relation_size('${table}'::regclass)::bigint AS b`
        );
        afterBytes = Number(sizeRes2.rows[0]?.b ?? 0);

        await admin
          .from('database_maintenance_jobs')
          .update({
            status: 'completed',
            finished_at: new Date().toISOString(),
            duration_ms: Date.now() - startedAt,
            before_total_bytes: beforeBytes,
            after_total_bytes: afterBytes,
          })
          .eq('id', jobId);

        // Refresh stale alerts now that DB has shrunk
        try { await admin.rpc('evaluate_health_alerts'); } catch { /* non-fatal */ }
        // Capture a fresh snapshot so growth math re-baselines immediately
        try { await admin.rpc('capture_database_size_snapshot'); } catch { /* non-fatal */ }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[admin-vacuum-full] ${table} failed:`, msg);
        await admin
          .from('database_maintenance_jobs')
          .update({
            status: 'failed',
            finished_at: new Date().toISOString(),
            duration_ms: Date.now() - startedAt,
            before_total_bytes: beforeBytes,
            after_total_bytes: afterBytes,
            error_message: msg,
          })
          .eq('id', jobId);
      } finally {
        try { await client.end(); } catch { /* ignore */ }
      }
    };

    // @ts-ignore EdgeRuntime is global in Supabase Edge Functions
    if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime.waitUntil) {
      // @ts-ignore
      EdgeRuntime.waitUntil(work());
    } else {
      // Fallback: fire-and-forget
      work();
    }

    return json({ ok: true, job_id: jobId, table, status: 'running' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ error: msg }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
