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
        path: "/tools/unshipped-purchases",
        label: "Unshipped Purchases",
        description: "Money spent that never reached Amazon — find purchases with no shipment.",
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
