import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logHealthSignal, HealthSignals } from "../_shared/health-signal.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// AWS SigV4 signing helper for SP-API (GET only here)
async function spApiSignedFetch(params: {
  method: string;
  path: string;
  queryParams?: string;
  accessToken: string;
  bodyString?: string;
}): Promise<Response> {
  const { method, path, queryParams = "", accessToken, bodyString } = params;

  const awsAccessKeyId = Deno.env.get("AWS_ACCESS_KEY_ID");
  const awsSecretAccessKey = Deno.env.get("AWS_SECRET_ACCESS_KEY");
  const awsRegion = Deno.env.get("SPAPI_AWS_REGION") || "us-east-1";

  if (!awsAccessKeyId || !awsSecretAccessKey) {
    throw new Error("AWS credentials not configured");
  }

  const host = "sellingpartnerapi-na.amazon.com";
  const service = "execute-api";
  const url = `https://${host}${path}${queryParams ? `?${queryParams}` : ""}`;

  const timestamp = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = timestamp.slice(0, 8);

  const encoder = new TextEncoder();
  const canonicalHeaders = `host:${host}\nx-amz-date:${timestamp}\n`;
  const signedHeaders = "host;x-amz-date";

  const payload = bodyString ?? "";
  const payloadHash = await crypto.subtle.digest("SHA-256", encoder.encode(payload));
  const payloadHashHex = Array.from(new Uint8Array(payloadHash))
    .map((b) => b.toString(16).padStart(2, "0")).join("");

  const canonicalRequest = `${method}\n${path}\n${queryParams}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHashHex}`;
  const canonicalRequestHash = await crypto.subtle.digest("SHA-256", encoder.encode(canonicalRequest));
  const canonicalRequestHashHex = Array.from(new Uint8Array(canonicalRequestHash))
    .map((b) => b.toString(16).padStart(2, "0")).join("");

  const credentialScope = `${date}/${awsRegion}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${canonicalRequestHashHex}`;

  const hmacSha256 = async (key: ArrayBuffer | Uint8Array, data: Uint8Array) => {
    const cryptoKey = await crypto.subtle.importKey("raw", key as any, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return await crypto.subtle.sign("HMAC", cryptoKey, data as any);
  };

  const getSignatureKey = async (key: string, dateStamp: string, regionName: string, serviceName: string) => {
    const kDate = await hmacSha256(encoder.encode("AWS4" + key), encoder.encode(dateStamp));
    const kRegion = await hmacSha256(kDate, encoder.encode(regionName));
    const kService = await hmacSha256(kRegion, encoder.encode(serviceName));
    return await hmacSha256(kService, encoder.encode("aws4_request"));
  };

  const signingKey = await getSignatureKey(awsSecretAccessKey, date, awsRegion, service);
  const signature = await hmacSha256(signingKey, encoder.encode(stringToSign));
  const signatureHex = Array.from(new Uint8Array(signature)).map((b) => b.toString(16).padStart(2, "0")).join("");

  const authorizationHeader = `AWS4-HMAC-SHA256 Credential=${awsAccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signatureHex}`;

  return await fetch(url, {
    method,
    headers: {
      Authorization: authorizationHeader,
      "x-amz-access-token": accessToken,
      "x-amz-date": timestamp,
      host,
      ...(bodyString ? { "Content-Type": "application/json" } : {}),
    },
    ...(bodyString ? { body: bodyString } : {}),
  });
}

async function getAccessToken(refreshToken: string): Promise<string> {
  const clientId = Deno.env.get("LWA_CLIENT_ID") ?? Deno.env.get("SPAPI_LWA_CLIENT_ID");
  const clientSecret = Deno.env.get("LWA_CLIENT_SECRET") ?? Deno.env.get("SPAPI_LWA_CLIENT_SECRET");
  if (!clientId || !clientSecret) throw new Error("LWA credentials not configured");

  const response = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!response.ok) throw new Error(`Failed to refresh token: ${await response.text()}`);
  return (await response.json()).access_token;
}

const collectProblemText = (value: unknown): string[] => {
  if (!value) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectProblemText);
  if (typeof value !== "object") return [];
  const item = value as Record<string, unknown>;
  return [item.code, item.message, item.details, item.messages, item.problems, item.operationProblems]
    .flatMap(collectProblemText);
};

