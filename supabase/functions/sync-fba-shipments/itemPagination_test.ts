import { assert, assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { nextPage } from './itemPagination.ts';

const MAX_PAGES = 20;

function fresh(overrides: Partial<Parameters<typeof nextPage>[0]> = {}) {
  return {
    sentToken: null as string | null,
    receivedToken: undefined as unknown,
    pagesFetched: 1,
    maxPages: MAX_PAGES,
    seenTokens: new Set<string>(),
    ...overrides,
  };
}

Deno.test('REGRESSION: the FBA19RKR64KC loop of 2026-11-18 terminates', () => {
  // Replays what Amazon actually did: every page returns the SAME token, so
  // the old `while (nextToken)` ran 54 times and died on 429 QuotaExceeded.
  const AMAZON_TOKEN = 'aGVsbG8tc2FtZS10b2tlbi1mb3JldmVy';
  const seen = new Set<string>();

  // Page 1: nothing sent yet, so the token looks new and we would advance.
  const first = nextPage(fresh({ sentToken: null, receivedToken: AMAZON_TOKEN, seenTokens: seen }));
  assertEquals(first.advance, true, 'the first token is not yet distinguishable');
  seen.add(AMAZON_TOKEN);

  // Page 2 onwards: the same token comes back. This must stop, every time.
  for (let page = 2; page <= 60; page++) {
    const d = nextPage(fresh({
      sentToken: AMAZON_TOKEN,
      receivedToken: AMAZON_TOKEN,
      pagesFetched: page,
      seenTokens: seen,
    }));
    assertEquals(d.advance, false, `page ${page} must not advance`);
    assert(d.reason.includes('repeated the token'), `unexpected reason: ${d.reason}`);
  }
});

Deno.test('the old rule would have looped (documents the defect)', () => {
  const token = 'same';
  // The old condition was simply `while (nextToken)`.
  assert(Boolean(token), 'a non-empty token was always truthy, whatever it contained');
});

Deno.test('a genuinely different token advances', () => {
  const d = nextPage(fresh({ sentToken: 'page1', receivedToken: 'page2' }));
  assertEquals(d.advance, true);
  assertEquals(d.token, 'page2');
});

Deno.test('a cycle longer than one page is caught', () => {
  const seen = new Set(['a', 'b']);
  const d = nextPage(fresh({ sentToken: 'b', receivedToken: 'a', pagesFetched: 3, seenTokens: seen }));
  assertEquals(d.advance, false);
  assert(d.reason.includes('cycle'));
});

Deno.test('absent, empty and non-string tokens all end the fetch', () => {
  for (const received of [undefined, null, '', 0, false, {}, []]) {
    const d = nextPage(fresh({ sentToken: 'page1', receivedToken: received }));
    assertEquals(d.advance, false, `token ${JSON.stringify(received)} must end the fetch`);
    assertEquals(d.token, null);
  }
});

Deno.test('the page cap stops a novel repeat pattern', () => {
  // Tokens that are always new, so no repeat check fires: only the cap can.
  let seen = new Set<string>();
  let pages = 0;
  let token: string | null = 'start';
  while (token) {
    pages++;
    const d = nextPage(fresh({
      sentToken: token,
      receivedToken: `t${pages}`,
      pagesFetched: pages,
      seenTokens: seen,
    }));
    seen.add(`t${pages}`);
    token = d.advance ? d.token : null;
    assert(pages <= MAX_PAGES + 1, 'the cap must bound this loop');
  }
  assertEquals(pages, MAX_PAGES);
});

Deno.test('INVARIANT: advance is never true without a usable new token', () => {
  const tokens: unknown[] = ['a', 'b', '', null, undefined, 'a', 42];
  for (const sent of ['a', 'b', null]) {
    for (const received of tokens) {
      for (const pagesFetched of [1, 5, MAX_PAGES, MAX_PAGES + 1]) {
        const seen = new Set(['a']);
        const d = nextPage(fresh({ sentToken: sent, receivedToken: received, pagesFetched, seenTokens: seen }));
        if (d.advance) {
          assert(typeof d.token === 'string' && d.token.length > 0, 'advanced with an unusable token');
          assert(d.token !== sent, 'advanced on the token we just sent');
          assert(!seen.has(d.token), 'advanced on a token already seen');
          assert(pagesFetched < MAX_PAGES, 'advanced past the page cap');
        } else {
          assertEquals(d.token, null, 'a refusal must not hand back a token');
        }
      }
    }
  }
});
