/**
 * When a paged SP-API item fetch may ask for another page -- and when it must
 * stop even though the response handed it a token.
 *
 * WHY THIS EXISTS (2026-11-18)
 * ----------------------------
 * `fetchV0ShipmentItems` ran `do { ... } while (nextToken)` against
 * `GET /fba/inbound/v0/shipments/{shipmentId}/items`, feeding `payload.NextToken`
 * back as a `NextToken` query parameter. Amazon's own model file says that
 * operation declares exactly two parameters:
 *
 *     getShipmentItemsByShipmentId
 *       shipmentId      in=path   required=true
 *       MarketplaceId   in=query  required=false   "Deprecated. Do not use."
 *
 * There is NO NextToken parameter. But the 200 response reuses the shared
 * `GetShipmentItemsResponse` schema, which carries a `NextToken` property for
 * the benefit of the *bulk* operation (`/fba/inbound/v0/shipmentItems`, where
 * `QueryType` is required and enumerates DATE_RANGE | NEXT_TOKEN). So Amazon
 * returned a non-null token, ignored the unknown parameter we sent back, and
 * served the identical first page forever.
 *
 * Measured on shipment FBA19RKR64KC: 54 consecutive calls, every one 200 OK,
 * 4,735 bytes, 15 items, call_ms ~100, until `429 QuotaExceeded`. callSpApi
 * then threw, the call site's catch only logged, and all 15 genuinely-fetched
 * items were discarded -- which is why six weeks of October items read as
 * "0 items" rather than as a failure. One loop produced three wrong answers:
 * a slow sync, an empty result, and a poisoned shared inbound quota.
 *
 * The v0 per-shipment call is now a single call with no pagination at all,
 * because the spec says there is no second page to ask for. This module is for
 * the 2024-03-20 endpoint, which really does page (`paginationToken` in,
 * `pagination.nextToken` out) -- and it refuses a token it has already sent, so
 * the same bug cannot recur silently on an endpoint where paging is legitimate.
 *
 * Deliberately function-local rather than in `_shared/`: a `_shared/**` edit
 * redeploys all ~262 edge functions.
 */

export interface PageRequest {
  /** The token we sent for the page just received; null on the first page. */
  sentToken: string | null;
  /** Whatever the response put where a token belongs. Unvalidated on purpose. */
  receivedToken: unknown;
  /** How many pages have come back so far, including this one. */
  pagesFetched: number;
  /** Hard ceiling, so a novel repeat pattern still terminates. */
  maxPages: number;
  /** Every token already sent, so a cycle of length > 1 is caught too. */
  seenTokens: Set<string>;
}

export interface PageDecision {
  advance: boolean;
  /** The token to send next. Non-null only when `advance` is true. */
  token: string | null;
  reason: string;
}

export function nextPage(req: PageRequest): PageDecision {
  const { sentToken, receivedToken, pagesFetched, maxPages, seenTokens } = req;

  const token = typeof receivedToken === 'string' && receivedToken.length > 0
    ? receivedToken
    : null;

  if (token === null) {
    return { advance: false, token: null, reason: 'no token in response' };
  }

  // THE DEFECT THIS MODULE EXISTS FOR. An endpoint that ignores our token
  // returns the same one back, so "there is a token" and "there is another
  // page" are two different facts and must not share one test.
  if (token === sentToken) {
    return {
      advance: false,
      token: null,
      reason: 'response repeated the token we just sent (endpoint is not paging)',
    };
  }

  if (seenTokens.has(token)) {
    return {
      advance: false,
      token: null,
      reason: 'token already used earlier in this fetch (pagination cycle)',
    };
  }

  if (pagesFetched >= maxPages) {
    return {
      advance: false,
      token: null,
      reason: `page cap reached (${pagesFetched}/${maxPages}) with a token still outstanding`,
    };
  }

  return { advance: true, token, reason: `advancing to page ${pagesFetched + 1}` };
}
