// Shared helper to raise SP-API health alerts and email admin immediately.
// Used by the periodic monitor AND by live SP-API callers when they detect auth/secret failures.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const ADMIN_EMAIL = "sezflower01@gmail.com";

export type SpapiIssueType =
  | "invalid_grant"
  | "invalid_client"
  | "unauthorized"
  | "forbidden"
  | "missing_credentials"
  | "network"
  | "other";

// Classify an Amazon SP-API / LWA error message into a stable issue type.
export function classifySpapiError(raw: string): SpapiIssueType {
  const m = (raw || "").toLowerCase();
  if (!m) return "other";
  if (m.includes("invalid_grant") || m.includes("refresh token") || m.includes("refresh_token"))
    return "invalid_grant";
  if (m.includes("invalid_client") || m.includes("client authentication failed"))
    return "invalid_client";
  if (m.includes("missing credentials") || m.includes("no credentials"))
    return "missing_credentials";
  if (m.includes("403") || m.includes("forbidden") || m.includes("access to requested resource is denied"))
    return "forbidden";
  if (m.includes("401") || m.includes("unauthorized") || m.includes("unauthenticated"))
    return "unauthorized";
  // TRANSPORT failures. This list was once just network/timeout/fetch failed,
  // and that was too literal: on 2026-10-18 08:55 GMT the monitor got
  //
  //   error sending request from 10.32.180.184:46164 for
  //   .../sellers/v1/marketplaceParticipations (3.162.114.211:443):
  //   client error (SendRequest): connection error: connection reset
  //
  // which contains none of those three words, so it fell through to "other"
  // and emailed -- despite "other" being the only type that is NOT suppressed
  // as transient. The next tick succeeded: the whole incident lasted 4m32s and
  // nothing was wrong with the credentials. Worse, the email told the seller to
  // re-test and reconnect, which would have rotated a working refresh token
  // over a dropped TCP connection.
  //
  // A transport error is one where no HTTP response ever arrived, so it says
  // nothing at all about whether the credentials are valid. Amazon resets
  // connections routinely under load.
  if (
    m.includes("network") ||
    m.includes("timeout") ||
    m.includes("timed out") ||
    m.includes("fetch failed") ||
    m.includes("connection reset") ||
    m.includes("connection error") ||
    m.includes("connection closed") ||
    m.includes("connection refused") ||
    m.includes("connection aborted") ||
    m.includes("econnreset") ||
    m.includes("econnrefused") ||
    m.includes("econnaborted") ||
    m.includes("etimedout") ||
    m.includes("epipe") ||
    m.includes("broken pipe") ||
    m.includes("sendrequest") ||
    m.includes("error sending request") ||
    m.includes("unexpected eof") ||
    m.includes("handshake") ||
    m.includes("dns error") ||
    m.includes("unreachable") ||
    m.includes("502") ||
    m.includes("503") ||
    m.includes("504") ||
    m.includes("bad gateway") ||
    m.includes("service unavailable") ||
    m.includes("gateway timeout")
  ) {
    return "network";
  }
  return "other";
}

function humanIssue(t: SpapiIssueType): string {
  switch (t) {
    case "invalid_grant": return "Refresh token rejected (re-authorization needed)";
    case "invalid_client": return "Invalid LWA Client ID / Secret";
    case "missing_credentials": return "Missing SP-API credentials";
    case "forbidden": return "Access forbidden (role / scope issue)";
    case "unauthorized": return "Unauthorized (token / auth failure)";
    case "network": return "Network / timeout reaching Amazon";
    default: return "SP-API error";
  }
}

const NOTIFY_COOLDOWN_HOURS = 6; // re-notify at most every 6h while issue stays open

// How long a TRANSPORT failure must persist before it is worth an email. The
// monitor ticks every 5 minutes, so 30 means roughly six consecutive failures.
// Below this it is a blip and emailing is worse than silence -- see the
// 2026-10-18 incident noted in classifySpapiError, which lasted 4m32s.
const NETWORK_SUSTAINED_MINUTES = 30;

