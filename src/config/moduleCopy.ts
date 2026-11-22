// Per-module marketing copy used by the dynamic /products/modules/:slug page.
// Falls back to a generic template when no override is present.

export type ModuleCopy = {
  tagline: string;
  hero: string;
  bullets: string[];
  how: { title: string; desc: string }[];
  audience: string[];
  cta?: string;
};

export const slugify = (label: string) =>
  label
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

export const MODULE_COPY: Record<string, Partial<ModuleCopy>> = {
  "overview": {
    tagline: "Your business at a glance",
    hero: "A live snapshot of every moving part of your Amazon business — profit, inventory, repricing health, shipments, and the alerts that actually matter.",
    bullets: [
      "Live profit & revenue tiles powered by Settlement + Orders data",
      "Inventory health: available, reserved, inbound, missing-from-report",
      "Repricer pulse: how many ASINs are competitive right now",
      "Shipment status & action queue front-and-center",
    ],
  },
  "inventory-valuation": {
    tagline: "Know exactly what your stock is worth — today",
    hero: "Real-time FBA inventory valuation that combines Summaries (available + reserved) with FBA Reports (inbound) so you always have one trusted number.",
    bullets: [
      "Per-SKU value × quantity, totals by warehouse and by status",
      "FX-aware: US, CA, MX, BR converted to your home currency",
      "Stale-data guard: rejects suspicious zeroes from SP-API hiccups",
      "Default sort by Value Stock for instant 'where is my money' answers",
    ],
  },
  "inventory-restoration": {
    tagline: "One-click safe reconcile",
    hero: "When SP-API gets noisy, Inventory Restoration walks Summaries and the FBA report in safe order to rebuild a trustworthy picture of your stock.",
    bullets: [
      "Summaries first (truth for available + reserved), Report second (inbound)",
      "Double-confirmation before any zero is written",
      "Surfaces what changed, what stayed, and what needs review",
    ],
  },
  "inventory-review-queue": {
    tagline: "Never auto-zero a real SKU again",
    hero: "Any SKU that disappears from the FBA report is queued for human review instead of being silently zeroed. Decide explicitly — or keep prior stock.",
    bullets: [
      "Preserves prior stock until you confirm",
      "Shows last-known available, reserved, inbound and last sync",
      "Keeps a clean audit trail of every decision",
    ],
  },
  "inventory-write-off": {
    tagline: "Turn warehouse losses into clean accounting",
    hero: "Record restricted, dead and expired stock as Business Loss so it flows correctly into P&L without distorting COGS or inventory value.",
    bullets: [
      "Reason codes (restricted, dead, expired, damaged)",
      "Auto-posts to P&L as Business Loss",
      "Per-SKU history with quantity, value, and date",
    ],
  },
  "disposition-management": {
    tagline: "Track every removal and disposal",
    hero: "Reviews Amazon removals, disposals and liquidations in one place and feeds the unsellable losses into your P&L automatically.",
    bullets: [
      "Removals, disposals, liquidations grouped by order",
      "Reconciles units shipped vs. units lost",
      "Loss totals fed into P&L Business Loss",
    ],
  },
  "product-library": {
    tagline: "Your private Amazon catalog — always one click from a reorder",
    hero: "Every product you've ever sourced, organized with supplier links, cost history and quick reorder. Stop digging through spreadsheets to find that one ASIN.",
    bullets: [
      "Saved ASINs with images, titles and last-seen prices",
      "Multiple supplier URLs per product with cost history",
      "Search by ASIN, UPC, supplier or note",
      "One-click jump to supplier site to reorder",
    ],
  },
  "create-listing": {
    tagline: "Build a new Amazon listing without the friction",
    hero: "Guided fields, validation and SP-API submission in one screen — so creating a listing takes minutes instead of hours.",
    bullets: [
      "Required-field validation before submit",
      "Image, dimensions, and category helpers",
      "Direct submission to Amazon SP-API",
    ],
  },
  "profit-and-loss": {
    tagline: "True P&L from Settlement, not estimates",
    hero: "Built on Financial Events Cache (FEC) — the same numbers Amazon settles you with — so revenue, fees, and net profit match Sellerboard to the cent.",
    bullets: [
      "Revenue, fees, refunds, ads, and Business Loss broken out",
      "Per-marketplace and per-month views",
      "FX-aware totals in your home currency",
    ],
  },
  "sales-report": {
    tagline: "Every sale, every refund, every day",
    hero: "Live sales powered by the Orders API with auto gap-detection and nightly settlement reconcile.",
    bullets: [
      "Daily, weekly, monthly, custom-range views",
      "Refunds and unit gaps surfaced clearly",
      "Local-timezone period boundaries",
    ],
  },
  "settlement": {
    tagline: "Amazon settlement, decoded",
    hero: "Browse settlement reports by period with line-item drill-down and FX conversion to your home currency.",
    bullets: [
      "Per-period totals: revenue, fees, reserves",
      "Drill into any settlement line",
      "Marketplace-aware FX",
    ],
  },
  "reimbursements": {
    tagline: "Catch every dollar Amazon owes you",
    hero: "Track FBA reimbursement claims end-to-end — from candidate detection through payout reconciliation.",
    bullets: [
      "Lost, damaged, and overcharged inventory candidates",
      "Status tracking from claim to payout",
      "Reconciles payouts back to original SKU",
    ],
  },
  "my-expenses": {
    tagline: "Tax-ready expense tracking",
    hero: "Categorized business expenses that flow directly into your P&L — no spreadsheets, no surprises at tax time.",
    bullets: [
      "Categories aligned with common tax buckets",
      "Receipt notes and dates per entry",
      "Feeds straight into P&L",
    ],
  },
  "reports-and-accounting": {
    tagline: "Generate the reports your accountant actually wants",
    hero: "P&L, sales, settlement and inventory exports — formatted for accountants and bookkeepers.",
    bullets: [
      "CSV / spreadsheet exports",
      "Date-range and marketplace filters",
      "Repeatable monthly close workflow",
    ],
  },
  "shipment-profit-and-loss": {
    tagline: "Per-shipment profit, fully costed",
    hero: "COGS, Amazon inbound fees, and your manual costs combined into one true profit number per shipment.",
    bullets: [
      "Per-SKU and per-shipment cost breakdown",
      "Inbound placement & prep fees included",
      "Manual cost lines (boxes, labels, freight)",
    ],
  },
  "fba-shipment-builder": {
    tagline: "Build your Amazon shipment plan in minutes",
    hero: "Search your synced inventory and we build a ready-to-ship Amazon inbound plan instantly — no re-typing ASINs in Seller Central. From there, confirm your box split, quantities, dimensions and weight directly in Amazon.",
    bullets: [
      "Pick products straight from your synced inventory",
      "Set prep requirements (polybag, fragile, liquid…) in one screen",
      "We build your ready-to-ship inbound plan instantly",
      "Confirm box split, quantities, dimensions & weight directly in Seller Central",
      "Save drafts and continue any shipment later",
    ],
    how: [
      { title: "Name your shipment", desc: "Pick the marketplace and where it ships from." },
      { title: "Pick products", desc: "Search your synced inventory and tick the items you're sending." },
      { title: "Prep requirements", desc: "Choose prep (polybag, fragile, liquid…) for what you're sending." },
      { title: "We build your plan", desc: "Instantly generates your ready-to-ship Amazon inbound plan." },
      { title: "Confirm in Seller Central", desc: "Confirm your box split — one box, five, or more — set quantities, and enter dimensions & weight directly in Amazon." },
    ],
  },
  "shipment-tracking": {
    tagline: "Where is my shipment, really?",
    hero: "Live FBA shipment status with checkpoint history — no more refreshing Seller Central.",
    bullets: [
      "Status timeline per shipment",
      "Working / Shipped / Receiving / Closed views",
      "Discrepancy flags",
    ],
  },
  "label-printing": {
    tagline: "FNSKU & shipping labels, instantly",
    hero: "Generate Amazon-compliant FNSKU and shipping labels in the right format — print straight to your thermal printer.",
    bullets: [
      "FNSKU, address, and box labels",
      "Multiple paper sizes",
      "Batch printing",
    ],
  },
  "print-without-pdf": {
    tagline: "Skip the PDF middle-step",
    hero: "Direct ZPL/EPL thermal printing — no PDF round-trip, no scaling issues.",
    bullets: [
      "Native thermal printer protocol",
      "Faster than PDF print",
      "Perfect 1:1 label sizing",
    ],
  },
  "worldwide-tracking": {
    tagline: "One tracker for every carrier, anywhere",
    hero: "Track packages from any carrier worldwide — no more bouncing between carrier sites.",
    bullets: [
      "100+ carriers supported",
      "Unified status timeline",
      "Search by tracking number",
    ],
  },
  "repricer": {
    tagline: "AI repricing that protects your margin first",
    hero: "Not just undercutting. ROI-aware floors, Buy Box optimization and fulfillment-aware lanes, with every decision recorded and explainable.",
    bullets: [
      "Respects the minimum price you set — never sells below it",
      "FBA & FBM lane selection per ASIN",
      "Every price change logged with the reason behind it",
      "Inventory-aware: pre-positioning, oscillation relief, restock snap-back",
    ],
  },
  "fetch-listing-price": {
    tagline: "Compare your price across marketplaces",
    hero: "See your live US, CA, MX and BR prices side-by-side with FX conversion.",
    bullets: [
      "All home marketplaces in one view",
      "FX-converted to your home currency",
      "Identifies arbitrage between your own marketplaces",
    ],
  },
  "price-history": {
    tagline: "Read the market like a chart",
    hero: "Track ASIN price changes over time — Buy Box, lowest FBA, lowest FBM — with clean charts.",
    bullets: [
      "BB, lowest FBA, lowest FBM lines",
      "Daily / weekly / monthly granularity",
      "Marketplace filters",
    ],
  },
  "product-finder": {
    tagline: "Hunt deals like a pro, with Keepa filters built in",
    hero: "Browse Amazon by category with Keepa-grade filters tuned for online arbitrage and wholesale sourcing.",
    bullets: [
      "Sales rank, price-drop, BB ownership filters",
      "Quick-add to Product Library",
      "Profit calc inline",
    ],
  },
  "sourcer": {
    tagline: "Scout any ASIN, UPC or keyword in seconds",
    hero: "Live offers, profit calculator, sales history and price trend in one panel — built for fast sourcing decisions.",
    bullets: [
      "Live BB, lowest FBA, lowest FBM offers",
      "Profit calculator with your real fees",
      "Sales history + price trend chart",
    ],
  },
  "scan-history": {
    tagline: "Every UPC you've ever scanned",
    hero: "From the mobile scanner straight into a searchable history with ASIN, price and computed profit.",
    bullets: [
      "Searchable, exportable scan log",
      "Profit calc per scan",
      "Jump straight back to Sourcer",
    ],
  },
  "replenish-search": {
    tagline: "Find what's worth buying again",
    hero: "Surface profitable replenishment candidates from your own catalog and recent purchases.",
    bullets: [
      "Velocity-weighted suggestions",
      "Filters by category, supplier, profit",
      "One-click reorder",
    ],
  },
  "need-to-buy-again": {
    tagline: "Restock the winners — automatically",
    hero: "Past purchases ranked by sales velocity and current profitability so you reorder the right things first.",
    bullets: [
      "Days-of-stock projections",
      "Profit-aware ranking",
      "Direct supplier links",
    ],
  },
  "google-product-search": {
    tagline: "Reverse-search any ASIN with Google Shopping",
    hero: "Pull images and supplier prices from Google Shopping for any ASIN — handy for quick supplier discovery.",
    bullets: [
      "ASIN → Google Shopping in one click",
      "Image + price + merchant",
      "Great for quick price extraction",
    ],
  },
  "store-scan": {
    tagline: "Pre-scanned profit waiting for you",
    hero: "Browse curated supplier-to-Amazon matches that are already analyzed for profit — no Keepa or SP-API credits used.",
    bullets: [
      "No API credits consumed",
      "Filter by category and minimum profit",
      "Add directly to Product Library",
    ],
  },
  "supplier-discovery": {
    tagline: "Find suppliers other sellers already discovered",
    hero: "Look up supplier candidates already discovered for any ASIN — no API credits used, instant results.",
    bullets: [
      "ASIN → list of supplier URLs",
      "Cached, instant, free to query",
      "Great starting point for sourcing",
    ],
  },
  "supplier-discovery-live": {
    tagline: "Live retail-source hunting, auto-ranked",
    hero: "Find live retail source candidates for any ASIN — auto-ranked, with extracted prices and confidence scores.",
    bullets: [
      "Live web crawl + price extraction",
      "Confidence-ranked results",
      "Saves successful discoveries to the shared cache",
    ],
  },
  "price-extractor": {
    tagline: "Universal product price extractor",
    hero: "Paste any product URL — get price, currency, image and title back in seconds.",
    bullets: [
      "Works on most retail sites",
      "Currency-aware",
      "Returns image + title + price",
    ],
  },
  "scan-categories": {
    tagline: "Curate categories users can browse",
    hero: "Group supplier URLs into named categories (e.g. Books, Toys) so users can browse pre-vetted sources.",
    bullets: [
      "Named, ordered categories",
      "Bulk URL import",
      "Surfaced inside Store Scan",
    ],
  },
  "roi-calculator": {
    tagline: "Profit math, instantly",
    hero: "Cost in, sale price in — get fees, profit and ROI out. Plus break-even and target-margin helpers.",
    bullets: [
      "Real Amazon fee modeling",
      "ROI %, margin %, profit $",
      "Break-even & target views",
    ],
  },
  "target-roi-price": {
    tagline: "What price do I need to hit my ROI?",
    hero: "Tell it your cost and target ROI — get the exact selling price you need across every home currency.",
    bullets: [
      "Target ROI → required price",
      "FX-aware: US, CA, MX, BR",
      "Floor-aware (respects $5 absolute minimum)",
    ],
  },
  "user-management": {
    tagline: "Roles and access, in one place",
    hero: "Owner / Admin / Manager / Viewer with module-level access — locked down by RLS at the database layer.",
    bullets: [
      "Role-based access control",
      "Module-level visibility",
      "Audit-friendly",
    ],
  },
  "admin-management": {
    tagline: "Manage your admin team",
    hero: "Profiles, names, and avatars for every admin — keep the team identity tidy.",
    bullets: [
      "Admin profile editor",
      "Avatar uploads",
      "Display-name controls",
    ],
  },
  "amazon-sp-api-connection": {
    tagline: "Encrypted, audited, and bulletproof",
    hero: "Manage encrypted LWA credentials with one-click connection tests and clear health signals.",
    bullets: [
      "LWA_CLIENT_ID-first auth routing",
      "Encrypted at rest",
      "Live health & rate-limit indicators",
    ],
  },
};

