/**
 * Amazon URL builders, lifted out of NewListingsPanel so SellerBrandList can
 * use them too.
 *
 * They were local to the panel. Importing them from there would have made a
 * cycle -- the panel renders SellerBrandList, so SellerBrandList must not
 * import the panel.
 */

const MARKETPLACE_DOMAIN: Record<string, string> = {
  US: "amazon.com", CA: "amazon.ca", MX: "amazon.com.mx", BR: "amazon.com.br",
  UK: "amazon.co.uk", GB: "amazon.co.uk", DE: "amazon.de", FR: "amazon.fr",
  IT: "amazon.it", ES: "amazon.es", JP: "amazon.co.jp", IN: "amazon.in",
};

export function amazonListingUrl(asin: string, marketplace: string): string {
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
export function amazonStorefrontUrl(sellerId: string, marketplace: string): string {
  const host = MARKETPLACE_DOMAIN[marketplace.toUpperCase()] || "amazon.com";
  return `https://www.${host}/s?i=merchant-items&me=${encodeURIComponent(sellerId)}`;
}
