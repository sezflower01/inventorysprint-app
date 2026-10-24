import { Helmet } from "react-helmet-async";

// Staging hosts that must never be indexed. Mirrors LOVABLE_HOSTS in main.tsx,
// which still hard-redirects them to the primary domain.
const NOINDEX_HOSTS = ["repricer.lovable.app"];

/**
 * Site-wide social defaults, rendered once near the root.
 *
 * WHY THIS EXISTS
 * ---------------
 * index.html used to carry a full Open Graph block. Because those tags were
 * not Helmet-managed, every page served TWO of each -- the homepage's and its
 * own -- and a crawler picked arbitrarily. Worse, 22 public pages set no OG of
 * their own, so they advertised og:url = the homepage: sharing a blog post
 * showed the homepage's URL and title.
 *
 * The static tags are now marked data-rh="true" so Helmet adopts and replaces
 * them. That fixes the duplication, but on its own it would strip og:image
 * from those 22 pages, which is a real loss for link previews.
 *
 * So this component supplies only what is genuinely the same on every page:
 * the image, the site name, the card type. It deliberately does NOT set
 * og:url, og:title or og:description -- those are per-page or they are wrong,
 * and a wrong og:url is worse than none, because platforms fall back to the
 * real URL and the <title> when it is absent.
 *
 * Rendered above the routes, so any page-level <Helmet> that sets the same
 * property overrides it: react-helmet-async resolves deeper instances last.
 */
const DefaultSeo = () => {
  // Robots lives here rather than in main.tsx, where it was appended straight
  // to <head> outside Helmet. A page could not override it there: NotFound
  // could ask for noindex and the runtime tag would sit beside it saying
  // index, leaving two conflicting directives on every soft 404. Helmet
  // resolves deeper instances last, so a page Helmet now wins outright.
  const host = typeof window !== "undefined" ? window.location.hostname : "";
  const robots = NOINDEX_HOSTS.includes(host)
    ? "noindex, follow"
    : "index, follow, noarchive";

  return (
    <Helmet>
      <meta name="robots" content={robots} />
      <meta name="googlebot" content={robots} />
      <meta property="og:type" content="website" />
      <meta property="og:site_name" content="InventorySprint" />
      <meta property="og:image" content="https://inventorysprint.com/logo-icon.png" />
      <meta property="og:image:width" content="1200" />
      <meta property="og:image:height" content="630" />
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:image" content="https://inventorysprint.com/logo-icon.png" />
    </Helmet>
  );
};

export default DefaultSeo;