const DEFAULT_HOW: ModuleCopy["how"] = [
  { title: "Connect", desc: "Securely link to Amazon SP-API in one click — encrypted credentials, audited access." },
  { title: "Sync", desc: "Live data flows in continuously, with smart guards to reject stale or suspicious values." },
  { title: "Decide", desc: "Clean dashboards turn raw data into the next action you should take." },
];

const DEFAULT_AUDIENCE = [
  "OA & wholesale arbitrage sellers",
  "Private-label brands scaling SKUs",
  "Agencies managing multiple seller accounts",
];

export function getModuleCopy(label: string, fallbackDescription: string): ModuleCopy {
  const slug = slugify(label);
  const copy = MODULE_COPY[slug] || {};
  return {
    tagline: copy.tagline || `${label} — built into InventorySprint`,
    hero: copy.hero || fallbackDescription,
    bullets: copy.bullets || [
      "Built into the same workspace as your repricer & sourcing tools",
      "Multi-marketplace aware (US, CA, MX, BR) with FX conversion",
      "Backed by Supabase RLS — your data stays yours",
      "Live SP-API integration with smart safety guards",
    ],
    how: copy.how || DEFAULT_HOW,
    audience: copy.audience || DEFAULT_AUDIENCE,
    cta: copy.cta,
  };
}
