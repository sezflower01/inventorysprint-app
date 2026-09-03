import { useState } from "react";
import { ChevronDown, Loader2, Store } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { amazonListingUrl, amazonStorefrontUrl } from "./amazonUrls";

/**
 * One seller row, expandable to the items of theirs that match my brands.
 *
 * Shared by two tabs that answer DIFFERENT questions off the same shape:
 *
 *   Seller catalogue   since = null   -- what they sell now, no date filter
 *   New since 2 Sep    since = a date -- what they genuinely added recently
 *
 * The `since` prop is the only difference, and it is passed straight through
 * to get_seller_brand_items. Keeping one component means the two tabs cannot
 * drift into rendering the same data two different ways -- but they stay two
 * tabs, because merging the QUESTIONS is what made the old "Seller activity"
 * tab misleading.
 */

export interface SellerBrandRow {
  seller_id: string;
  marketplace: string;
  seller_name: string | null;
  /** Items of theirs matching my brands, within this tab's window. */
  count: number;
  /** Catalogue view only: their full ASIN list size, how many of those we are
   *  checking (capped at 1,000), and how many we now have a brand for. */
  catalogueSize?: number | null;
  inScope?: number | null;
  identified?: number | null;
  /** Most recent detection in this tab's window. */
  lastAt: string | null;
}

interface Item {
  asin: string;
  title: string | null;
  brand: string | null;
  image_url: string | null;
  /** NULL when the item came from the brand backfill rather than from a
   *  detection -- most catalogue items were never "detected", they were just
   *  looked up. Rendering it blindly gave "Invalid Date". */
  detected_at: string | null;
  still_listed: boolean;
}

function SellerRow({ row, since }: { row: SellerBrandRow; since: string | null }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Fetched on first expand rather than up front: 111 sellers x their items is
  // a lot of rows to load for a list where the user opens one or two.
  const load = async () => {
    if (items !== null || busy) return;
    setBusy(true);
    setErr(null);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any).rpc("get_seller_brand_items", {
        p_seller_id: row.seller_id,
        p_marketplace: row.marketplace,
        p_since: since,
      });
      if (error) throw error;
      setItems((data as Item[]) || []);
    } catch (e) {
      setErr((e as Error).message || "Could not load this seller's items");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Collapsible onOpenChange={(open) => { if (open) void load(); }}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-muted/50"
        >
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">
              {row.seller_name || row.seller_id}
              {typeof row.catalogueSize === "number" &&
                typeof row.inScope === "number" &&
                row.catalogueSize > row.inScope && (
                  <Badge variant="outline" className="ml-2 text-[10px] font-normal">
                    sample
                  </Badge>
                )}
            </div>
            <div className="text-xs text-muted-foreground">
              {row.count.toLocaleString()} in your brands
              {/* The denominator matters more than the count. A bare "306"
                  beside a 55,330-item catalogue would read as the whole
                  answer when it is drawn from a 1,000-item sample. */}
              {typeof row.inScope === "number" && row.inScope > 0 && (
                <>
                  {" · "}
                  {(row.identified ?? 0).toLocaleString()} of{" "}
                  {row.inScope.toLocaleString()} checked
                  {typeof row.catalogueSize === "number" &&
                    row.catalogueSize > row.inScope && (
                      <> , sampled from {row.catalogueSize.toLocaleString()}</>
                    )}
                </>
              )}
              {row.lastAt && (
                <>
                  {" · "}
                  {new Date(row.lastAt).toLocaleDateString()}
                </>
              )}
              {" · "}{row.marketplace}
            </div>
          </div>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-1 border-t bg-muted/20 px-3 py-2">
          {busy && (
            <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> Loading…
            </div>
          )}
          {err && <p className="py-1 text-xs text-destructive">{err}</p>}
          {items !== null && items.length === 0 && !busy && (
            <p className="py-1 text-xs text-muted-foreground">No items in this window.</p>
          )}
          {(items || []).map((it) => (
            <div key={it.asin} className="flex items-center gap-2 text-xs">
              <a
                href={amazonListingUrl(it.asin, row.marketplace)}
                target="_blank"
                rel="noreferrer"
                className="shrink-0 font-mono text-primary hover:underline"
              >
                {it.asin}
              </a>
              <span className="truncate">{it.title || "(no title)"}</span>
              {it.brand && (
                <Badge variant="outline" className="shrink-0 text-[10px]">{it.brand}</Badge>
              )}
              {/* Only worth saying when it is FALSE -- "still listed" is the
                  normal case and badging every row would be noise. */}
              {!it.still_listed && (
                <Badge variant="secondary" className="shrink-0 text-[10px]">no longer listed</Badge>
              )}
              <span className="ml-auto shrink-0 text-muted-foreground">
                {it.detected_at ? new Date(it.detected_at).toLocaleDateString() : "in catalogue"}
              </span>
            </div>
          ))}
          <a
            href={amazonStorefrontUrl(row.seller_id, row.marketplace)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 pt-1 text-xs text-primary hover:underline"
          >
            <Store className="h-3 w-3" /> Open storefront
          </a>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function SellerBrandList({
  rows,
  since,
}: {
  rows: SellerBrandRow[];
  since: string | null;
}) {
  return (
    <div className="divide-y rounded-md border">
      {rows.map((r) => (
        <SellerRow key={`${r.seller_id}|${r.marketplace}`} row={r} since={since} />
      ))}
    </div>
  );
}
