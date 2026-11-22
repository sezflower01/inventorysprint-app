import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { resolveNextCompetitorPrice } from "./competitorPrice.ts";

// ── THE DEFECT ───────────────────────────────────────────────────────────────

Deno.test("we hold the lowest offer: no competitor is reported", () => {
  // lowest_overall_price == our price, because the offer list includes us.
  // The old code handed 22.36 to the prompt as "Next Competitor".
  assertEquals(resolveNextCompetitorPrice(22.36, 22.36), null);
});

Deno.test("the old behaviour is what we are removing", () => {
  // Pinned as a contrast: the previous expression was simply
  // `lowest_overall_price ?? null`, which returns our own price here.
  const oldBehaviour = (_cur: number, lowest: number | null) => lowest ?? null;
  assertEquals(oldBehaviour(22.36, 22.36), 22.36); // wrong, and confidently so
  assertEquals(resolveNextCompetitorPrice(22.36, 22.36), null);
});

Deno.test("a competitor genuinely below us IS reported", () => {
  assertEquals(resolveNextCompetitorPrice(22.36, 21.99), 21.99);
});

Deno.test("a tie within epsilon is not an undercut", () => {
  assertEquals(resolveNextCompetitorPrice(20.00, 19.998), null);
  assertEquals(resolveNextCompetitorPrice(20.00, 19.99), 19.99);
});

Deno.test("a competitor above us is not a competitor below us", () => {
  // Seen in the live sample: the lowest recorded offer sat well ABOVE our
  // price, which is only possible via timing skew or a non-USD marketplace.
  // Either way it must not be presented as someone undercutting us.
  assertEquals(resolveNextCompetitorPrice(20.00, 48.91), null);
});

// ── MISSING AND MALFORMED DATA ───────────────────────────────────────────────

Deno.test("no lowest-overall price means unknown, not zero", () => {
  assertEquals(resolveNextCompetitorPrice(22.36, null), null);
  assertEquals(resolveNextCompetitorPrice(22.36, undefined), null);
});

Deno.test("without our own price we cannot say whose the lowest offer is", () => {
  // This is the conservative half: the lowest offer might be ours, and
  // claiming otherwise is the bug.
  assertEquals(resolveNextCompetitorPrice(null, 21.99), null);
  assertEquals(resolveNextCompetitorPrice(undefined, 21.99), null);
});

Deno.test("zero and negative prices are never a competitor", () => {
  assertEquals(resolveNextCompetitorPrice(22.36, 0), null);
  assertEquals(resolveNextCompetitorPrice(22.36, -1), null);
});

Deno.test("NaN on either side yields null rather than propagating", () => {
  assertEquals(resolveNextCompetitorPrice(Number.NaN, 21.99), null);
  assertEquals(resolveNextCompetitorPrice(22.36, Number.NaN), null);
});

Deno.test("a real undercut survives at small absolute prices", () => {
  assertEquals(resolveNextCompetitorPrice(8.70, 8.00), 8.00);
});