const buildExpirationContext = (operationErrors: Array<{ messages: string[]; problems: any[] }>) => {
  const amazonMessage = collectProblemText(operationErrors).join(" | ");
  if (!/expiration\s+(date\s+)?required|expiry\s+(date\s+)?required/i.test(amazonMessage)) return null;
  return {
    code: "EXPIRATION_DATE_REQUIRED",
    message: "Amazon says an expiration date is required but did not identify the exact SKU in the API response.",
    amazonMessage: amazonMessage.slice(0, 1000),
  };
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const refreshToken = Deno.env.get("SPAPI_REFRESH_TOKEN");
    if (!refreshToken) {
      return new Response(JSON.stringify({ error: "SPAPI_REFRESH_TOKEN not configured" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));
    const inboundPlanId = String(body?.inboundPlanId || "").trim();
    if (!inboundPlanId) {
      return new Response(JSON.stringify({ error: "inboundPlanId is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const accessToken = await getAccessToken(refreshToken);

    const planPath = `/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(inboundPlanId)}`;
    const planResp = await spApiSignedFetch({ method: "GET", path: planPath, accessToken });
    const planText = await planResp.text();
    let planData: any = null;
    try { planData = JSON.parse(planText); } catch {}

    if (!planResp.ok) {
      return new Response(JSON.stringify({
        success: false,
        inboundPlanId,
        httpStatus: planResp.status,
        error: planData?.errors?.[0]?.message ?? "Amazon rejected the status request",
        details: planText,
      }), {
        status: planResp.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const status = planData?.status ?? "UNKNOWN";
    const shipments = Array.isArray(planData?.shipments) ? planData.shipments : [];
    const shipmentIds = shipments
      .map((s: any) => s?.shipmentId)
      .filter((s: unknown): s is string => typeof s === "string" && s.length > 0);

    // If the plan ERRORED, fetch operation history to get the actual error reasons.
    // Amazon's behavior here is inconsistent: sometimes operationProblems is attached
    // to FAILED ops, sometimes to SUCCESS ops, and sometimes the list is empty.
    // We therefore inspect EVERY operation we can find and report any problems.
    let operationErrors: Array<{ operation: string; status: string; messages: string[]; problems: any[] }> = [];
    let inspectedOpsCount = 0;
    if (status === "ERRORED") {
      try {
        const opsPath = `/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(inboundPlanId)}/operations`;
        const opsResp = await spApiSignedFetch({ method: "GET", path: opsPath, accessToken });
        const opsText = await opsResp.text();
        let opsData: any = null;
        try { opsData = JSON.parse(opsText); } catch {}
        const operations = Array.isArray(opsData?.operations) ? opsData.operations : [];
        inspectedOpsCount = operations.length;

        // Inspect EVERY operation — Amazon may attach problems to ops that aren't
        // marked FAILED. We surface anything that has operationProblems.
        for (const op of operations) {
          const opId = op?.operationId;
          if (!opId) continue;
          try {
            const opDetailPath = `/inbound/fba/2024-03-20/operations/${encodeURIComponent(opId)}`;
            const opDetailResp = await spApiSignedFetch({ method: "GET", path: opDetailPath, accessToken });
            const opDetailText = await opDetailResp.text();
            let opDetailData: any = null;
            try { opDetailData = JSON.parse(opDetailText); } catch {}
            const problems = Array.isArray(opDetailData?.operationProblems) ? opDetailData.operationProblems : [];

            // Skip operations that returned no problems AND completed successfully.
            const opStatus = op?.operationStatus ?? opDetailData?.operationStatus ?? "UNKNOWN";
            if (problems.length === 0 && opStatus === "SUCCESS") continue;

            const messages = problems.map((p: any) => {
              const code = p?.code ? `[${p.code}] ` : "";
              const msg = p?.message ?? "";
              const details = p?.details ? ` (${p.details})` : "";
              return `${code}${msg}${details}`.trim();
            }).filter(Boolean);

            operationErrors.push({
              operation: op?.operation ?? "unknown",
              status: opStatus,
              messages: messages.length > 0
                ? messages
                : [`Operation ${opStatus.toLowerCase()} with no problem details returned by Amazon.`],
              problems,
            });
          } catch (opErr) {
            operationErrors.push({
              operation: op?.operation ?? "unknown",
              status: op?.operationStatus ?? "FAILED",
              messages: [`Failed to fetch operation details: ${(opErr as Error).message}`],
              problems: [],
            });
          }
        }
      } catch (opsErr) {
        console.error("Failed to fetch operations for ERRORED plan:", opsErr);
      }
    }

    // Build a top-level error summary for ERRORED status
    let topLevelError: string | undefined;
    if (status === "ERRORED") {
      const allMessages = operationErrors.flatMap((e) => e.messages).filter(Boolean);
      if (allMessages.length > 0) {
        topLevelError = allMessages.slice(0, 3).join(" | ");
      } else if (inspectedOpsCount > 0) {
        topLevelError =
          `Amazon marked this plan as ERRORED. ${inspectedOpsCount} operation(s) were inspected but Amazon returned no problem details. ` +
          "This usually means one of the MSKUs is not active in Seller Central, the destination marketplace rejected the catalog, or prep/label requirements changed. " +
          "Open this Inbound Plan ID in Seller Central → Send to Amazon to see the underlying message, then start a new shipment.";
      } else {
        topLevelError =
          "Amazon marked this plan as ERRORED and returned no operation history. " +
          "The plan cannot be recovered — start a new shipment. Verify each MSKU exists and is active in Seller Central → Manage Inventory before retrying.";
      }
    }
    const expirationContext = buildExpirationContext(operationErrors);
    if (expirationContext) topLevelError = expirationContext.message;

    // HEALTH SIGNAL: shipment ERRORED at Amazon (critical)
    if (status === "ERRORED") {
      await logHealthSignal({
        user_id: user.id, module: 'shipments', severity: 'critical', confidence: 'high',
        pattern: 'inbound_plan_error',
        title: 'Inbound plan ERRORED at Amazon',
        impact: `Plan ${inboundPlanId} cannot proceed; ${shipmentIds.length} shipment(s) blocked.`,
        recommended_fix: 'Open Shipment Builder and recreate the plan after fixing flagged items.',
        auto_fix_action: 'check-inbound-plan-status',
        entity: { marketplace: (planData?.destinationMarketplaces?.[0]?.marketplaceId) ?? undefined } as any,
        function_name: 'check-inbound-plan-status', source: 'edge_runtime',
        raw_message: `inboundPlanId=${inboundPlanId} step=plan_status ${topLevelError ?? 'ERRORED'}`,
      });
    }

    // ── PERSIST AMAZON'S SHIPMENT IDS (added 2026-11-02) ──────────────
    //
    // Amazon hands these back on every call and nothing ever stored them.
    // Measured before this change: amazon_shipment_id was set on 1 of 126
    // drafts, and shipment_purchase_allocations.shipment_id was NULL on all
    // 628 rows -- so the builder could not tell a draft from a shipment that
    // had actually been accepted, and the COG gate had no strong signal to
    // key on.
    //
    // The draft is found by inbound_plan_id, which create-inbound-plan already
    // writes, so no new linkage is needed. Writes are best-effort: this
    // function's job is to report plan status, and a bookkeeping failure must
    // not turn a successful status check into an error. Failures are logged.
    //
    // Only the FIRST shipment id goes on the draft, because the column is
    // singular; the full list is on the allocations, which are per purchase
    // lot. A plan that splits into several shipments therefore keeps all of
    // them, and the draft's own column is "one of them" rather than "the only
    // one" -- worth knowing before anyone treats it as complete.
    let persisted: { drafts: number; allocations: number } | null = null;
    if (shipmentIds.length > 0 && user?.id) {
      try {
        const { data: draftRows, error: draftErr } = await supabase
          .from("shipment_builder_drafts")
          .update({
            amazon_shipment_id: shipmentIds[0],
            synced_at: new Date().toISOString(),
          })
          .eq("user_id", user.id)
          .eq("inbound_plan_id", inboundPlanId)
          .select("draft_id");

        if (draftErr) {
          console.warn(`[inbound-status] could not store shipment id on draft: ${draftErr.message}`);
        }

        let allocCount = 0;
        for (const d of draftRows ?? []) {
          const { data: allocRows, error: allocErr } = await supabase
            .from("shipment_purchase_allocations")
            .update({ shipment_id: shipmentIds[0] })
            .eq("user_id", user.id)
            .eq("draft_id", (d as any).draft_id)
            .is("shipment_id", null)
            .select("id");
          if (allocErr) {
            console.warn(`[inbound-status] could not store shipment id on allocations: ${allocErr.message}`);
          } else {
            allocCount += (allocRows ?? []).length;
          }
        }
        persisted = { drafts: (draftRows ?? []).length, allocations: allocCount };
        if (persisted.drafts > 0 || persisted.allocations > 0) {
          console.log(
            `[inbound-status] stored shipment ${shipmentIds[0]} on ${persisted.drafts} draft(s) and ${persisted.allocations} allocation(s) for plan ${inboundPlanId}`,
          );
        }
      } catch (e) {
        console.warn(`[inbound-status] shipment-id persistence failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      inboundPlanId,
      status,
      persisted,
      sourceAddress: planData?.sourceAddress ?? null,
      destinationMarketplaces: planData?.destinationMarketplaces ?? [],
      shipmentIds,
      shipmentsCount: shipments.length,
      operationErrors,
      expirationContext,
      error: topLevelError,
      raw: planData,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("check-inbound-plan-status error:", error);
    // HEALTH SIGNAL: top-level fatal — derive userId from auth header
    try {
      const authHeader = req.headers.get("Authorization");
      if (authHeader) {
        const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
        const { data: { user: fatalUser } } = await sb.auth.getUser(authHeader.replace("Bearer ", ""));
        if (fatalUser?.id) {
          await HealthSignals.inboundPlanError(fatalUser.id, 'check-inbound-plan-status', `Fatal: ${(error as Error).message}`);
        }
      }
    } catch { /* never throw */ }
    return new Response(JSON.stringify({
      error: "Failed to check inbound plan status",
      details: (error as Error).message,
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
