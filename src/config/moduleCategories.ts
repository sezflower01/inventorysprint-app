// Single source of truth for the categorized module navigation.
// Used by /tools (Tools Hub) and the navbar Platform Modules mega-dropdown.
import {
  AlertTriangle,
  BarChart3,
  Banknote,
  BoxIcon,
  DollarSign,
  LayoutDashboard,
  ListChecks,
  Receipt,
  SearchX,
  ShieldAlert,
  ShieldCheck,
  Tags,
  Truck,
  Warehouse,
  type LucideIcon,
} from "lucide-react";

export type ModuleBadge = "free" | "subscribe" | "admin-live" | "admin" | "soon";

export type ModuleItem = {
  /** Internal route. If undefined the item is "coming soon". */
  path?: string;
  label: string;
  description: string;
  icon: LucideIcon;
  /** Tailwind gradient classes used for the icon tile background. */
  color: string;
  badges?: ModuleBadge[];
  /** Hide unless the user has admin role. */
  adminOnly?: boolean;
  /** GA event name for click tracking. */
  ga?: string;
  /** If set, clicking the card downloads this file (relative public URL) instead of navigating. */
  downloadUrl?: string;
  /** Filename to save the downloaded file as. */
  downloadFilename?: string;
};

export type ModuleCategory = {
  id: string;
  label: string;
  /** Short tagline shown under the category title. */
  tagline: string;
  /** Single emoji used in compact menus / breadcrumbs. */
  emoji: string;
  icon: LucideIcon;
  /** Tailwind gradient for the category accent. */
  accent: string;
  /** Featured categories get a brighter, slightly larger card treatment. */
  featured?: boolean;
  modules: ModuleItem[];
};

