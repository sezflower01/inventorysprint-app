import { ExternalLink, Search, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  googleSearchUrl, resolveSourceUrl, sourcesForBrand, type BrandSourceMap,
} from "@/lib/brandSources";

/**
 * Where to buy this listing's brand: direct links to the user's own retailers,
 * with Google as the fallback.
 *
 * Shared by all three listing views (To review, Seller catalogue, New since
 * 2 Sep) so the same brand never offers different links depending on which tab
 * it is looked at from.
 *
 * ---- GOOGLE IS NEVER REMOVED -------------------------------------------
 *
 * It sits on every row whatever else is there. A direct link can come up empty
 * -- the retailer dropped the line, the search term does not match their
 * catalogue -- so Google is the backstop for that, not merely a placeholder
 * until sources exist.
 *
 * ---- EVERY ROW SHOWS A SOURCE SLOT -------------------------------------
 *
 * A brand with no saved source renders "Unavailable" rather than nothing.
 * Rendering nothing made the feature invisible: there was no way to tell a
 * brand that needs a source from one the app never supported, so the whole
 * thing read as absent. A slot on every row makes the gap legible and tells
 * you which brands are still worth setting up.
 *
 * ---- WHAT "UNAVAILABLE" MEANS ------------------------------------------
 *
 * It means NO SOURCE IS SAVED for this brand. It does NOT mean a link was
 * tested and found dead -- the browser cannot fetch a retailer to check,
 * cross-origin requests are blocked, and claiming otherwise would assert
 * something we never verified. The tooltip says which brand is missing, so
 * the fix is one step away.
 *
 * ---- A BROKEN LINK STAYS VISIBLE ---------------------------------------
 *
 * Nothing validates that a retailer still resolves, and that is on purpose: a
 * source whose URL has broken should be seen and fixed, not quietly hidden.
 * Hiding it would present "this retailer stopped working" and "you never added
 * one" as the same state.
 */

const INLINE_LIMIT = 2;

export function SourceButtons({
  brand,
  title,
  sourceMap,
  size = "sm",
}: {
  brand: string | null | undefined;
  title: string | null | undefined;
  sourceMap: BrandSourceMap;
  size?: "sm" | "xs";
}) {
  const sources = sourcesForBrand(sourceMap, brand);
  // Falls back to the brand: SP-API sometimes resolves a title a cycle after
  // detection, and a brand search still beats no button at all.
  const google = googleSearchUrl(title || brand);

  const pad = size === "xs" ? "h-6 px-2 text-[11px]" : "h-7 px-2.5 text-xs";
  const inline = sources.slice(0, INLINE_LIMIT);
  const overflow = sources.slice(INLINE_LIMIT);

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {inline.map((s) => (
        <Button key={s.retailer_id} asChild type="button" variant="outline" className={pad}>
          <a
            href={resolveSourceUrl(s.template, { brand, title })}
            target="_blank"
            rel="noopener noreferrer"
            // The note is the caveat that matters at the moment of clicking --
            // "case pack only", "clearance aisle" -- so it rides the link.
            title={s.note ? `${s.label} — ${s.note}` : s.label}
          >
            <ExternalLink className="mr-1 h-3 w-3" />
            {s.label}
            {s.note && <span className="ml-1 text-muted-foreground">*</span>}
          </a>
        </Button>
      ))}

      {overflow.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" className={pad}>
              +{overflow.length}
              <ChevronDown className="ml-0.5 h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            {overflow.map((s) => (
              <DropdownMenuItem key={s.retailer_id} asChild>
                <a
                  href={resolveSourceUrl(s.template, { brand, title })}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex flex-col items-start gap-0.5"
                >
                  <span className="flex items-center gap-1.5 text-xs">
                    <ExternalLink className="h-3 w-3" /> {s.label}
                  </span>
                  {s.note && (
                    <span className="text-[11px] text-muted-foreground">{s.note}</span>
                  )}
                </a>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {sources.length === 0 && (
        <span
          className={`inline-flex shrink-0 items-center rounded border border-dashed px-2 text-muted-foreground ${
            size === "xs" ? "h-6 text-[11px]" : "h-7 text-xs"
          }`}
          title={
            brand
              ? `No purchase source saved for "${brand}". Add one under Purchase sources on the Add sellers tab.`
              : "No brand on this listing, so no purchase source can be matched."
          }
        >
          Unavailable
        </span>
      )}

      {google ? (
        <Button
          asChild
          type="button"
          variant="outline"
          className={pad}
        >
          <a
            href={google}
            target="_blank"
            rel="noopener noreferrer"
            title="Search Google for this product"
            aria-label="Search Google for this product"
          >
            <Search className="mr-1 h-3 w-3" />
            Google
          </a>
        </Button>
      ) : (
        // Kept rather than hidden so the row does not silently lose its action.
        <span className="shrink-0 text-xs text-muted-foreground" title="No title captured yet">
          No title yet
        </span>
      )}
    </div>
  );
}
