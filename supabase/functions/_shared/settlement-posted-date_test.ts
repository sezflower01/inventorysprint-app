// Tests for parsePostedDate, the settlement-mapper date reader.
//
// Context: every non-USD settlement line was stored with a NULL posted_date
// because the Canadian flat file writes dates DAY-FIRST and DOT-separated
// ("28.10.2026 15:54:28 UTC") while the parser only understood the US
// year-first form. Confirmed 2026-11-23 against one real CAD report.
//
// Two properties are pinned here, and the second matters more than the first:
//
//   1. KNOWN FORMATS PARSE   every format we have actually observed yields the
//                            date as written, and the US forms are unchanged.
//   2. AMBIGUITY IS NULL     a date whose component order is NOT forced by the
//                            value itself must return null. The old code sent
//                            it to new Date(), which silently assumed
//                            month-first -- so "08.11.2026" became 11 August
//                            instead of 8 November. A null is visibly missing
//                            and can be re-fetched. A plausible wrong date
//                            cannot be found again, and would land revenue in
//                            the wrong month of the P&L.
//
// Every value below is synthetic. No order ids, skus or amounts appear: the
// parser reads nothing but the two date columns.
//
//   deno test supabase/functions/_shared/settlement-posted-date_test.ts

import { assertEquals } from "jsr:@std/assert@1";
import { parsePostedDate } from "./settlement-mapper.ts";

// The parser takes a row, so wrap bare strings. Both column names are tested
// because the header row of a settlement file is read through 'posted-date'
// (settlement-start-date / deposit-date) and line rows through
// 'posted-date-time' -- one broken format breaks both.
const asDateTime = (s: string) => parsePostedDate({ "posted-date-time": s });
const asDate = (s: string) => parsePostedDate({ "posted-date": s });

Deno.test("US year-first forms are unchanged", () => {
  assertEquals(asDateTime("2026-11-08 12:00:00 UTC"), "2026-11-08");
  assertEquals(asDateTime("2026-11-08T12:00:00Z"), "2026-11-08");
  assertEquals(asDateTime("2026-11-08T12:00:00+00:00"), "2026-11-08");
  assertEquals(asDateTime("2026-11-08"), "2026-11-08");
  assertEquals(asDate("2026-11-08 12:00:00 UTC"), "2026-11-08");
  // Late-evening UTC must stay on its own day: the suffix says UTC, so there
  // is no timezone conversion to do and none must be invented.
  assertEquals(asDateTime("2026-11-08 23:59:59 UTC"), "2026-11-08");
  assertEquals(asDateTime("2026-01-01 00:00:00 UTC"), "2026-01-01");
});

Deno.test("CA dotted day-first parses, with and without a time", () => {
  // The format that caused the bug. Day 28 > 12, so this one case was always
  // decidable -- it still returned null before the fix.
  assertEquals(asDateTime("28.10.2026 15:54:28 UTC"), "2026-10-28");
  assertEquals(asDateTime("28.10.2026"), "2026-10-28");
  assertEquals(asDate("28.10.2026"), "2026-10-28");
  // Single-digit components, unpadded.
  assertEquals(asDateTime("1.9.2026"), "2026-09-01");
  assertEquals(asDateTime("01.09.2026"), "2026-09-01");
});

Deno.test("dotted dates are day-first even when the value does not force it", () => {
  // THE REGRESSION THAT MATTERS. Both components are <= 12, so the value
  // alone cannot say which is the day -- but dots are a day-first convention,
  // and the CAD file is confirmed day-first, so this is 8 November.
  // Month-first would make it 11 August: a 3-month error in the P&L.
  assertEquals(asDateTime("08.11.2026"), "2026-11-08");
  assertEquals(asDateTime("08.11.2026 12:00:00 UTC"), "2026-11-08");
  assertEquals(asDateTime("11.08.2026"), "2026-08-11");
  assertEquals(asDateTime("03.04.2026"), "2026-04-03");
  assertEquals(asDateTime("12.12.2026"), "2026-12-12"); // same either way
});

Deno.test("slash and dash dates parse only when the order is forced", () => {
  // Forced month-first: 25 cannot be a month.
  assertEquals(asDateTime("11/25/2026"), "2026-11-25");
  assertEquals(asDateTime("11-25-2026"), "2026-11-25");
  // Forced day-first: likewise.
  assertEquals(asDateTime("25/11/2026"), "2026-11-25");
  assertEquals(asDateTime("25-11-2026"), "2026-11-25");
  // Forced, with a trailing time.
  assertEquals(asDateTime("25/11/2026 15:54:28 UTC"), "2026-11-25");
  // Boundaries of "forced": 13 forces, 12 does not.
  assertEquals(asDateTime("13/01/2026"), "2026-01-13");
  assertEquals(asDateTime("01/13/2026"), "2026-01-13");
});

Deno.test("ambiguous slash and dash dates return null, never a guess", () => {
  // Both components <= 12 and no convention to lean on. The old code returned
  // 2026-08-11 for the first of these -- plausible, undetectable, wrong half
  // the time. null is the only honest answer.
  for (const raw of [
    "08/11/2026",
    "08-11-2026",
    "11/08/2026",
    "01/02/2026",
    "12/12/2026", // identical either way, but still not decidable as a FORMAT
    "08/11/2026 12:00:00 UTC",
  ]) {
    assertEquals(asDateTime(raw), null, `must not guess an order for ${raw}`);
    assertEquals(asDate(raw), null, `must not guess an order for ${raw}`);
  }
});

Deno.test("impossible dates are rejected, not rolled forward", () => {
  // Date.UTC(2026, 1, 31) rolls to 3 March. A rolled date is a wrong date.
  assertEquals(asDateTime("31.02.2026"), null);
  assertEquals(asDateTime("30.02.2026"), null);
  assertEquals(asDateTime("32.01.2026"), null);
  assertEquals(asDateTime("00.01.2026"), null);
  assertEquals(asDateTime("31/02/2026"), null);
  // 29 February exists in a leap year and not otherwise.
  assertEquals(asDateTime("29.02.2024"), "2024-02-29");
  assertEquals(asDateTime("29.02.2026"), null);
  // A dotted date whose second component cannot be a month fails loudly
  // rather than flipping to month-first.
  assertEquals(asDateTime("10.28.2026"), null);
});

Deno.test("missing and unreadable values return null", () => {
  assertEquals(parsePostedDate({}), null);
  assertEquals(asDateTime(""), null);
  assertEquals(asDateTime("   "), null);
  assertEquals(asDateTime("not a date"), null);
  assertEquals(asDateTime("8 de noviembre de 2026"), null);
  assertEquals(asDateTime("0000-00-00"), null);
  assertEquals(asDateTime("2026-13-01"), null);
});

Deno.test("posted-date-time wins over posted-date when both are present", () => {
  // Unchanged precedence, pinned so a future edit to the fallback chain
  // cannot quietly reverse it.
  assertEquals(
    parsePostedDate({ "posted-date-time": "28.10.2026", "posted-date": "01.01.2026" }),
    "2026-10-28",
  );
  // ...but an empty datetime must fall through to the date column rather than
  // short-circuiting to null.
  assertEquals(
    parsePostedDate({ "posted-date-time": "", "posted-date": "28.10.2026" }),
    "2026-10-28",
  );
});

Deno.test("surrounding whitespace does not change the answer", () => {
  assertEquals(asDateTime("  28.10.2026  "), "2026-10-28");
  assertEquals(asDateTime("\t2026-11-08 12:00:00 UTC\n"), "2026-11-08");
});
