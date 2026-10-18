// Tests for classifySpapiError.
//
// These exist because of a real false alarm. On 2026-10-18 08:55 GMT the
// health monitor emailed the seller "re-test credentials, and reconnect if the
// refresh token is rejected" for what was a 4m32s TCP connection reset. The
// classifier only looked for the literal words network / timeout /
// fetch failed, so a reset fell through to "other" -- the one type that is NOT
// suppressed as transient. The advice was actively harmful: following it would
// have rotated a working refresh token over a dropped packet.
//
// The distinction the classifier has to get right is simple and worth stating:
// a TRANSPORT error means no HTTP response ever arrived, so it says NOTHING
// about whether the credentials are valid. An AUTH error means Amazon answered
// and refused. Only the second kind should ever tell someone to touch their
// credentials.

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { classifySpapiError } from "./spapi-alert.ts";

Deno.test("the exact 2026-10-18 incident classifies as network, not other", () => {
  const raw =
    "error sending request from 10.32.180.184:46164 for " +
    "https://sellingpartnerapi-na.amazon.com/sellers/v1/marketplaceParticipations " +
    "(3.162.114.211:443): client error (SendRequest): connection error: connection reset";
  assertEquals(classifySpapiError(raw), "network");
});

Deno.test("transport failures are all network", () => {
  const transport = [
    "connection reset by peer",
    "ECONNRESET",
    "connection refused",
    "ECONNREFUSED",
    "connection closed before message completed",
    "connection aborted",
    "ETIMEDOUT",
    "request timed out",
    "operation timeout",
    "fetch failed",
    "broken pipe",
    "EPIPE",
    "error sending request",
    "client error (SendRequest)",
    "unexpected EOF",
    "tls handshake failure",
    "dns error: failed to lookup address",
    "network is unreachable",
    "502 Bad Gateway",
    "503 Service Unavailable",
    "504 Gateway Timeout",
  ];
  for (const msg of transport) {
    assertEquals(classifySpapiError(msg), "network", `expected network for: ${msg}`);
  }
});

Deno.test("real auth failures are NOT swallowed as network", () => {
  // The whole point of widening the transport list is that it must not start
  // eating genuine credential problems -- those are the ones worth an email.
  assertEquals(classifySpapiError("invalid_grant"), "invalid_grant");
  assertEquals(classifySpapiError("The refresh token is invalid"), "invalid_grant");
  assertEquals(classifySpapiError("invalid_client"), "invalid_client");
  assertEquals(classifySpapiError("Client authentication failed"), "invalid_client");
  assertEquals(classifySpapiError("missing credentials"), "missing_credentials");
  assertEquals(classifySpapiError("Access to requested resource is denied"), "forbidden");
  assertEquals(classifySpapiError("403 Forbidden"), "forbidden");
  assertEquals(classifySpapiError("401 Unauthorized"), "unauthorized");
  assertEquals(classifySpapiError("unauthorized_client"), "unauthorized");
});

Deno.test("auth wins when a message carries both signals", () => {
  // Amazon answered and refused; the transport words are incidental. Treating
  // this as a blip would hide a genuine re-authorization need, which is the
  // expensive direction to be wrong in.
  assertEquals(
    classifySpapiError("invalid_grant: refresh token expired (connection reset on retry)"),
    "invalid_grant",
  );
  assertEquals(
    classifySpapiError("403 Forbidden after connection reset"),
    "forbidden",
  );
});

Deno.test("empty and genuinely unknown stay other", () => {
  assertEquals(classifySpapiError(""), "other");
  assertEquals(classifySpapiError(null as unknown as string), "other");
  assertEquals(classifySpapiError("Not authorized for requested operation"), "other");
  assertEquals(classifySpapiError("something nobody has seen before"), "other");
});
