import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Loader2, ExternalLink, Package, Search, Store, Trash2, ChevronDown } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useSellerNewListings, type NewListing } from "@/hooks/use-seller-new-listings";
import EligibilityBadge from "@/components/common/EligibilityBadge";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";

/**
 * Manual source search, replacing the automated pipeline removed 2026-08-19.
 *
 * TITLE ONLY, deliberately -- not the UPC. Measured: UPC search is precise but
 * low-recall, because most retail pages show the product NAME prominently and
 * never print the raw UPC in indexable text. On a live check a UPC query matched
 * only two foreign resellers while the title alone found walmart.com and
 * bathandbodyworks.com directly.
 *
 * Opens in a new tab. rel="noopener" matters: without it the opened page gets a
 * handle back to this one via window.opener.
 */
function googleSearchUrl(title: string | null): string | null {
  const q = (title ?? "").trim();
  if (!q) return null;
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
}

/** Amazon sell price, captured during detection by a Keepa call that already runs. */
function formatAmazonPrice(l: NewListing): string | null {
  const cents = l.new_price_cents ?? l.amazon_price_cents;
  if (typeof cents !== "number" || cents <= 0) return null;
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * FBA competition on the listing, from the same Keepa call as the price.
 *
 * A stronger "worth clicking" cue than price alone -- price says what it sells
 * for, this says whether it is competitive at all. ZERO is meaningful and is
 * shown, not hidden: no FBA sellers usually means private-label or exclusive,
 * which is the clearest possible signal NOT to spend time on it.
 *
 * null means offers were never captured (Keepa refused, or the run ran out of
 * time). That is unknown, not zero, so it renders nothing rather than "0".
 */
function formatFbaOffers(l: NewListing): string | null {
  const n = l.fba_offer_count;
  if (typeof n !== "number" || n < 0) return null;
  return n === 1 ? "1 FBA seller" : `${n} FBA sellers`;
}

const MARKETPLACE_DOMAIN: Record<string, string> = {
  US: "amazon.com", CA: "amazon.ca", MX: "amazon.com.mx", BR: "amazon.com.br",
  UK: "amazon.co.uk", GB: "amazon.co.uk", DE: "amazon.de", FR: "amazon.fr",
  IT: "amazon.it", ES: "amazon.es", JP: "amazon.co.jp", IN: "amazon.in",
};
function amazonListingUrl(asin: string, marketplace: string): string {
  const host = MARKETPLACE_DOMAIN[marketplace.toUpperCase()] || "amazon.com";
  return `https://www.${host}/dp/${asin}`;
}

/**
 * The seller's STOREFRONT (their listings), not their profile page.
 *
 * Two shapes exist in this codebase: send-email uses `/sp?seller=` (the
 * profile, with feedback and business details) and OffersTable uses
 * merchant-items (their actual catalogue). From a new-listing row the useful
 * destination is what else they are selling, so this follows OffersTable --
 * but marketplace-aware, where that one hardcodes amazon.com and a US
 * marketplace id.
 */
function amazonStorefrontUrl(sellerId: string, marketplace: string): string {
  const host = MARKETPLACE_DOMAIN[marketplace.toUpperCase()] || "amazon.com";
  return `https://www.${host}/s?i=merchant-items&me=${encodeURIComponent(sellerId)}`;
}

/**
 * Turn a stored disqualified_reason into something a person can act on.
 *
 * The raw values carry a payload after a colon (`excluded_group:dvd`,
 * `rank_over_500000:1254159`) because the worker records what it actually saw
 * rather than a generic label -- that detail is the difference between "some
 * rule blocked this" and "this is rank 1.2M, far past your ceiling".
 */
function formatDisqualifiedReason(raw: string | null): string {
  if (!raw) return "Not searchable";
  const [kind, detail] = raw.split(":");
  switch (kind) {
    case "restricted":
      return "Restricted — cannot be sold";
    case "needs_approval_excluded":
      return "Needs approval — excluded by your setting";
    case "no_upc":
      return "No UPC — nothing to search with";
    case "excluded_group":
      return `Excluded category${detail ? `: ${detail}` : ""}`;
    case "rank_over_500000":
      return detail
        ? `Sales rank ${Number(detail).toLocaleString()} — over the 500,000 limit`
        : "Sales rank over the limit";
    case "expired":
      return "Expired unsearched after 5 days";
    default:
      return raw;
  }
}



/**
 * Delete queued listings matching the user's own excluded title words OR
 * excluded brands. Both are the user's own rules, as opposed to Amazon's
 * restricted/needs-approval state, which changes and is never deleted here.
 *
 * The same sweep exists on the Excluded Title Words card in the settings
 * column, and that is the wrong place to need it. You notice a listing you do
 * not want while looking AT the queue, so the action to remove it belongs on
 * the queue -- not two panels away, behind a card about word lists.
 *
 * Counts first, always. The dry run uses the exact matcher the delete uses, so
 * the number in the dialog is the number that goes. That matters more here than
 * on the settings card: from this tab the user is reacting to something they
 * just saw, not deliberately administering rules.
 *
 * Deleting is permanent in a way worth restating in the dialog: detection
 * compares each seller against a stored known-ASIN baseline that updates
 * whether or not a listing row survives, so these are not re-detected -- and do
 * not return if the matching word is later removed.
 */
function DeleteMatchingExcludedWords({ onDone }: { onDone: () => void }) {
  const { toast } = useToast();
  const [running, setRunning] = useState(false);
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<{ matched: number; byTerm: Record<string, number> } | null>(null);

  const run = async (dryRun: boolean) => {
    setRunning(true);
    try {
      const { data, error } = await supabase.functions.invoke("apply-title-exclusions", {
        body: { dryRun, mode: "delete", kinds: ["title_keyword", "brand"] },
      });
      if (error) throw new Error(error.message);
      if (data?.error) throw new Error(data.error);
      if (dryRun) {
        setPreview({ matched: data?.matched ?? 0, byTerm: data?.byTerm ?? {} });
        setOpen(true);
      } else {
        setOpen(false);
        setPreview(null);
        toast({ title: `Deleted ${(data?.deleted ?? 0).toLocaleString()} matching listing(s)` });
        onDone();
      }
    } catch (e) {
      toast({ title: "Could not check listings", description: (e as Error).message, variant: "destructive" });
    } finally {
      setRunning(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 text-xs"
        disabled={running}
        onClick={() => run(true)}
      >
        {running && !open ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : null}
        Matching your excluded words or brands
      </Button>

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {preview?.matched
                ? `Delete ${preview.matched.toLocaleString()} queued listing${preview.matched === 1 ? "" : "s"}?`
                : "Nothing matches your excluded words or brands"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {preview?.matched ? (
                <>
                  These queued listings match one of your excluded title words or excluded brands. Deleting is
                  permanent: they are not re-detected on the next seller check, and they do not
                  come back if you later remove the word that matched them. Finished results on
                  the Done tab are not affected.
                </>
              ) : (
                <>
                  No queued listing matches any of your excluded title words or brands, so there is nothing
                  to delete.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {preview?.matched ? (
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(preview.byTerm).map(([term, n]) => (
                <Badge key={term} variant="outline" className="font-normal">
                  {term} - {n.toLocaleString()}
                </Badge>
              ))}
            </div>
          ) : null}

          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            {preview?.matched ? (
              <AlertDialogAction
                onClick={(e) => {
                  // Keep the dialog open while the delete runs; run() closes it.
                  e.preventDefault();
                  void run(false);
                }}
              >
                {running ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : null}
                Delete {preview.matched.toLocaleString()}
              </AlertDialogAction>
            ) : null}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export default function NewListingsPanel() {
  const { done, pending, doneTotal, pendingTotal, pendingQualifiedTotal, pendingOlderTotal, reviewWindowDays, myBrandsOnly, setMyBrandsOnly, loading, eligibility, sellerNames, deleteListings, deleteByStatus, refresh } = useSellerNewListings();
  const [tab, setTab] = useState("done");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [removing, setRemoving] = useState(false);
  const { toast } = useToast();

  // Selection is cleared when the tab changes. One Set backs both tabs, and a
  // "Remove 40" that silently included rows from the tab you are not looking at
  // is exactly the kind of surprise a delete button must never spring.
  const changeTab = (v: string) => {
    setTab(v);
    setSelected(new Set());
  };

  const toggleAll = (ids: string[], checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };

  const toggleOne = (id: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const removeIds = async (ids: string[], label: string) => {
    setRemoving(true);
    try {
      const n = await deleteListings(ids);
      setSelected((prev) => {
        const next = new Set(prev);
        for (const id of ids) next.delete(id);
        return next;
      });
      toast({ title: `${label} ${n.toLocaleString()} listing${n === 1 ? "" : "s"}` });
    } catch (e) {
      toast({ title: "Could not remove listings", description: (e as Error).message, variant: "destructive" });
    } finally {
      setRemoving(false);
    }
  };

  const purge = async (statuses: Parameters<typeof deleteByStatus>[0], label: string) => {
    setRemoving(true);
    try {
      const n = await deleteByStatus(statuses);
      setSelected(new Set());
      toast({ title: `Deleted ${n.toLocaleString()} ${label}` });
    } catch (e) {
      toast({ title: "Could not delete listings", description: (e as Error).message, variant: "destructive" });
    } finally {
      setRemoving(false);
    }
  };

  // Deliberately NOT returning null when empty. The panel used to vanish
  // entirely with no listings, which made the ROI filter look unbuilt rather
  // than un-fed -- and "empty" is the EXPECTED state for days after re-seeding
  // a watchlist, since a seller's first check records a baseline and produces
  // no listings by design. The controls stay visible and the content area says
  // what is actually happening.
  const isEmpty = !loading && done.length === 0 && pending.length === 0;

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold">New listings</h2>
        </div>

        <Tabs value={tab} onValueChange={changeTab}>
          {/*
            OUTSIDE TabsList. Placed inside it first and it was clipped --
            TabsList is an inline-flex strip sized for triggers, not arbitrary
            controls, so the button rendered but could not be seen.

            Governs BOTH tabs and every count, matched in the database (see
            seller_new_listings_branded) rather than by shipping 1,484 brand
            names to PostgREST as a filter.

            ⚠️ A match is NOT automatically a good lead. Publishers and studios
            dominate the matches -- Simon & Schuster, WARNER BROS, UNIVERSAL --
            because selling one book once records its publisher as a "brand".
            Of 151 matches on 2026-08-30, only the first handful (Milwaukee 154
            units, Scholastic 13, Nintendo 7) were brands actually stocked. So
            matched rows carry their held-unit count and sort by it: the filter
            narrows the field, the number tells you which end to work from.
          */}
          <div className="mb-3 flex items-center gap-2">
            <Button
              type="button"
              variant={myBrandsOnly ? "default" : "outline"}
              size="sm"
              className="h-8"
              onClick={() => setMyBrandsOnly(!myBrandsOnly)}
              title="Show only listings whose brand you already carry"
            >
              {myBrandsOnly ? "My brands only" : "All brands"}
            </Button>
            {myBrandsOnly && (
              <span className="text-xs text-muted-foreground">
                Sorted by how many ASINs of that brand you have carried. Zero
                stock is fine — a brand you sold through is still a brand you
                know. One ASIN usually means a publisher matched by accident.
              </span>
            )}
          </div>

          <TabsList className="mb-3">
            {/*
              Badges show SERVER-SIDE totals, never `done.length` / `pending.length`.
              Those are one PAGE_SIZE window, so the queued badge sat at exactly 200
              from the moment the backlog passed 200 -- it read as a nearly-empty
              queue while the table held 8,717 rows and 6,166 of them were actionable.

              The queued badge counts QUALIFIED rows only: a disqualified listing is
              never going to be worked, so counting it promises work that will not
              happen. The full queued figure still appears on "Clear in bulk", which
              is the one place it is the honest number, because a purge deletes
              disqualified rows too.
            */}
            <TabsTrigger value="done" className="gap-2">
              Done
              {doneTotal > 0 && <Badge variant="secondary">{doneTotal.toLocaleString()}</Badge>}
            </TabsTrigger>
            {/*
              "To review", not "Searching".
              Automated Find Source was deleted on 2026-08-19 (commit ee359a3):
              Google CSE returned 403 on every call and SerpAPI's quota ran out,
              so rather than buy search capacity for a judgement reviewed by hand
              anyway, the worker and its cron were removed from the repo and from
              production.
              Nothing has moved a row out of this tab since. Calling it
              "Searching" promised work in progress that cannot happen -- reported
              2026-08-30 as 5,624 rows apparently stuck for over a week. The rows
              are a manual backlog and the count being static is correct.
            */}
            <TabsTrigger value="searching" className="gap-2">
              To review
              <span className="sr-only">last {reviewWindowDays} days</span>
              {pendingQualifiedTotal > 0 && (
                <Badge variant="secondary">{pendingQualifiedTotal.toLocaleString()}</Badge>
              )}
            </TabsTrigger>
          </TabsList>

          {(["done", "searching"] as const).map((key) => {
            const isDone = key === "done";
            const rows = isDone ? done : pending;
            const total = isDone ? doneTotal : pendingTotal;
            // A row with qualified === false will NEVER be searched -- the
            // auto-source worker filters on .eq('qualified', true). Listing it
            // as "Queued" promised work that was never going to happen, which
            // is what made a DVD-heavy seller look like it was flooding the
            // search budget when in fact none of those rows were reachable.
            // Measured 2026-08-17: 2,383 of 2,484 rows are disqualified.
            //
            // Separated rather than hidden: "why is this listing not being
            // searched" is a real question, and disqualified_reason has been
            // stored on every row all along without ever being shown.
            const blocked = isDone ? [] : rows.filter((l) => l.qualified === false);
            let shown = isDone ? rows : rows.filter((l) => l.qualified !== false);

            const ids = rows.map((l) => l.id);
            const allSelected = ids.length > 0 && ids.every((id) => selected.has(id));
            // Only the loaded rows can ever be selected, so the label says so
            // rather than letting "Select all" imply it reached all of them.
            const truncated = total > rows.length;
            return (
              <TabsContent key={key} value={key} className="mt-0 space-y-3">
                {rows.length > 0 && (
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-2">
                    <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
                      <Checkbox
                        checked={allSelected}
                        onCheckedChange={(v) => toggleAll(ids, v === true)}
                        aria-label="Select all listings shown"
                      />
                      <span>
                        Select all shown ({rows.length.toLocaleString()})
                        {truncated && (
                          <span className="text-muted-foreground">
                            {" "}of {total.toLocaleString()}
                          </span>
                        )}
                      </span>
                    </label>

                    {selected.size > 0 && (
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">{selected.size.toLocaleString()} selected</span>
                        <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setSelected(new Set())}>
                          Clear
                        </Button>
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button type="button" variant="destructive" size="sm" className="h-7 text-xs" disabled={removing}>
                              {removing && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                              Remove {selected.size.toLocaleString()}
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>
                                Delete {selected.size.toLocaleString()} listing{selected.size === 1 ? "" : "s"}?
                              </AlertDialogTitle>
                              <AlertDialogDescription>
                                {isDone
                                  ? "Permanently deleted, along with their source candidates."
                                  : "Permanently deleted before they are searched, so they will not spend any of your daily source-search budget."}
                                {" "}They will not come back on the next seller check — detection
                                compares against each seller's known-ASIN baseline, which already
                                includes them. This cannot be undone.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction onClick={() => removeIds(Array.from(selected), "Deleted")}>
                                Delete {selected.size.toLocaleString()}
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    )}
                  </div>
                )}

                {/* Clearing a backlog by predicate, not by selection. These act
                    on every matching row in the database, so they are unaffected
                    by how many are loaded -- which is the whole point: selecting
                    rows first would mean loading hundreds of the fattest rows in
                    the table purely to delete them. */}
                {/* Clear the whole queue by predicate, independent of what is
                    loaded. Deleting queued rows also reclaims search budget --
                    each one the worker never reaches is a search not spent. */}
                {!isDone && pendingTotal > 0 && (
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="text-muted-foreground">Clear in bulk:</span>
                    {/* Placed BEFORE "Everything queued" deliberately: the
                        targeted action should be reached first, since it is
                        almost always the one wanted. */}
                    <DeleteMatchingExcludedWords onDone={refresh} />
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button type="button" variant="outline" size="sm" className="h-7 text-xs" disabled={removing}>
                          Everything queued ({pendingTotal.toLocaleString()})
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>
                            Delete all {pendingTotal.toLocaleString()} queued listing{pendingTotal === 1 ? "" : "s"}?
                          </AlertDialogTitle>
                          <AlertDialogDescription>
                            None of these have been searched yet, so nothing found is lost and none
                            of your daily search budget is spent on them. Finished results on the
                            Done tab are not affected. Permanent, and they will not be re-detected.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction onClick={() => purge(["unsourced", "sourcing"], "queued listings")}>
                            Delete {pendingTotal.toLocaleString()}
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                )}

                {isDone && doneTotal > 0 && (
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="text-muted-foreground">Clear in bulk:</span>


                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button type="button" variant="outline" size="sm" className="h-7 text-xs" disabled={removing}>
                          Everything done ({doneTotal.toLocaleString()})
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>
                            Delete all {doneTotal.toLocaleString()} finished listing{doneTotal === 1 ? "" : "s"}?
                          </AlertDialogTitle>
                          <AlertDialogDescription>
                            This includes listings with source candidates and any you marked as
                            sourced — their saved sources go too. Permanent, and they will not be
                            re-detected. Listings on the To review tab are not affected.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction onClick={() => purge(["candidates_found", "sourced", "no_candidates"], "finished listings")}>
                            Delete {doneTotal.toLocaleString()}
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                )}

                {truncated && (
                  <p className="text-xs text-muted-foreground">
                    Showing the {rows.length} most recent of {total.toLocaleString()}. Remove these
                    to reveal older ones, or use the bulk clear above.
                  </p>
                )}

                {/* The badge counts the last N days only, so anything older has
                    to be stated -- a bounded number that quietly drops rows is
                    just a different kind of dishonest. */}
                {!isDone && pendingOlderTotal > 0 && (
                  <p className="text-xs text-muted-foreground">
                    The count above covers the last {reviewWindowDays} days.{" "}
                    <strong>{pendingOlderTotal.toLocaleString()}</strong> older detection
                    {pendingOlderTotal === 1 ? " is" : "s are"} still stored and can be cleared
                    with the bulk action above. Nothing moves out of this tab on its own —
                    automated source search was removed on 19 Aug 2026.
                  </p>
                )}

                {rows.length === 0 && (
                  <div className="py-8 text-center text-xs text-muted-foreground space-y-1">
                    {isEmpty ? (
                      <>
                        <p className="font-medium text-foreground">No listings yet — seeding in progress</p>
                        <p>
                          A seller's first check records what they already sell; only the SECOND
                          check can show something new. Monitoring runs midnight–6am Pacific.
                        </p>
                        <p>The filter above is live and will apply as soon as listings arrive.</p>
                      </>
                    ) : (
                      {/* Both messages described a source-search worker that
                          was deleted on 2026-08-19 (20260819220000 — Google CSE
                          returned 403 on every call, SerpAPI's quota ran out,
                          and automating a judgement the seller was reviewing by
                          hand anyway was not worth paying for). Search is a
                          manual link per listing now.

                          The old "every detected listing has been searched" was
                          the worse of the two: it asserted work had been done
                          that nothing performs. On 2026-09-02, with 1,243
                          brand-matched listings sitting unsourced, it read as
                          "all clear" and cost a long investigation into a
                          pipeline that had been removed on purpose. */}
                      <p>
                        {key === "done"
                          ? "Nothing here yet. Automated source search was removed in August 2026 — use the Search link on a listing, and ones you source appear here."
                          : "Nothing to review right now."}
                      </p>
                    )}
                  </div>
                )}
                {shown.map((listing) => {

            return (
              <div key={listing.id} className="border-b last:border-b-0 pb-3 last:pb-0">
                <div className="flex items-center gap-3">
                  <Checkbox
                    checked={selected.has(listing.id)}
                    onCheckedChange={(v) => toggleOne(listing.id, v === true)}
                    aria-label={`Select ${listing.title || listing.asin}`}
                    className="shrink-0"
                  />
                  <div className="h-10 w-10 rounded-md bg-muted flex items-center justify-center text-muted-foreground shrink-0 overflow-hidden">
                    {listing.image_url ? (
                      <img src={listing.image_url} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <Package className="h-4 w-4" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-sm font-medium truncate">{listing.title || listing.asin}</span>
                      {/* Gating is the first triage question -- a restricted
                          ASIN is worth nothing however good the source is --
                          so it sits beside the title, not below the fold. */}
                      <EligibilityBadge status={eligibility[listing.asin]} />
                      {/* Shows ASINs carried, not units held, and shows even at
                          zero stock. A brand at 0 units is frequently one sold
                          through and worth restocking -- not a weak lead. What
                          separates a real brand from a publisher that appeared
                          once is BREADTH: Crabtree & Evelyn is 36 ASINs at 0
                          units; Simon & Schuster is one book. */}
                      {myBrandsOnly && (listing as any).my_brand_asins > 0 && (
                        <Badge
                          variant="secondary"
                          className="text-[10px]"
                          title={`You have carried ${(listing as any).my_brand_asins} ASIN(s) of ${listing.brand}; ${(listing as any).my_brand_units} unit(s) in stock now`}
                        >
                          {(listing as any).my_brand_asins} ASIN{(listing as any).my_brand_asins === 1 ? "" : "s"}
                          {(listing as any).my_brand_units > 0
                            ? ` · ${(listing as any).my_brand_units}u`
                            : " · none in stock"}
                        </Badge>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      <a
                        href={amazonListingUrl(listing.asin, listing.marketplace)}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary hover:underline"
                      >
                        {listing.asin}
                      </a>
                      {" "}· detected {new Date(listing.detected_at).toLocaleString()}
                    </div>
                    {/* Amazon sell price, kept from the automated era because
                        it costs nothing -- check-seller-watchlist captures it
                        from a Keepa call it already makes. It is the quick
                        "is this worth clicking" signal now that ROI is judged
                        manually after opening the search. */}
                    {(formatAmazonPrice(listing) || formatFbaOffers(listing)) && (
                      <div className="text-xs">
                        {formatAmazonPrice(listing) && (
                          <>
                            <span className="font-medium">{formatAmazonPrice(listing)}</span>
                            <span className="text-muted-foreground"> on Amazon</span>
                          </>
                        )}
                        {formatFbaOffers(listing) && (
                          <span
                            className={
                              listing.fba_offer_count === 0
                                ? "text-amber-600 dark:text-amber-500"
                                : "text-muted-foreground"
                            }
                            title={
                              listing.fba_offer_count === 0
                                ? "No FBA competition — usually private-label or exclusive"
                                : "Live FBA offers on this ASIN"
                            }
                          >
                            {formatAmazonPrice(listing) ? " · " : ""}
                            {formatFbaOffers(listing)}
                          </span>
                        )}
                      </div>
                    )}
                    {/* Which seller listed it. With hundreds of watched
                        sellers the row is otherwise anonymous, and "who is
                        selling this" is the first thing needed to judge it --
                        falls back to the raw id when the name has not been
                        filled in yet. */}
                    <div className="text-xs text-muted-foreground">
                      from{" "}
                      <a
                        href={amazonStorefrontUrl(listing.seller_id, listing.marketplace)}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary hover:underline inline-flex items-center gap-1"
                        title="Open this seller's storefront on Amazon"
                      >
                        <Store className="h-3 w-3" />
                        {sellerNames[`${listing.seller_id}|${listing.marketplace}`] || listing.seller_id}
                      </a>
                      {" "}({listing.marketplace})
                    </div>
                  </div>
                  {/* Manual search, replacing the automated pipeline. Title
                      only -- see googleSearchUrl. Disabled rather than hidden
                      when there is no title yet, so the row does not silently
                      lose its action: SP-API sometimes resolves the title a
                      cycle after detection. */}
                  {googleSearchUrl(listing.title) ? (
                    <Button asChild type="button" size="sm" variant="outline" className="shrink-0">
                      <a
                        href={googleSearchUrl(listing.title)!}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Search Google for this product title"
                      >
                        <Search className="h-3.5 w-3.5 mr-1" /> Search on Google
                      </a>
                    </Button>
                  ) : (
                    <span className="text-xs text-muted-foreground shrink-0" title="No title captured yet">
                      No title yet
                    </span>
                  )}

                  {/* Single-row delete. No confirm: one row is cheap to lose and
                      the bulk path is where an accident would actually hurt. */}
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                    disabled={removing}
                    onClick={() => removeIds([listing.id], "Deleted")}
                    title="Delete this listing permanently"
                    aria-label={`Delete ${listing.title || listing.asin}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>

              </div>
                );
                })}

                {blocked.length > 0 && (
                  <Collapsible>
                    <CollapsibleTrigger asChild>
                      <button
                        type="button"
                        className="flex w-full items-center justify-between gap-2 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground hover:bg-muted/50"
                      >
                        <span>
                          {blocked.length.toLocaleString()} not searchable — these will never be
                          searched
                        </span>
                        <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                      </button>
                    </CollapsibleTrigger>
                    <CollapsibleContent className="mt-2 divide-y rounded-md border">
                      {/* Compact deliberately: a row that will never be searched
                          has no candidates to show and no source to mark, so the
                          full layout would be mostly empty controls. */}
                      {blocked.map((listing) => (
                        <div key={listing.id} className="flex items-center gap-3 px-3 py-2">
                          <Checkbox
                            checked={selected.has(listing.id)}
                            onCheckedChange={(v) => toggleOne(listing.id, v === true)}
                            aria-label={`Select ${listing.title || listing.asin}`}
                            className="shrink-0"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="truncate text-sm">{listing.title || listing.asin}</span>
                              <EligibilityBadge status={eligibility[listing.asin]} />
                            </div>
                            <div className="text-xs text-muted-foreground truncate">
                              <a
                                href={amazonListingUrl(listing.asin, listing.marketplace)}
                                target="_blank"
                                rel="noreferrer"
                                className="text-primary hover:underline"
                              >
                                {listing.asin}
                              </a>
                              {" "}· {formatDisqualifiedReason(listing.disqualified_reason)}
                            </div>
                          </div>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                            disabled={removing}
                            onClick={() => removeIds([listing.id], "Deleted")}
                            title="Delete this listing permanently"
                            aria-label={`Delete ${listing.title || listing.asin}`}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      ))}
                    </CollapsibleContent>
                  </Collapsible>
                )}
              </TabsContent>
            );
          })}
        </Tabs>
      </CardContent>
    </Card>
  );
}
