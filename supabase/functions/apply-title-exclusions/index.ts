// Apply the user's title-keyword exclusions to listings ALREADY detected.
//
// WHY A BUTTON AND NOT A SWEEP. Title rules get added over time -- the brand
// list grew the same way -- so a rule added today has no effect on the rows
// detected before it. Qualification runs once, at detection, which is
// deliberate: the verdict and its reason are stored so the worker does a cheap
// indexed read instead of re-deriving it. This function is the explicit way to
// re-run that one rule over history, on demand.
//
// It is NOT wired to a cron and must not be. An automatic sweep would silently
// rewrite stored verdicts every time it ran, destroying exactly the audit trail
// that storing `disqualified_reason` exists to preserve.
//
// ONE DIRECTION ONLY: it excludes, it never re-qualifies.
//
// Removing a keyword does NOT bring back listings that keyword excluded, and
// the UI says so. Restoring them would mean re-running the FULL qualification
// (eligibility, category, brand, UPC, rank) against stored columns -- and
// `eligibility` is not one of them. A restore built only on the columns that
// ARE present would quietly re-qualify restricted ASINs, which is worse than
// the asymmetry. Left as a stated limitation rather than a half-correct fix.
//
// The matcher is imported, never reimplemented. A second copy of the
// word-boundary rule would drift from the one that runs at detection, and the
// symptom -- a listing the preview said would be excluded that then is not --
// would be nearly impossible to trace back here.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { findExcludedTitleTerm } from '../_shared/title-exclusions.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

