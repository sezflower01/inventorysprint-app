// Tests for bulk seller-watch input parsing.
//
// Imports the REAL module rather than mirroring it (the workaround used by
// check-price-alerts, whose index.ts calls Deno.serve at module scope). This
// logic decides which rows land in a user's watchlist, so a drifting copy
// would be worse than no test.
//
// Run:
//   deno test --allow-net --allow-env --allow-read \
//     supabase/functions/bulk-create-seller-watches/parse_test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { classifyInput, parseSellerLine, splitInputLines } from './parse.ts';

Deno.test('parseSellerLine: bare seller ID', () => {
  assertEquals(parseSellerLine('ASYNTH00000002'), 'ASYNTH00000002');
});

Deno.test('parseSellerLine: normalises case', () => {
  assertEquals(parseSellerLine('asynth00000002'), 'ASYNTH00000002');
});

Deno.test('parseSellerLine: full storefront URL', () => {
  const url = 'https://www.amazon.com/sp?ie=UTF8&seller=ASYNTH00000002&me=ASYNTH00000002';
  assertEquals(parseSellerLine(url), 'ASYNTH00000002');
});

Deno.test('parseSellerLine: URL me= wins over other long alphanumeric runs', () => {
  // marketplaceID is a valid-looking token and appears BEFORE me= here. If
  // the column scan ran first it would return the wrong ID entirely.
  const url = 'https://www.amazon.com/sp?marketplaceID=ATVPDKIKX0DER&me=ASYNTH00000009&ref_=sr';
  assertEquals(parseSellerLine(url), 'ASYNTH00000009');
});

Deno.test('parseSellerLine: CSV with ID first', () => {
  assertEquals(parseSellerLine('ASYNTH00000002,Seller C'), 'ASYNTH00000002');
});

Deno.test('parseSellerLine: CSV with name first', () => {
  assertEquals(parseSellerLine('Seller C,ASYNTH00000002'), 'ASYNTH00000002');
});

Deno.test('parseSellerLine: strips surrounding quotes', () => {
  assertEquals(parseSellerLine('"ASYNTH00000002","Seller C"'), 'ASYNTH00000002');
});

Deno.test('parseSellerLine: semicolon and tab delimiters', () => {
  assertEquals(parseSellerLine('Seller C;ASYNTH00000002'), 'ASYNTH00000002');
  assertEquals(parseSellerLine('Seller C\tASYNTH00000002'), 'ASYNTH00000002');
});

Deno.test('parseSellerLine: rejects too-short and too-long tokens', () => {
  assertEquals(parseSellerLine('ABC12'), null);            // 5 chars
  assertEquals(parseSellerLine('A'.repeat(21)), null);     // 21 chars
});

Deno.test('parseSellerLine: rejects lines with nothing ID-shaped', () => {
  assertEquals(parseSellerLine('not a seller'), null);
  assertEquals(parseSellerLine(''), null);
  assertEquals(parseSellerLine('   '), null);
});

Deno.test('splitInputLines: drops a header row', () => {
  const text = 'seller_id,name\nASYNTH00000002,Seller C\nASYNTH00000009,VIP';
  assertEquals(splitInputLines(text).length, 2);
});

Deno.test('splitInputLines: keeps a first line that IS an ID', () => {
  const text = 'ASYNTH00000002\nASYNTH00000009';
  assertEquals(splitInputLines(text), ['ASYNTH00000002', 'ASYNTH00000009']);
});

Deno.test('splitInputLines: single ID line is not mistaken for a header', () => {
  assertEquals(splitInputLines('ASYNTH00000002'), ['ASYNTH00000002']);
});

Deno.test('splitInputLines: handles CRLF and blank lines', () => {
  const text = 'ASYNTH00000002\r\n\r\nASYNTH00000009\r\n';
  assertEquals(splitInputLines(text), ['ASYNTH00000002', 'ASYNTH00000009']);
});

Deno.test('classifyInput: dedupes case-insensitively, preserving first-seen order', () => {
  const { parsed, duplicates } = classifyInput('ASYNTH00000002\nasynth00000002\nASYNTH00000009');
  assertEquals(parsed, ['ASYNTH00000002', 'ASYNTH00000009']);
  assertEquals(duplicates, ['ASYNTH00000002']);
});

Deno.test('classifyInput: separates invalid lines from valid ones', () => {
  const { parsed, invalid } = classifyInput('ASYNTH00000002\ngarbage line\nASYNTH00000009');
  assertEquals(parsed.length, 2);
  assertEquals(invalid, ['garbage line']);
});

Deno.test('classifyInput: mixed bare IDs, URLs and CSV rows in one paste', () => {
  const text = [
    'seller_id,note',
    'ASYNTH00000002,first',
    'https://www.amazon.com/sp?me=ASYNTH00000009',
    'Some Store;ASYNTH00000008',
    'oops',
  ].join('\n');
  const { parsed, invalid } = classifyInput(text);
  assertEquals(parsed, ['ASYNTH00000002', 'ASYNTH00000009', 'ASYNTH00000008']);
  assertEquals(invalid, ['oops']);
});

Deno.test('classifyInput: caps the reject samples it echoes back', () => {
  const text = Array.from({ length: 120 }, (_, i) => `bad line ${i}`).join('\n');
  const { invalid, parsed } = classifyInput(text, 50);
  assertEquals(parsed.length, 0);
  assertEquals(invalid.length, 50);
});

Deno.test('classifyInput: empty input yields nothing rather than throwing', () => {
  const { parsed, invalid, duplicates } = classifyInput('');
  assertEquals(parsed.length, 0);
  assertEquals(invalid.length, 0);
  assertEquals(duplicates.length, 0);
});
