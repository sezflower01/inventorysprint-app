import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { EligibilityStatus } from "@/components/common/EligibilityBadge";

export interface NewListing {
  id: string;
  watch_id: string;
  seller_id: string;
  marketplace: string;
  asin: string;
  title: string | null;
  brand: string | null;
  image_url: string | null;
  upc: string | null;
  detected_at: string;
  source_status: "unsourced" | "sourcing" | "candidates_found" | "sourced" | "no_candidates" | "expired";
  /** Passed auto-source qualification. false = deliberately never searched. */
  qualified: boolean | null;
  disqualified_reason: string | null;
  /**
   * Amazon sell price in cents, captured during detection by a Keepa call
   * check-seller-watchlist already makes. Shown beside the search button as
   * the "is this worth clicking" signal. Null = capture did not happen.
   *
   * The candidate columns (candidates, sourced_candidate,
   * rejected_candidate_urls), strict_reason, the offer counts and
   * total_fees_cents were dropped from this type on 2026-08-19 with the
   * automated search pipeline. The COLUMNS still exist -- removing them is a
   * separate destructive migration -- but declaring fields that SELECT_COLS no
   * longer fetches made the query's inferred row type disagree with this
   * interface, which is what produced the overload errors.
   */
  amazon_price_cents: number | null;
  new_price_cents: number | null;
  /**
   * Live FBA offers on the ASIN, from the same Keepa call as the price.
   *
   * Kept as a display signal after strict mode was removed, because it is a
   * STRONGER "is this worth clicking" cue than price alone: price says what it
   * sells for, this says whether the listing is competitive at all. It also
   * retroactively justifies the offers=20 call shape (5-6 tokens vs 1) --
   * without a consumer that upgrade was buying nothing.
   *
   * Counts FBA only, never FBM. Measured 2026-08-19: Keepa's free COUNT_NEW
   * conflates the two, and two of three sampled ASINs had a non-zero
   * COUNT_NEW with ZERO FBA offers.
   */
  fba_offer_count: number | null;
}


const SELECT_COLS =
  "id, watch_id, seller_id, marketplace, asin, title, brand, image_url, upc, detected_at, " +
  "source_status, qualified, disqualified_reason, " +
  // Price is the one signal kept from the automated era: it costs nothing,
  // since check-seller-watchlist captures it from a Keepa call it already
  // makes, and it answers "is this worth clicking" before opening a search.
  //
  // candidates / sourced_candidate / rejected_candidate_urls / strict_reason /
  // the offer counts are deliberately NOT selected -- the columns still exist
  // (dropping them is a separate, destructive migration) but nothing reads
  // them now that search is manual.
  "amazon_price_cents, new_price_cents, fba_offer_count, " +
  "is_my_brand, my_brand_units, my_brand_asins";

/** Sourcer sends 20 per call; check-product-eligibility is built for batches. */
const ELIGIBILITY_BATCH = 20;

/**
 * Rows fetched per tab.
 *
 * Was 50, inherited from the original single shared query and never revisited.
 * The database does not care -- (user_id, detected_at DESC) is indexed and RLS
 * already scopes by user -- so this is a UI choice, raised to make a backlog
 * browsable.
 */
// How far back the review tab looks.
//
// Automated Find Source was deleted on 2026-08-19, so nothing moves rows out of
// this tab any more -- it only ever grows. Counting every row ever detected made
// the badge read 5,624 and climbing, which looks like a queue falling further
// behind rather than a list of recent detections worth a glance.
//
// Older rows are NOT deleted or hidden from the database; they are counted
// separately and reported, so the number is bounded without anything going
// quietly missing.
const REVIEW_WINDOW_DAYS = 30;

// Sourcing filter: only listings whose brand the user already carries.
//
// Matched in the database (see seller_new_listings_branded) rather than by
// pulling the brand list into the browser -- 1,484 brands as an `.in(...)`
// would be ~20KB of URL, past what proxies reliably accept, and would fail by
// truncating rather than erroring.
//
// Matches ALL brands ever carried, not just ones in stock: 1,279 of the 1,484
// sit at zero units and those are exactly the ones worth restocking.

