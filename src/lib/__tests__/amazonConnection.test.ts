// The 409 the operator-credential guard returns has to survive supabase-js to
// reach a person's screen, and supabase-js makes that harder than it looks:
// `error.message` is the fixed string "Edge Function returned a non-2xx status
// code" for EVERY http failure, and the real body is on `error.context`, a
// Response that can be read once.
//
// Four components used to show that fixed string, which is why a user with no
// Amazon connection saw "non-2xx status code" rather than being told to connect
// an account. These tests pin the extraction, including the parts that are easy
// to get wrong: a body already consumed, a non-JSON body, and the 200-with-
// error-field shape that CreatedListings.tsx checks separately.
import { describe, it, expect } from "vitest";
import {
  isAmazonNotConnected,
  functionErrorMessage,
  readFunctionErrorBody,
  AMAZON_NOT_CONNECTED,
  AMAZON_CONNECT_MESSAGE,
} from "../amazonConnection";

/** A FunctionsHttpError as supabase-js v2 builds it. */
const httpError = (status: number, body: unknown) => ({
  name: "FunctionsHttpError",
  message: "Edge Function returned a non-2xx status code",
  context: new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  }),
});

const GUARD_BODY = {
  error: "Connect your Amazon seller account to use this feature. (this account has no Amazon connection)",
  code: AMAZON_NOT_CONNECTED,
  amazonConnected: false,
};

describe("recognising the guard's 409", () => {
  it("detects AMAZON_NOT_CONNECTED through a FunctionsHttpError", async () => {
    expect(await isAmazonNotConnected(httpError(409, GUARD_BODY))).toBe(true);
  });

  it("does not fire on an unrelated failure", async () => {
    expect(await isAmazonNotConnected(httpError(500, { error: "boom" }))).toBe(false);
    expect(await isAmazonNotConnected(httpError(404, { error: "NOT_FOUND" }))).toBe(false);
  });

  it("also accepts a 200-with-error-body payload", async () => {
    // CreatedListings.tsx checks `data?.error` separately from `error`, so a
    // function returning 200 with an error field has to be covered too.
    expect(await isAmazonNotConnected(GUARD_BODY)).toBe(true);
    expect(await isAmazonNotConnected({ error: "QUOTA_EXCEEDED" })).toBe(false);
  });

  it("never throws on junk, because it runs inside an error path", async () => {
    for (const junk of [null, undefined, 0, "", "a string", {}, { context: 1 }, new Error("x")]) {
      expect(await isAmazonNotConnected(junk)).toBe(false);
    }
  });

  it("survives a non-JSON body (an HTML page from a proxy)", async () => {
    const err = {
      message: "Edge Function returned a non-2xx status code",
      context: new Response("<html>502 Bad Gateway</html>", { status: 502 }),
    };
    expect(await isAmazonNotConnected(err)).toBe(false);
    expect(await readFunctionErrorBody(err)).toEqual({});
  });

  it("clones the body, so reading it twice still works", async () => {
    // A Response body is a one-shot stream. If the helper consumed the
    // original, a call site that checked isAmazonNotConnected() and then
    // called functionErrorMessage() would get an empty body the second time --
    // and show the fallback instead of the real sentence.
    const err = httpError(409, GUARD_BODY);
    expect(await isAmazonNotConnected(err)).toBe(true);
    expect(await functionErrorMessage(err, "fallback")).toBe(GUARD_BODY.error);
    expect(await isAmazonNotConnected(err)).toBe(true);
  });
});

describe("the message a person actually sees", () => {
  it("is the guard's own sentence for a 409", async () => {
    expect(await functionErrorMessage(httpError(409, GUARD_BODY), "fallback"))
      .toBe(GUARD_BODY.error);
  });

  it("falls back to the constant if the body carried a code but no text", async () => {
    const msg = await functionErrorMessage(
      httpError(409, { code: AMAZON_NOT_CONNECTED }), "fallback");
    expect(msg).toBe(AMAZON_CONNECT_MESSAGE);
  });

  it("prefers a real body message over supabase's fixed string", async () => {
    expect(await functionErrorMessage(httpError(500, { error: "ASIN not found" }), "fallback"))
      .toBe("ASIN not found");
  });

  it("SUPPRESSES the useless 'non-2xx status code' string", async () => {
    // This is the whole bug. With no readable body there is nothing better
    // than the caller's own fallback, and the fixed string must not win.
    const err = { message: "Edge Function returned a non-2xx status code" };
    expect(await functionErrorMessage(err, "Could not load fees")).toBe("Could not load fees");
  });

  it("keeps an ordinary error message", async () => {
    expect(await functionErrorMessage(new Error("network down"), "fallback"))
      .toBe("network down");
  });

  it("uses the fallback when there is nothing at all", async () => {
    expect(await functionErrorMessage(null, "Request failed")).toBe("Request failed");
    expect(await functionErrorMessage({}, "Request failed")).toBe("Request failed");
  });

  it("the user-facing constant tells the user what to DO", async () => {
    // Not "forbidden", not "error" -- an instruction. The guard returns 409
    // rather than 403 for the same reason.
    expect(AMAZON_CONNECT_MESSAGE.toLowerCase()).toContain("connect");
    expect(AMAZON_CONNECT_MESSAGE.toLowerCase()).not.toMatch(/forbidden|denied|unauthoriz/);
  });
});