/** What the seller should actually DO about each issue type. */
function actionFor(t: SpapiIssueType): string {
  switch (t) {
    case "invalid_grant":
      return "Open <strong>Settings → Amazon Connection</strong> and reconnect — the refresh token was rejected and must be re-authorized.";
    case "invalid_client":
      return "Check the <strong>LWA Client ID and Secret</strong> in Settings → Amazon Connection. The credentials themselves are being refused, so reconnecting alone will not help.";
    case "missing_credentials":
      return "No SP-API credentials are stored for this user. Connect the Amazon account in <strong>Settings → Amazon Connection</strong>.";
    case "forbidden":
      return "The credentials work but lack permission for this call. Check the app's <strong>roles and scopes</strong> in Seller Central → Apps &amp; Services → Develop Apps.";
    case "unauthorized":
      return "Re-test the connection in <strong>Settings → Amazon Connection</strong>. If it keeps failing, reconnect to mint a fresh token.";
    case "network":
      return "<strong>No action needed on your credentials.</strong> This is a network fault reaching Amazon — no HTTP response arrived, so it says nothing about whether your tokens are valid. It is only being reported because it has persisted; if it clears on its own, nothing was wrong.";
    default:
      return "Re-test the connection in <strong>Settings → Amazon Connection</strong>. If the test passes, this was transient and needs no action.";
  }
}

/**
 * Record an SP-API health failure for `userId` and email the admin if this is
 * a new alert OR the cooldown has elapsed since the last notification.
 *
 * `transient` issues (network/timeout) do NOT email — they only get logged so
 * we don't spam admin on flaky connectivity.
 */
export async function raiseSpapiAlert(opts: {
  userId: string;
  userEmail?: string | null;
  errorMessage: string;
  source: string; // e.g. "monitor", "push-bounds-to-amazon", "update-amazon-price"
}): Promise<void> {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);

    const issueType = classifySpapiError(opts.errorMessage);

    // Find existing OPEN alert for this user/issue
    const { data: existing } = await admin
      .from("spapi_health_alerts")
      .select("id, last_notified_at, notify_count, first_detected_at")
      .eq("user_id", opts.userId)
      .eq("issue_type", issueType)
      .eq("status", "open")
      .maybeSingle();

    const now = new Date();
    let alertId: string;
    let shouldNotify = false;

    if (existing?.id) {
      alertId = existing.id;
      const lastNotified = existing.last_notified_at ? new Date(existing.last_notified_at) : null;
      const ageHours = lastNotified ? (now.getTime() - lastNotified.getTime()) / 36e5 : Infinity;
      shouldNotify = ageHours >= NOTIFY_COOLDOWN_HOURS;

      await admin
        .from("spapi_health_alerts")
        .update({
          last_detected_at: now.toISOString(),
          error_message: opts.errorMessage.slice(0, 800),
          updated_at: now.toISOString(),
        })
        .eq("id", alertId);
    } else {
      const { data: inserted, error: insErr } = await admin
        .from("spapi_health_alerts")
        .insert({
          user_id: opts.userId,
          user_email: opts.userEmail ?? null,
          issue_type: issueType,
          error_message: opts.errorMessage.slice(0, 800),
          status: "open",
        })
        .select("id")
        .single();
      if (insErr) throw insErr;
      alertId = inserted.id;
      shouldNotify = true; // first detection — always email
    }

    // Transport failures are suppressed while they still look like a blip, but
    // NOT forever: previously `network` never emailed at all, which means a
    // genuine multi-hour outage reaching Amazon would have been completely
    // silent. A 4-minute reset is noise; an hour of resets is an outage the
    // seller needs to know about, because nothing is syncing meanwhile.
    //
    // The threshold is measured from first_detected_at, so it takes several
    // consecutive failing ticks (the monitor runs every 5 minutes) before any
    // email goes out.
    if (issueType === "network") {
      const firstSeen = existing?.first_detected_at
        ? new Date(existing.first_detected_at)
        : now;
      const openMinutes = (now.getTime() - firstSeen.getTime()) / 60_000;
      if (openMinutes < NETWORK_SUSTAINED_MINUTES) shouldNotify = false;
    }

    if (!shouldNotify) return;

    // Send email to admin
    const subject = `🚨 SP-API connection issue: ${humanIssue(issueType)}`;
    const html = `
      <div style="font-family: -apple-system, system-ui, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background:#fee2e2;border-left:4px solid #dc2626;padding:14px;border-radius:6px;margin-bottom:18px">
          <h2 style="margin:0 0 6px;color:#991b1b;font-size:18px">${humanIssue(issueType)}</h2>
          <p style="margin:0;color:#7f1d1d;font-size:13px">Detected at ${now.toUTCString()}</p>
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <tr><td style="padding:6px 0;color:#6b7280">User</td><td style="padding:6px 0;font-family:monospace">${opts.userEmail || opts.userId}</td></tr>
          <tr><td style="padding:6px 0;color:#6b7280">Source</td><td style="padding:6px 0;font-family:monospace">${opts.source}</td></tr>
          <tr><td style="padding:6px 0;color:#6b7280">Issue type</td><td style="padding:6px 0;font-family:monospace">${issueType}</td></tr>
        </table>
        <div style="background:#f9fafb;border:1px solid #e5e7eb;padding:12px;border-radius:6px;margin-top:14px">
          <div style="color:#6b7280;font-size:12px;margin-bottom:6px">Amazon error</div>
          <pre style="margin:0;white-space:pre-wrap;font-size:12px;color:#111827">${escapeHtml(opts.errorMessage.slice(0, 1500))}</pre>
        </div>
        <p style="margin-top:18px;color:#374151;font-size:14px">
          ${actionFor(issueType)}
        </p>
        <p style="margin-top:8px;color:#9ca3af;font-size:12px">
          Future emails for this same issue are throttled to one every ${NOTIFY_COOLDOWN_HOURS}h until it resolves.
        </p>
      </div>
    `;

    const resendKey = Deno.env.get("RESEND_API_KEY");
    if (!resendKey) {
      console.warn("[spapi-alert] RESEND_API_KEY missing — cannot email admin");
      return;
    }

    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "InventorySprint Alerts <onboarding@resend.dev>",
        to: [ADMIN_EMAIL],
        subject,
        html,
      }),
    });

    const respText = await resp.text();
    if (!resp.ok) {
      console.error("[spapi-alert] Resend failed", resp.status, respText);
      return;
    }

    await admin
      .from("spapi_health_alerts")
      .update({
        last_notified_at: now.toISOString(),
        notify_count: (existing?.notify_count ?? 0) + 1,
      })
      .eq("id", alertId);

    // Also write to error_reports for the in-app admin notifications panel
    await admin.from("error_reports").insert({
      user_id: opts.userId,
      user_email: opts.userEmail ?? null,
      error_message: `SP-API: ${humanIssue(issueType)}`,
      error_context: `${opts.source}\n\n${opts.errorMessage.slice(0, 800)}`,
      page_url: "system://spapi-monitor",
    });
  } catch (e) {
    console.error("[spapi-alert] Failed:", e);
  }
}

