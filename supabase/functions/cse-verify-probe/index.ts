// TEMPORARY probe. Reports RAW Keepa offer fields so FBA/FBM classification can
// be checked against the source rather than against our own rendering.
//
// Two rules disagree in this codebase:
//   analyzer-product-snapshot :  isFBA && isPrime   ("Keepa over-flags FBA")
//   _shared/strict-mode.ts    :  isFBA
// If Keepa sets isFBA without isPrime on genuine FBA offers, the analyzer shows
// them as FBM and the two surfaces disagree about the same ASIN.
const PROBE_TOKEN = 'v3Nq7xLm2pRw8sKt';

Deno.serve(async (req) => {
  if (req.headers.get('x-probe-token') !== PROBE_TOKEN) {
    return new Response(JSON.stringify({ error: 'nope' }), { status: 401 });
  }
  const KEEPA_KEY = Deno.env.get('KEEPA_API_KEY')!.trim();
  const body = await req.json().catch(() => ({}));
  const asins: string[] = Array.isArray(body.asins) && body.asins.length
    ? body.asins
    : ['B0GYVHLP4L', 'B078ZLHXWX', 'B0FV4WB7VQ'];

  const KEEPA_EPOCH_MS = Date.UTC(2011, 0, 1);
  const nowKeepaMin = Math.floor((Date.now() - KEEPA_EPOCH_MS) / 60000);
  const LIVE_WINDOW_MIN = 7 * 24 * 60;

  const out: Record<string, unknown> = {};
  const results: unknown[] = [];

  for (const asin of asins) {
    const r = await fetch(
      `https://api.keepa.com/product?key=${KEEPA_KEY}&domain=1&asin=${asin}&stats=1&offers=20`,
    );
    const j = await r.json().catch(() => ({}));
    if (j?.error) { results.push({ asin, inBodyError: j.error }); continue; }
    const p = j?.products?.[0];
    const offers: any[] = Array.isArray(p?.offers) ? p.offers : [];
    const liveIdx: number[] = Array.isArray(p?.liveOffersOrder) ? p.liveOffersOrder : [];
    const live = liveIdx.length ? liveIdx.map((i) => offers[i]).filter(Boolean) : offers;

    // Condition 1 == New. Keepa returns every offer ever seen, so the live list
    // and a recency window are both needed before any of this means anything.
    const newLive = live.filter((o) => o?.condition === 1 || o?.condition === 0 || o?.condition == null);
    const recent = newLive.filter((o) => {
      const ls = Number(o?.lastSeen ?? 0);
      return !ls || nowKeepaMin - ls <= LIVE_WINDOW_MIN;
    });

    const looseFBA = recent.filter((o) => o.isFBA === true);
    const strictFBA = recent.filter((o) => o.isFBA === true && o.isPrime === true);
    // The population the two rules disagree about -- FBA per Keepa, but NOT
    // prime, so the analyzer renders them FBM.
    const fbaNotPrime = recent.filter((o) => o.isFBA === true && o.isPrime !== true);

    results.push({
      asin,
      title: p?.title?.slice(0, 55) ?? null,
      offersInPayload: offers.length,
      liveOffers: live.length,
      newAndRecent: recent.length,
      classify: {
        looseRule_isFBA_only: looseFBA.length,
        strictRule_isFBA_and_isPrime: strictFBA.length,
        DISAGREEMENT_fba_but_not_prime: fbaNotPrime.length,
      },
      // Raw fields for a handful, so the verdict is checkable rather than trusted.
      sampleRaw: recent.slice(0, 6).map((o) => ({
        sellerId: o.sellerId,
        isFBA: o.isFBA ?? null,
        isPrime: o.isPrime ?? null,
        isAmazon: o.isAmazon ?? null,
        condition: o.condition ?? null,
        lastSeenDaysAgo: o.lastSeen ? Math.round((nowKeepaMin - o.lastSeen) / 1440) : null,
      })),
    });
  }

  out.results = results;
  const totalDisagree = results.reduce(
    (n: number, r: any) => n + (r?.classify?.DISAGREEMENT_fba_but_not_prime ?? 0), 0);
  out.verdict = totalDisagree === 0
    ? 'isPrime never differs from isFBA in this sample -- the strict rule is NOT causing FBM misclassification. FBM-heavy results reflect the real marketplace.'
    : `${totalDisagree} offer(s) are isFBA WITHOUT isPrime -- the analyzer renders these as FBM while strict-mode counts them as FBA. The two surfaces disagree.`;

  return new Response(JSON.stringify(out, null, 2), { headers: { 'Content-Type': 'application/json' } });
});