export const MODULE_CATEGORIES: ModuleCategory[] = [
  {
    id: "dashboard",
    label: "Dashboard",
    tagline: "Overview & quick stats",
    emoji: "🏠",
    icon: LayoutDashboard,
    accent: "from-slate-500 to-slate-700",
    modules: [
      {
        path: "/tools/dashboard",
        label: "Overview",
        description: "Live business snapshot: profit, inventory, repricing, shipments and alerts.",
        icon: LayoutDashboard,
        color: "from-slate-500 to-slate-700",
        ga: "tool_menu_dashboard",
      },
    ],
  },
  {
    id: "inventory",
    label: "Inventory",
    tagline: "Stock, value, corrections",
    emoji: "📦",
    icon: Warehouse,
    accent: "from-orange-500 to-amber-600",
    modules: [
      {
        path: "/tools/synced-inventory",
        label: "Inventory Valuation",
        description: "Real-time inventory valuation & sync with Amazon FBA.",
        icon: Warehouse,
        color: "from-orange-500 to-amber-600",
        badges: ["free"],
        ga: "tool_menu_synced_inventory",
      },
      {
        path: "/tools/inventory-writeoff",
        label: "Inventory Write-Off",
        description: "Record warehouse losses (restricted, dead, expired). Flows into P&L as Business Loss.",
        icon: AlertTriangle,
        color: "from-rose-500 to-red-600",
        ga: "tool_menu_inventory_writeoff",
      },
      {
        path: "/tools/disposition-management",
        label: "Disposition Management",
        description: "Review removals, disposals & liquidations. Tracks unsellable losses fed into your P&L.",
        icon: AlertTriangle,
        color: "from-red-500 to-orange-600",
        ga: "tool_menu_disposition_management",
      },
      {
        path: "/tools/created-listings",
        label: "Product Library",
        description: "Saved product catalog with supplier links, search & quick reorder.",
        icon: ListChecks,
        color: "from-teal-500 to-cyan-600",
        badges: [],
        ga: "tool_menu_created_listings",
      },
      {
        path: "/tools/still-thinking",
        label: "Still Thinking",
        description: "Saved-for-later products from the extension. Convert to a real listing when you're ready to buy.",
        icon: ListChecks,
        color: "from-violet-500 to-purple-600",
        ga: "tool_menu_still_thinking",
      },
      {
        path: "/tools/fba-eligibility-issues",
        label: "FBA Eligibility Issues",
        description:
          "See what's already blocked and what's exposed to Amazon's manufacturer-barcode / brand-registry rule before it costs you a listing.",
        icon: ShieldAlert,
        color: "from-red-500 to-rose-600",
        ga: "tool_menu_fba_eligibility_issues",
      },
      {
        // Existed since Phase B but was never listed here, so the only way in
        // was typing the URL. That is why "where do I check hazmat / gated /
        // restricted" had no answer (2026-09-24).
        path: "/tools/product-analyzer",
        label: "Product Analyzer",
        description:
          "One ASIN, every gate: sellable, gated or restricted for your account, hazmat, prep required, FBA eligibility, and an on-demand inbound shipment test.",
        icon: ShieldCheck,
        color: "from-sky-500 to-blue-600",
        ga: "tool_menu_product_analyzer",
      },
      {
        path: "/tools/bulk-eligibility",
        label: "Bulk Eligibility Check",
        description:
          "Paste a whole lead list and see which ASINs you can actually sell — sellable, needs approval, restricted, hazmat, prep — before you spend money.",
        icon: ListChecks,
        color: "from-teal-500 to-emerald-600",
        ga: "tool_menu_bulk_eligibility",
      },
    ],
  },
  {
    id: "finance",
    label: "Finance & Accounting",
    tagline: "Taxes, profit, expenses",
    emoji: "💰",
    icon: DollarSign,
    accent: "from-emerald-500 to-green-600",
    modules: [
      {
        path: "/tools/profit-loss",
        label: "Profit & Loss",
        description: "Comprehensive P&L statements and financial insights.",
        icon: BarChart3,
        color: "from-violet-500 to-purple-600",
        adminOnly: false,
        ga: "tool_menu_profit_loss",
      },
      {
        path: "/tools/sales",
        label: "Sales Report",
        description: "Track daily sales, refunds, and revenue analytics.",
        icon: DollarSign,
        color: "from-blue-500 to-indigo-600",
        adminOnly: true,
        ga: "tool_menu_sales",
      },
      {
        path: "/tools/settlement",
        label: "Settlement",
        description: "View Amazon settlement reports.",
        icon: Banknote,
        color: "from-lime-500 to-green-600",
        adminOnly: false,
        ga: "tool_menu_settlement",
      },
      {
        path: "/tools/reimbursements",
        label: "Reimbursements",
        description: "Track FBA reimbursement claims.",
        icon: AlertTriangle,
        color: "from-red-500 to-rose-600",
        adminOnly: true,
        ga: "tool_menu_reimbursements",
      },
      {
        path: "/tools/expenses",
        label: "My Expenses",
        description: "Track business expenses for tax reporting.",
        icon: Receipt,
        color: "from-yellow-500 to-amber-600",
        adminOnly: false,
        ga: "tool_menu_expenses",
      },
    ],
  },
  {
    id: "logistics",
    label: "Shipments & Logistics",
    tagline: "Send, track, label",
    emoji: "🚚",
    icon: Truck,
    accent: "from-sky-500 to-blue-600",
    modules: [
      {
        path: "/tools/shipment-builder",
        label: "FBA Shipment Builder",
        description: "Create and manage FBA shipments.",
        icon: BoxIcon,
        color: "from-sky-500 to-blue-600",
        adminOnly: false,
        ga: "tool_menu_shipment_builder",
      },
      {
        path: "/tools/purchase-vs-shipment",
        label: "Purchase vs Shipment Report",
        description: "Compare units ordered, received, and shipped per ASIN.",
        icon: BoxIcon,
        color: "from-indigo-500 to-blue-600",
        adminOnly: false,
        ga: "tool_menu_purchase_vs_shipment",
      },
      {
        // Buckets every price mismatch the moment it loads: Confirmed
        // Mismatch, FX Suspect, Qty-halving, Pending Estimates, Missing My
        // Price. It was in the tools dropdown only, which is a poor place for
        // the one screen that answers "is a number on my reports wrong".
        //
        // Three of its buckets name faults this codebase has actually had --
        // unconverted native currency, a double-divide in a backfill writer,
        // and estimates standing in for confirmed prices -- so it is the first
        // screen to open when a figure looks wrong, not the last.
        path: "/tools/price-discrepancy-audit",
        label: "Price Discrepancy Audit",
        description: "Where a Sales Report price disagrees with what you listed at — FX, qty and estimate faults, bucketed.",
        icon: ShieldAlert,
        color: "from-amber-500 to-orange-600",
        adminOnly: false,
        ga: "tool_menu_price_discrepancy_audit",
      },
      {
        // Renamed and re-described because it could not be found by what it
        // does. The card said "purchases with no shipment", which names one of
        // its four buckets; the page opens on a tab called Discrepancies and
        // the other three are unit shortfalls -- Short (fewer units locatable
        // than purchased), Amazon didn't receive (shipped but not checked in),
        // and Never reached Amazon. Someone looking for a units discrepancy
        // had no reason to click it.
        path: "/tools/unshipped-purchases",
        label: "Shipment Discrepancies",
        description: "Units purchased vs units Amazon actually received — short shipments, never-arrived, and unchecked-in stock.",
        icon: SearchX,
        color: "from-rose-500 to-red-600",
        adminOnly: false,
        ga: "tool_menu_unshipped_purchases",
      },
      {
        path: "/tools/shipment-tracking",
        label: "Shipment Tracking",
        description: "Track your FBA shipment status.",
        icon: Truck,
        color: "from-slate-500 to-gray-600",
        adminOnly: false,
        ga: "tool_menu_shipment_tracking",
      },
      {
        // The only shipment page with no card. It was reachable from the tools
        // dropdown and by typing the URL, which is why it kept getting lost --
        // it answers "did this shipment actually pay for itself", and that is
        // not a question anyone remembers a URL for.
        //
        // Not admin-only, by request. The route carries no ModuleGuard, so any
        // signed-in user could already reach it by URL; the flag only ever
        // controlled whether it was findable. The page's own isAdmin checks
        // still gate its repair tools, which is where the risk actually was.
        path: "/tools/shipment-accounting",
        label: "Shipment Accounting",
        description: "Cost, fees and revenue per shipment — find units sent that never arrived.",
        icon: Banknote,
        color: "from-emerald-500 to-teal-600",
        adminOnly: false,
        ga: "tool_menu_shipment_accounting",
      },
    ],
  },
  {
    id: "repricing",
    label: "Repricing & Pricing",
    tagline: "Price, compete, track",
    emoji: "🔁",
    icon: Tags,
    accent: "from-rose-500 to-red-600",
    modules: [
      {
        path: "/tools/repricer",
        label: "Repricer",
        description: "Automatically adjust prices using advanced repricing logic.",
        icon: Tags,
        color: "from-rose-500 to-red-600",
        ga: "tool_menu_repricer",
      },
    ],
  },
];

export const visibleModules = (
  category: ModuleCategory,
  isAdmin: boolean,
): ModuleItem[] => category.modules.filter((m) => !m.adminOnly || isAdmin);

export const visibleCategories = (isAdmin: boolean): ModuleCategory[] =>
  MODULE_CATEGORIES.map((c) => ({ ...c, modules: visibleModules(c, isAdmin) })).filter(
    (c) => c.modules.length > 0,
  );