/** Read in pages so a large history cannot blow the function's memory. */
const PAGE = 1000;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const admin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    // Caller identity comes from the JWT, never from the body. The body decides
    // only whether to write; it can never choose whose listings get rewritten.
    const token = (req.headers.get('Authorization') || '').replace('Bearer ', '');
    const { data: { user }, error: authError } = await admin.auth.getUser(token);
    if (authError || !user) return json({ error: 'Unauthorized' }, 401);

    const body = await req.json().catch(() => ({}));
    const dryRun = body?.dryRun === true;
    // 'mark' (default) flips qualified=false and stores the reason, leaving the
    // row visible with an explanation. 'delete' removes it outright.
    //
    // DELETE IS PERMANENT IN A WAY THAT IS NOT OBVIOUS: detection compares each
    // seller against a stored known-ASIN baseline, and that baseline is updated
    // whether or not a listing row survives. So a deleted listing is never
    // re-detected -- not on the next check, and not if the user later removes
    // the very term that matched it. Defaulting to 'mark' keeps the destructive
    // path opt-in, and the dryRun preview in front of it is the safeguard.
    const mode: 'mark' | 'delete' = body?.mode === 'delete' ? 'delete' : 'mark';

    // Which of the user's own rules to apply. Defaults to title_keyword ALONE
    // so the Excluded Title Words card, which has always called this endpoint
    // with no `kinds`, keeps doing exactly what its label promises. A card
    // about words must not silently start deleting on brand rules.
    //
    // The queue-side button passes both, because from there the user is
    // clearing listings they do not want, not administering one rule list.
    const requested: string[] = Array.isArray(body?.kinds) && body.kinds.length
      ? body.kinds.map((k: unknown) => String(k))
      : ['title_keyword'];
    const kinds = requested.filter((k) => k === 'title_keyword' || k === 'brand');
    if (!kinds.length) return json({ error: 'kinds must include title_keyword and/or brand' }, 400);

    // Same effective set the seller-watch worker uses: own + shared - muted.
    // Applying only the user's own terms here would make "apply to existing
    // listings" quietly weaker than the live filter.
    const { data: allTerms, error: termErr } = await admin
      .rpc('get_effective_excluded_terms_for', { p_user: user.id });
    if (termErr) return json({ error: termErr.message }, 500);
    const termRows = ((allTerms ?? []) as Array<{ kind: string; value: string; label: string | null }>)
      .filter((t) => kinds.includes(t.kind as typeof kinds[number]));

    // `label` is what the user typed and is what the reason should name; `value`
    // is the normalised form. The matcher normalises either way, so preferring
    // the label costs nothing and keeps the stored reason readable.
    const rows_ = (termRows ?? []) as Array<{ kind: string; value: string; label?: string }>;
    const terms = rows_
      .filter((t) => t.kind === 'title_keyword')
      .map((t) => String(t.label || t.value))
      .filter(Boolean);

    // Brands are matched EXACTLY, never as a substring -- "Generic" excludes
    // "Generic" and not "Generic Electric". Built from `value` (the normalised
    // form) rather than `label`, and compared against the row's brand lowercased
    // and trimmed. That mirrors qualifyListing byte for byte:
    //
    //     const brand = (input.brand || '').trim().toLowerCase();
    //     if (brand && brands.has(brand)) ...
    //
    // Case-folded, exactly as qualifyListing now folds it. The point is still
    // that the sweep and detection must agree -- when this was written they
    // agreed on being broken, because the UI stores brands verbatim ("Generic")
    // while the matcher lowercases only the listing's brand. Folding both sides
    // is what makes them agree on being right.
    const brandSet = new Set(
      rows_
        .filter((t) => t.kind === 'brand')
        .map((t) => String(t.value).trim().toLowerCase())
        .filter(Boolean),
    );

    // No rules is a valid state, not an error, and must be a no-op that touches
    // no rows at all.
    if (!terms.length && !brandSet.size) {
      return json({ scanned: 0, matched: 0, updated: 0, deleted: 0, byTerm: {}, dryRun, mode, kinds });
    }

    let scanned = 0;
    // `reason` is the full stored verdict (excluded_brand:x / excluded_title:y)
    // so mark mode writes exactly what detection would have written, and the
    // per-term breakdown the UI shows names the rule that actually fired.
    const matches: Array<{ id: string; term: string; reason: string }> = [];
    const byTerm: Record<string, number> = {};

    // Only rows still counted as qualified can change. A row already excluded
    // for another reason keeps that reason -- overwriting it would swap one
    // accurate stored verdict for another equally true one and lose the first.
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await admin
        .from('seller_watch_new_listings')
        .select('id, title, brand')
        .eq('user_id', user.id)
        .eq('qualified', true)
        .order('detected_at', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) return json({ error: error.message }, 500);
      if (!data?.length) break;

      scanned += data.length;
      for (const row of data as Array<{ id: string; title: string | null; brand: string | null }>) {
        // Brand BEFORE title, matching qualifyListing's own order, so a listing
        // tripping both is recorded under the same rule detection would name.
        const brand = (row.brand || '').trim().toLowerCase();
        if (brand && brandSet.has(brand)) {
          matches.push({ id: row.id, term: brand, reason: `excluded_brand:${brand}` });
          byTerm[brand] = (byTerm[brand] ?? 0) + 1;
          continue;
        }
        const term = terms.length ? findExcludedTitleTerm(row.title, terms) : null;
        if (term) {
          matches.push({ id: row.id, term, reason: `excluded_title:${term}` });
          byTerm[term] = (byTerm[term] ?? 0) + 1;
        }
      }
      if (data.length < PAGE) break;
    }

    if (dryRun) {
      return json({ scanned, matched: matches.length, updated: 0, deleted: 0, byTerm, dryRun: true, mode, kinds });
    }

    // Grouped by term so each write carries the reason that actually fired
    // rather than a generic one: "excluded_title:pokemon" tells the user which
    // of their own rules did this.
    let updated = 0;
    const groups = new Map<string, string[]>();
    for (const m of matches) {
      const list = groups.get(m.reason) ?? [];
      list.push(m.id);
      groups.set(m.reason, list);
    }
    for (const [reason, ids] of groups) {
      for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        // user_id is repeated on the write even though the ids came from a
        // user-scoped read. Belt and braces on a service-role client, where a
        // future edit to the read is the only thing standing between this and
        // another account's rows.
        const { error } = mode === 'delete'
          ? await admin
              .from('seller_watch_new_listings')
              .delete()
              .eq('user_id', user.id)
              .in('id', chunk)
          : await admin
              .from('seller_watch_new_listings')
              .update({ qualified: false, disqualified_reason: reason })
              .eq('user_id', user.id)
              .in('id', chunk);
        if (error) return json({ error: error.message, updated, mode }, 500);
        updated += chunk.length;
      }
    }

    console.log(
      `[apply-title-exclusions] user=${user.id} mode=${mode} kinds=${kinds.join(',')} scanned=${scanned} affected=${updated}`,
      JSON.stringify(byTerm),
    );
    return json({
      scanned,
      matched: matches.length,
      updated: mode === 'mark' ? updated : 0,
      deleted: mode === 'delete' ? updated : 0,
      byTerm,
      dryRun: false,
      mode,
      kinds,
    });
  } catch (e) {
    console.error('[apply-title-exclusions] failed', e);
    return json({ error: (e as Error).message }, 500);
  }
});
