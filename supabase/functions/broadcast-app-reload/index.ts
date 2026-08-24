import { requireInternalCall } from '../_shared/require-internal.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-internal-secret',
};

/**
 * Tells every connected browser tab that a newer build is live.
 *
 * WHY THIS EXISTS
 * ---------------
 * Deploying a frontend fix does not deliver it. A tab left open keeps running
 * the bundle it downloaded when it was opened, forever. On 2026-08-23 a fix for
 * a query scanning 64,421 rows was live for over twelve hours while three
 * machines in different locations kept running the previous bundle, firing the
 * old query every 15 minutes until the PostgREST connection pool was exhausted
 * and the app froze. The only remedy was visiting each machine in person.
 *
 * The client half is src/components/AppVersionGate.tsx, which decides whether
 * to reload silently, reload once the tab is backgrounded, or prompt -- it
 * never discards in-progress edits. This function is only the trigger.
 *
 * WHY HTTP AND NOT A REALTIME CLIENT
 * ----------------------------------
 * Supabase Realtime exposes an HTTP broadcast endpoint. Using it avoids
 * opening, awaiting and tearing down a websocket inside a short-lived edge
 * function -- a subscribe() that never reaches SUBSCRIBED would otherwise hang
 * the invocation until timeout, and the failure mode would be a deploy
 * notification that silently never sends.
 *
 * USAGE
 *   curl -X POST "$SUPABASE_URL/functions/v1/broadcast-app-reload" \
 *     -H "x-internal-secret: $INTERNAL_SYNC_SECRET" \
 *     -H "content-type: application/json" \
 *     -d '{"buildId":"<git sha, first 12>"}'
 *
 * buildId must match what vite.config.ts baked into the new bundle
 * (VERCEL_GIT_COMMIT_SHA sliced to 12). Clients compare it against their own
 * and ignore a broadcast whose id equals theirs, so re-sending is harmless and
 * sending a stale id is a no-op rather than a reload loop.
 */

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const forbidden = requireInternalCall(req);
  if (forbidden) return forbidden;

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    const body = await req.json().catch(() => ({}));
    const buildId = String(body?.buildId ?? '').trim();

    // Refuse rather than broadcast an empty id. A client receiving one ignores
    // it (see AppVersionGate), so an empty send would look like success while
    // reaching nobody -- exactly the silent no-op this function exists to
    // prevent.
    if (!buildId) return json({ error: 'buildId is required' }, 400);

    const res = await fetch(`${SUPABASE_URL}/realtime/v1/api/broadcast`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
      },
      body: JSON.stringify({
        messages: [
          {
            topic: 'app-version',
            event: 'reload',
            payload: { buildId, sentAt: new Date().toISOString() },
          },
        ],
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`[broadcast-app-reload] realtime ${res.status}: ${text.slice(0, 300)}`);
      return json({ error: `realtime broadcast failed: ${res.status}`, detail: text.slice(0, 300) }, 502);
    }

    console.log(`[broadcast-app-reload] announced buildId=${buildId}`);
    return json({ ok: true, buildId });
  } catch (e) {
    console.error('[broadcast-app-reload] failed', e);
    return json({ error: (e as Error).message }, 500);
  }
});
