// Admin / owner-only SP-API credential manager.
// Actions:
//   POST { action: 'save', user_id?, lwa_client_id?, lwa_client_secret?, refresh_token?, region?, marketplace? }
//   POST { action: 'test', user_id? }   -> calls Amazon LWA + Sellers API
// All requests must come from an authenticated user. Admins may target any user_id.
// Plain secrets are never returned. Test results are persisted via record_spapi_test_result.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { raiseSpapiAlert, resolveSpapiAlerts } from "../_shared/spapi-alert.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SP_API_HOSTS: Record<string, string> = {
  na: "https://sellingpartnerapi-na.amazon.com",
  eu: "https://sellingpartnerapi-eu.amazon.com",
  fe: "https://sellingpartnerapi-fe.amazon.com",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Trim on the way in as well as in the UI. Two reasons: this endpoint is also
// reachable by anything else that posts to it, and a stray newline copied out
// of Seller Central is indistinguishable from a wrong secret once Amazon has
// answered "Client authentication failed" -- so the guard belongs on the side
// that does the storing, not only on the side that happened to collect it.
const cleanCred = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
};

async function getLWAToken(refreshToken: string, clientId: string, clientSecret: string) {
  const r = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  const text = await r.text();
  if (!r.ok) {
    let parsed: any = {};
    try { parsed = JSON.parse(text); } catch { /* ignore */ }
    throw new Error(
      parsed?.error_description ||
      parsed?.error ||
      `LWA ${r.status}: ${text.slice(0, 200)}`
    );
  }
  return JSON.parse(text).access_token as string;
}

async function getSellerInfo(accessToken: string, region: string) {
  const host = SP_API_HOSTS[region] ?? SP_API_HOSTS.na;
  const r = await fetch(`${host}/sellers/v1/marketplaceParticipations`, {
    headers: {
      "x-amz-access-token": accessToken,
      "Content-Type": "application/json",
    },
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`Sellers API ${r.status}: ${text.slice(0, 300)}`);
  }
  const data = JSON.parse(text);
  const list = data?.payload ?? [];
  const sellerId =
    list[0]?.participation?.merchantId ||
    list[0]?.marketplaceParticipation?.merchantId ||
    null;
  const marketplaces = list.map((p: any) => ({
    id: p?.marketplace?.id,
    countryCode: p?.marketplace?.countryCode,
    name: p?.marketplace?.name,
  }));
  return { sellerId, marketplaces };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const authHeader = req.headers.get("Authorization") || "";
    if (!authHeader.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);

    // Identify caller
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return json({ error: "unauthorized" }, 401);
    const callerId = userData.user.id;

    const body = await req.json().catch(() => ({}));
    const action = String(body?.action || "").toLowerCase();
    const targetUserId: string = body?.user_id || callerId;

    // Admin check (RPC enforces too, but fail fast here)
    if (targetUserId !== callerId) {
      const { data: isAdmin } = await userClient.rpc("has_role", {
        _user_id: callerId, _role: "admin",
      });
      if (!isAdmin) return json({ error: "forbidden" }, 403);
    }

    // Service-role client for privileged RPCs (decrypt + record)
    const admin = createClient(supabaseUrl, serviceKey);

    if (action === "save") {
      // Use the caller's auth context so the RPC's auth.uid() matches
      const { error } = await userClient.rpc("save_spapi_credentials", {
        p_user_id: targetUserId,
        p_lwa_client_id: cleanCred(body?.lwa_client_id),
        p_lwa_client_secret: cleanCred(body?.lwa_client_secret),
        p_refresh_token: cleanCred(body?.refresh_token),
        p_region: body?.region ?? "na",
        p_marketplace: body?.marketplace ?? "US",
      });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    if (action === "delete") {
      // Hard-delete the stored row for this user.
      const { error: delErr } = await admin
        .from("user_spapi_credentials")
        .delete()
        .eq("user_id", targetUserId);
      if (delErr) return json({ error: delErr.message }, 400);
      // Also clear any open alerts.
      try { await resolveSpapiAlerts({ userId: targetUserId, userEmail: null }); } catch {}
      return json({ ok: true, deleted: true });
    }

    if (action === "test") {
      // Allow inline credential testing (before save) — fall back to stored if not provided
      let clientId: string | null = body?.lwa_client_id ?? null;
      let clientSecret: string | null = cleanCred(body?.lwa_client_secret);
      let refreshTok: string | null = body?.refresh_token ?? null;
      let regionForTest: string = body?.region ?? "na";

      if (!clientId || !clientSecret || !refreshTok) {
        // Decrypt stored credentials
        const { data: rows, error: decErr } = await admin.rpc(
          "get_spapi_credentials_decrypted",
          { p_user_id: targetUserId },
        );
        if (decErr) return json({ error: decErr.message }, 400);
        const c = (rows as any[])?.[0];
        clientId = clientId || c?.lwa_client_id || null;
        clientSecret = clientSecret || c?.lwa_client_secret || null;
        refreshTok = refreshTok || c?.refresh_token || null;
        regionForTest = body?.region || c?.region || "na";
      }

      if (!clientId || !clientSecret || !refreshTok) {
        await admin.rpc("record_spapi_test_result", {
          p_user_id: targetUserId,
          p_status: "error",
          p_error: "Missing credentials — please save Client ID, Secret, and Refresh Token first.",
          p_seller_id: null,
          p_marketplaces: null,
        });
        // Resolve email + notify admin
        let preEmail: string | null = null;
        try {
          const { data: u } = await admin.auth.admin.getUserById(targetUserId);
          preEmail = u?.user?.email ?? null;
        } catch {}
        await raiseSpapiAlert({
          userId: targetUserId,
          userEmail: preEmail,
          errorMessage: "Missing credentials — Client ID, Secret, or Refresh Token not stored.",
          source: "spapi-credentials/test",
        });
        return json({
          ok: false,
          status: "error",
          error: "Missing credentials. Save Client ID, Secret, and Refresh Token first.",
        });
      }

      const c = { lwa_client_id: clientId, lwa_client_secret: clientSecret, refresh_token: refreshTok, region: regionForTest };

      // Resolve user email once for alert messages
      let userEmail: string | null = null;
      try {
        const { data: u } = await admin.auth.admin.getUserById(targetUserId);
        userEmail = u?.user?.email ?? null;
      } catch {}

      try {
        const token = await getLWAToken(c.refresh_token, c.lwa_client_id, c.lwa_client_secret);
        const info = await getSellerInfo(token, c.region || "na");
        await admin.rpc("record_spapi_test_result", {
          p_user_id: targetUserId,
          p_status: "ok",
          p_error: null,
          p_seller_id: info.sellerId,
          p_marketplaces: info.marketplaces,
        });
        // Clear any open alerts
        await resolveSpapiAlerts({ userId: targetUserId, userEmail });
        return json({
          ok: true,
          status: "ok",
          sellerId: info.sellerId,
          marketplaces: info.marketplaces,
        });
      } catch (e: any) {
        const msg = String(e?.message || e);
        await admin.rpc("record_spapi_test_result", {
          p_user_id: targetUserId,
          p_status: "error",
          p_error: msg,
          p_seller_id: null,
          p_marketplaces: null,
        });
        // Notify admin immediately
        await raiseSpapiAlert({
          userId: targetUserId,
          userEmail,
          errorMessage: msg,
          source: "spapi-credentials/test",
        });
        return json({ ok: false, status: "error", error: msg });
      }
    }

    return json({ error: "unknown action" }, 400);
  } catch (e: any) {
    return json({ error: String(e?.message || e) }, 500);
  }
});
