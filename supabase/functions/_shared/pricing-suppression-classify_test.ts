// classifyIssues(): locator categories are not reasons, and a reason-less
// suppression is judged by its code.
//
// Every payload below is a real one, copied from
// repricer_pricing_suppression_checks.issues_seen (2026-09-30), not invented.
// The B0F6KKKNJ6 case is the one that sent a false review item to the admin
// panel: its only "unknown" bucket was LISTING, which says where the issue
// sits, while its actual reason (QUALIFICATION_REQUIRED) had been understood
// since the first probe.
//
// deno test --allow-net --allow-env --allow-read \
//   supabase/functions/_shared/pricing-suppression-classify_test.ts

import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { classifyIssues } from './pricing-suppression-core.ts';

const suppressed = [{ action: 'LISTING_SUPPRESSED' }];

Deno.test('B0F6KKKNJ6: QUALIFICATION_REQUIRED + LISTING is not an unknown bucket', () => {
  const { pricingIssue, unknownFlagged, unknownCategories } = classifyIssues([
    {
      code: '18616',
      severity: 'WARNING',
      categories: ['MISSING_ATTRIBUTE', 'PRODUCT'],
      message: 'Your product was identified as a chemical that requires a Safety Data Sheet.',
    },
    {
      code: '100332',
      severity: 'ERROR',
      categories: ['QUALIFICATION_REQUIRED', 'LISTING'],
      enforcements: { actions: suppressed },
      message: 'This product has other listing limitations.',
    },
  ]);
  assertEquals(pricingIssue, null);
  assertEquals(unknownFlagged, false);
  assertEquals(unknownCategories, []);
});

Deno.test('a genuinely new reason still flags, and the locator is not reported with it', () => {
  const { unknownFlagged, unknownCategories } = classifyIssues([
    {
      code: '99999',
      severity: 'ERROR',
      categories: ['SOME_NEW_BUCKET', 'LISTING'],
      enforcements: { actions: suppressed },
    },
  ]);
  assert(unknownFlagged);
  assertEquals(unknownCategories, ['SOME_NEW_BUCKET']);
});

Deno.test('13013 (product not in catalog) carries no reason category and stays quiet', () => {
  for (const categories of [[], ['LISTING']]) {
    const { unknownFlagged } = classifyIssues([
      {
        code: '13013',
        severity: 'ERROR',
        categories,
        enforcements: { actions: suppressed },
        message: 'No se puede agregar tu oferta al SKU porque el producto no está en el catálogo.',
      },
    ]);
    assertEquals(unknownFlagged, false, `categories=${JSON.stringify(categories)}`);
  }
});

Deno.test('18977 counterfeit-without-test-buy reaches review, reported by code', () => {
  // Previously invisible: categories is empty, and the old rule required
  // categories.length > 0 before it would consider an issue unknown at all.
  const { unknownFlagged, unknownCategories } = classifyIssues([
    {
      code: '18977',
      severity: 'ERROR',
      categories: [],
      enforcements: { actions: suppressed },
      message: 'Counterfeit without a Test Buy',
    },
  ]);
  assert(unknownFlagged);
  assertEquals(unknownCategories, ['code:18977']);
});

Deno.test('a real pricing suppression is still matched first, and never flagged unknown', () => {
  const { pricingIssue, unknownFlagged } = classifyIssues([
    {
      code: '18155',
      severity: 'ERROR',
      categories: ['INVALID_PRICE', 'INVALID_ATTRIBUTE', 'LISTING'],
      enforcements: { actions: suppressed },
      message: 'Seu preço de venda está abaixo do limite mínimo de preço.',
    },
  ]);
  assert(pricingIssue);
  assertEquals(pricingIssue.code, '18155');
  assertEquals(unknownFlagged, false);
});

Deno.test('a WARNING is never a suppression, however it is categorised', () => {
  const { unknownFlagged } = classifyIssues([
    { code: '18448', severity: 'WARNING', categories: ['MISSING_ATTRIBUTE', 'PRODUCT'] },
    { code: '100477', severity: 'WARNING', categories: ['PRODUCT'], enforcements: { actions: [{ action: 'CATALOG_ITEM_REMOVED' }] } },
  ]);
  assertEquals(unknownFlagged, false);
});
