// Cron fan-out: enumerate active users with inventory rows and invoke
// refresh-inventory-valuation-summary for each, with an 800ms delay
// between invocations (project-wide edge-function rate-limit rule).

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

  // "Active" = at least one inventory row updated in the last 7 days.
  // Keeps the fan-out small; users who haven't synced in a week skip.
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const userIds = new Set<string>();

  // Pull distinct user_ids in pages.
  let from = 0; const PAGE = 1000;
  for (let i = 0; i < 50; i += 1) {
    const { data, error } = await admin
      .from("inventory")
      .select("user_id, updated_at")
      .gte("updated_at", since)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) { console.error("active-user enumeration error", error); break; }
    if (!data || data.length === 0) break;
    for (const r of data) if (r.user_id) userIds.add(r.user_id as string);
    if (data.length < PAGE) break;
    from += PAGE;
  }

  const invokeUrl = `${supabaseUrl}/functions/v1/refresh-inventory-valuation-summary`;
  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${serviceKey}`,
  };

  let ok = 0, skipped = 0, failed = 0;
  for (const uid of userIds) {
    try {
      const res = await fetch(invokeUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ user_id: uid, source: "cron", caller: "cron" }),
      });
      if (res.ok) {
        const j = await res.json().catch(() => ({}));
        if (j?.skipped) skipped += 1; else ok += 1;
      } else {
        failed += 1;
      }
    } catch (e) {
      failed += 1;
      console.error("invoke failed for", uid, e);
    }
    await new Promise((r) => setTimeout(r, 800));
  }

  return new Response(
    JSON.stringify({ ok: true, users: userIds.size, refreshed: ok, skipped, failed }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