/**
 * Resolve any open alerts for this user when a credential test (or live call)
 * succeeds. Sends a brief "recovered" email so admin knows the issue cleared.
 */
export async function resolveSpapiAlerts(opts: {
  userId: string;
  userEmail?: string | null;
}): Promise<void> {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);

    const { data: openAlerts } = await admin
      .from("spapi_health_alerts")
      .select("id, issue_type")
      .eq("user_id", opts.userId)
      .eq("status", "open");

    if (!openAlerts || openAlerts.length === 0) return;

    const now = new Date().toISOString();
    await admin
      .from("spapi_health_alerts")
      .update({ status: "resolved", resolved_at: now, updated_at: now })
      .eq("user_id", opts.userId)
      .eq("status", "open");

    const resendKey = Deno.env.get("RESEND_API_KEY");
    if (!resendKey) return;

    const issues = openAlerts.map((a) => a.issue_type).join(", ");
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "InventorySprint Alerts <onboarding@resend.dev>",
        to: [ADMIN_EMAIL],
        subject: `✅ SP-API connection recovered`,
        html: `
          <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:18px">
            <div style="background:#dcfce7;border-left:4px solid #16a34a;padding:12px;border-radius:6px">
              <strong style="color:#166534">SP-API connection restored</strong>
            </div>
            <p style="margin-top:14px;color:#374151;font-size:14px">
              User <strong>${opts.userEmail || opts.userId}</strong> — previously open issues (${issues}) have cleared after a successful test.
            </p>
          </div>
        `,
      }),
    });
  } catch (e) {
    console.error("[spapi-alert] resolve failed:", e);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
