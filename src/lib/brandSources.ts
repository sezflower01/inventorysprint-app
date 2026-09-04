/**
 * Resolving a retailer's URL template into a link for one listing.
 *
 * ---- WHY ONE TEMPLATE FIELD AND NOT THREE COLUMNS ----------------------
 *
 * A retailer is reached three different ways depending on the shop: some have
 * a usable brand-search URL, some only really work from the homepage, and for
 * some the product title is the better query. Rather than a `homepage` column,
 * a `search_url` column and a mode flag, there is one template and an optional
 * placeholder:
 *
 *   https://www.walmart.com                        -> homepage, opened as-is
 *   https://www.walmart.com/search?q={brand}       -> that brand
 *   https://www.walmart.com/search?q={title}       -> that exact product
 *
 * No placeholder is not a special case that needs handling -- it is just a
 * template with nothing to substitute.
 *
 * {title} is usually the better choice. Measured while building the Google
 * fallback: a UPC query matched only two foreign resellers, while the title
 * alone found walmart.com and bathandbodyworks.com directly.
 */

export interface BrandSource {
  retailer_id: string;
  /** The user's own spelling, which is how the row is keyed in the database.
   *  The map key is lowercased so it can be matched against a listing's brand;
   *  this addresses the actual row for detach and note edits. */
  brand: string;
  label: string;
  template: string;
  /** 'catalog' = a shop shared by the platform; 'user' = one you added. */
  scope?: "user" | "catalog";
  note: string | null;
}

/** brand (lowercased, trimmed) -> the retailers it is bought from. */
export type BrandSourceMap = Record<string, BrandSource[]>;

/** Amazon's brand string never matches what the user typed byte for byte. */
export function normaliseBrand(brand: string | null | undefined): string {
  return String(brand ?? "").trim().toLowerCase();
}

export function sourcesForBrand(
  map: BrandSourceMap,
  brand: string | null | undefined,
): BrandSource[] {
  const key = normaliseBrand(brand);
  if (!key) return [];
  return map[key] ?? [];
}

/**
 * Substitute the placeholders. Values are percent-encoded, because a brand
 * like "Melissa & Doug" would otherwise terminate the query string at the
 * ampersand and search for "Melissa".
 */
export function resolveSourceUrl(
  template: string,
  opts: { brand?: string | null; title?: string | null },
): string {
  const brand = (opts.brand ?? "").trim();
  // Falling back to the brand rather than emptying the query: a template
  // asking for {title} against a listing whose title has not resolved yet
  // would otherwise open a search for nothing at all.
  const title = (opts.title ?? "").trim() || brand;
  return template
    .replace(/\{brand\}/gi, encodeURIComponent(brand))
    .replace(/\{title\}/gi, encodeURIComponent(title));
}

/** Kept as the fallback, and as the backstop when a direct link comes up dry. */
export function googleSearchUrl(query: string | null | undefined): string | null {
  const q = String(query ?? "").trim();
  if (!q) return null;
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
}

/** For the manager's live preview, and for showing what a template will do. */
export function describeTemplate(template: string): string {
  if (/\{title\}/i.test(template)) return "searches the product title";
  if (/\{brand\}/i.test(template)) return "searches the brand name";
  return "opens this page";
}

/** Tolerates a pasted domain without a scheme, which is how people type them. */
export function normaliseTemplate(raw: string): string {
  const t = raw.trim();
  if (!t) return t;
  return /^https?:\/\//i.test(t) ? t : `https://${t}`;
}

/** Shown on the button, so it must stay short. */
export function retailerHost(template: string): string {
  try {
    return new URL(template.replace(/\{[a-z]+\}/gi, "x")).hostname.replace(/^www\./, "");
  } catch {
    return template;
  }
}