const PAGE_SIZE = 200;

/**
 * Ceiling on ASINs auto-checked for eligibility per load.
 *
 * This is the one thing that scaled 1:1 with PAGE_SIZE: every loaded row fed
 * the eligibility fan-out, so raising 50 to 200 would have taken page load from
 * ~3 check-product-eligibility invocations to ~20, every time. Verdicts cache
 * server-side per ASIN so the SP-API work behind them is mostly free on repeat,
 * but the invocations are not.
 *
 * The cap is applied to the most recent rows, which are the ones being triaged.
 * Older rows simply render without a badge -- EligibilityBadge returns null for
 * an unknown status -- rather than showing a wrong or invented one.
 */
const MAX_ELIGIBILITY_ASINS = 60;

export function useSellerNewListings() {
  const [done, setDone] = useState<NewListing[]>([]);
  const [pending, setPending] = useState<NewListing[]>([]);
  /** Total finished rows, which exceeds `done.length` whenever PAGE_SIZE bites. */
  const [doneTotal, setDoneTotal] = useState(0);
  /** Total queued rows, which exceeds `pending.length` whenever PAGE_SIZE bites. */
  const [pendingTotal, setPendingTotal] = useState(0);
  /**
   * Queued rows the user can actually act on, i.e. qualified !== false.
   *
   * Kept SEPARATE from pendingTotal on purpose. The two answer different
   * questions and conflating them is what made the panel misleading: the tab
   * badge should say how much work there is, while "Clear in bulk" must say how
   * many rows a purge would really delete -- which is every queued row,
   * disqualified ones included.
   */
  const [pendingQualifiedTotal, setPendingQualifiedTotal] = useState(0);
  const [pendingOlderTotal, setPendingOlderTotal] = useState(0);
  const [myBrandsOnly, setMyBrandsOnly] = useState(false);
  const [loading, setLoading] = useState(false);
  const [eligibility, setEligibility] = useState<Record<string, EligibilityStatus>>({});
  /** `${seller_id}|${marketplace}` -> seller_name, for listings to show their origin. */
  const [sellerNames, setSellerNames] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const reviewCutoff = new Date(Date.now() - REVIEW_WINDOW_DAYS * 86_400_000).toISOString();
      // Applied to the LISTS and to every COUNT. A badge that ignored the
      // filter would report a queue the tab does not show.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const brandFilter = (q: any) => (myBrandsOnly ? q.eq("is_my_brand", true) : q);
      const [
        { data: doneRows, error },
        { data: pendingRows },
        { data: watchRows },
        { count: doneCount },
        { count: pendingCount },
        { count: pendingQualifiedCount },
        { count: pendingOlderCount },
      ] = await Promise.all([
        // DONE and SEARCHING are fetched separately with their own limits.
        // A single combined query ordered by detected_at is exactly what buried
        // completed research: 281 detections in a day pushed the 78 finished
        // rows past a shared 50-row window.
        brandFilter(supabase
          .from("seller_new_listings_branded")
          .select(SELECT_COLS)
          .in("source_status", ["candidates_found", "sourced", "no_candidates"]))
          .order(myBrandsOnly ? "my_brand_units" : "detected_at", { ascending: false, nullsFirst: false })
          .order("detected_at", { ascending: false })
          .limit(PAGE_SIZE),
        brandFilter(supabase
          .from("seller_new_listings_branded")
          .select(SELECT_COLS)
          .in("source_status", ["unsourced", "sourcing"]))
          .order(myBrandsOnly ? "my_brand_units" : "detected_at", { ascending: false, nullsFirst: false })
          .order("detected_at", { ascending: false })
          .limit(PAGE_SIZE),
        // Listing rows carry seller_id but not the seller's NAME -- that lives
        // on the watch. Fetched here so a listing can say who it came from,
        // which is the first thing you need in order to judge it.
        supabase
          .from("seller_watchlist")
          .select("seller_id, marketplace, seller_name")
          .neq("status", "cancelled"),
        // Counted, not fetched. Bulk delete can only ever act on the 50 rows
        // on screen, so the UI has to be able to say "50 of 213" rather than
        // implying a Select-all reached everything.
        brandFilter(supabase
          .from("seller_new_listings_branded")
          .select("id", { count: "exact", head: true })
          .in("source_status", ["candidates_found", "sourced", "no_candidates"])),
        brandFilter(supabase
          .from("seller_new_listings_branded")
          .select("id", { count: "exact", head: true })
          .in("source_status", ["unsourced", "sourcing"])),
        // Counted server-side rather than derived from `pending`, which is one
        // PAGE_SIZE window. Deriving it was the bug: the badge read the page
        // length and so sat at exactly 200 from the moment the queue passed 200,
        // reporting a nearly-empty queue while the table held 8,717 rows.
        brandFilter(supabase
          .from("seller_new_listings_branded")
          .select("id", { count: "exact", head: true })
          .in("source_status", ["unsourced", "sourcing"])
          .eq("qualified", true))
          .gte("detected_at", reviewCutoff),
        // Everything older, counted so it can be reported rather than vanish.
        brandFilter(supabase
          .from("seller_new_listings_branded")
          .select("id", { count: "exact", head: true })
          .in("source_status", ["unsourced", "sourcing"])
          .eq("qualified", true))
          .lt("detected_at", reviewCutoff),
      ]);
      if (error) throw error;
      setDone((doneRows as unknown as NewListing[]) || []);
      setPending((pendingRows as unknown as NewListing[]) || []);
      setDoneTotal(doneCount ?? 0);
      setPendingTotal(pendingCount ?? 0);
      setPendingQualifiedTotal(pendingQualifiedCount ?? 0);
      setPendingOlderTotal(pendingOlderCount ?? 0);

      const names: Record<string, string> = {};
      type WatchNameRow = { seller_id: string; marketplace: string; seller_name: string | null };
      for (const w of (watchRows as WatchNameRow[] | null) ?? []) {
        if (w?.seller_name) names[`${w.seller_id}|${w.marketplace}`] = w.seller_name;
      }
      setSellerNames(names);
    } catch (e) {
      console.error("[useSellerNewListings] refresh failed", e);
    } finally {
      setLoading(false);
    }
  }, [myBrandsOnly]);

  useEffect(() => { refresh(); }, [refresh]);

  /**
   * Auto-check listing eligibility for every visible ASIN.
   *
   * Gating is the first triage question on a new listing -- a restricted ASIN
   * is worth nothing however good the source is -- so this runs on load rather
   * than behind a button. Same edge function and batch size the six existing
   * consumers use (Sourcer, MobileScan, ...), and it caches server-side by
   * ASIN, so re-opening the panel costs nothing.
   *
   * Grouped by marketplace because gating is per-marketplace: the same ASIN can
   * be open in one and restricted in another, so a single blended call would
   * give a confidently wrong answer.
   */
  useEffect(() => {
    const listings = [...done, ...pending];
    if (!listings.length) return;

    const byMarketplace = new Map<string, string[]>();
    let queued = 0;
    for (const l of listings) {
      if (eligibility[l.asin]) continue; // already known or in flight
      // Bounded so the fan-out stops tracking PAGE_SIZE. Both lists are ordered
      // newest-first, so what gets checked is what is actually being triaged.
      if (queued >= MAX_ELIGIBILITY_ASINS) break;
      if (!byMarketplace.has(l.marketplace)) byMarketplace.set(l.marketplace, []);
      const arr = byMarketplace.get(l.marketplace)!;
      if (!arr.includes(l.asin)) { arr.push(l.asin); queued++; }
    }
    if (byMarketplace.size === 0) return;

    let cancelled = false;

    const markAll = (asins: string[], status: EligibilityStatus) =>
      setEligibility((prev) => {
        const next = { ...prev };
        for (const a of asins) next[a] = status;
        return next;
      });

    (async () => {
      for (const [marketplace, asins] of byMarketplace) {
        markAll(asins, "checking");
        for (let i = 0; i < asins.length; i += ELIGIBILITY_BATCH) {
          if (cancelled) return;
          const batch = asins.slice(i, i + ELIGIBILITY_BATCH);
          try {
            const { data, error } = await supabase.functions.invoke("check-product-eligibility", {
              body: { marketplace, asins: batch, force_rescan: false },
            });
            if (error) throw error;
            const results =
              (data as { results?: { asin: string; status: string }[] } | null)?.results ?? [];
            if (cancelled) return;
            setEligibility((prev) => {
              const next = { ...prev };
              for (const r of results) {
                // The function lowercases before returning; anything outside
                // the known set becomes 'error' rather than being rendered raw.
                next[r.asin] =
                  r.status === "approved" ? "approved"
                  : r.status === "approval_required" ? "approval_required"
                  : r.status === "restricted" ? "restricted"
                  : "error";
              }
              // A batch can come back short; leave nothing stuck on "checking".
              for (const a of batch) if (next[a] === "checking") next[a] = "error";
              return next;
            });
          } catch (e) {
            console.error("[useSellerNewListings] eligibility check failed", e);
            if (!cancelled) markAll(batch, "error");
          }
        }
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done, pending]);



  /**
   * Permanently delete listing rows.
   *
   * A real DELETE, not the soft cancel the watchlist uses -- verified safe:
   * nothing in the schema has a foreign key to seller_watch_new_listings(id),
   * so the row is a leaf and takes only its own candidates and
   * rejected_candidate_urls with it.
   *
   * It also does NOT come back. Detection diffs against
   * seller_watchlist.known_asin_list, never against this table, and that list
   * already contains the ASIN -- so a deleted row is not re-detected on the
   * next check. That makes this irreversible from the UI, which is what the
   * confirm dialog is for.
   *
   * Chunked at 100 for the same reason as cancelWatches: the ids ride in the
   * DELETE query string, and a few hundred UUIDs overflow what proxies accept
   * while failing as an opaque server error.
   */
  const deleteListings = useCallback(async (ids: string[]) => {
    if (!ids.length) return 0;
    const CHUNK = 100;
    let removed = 0;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      const { error } = await supabase.from("seller_new_listings_branded").delete().in("id", slice);
      if (error) {
        // Say what actually landed -- a partial delete reported as total
        // failure sends the user back to re-select rows that are already gone.
        await refresh();
        throw new Error(`${error.message} (removed ${removed} of ${ids.length} before failing)`);
      }
      removed += slice.length;
    }
    await refresh();
    return removed;
  }, [refresh]);

  /**
   * Delete every finished row matching a status, server-side.
   *
   * Deliberately NOT "select all then delete the ids": clearing a backlog by id
   * requires first loading every row into the browser, which is exactly the
   * wrong shape for the job -- these rows carry `candidates` JSONB and are the
   * fattest in the table. This deletes by predicate in one request, so it is
   * unaffected by PAGE_SIZE and costs the same whether it removes 20 or 2,000.
   *
   * RLS scopes it: the policy is FOR ALL with `auth.uid() = user_id`, so the
   * filter here is the status only and Postgres restricts the rest.
   *
   * Same permanence as deleteListings -- detection diffs against
   * seller_watchlist.known_asin_list, so nothing deleted here reappears.
   */
  const deleteByStatus = useCallback(async (statuses: NewListing["source_status"][]) => {
    if (!statuses.length) return 0;
    const { count, error } = await supabase
      .from("seller_new_listings_branded")
      .delete({ count: "exact" })
      .in("source_status", statuses);
    if (error) throw new Error(error.message);
    await refresh();
    return count ?? 0;
  }, [refresh]);

  return {
    done, pending, doneTotal, pendingTotal, pendingQualifiedTotal, loading,
    pendingOlderTotal, reviewWindowDays: REVIEW_WINDOW_DAYS,
    myBrandsOnly, setMyBrandsOnly,
    eligibility, sellerNames, deleteListings,
    deleteByStatus, refresh,
  };
}
