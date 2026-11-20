// Cron fan-out: enumerate users with sales in the last 7 days and invoke
// refresh-live-sales-summary for each, with 800ms delay (project rate-limit rule).
//
// NOT SCHEDULED YET — manual invocation only until parity is confirmed.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  const days = Number(body.days) > 0 ? Number(body.days) : 7;

  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const userIds = new Set<string>();
  let from = 0; const PAGE = 1000;
  for (let i = 0; i < 50; i += 1) {
    const { data, error } = await admin.from("sales_orders")
      .select("user_id, order_date")
      .gte("order_date", since)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) { console.error("user enumeration error", error); break; }
    if (!data || data.length === 0) break;
    for (const r of data) if ((r as any).user_id) userIds.add((r as any).user_id);
    if (data.length < PAGE) break;
    from += PAGE;
  }

  const invokeUrl = `${supabaseUrl}/functions/v1/refresh-live-sales-summary`;
  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${serviceKey}`,
  };

  let ok = 0, failed = 0;
  const errors: any[] = [];
  for (const uid of userIds) {
    try {
      const res = await fetch(invokeUrl, {
        method: "POST", headers,
        body: JSON.stringify({ user_id: uid, source: "cron", caller: "cron", days }),
      });
      if (res.ok) ok += 1;
      else { failed += 1; errors.push({ uid, status: res.status }); }
    } catch (e) {
      failed += 1;
      errors.push({ uid, err: String((e as any)?.message || e) });
    }
    await new Promise(r => setTimeout(r, 800));
  }

  return new Response(JSON.stringify({ ok: true, users: userIds.size, refreshed: ok, failed, errors: errors.slice(0, 10) }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
