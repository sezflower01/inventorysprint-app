import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Radio, LayoutDashboard, Sun, ListChecks, Activity, Stethoscope, Shield, ShieldCheck, FilePlus, FileText, Receipt, AlertTriangle, Printer, Package, Globe, Search, LineChart, Target, ScanLine, RefreshCw, FlaskConical, Store, Link2, FolderTree, TrendingUp, Users, Plug, Database, HeartPulse, Brain, TestTubes, Sparkles, Clock, Server, Terminal, Mail, BarChart3, type LucideIcon } from "lucide-react";

type StandaloneCard = {
  title: string;
  desc: string;
  path?: string;
  downloadUrl?: string;
  downloadFilename?: string;
  Icon: LucideIcon;
  accent: string;
  badge?: string;
};

async function triggerDownload(url: string, filename: string) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
    toast.success(`Downloading ${filename}…`);
  } catch (err: any) {
    toast.error(`Download failed: ${err.message || err}`);
  }
}

// Cards moved out of the main Tools Hub so they're only reachable from here.
// Add more entries to this list as additional cards get moved in.
const STANDALONE_CARDS: StandaloneCard[] = [
  {
    title: "Live Sales — Mobile View",
    desc: "Compact, mobile-optimized Today's sales view — great for a phone-sized window.",
    path: "/m/live-sales",
    Icon: Radio,
    accent: "from-emerald-500/15 to-emerald-500/5 border-emerald-400/30 text-emerald-300",
    badge: "Live",
  },
  {
    title: "Dashboard Overview",
    desc: "Live business snapshot: profit, inventory, repricing, shipments and alerts.",
    path: "/tools/dashboard",
    Icon: LayoutDashboard,
    accent: "from-slate-500/15 to-slate-500/5 border-slate-400/30 text-slate-300",
  },
  {
    title: "Inventory Restoration",
    desc: "One-click guided reconcile: Summaries (available + reserved) + FBA report (inbound) in safe order.",
    path: "/tools/inventory-restoration",
    Icon: ShieldCheck,
    accent: "from-emerald-500/15 to-teal-500/5 border-emerald-400/30 text-emerald-300",
  },
  {
    title: "Inventory Review Queue",
    desc: "SKUs missing from FBA reports — review and decide. No stock is changed automatically.",
    path: "/tools/inventory-review",
    Icon: ListChecks,
    accent: "from-amber-500/15 to-orange-500/5 border-amber-400/30 text-amber-300",
  },
  {
    title: "Create Listing",
    desc: "Create a new Amazon listing from scratch with guided fields and validation.",
    path: "/tools/create-listing",
    Icon: FilePlus,
    accent: "from-indigo-500/15 to-blue-500/5 border-indigo-400/30 text-indigo-300",
  },
  {
    title: "Reports & Accounting",
    desc: "Generate detailed business reports.",
    path: "/tools/reports",
    Icon: FileText,
    accent: "from-indigo-500/15 to-blue-500/5 border-indigo-400/30 text-indigo-300",
  },
  {
    title: "Shipment Profit & Loss",
    desc: "Per-shipment cost breakdown: COGS, Amazon inbound fees, manual costs and totals.",
    path: "/tools/shipment-accounting",
    Icon: Receipt,
    accent: "from-emerald-500/15 to-teal-500/5 border-emerald-400/30 text-emerald-300",
  },
  {
    title: "Price Discrepancy Audit",
    desc: "Compare My Price vs Sales Report vs Live Mobile per order to diagnose revenue mismatches.",
    path: "/tools/price-discrepancy-audit",
    Icon: AlertTriangle,
    accent: "from-orange-500/15 to-red-500/5 border-orange-400/30 text-orange-300",
  },
  {
    title: "Label Printing",
    desc: "Print FNSKU and shipping labels easily.",
    path: "/tools/label-printing",
    Icon: Printer,
    accent: "from-pink-500/15 to-rose-500/5 border-pink-400/30 text-pink-300",
  },
  {
    title: "Print Without PDF",
    desc: "Direct thermal printing without PDF files.",
    path: "/tools/printing-without-pdf",
    Icon: Package,
    accent: "from-fuchsia-500/15 to-pink-500/5 border-fuchsia-400/30 text-fuchsia-300",
  },
  {
    title: "Worldwide Tracking",
    desc: "Track packages from any carrier globally.",
    path: "/tools/tracking",
    Icon: Globe,
    accent: "from-cyan-500/15 to-teal-500/5 border-cyan-400/30 text-cyan-300",
  },
  {
    title: "Fetch Listing Price",
    desc: "Compare listing prices across US, CA, MX, BR.",
    path: "/tools/fetch-listing-price",
    Icon: Search,
    accent: "from-blue-500/15 to-cyan-500/5 border-blue-400/30 text-blue-300",
  },
];

// The entire former "Sourcing & Product Research" category, moved as a group.
const SOURCING_CARDS: StandaloneCard[] = [
  {
    title: "Product Finder",
    desc: "Search Amazon products with Keepa filters for OA & wholesale sourcing.",
    path: "/tools/product-finder",
    Icon: Search,
    accent: "from-violet-500/15 to-fuchsia-500/5 border-violet-400/30 text-violet-300",
  },
  {
    title: "Sourcer",
    desc: "Scout ASINs/UPCs/keywords with live offers, profit calculator, sales history & price trend.",
    path: "/tools/sourcer",
    Icon: Target,
    accent: "from-indigo-500/15 to-purple-500/5 border-indigo-400/30 text-indigo-300",
  },
  {
    title: "Scan History",
    desc: "Every UPC/EAN you scanned from the mobile scanner — with ASIN, price & profit.",
    path: "/tools/scan-history",
    Icon: ScanLine,
    accent: "from-blue-500/15 to-cyan-500/5 border-blue-400/30 text-blue-300",
  },
  {
    title: "Replenish Search",
    desc: "Find products to replenish stock.",
    path: "/tools/replenish-search",
    Icon: RefreshCw,
    accent: "from-purple-500/15 to-violet-500/5 border-purple-400/30 text-purple-300",
  },
  {
    title: "Need to Buy Again",
    desc: "Profitable past purchases worth restocking based on sales velocity.",
    path: "/tools/need-buy-again",
    Icon: RefreshCw,
    accent: "from-pink-500/15 to-rose-500/5 border-pink-400/30 text-pink-300",
  },
  {
    title: "Research Leads",
    desc: "Private research database — log past FBA Lead List ASINs & retail links. Isolated from your live library.",
    path: "/tools/research-leads",
    Icon: FlaskConical,
    accent: "from-violet-500/15 to-fuchsia-500/5 border-violet-400/30 text-violet-300",
  },
  {
    title: "Google Product Search",
    desc: "Search Google Shopping by ASIN for images and prices.",
    path: "/tools/google-product-search",
    Icon: Search,
    accent: "from-emerald-500/15 to-teal-500/5 border-emerald-400/30 text-emerald-300",
  },
  {
    title: "Store Scan",
    desc: "Browse pre-scanned profitable supplier-to-Amazon matches. No API credits used.",
    path: "/tools/user-store-scan",
    Icon: Store,
    accent: "from-emerald-500/15 to-green-500/5 border-emerald-400/30 text-emerald-300",
    badge: "Free",
  },
  {
    title: "Supplier Discovery",
    desc: "Look up supplier candidates already discovered for any ASIN. No API credits used.",
    path: "/tools/user-supplier-discovery",
    Icon: Search,
    accent: "from-cyan-500/15 to-blue-500/5 border-cyan-400/30 text-cyan-300",
    badge: "Free",
  },
];

// The entire former "Supplier Intelligence" category, moved as a group.
const SUPPLIER_INTEL_CARDS: StandaloneCard[] = [
  {
    title: "Supplier Discovery (Live)",
    desc: "Find retail source candidates for an ASIN — auto-ranked, auto-extracted prices.",
    path: "/tools/supplier-discovery",
    Icon: Search,
    accent: "from-orange-500/15 to-red-500/5 border-orange-400/30 text-orange-300",
    badge: "Admin · Live",
  },
  {
    title: "Price Extractor",
    desc: "Universal product price extractor — pulls price, currency, image and title from any URL.",
    path: "/tools/price-extractor",
    Icon: Link2,
    accent: "from-amber-500/15 to-orange-500/5 border-amber-400/30 text-amber-300",
    badge: "Admin · Live",
  },
  {
    title: "Scan Categories",
    desc: "Curate named categories (e.g. Books) with supplier URLs that users can browse.",
    path: "/tools/scan-categories",
    Icon: FolderTree,
    accent: "from-violet-500/15 to-purple-500/5 border-violet-400/30 text-violet-300",
    badge: "Admin · Live",
  },
];

// The entire former "Tools & Calculators" category, moved as a group.
const CALCULATOR_CARDS: StandaloneCard[] = [
  {
    title: "ROI Calculator",
    desc: "Calculate profit margins and return on investment.",
    path: "/tools/roi",
    Icon: TrendingUp,
    accent: "from-emerald-500/15 to-green-500/5 border-emerald-400/30 text-emerald-300",
    badge: "Free",
  },
  {
    title: "Target ROI Price",
    desc: "Calculate required selling price for target ROI across currencies.",
    path: "/tools/target-roi-price",
    Icon: Target,
    accent: "from-amber-500/15 to-yellow-500/5 border-amber-400/30 text-amber-300",
  },
];

// Everything that can tell you something is wrong -- errors, health checks,
// worker load, cron/job diagnostics -- gathered in one place so you don't have
// to remember which category each one originally lived under. These are the
// same cards/pages as elsewhere on this page (intentionally duplicated here
// for accessibility, not moved) -- see 2026-07-25 request.
const ALERTS_CARDS: StandaloneCard[] = [
  {
    title: "Error Log",
    desc: "All errors across every account: frontend, repricer, and backend -- grouped and categorized (infra vs Amazon throttling vs app).",
    path: "/tools/error-log",
    Icon: HeartPulse,
    accent: "from-red-500/15 to-rose-500/5 border-red-400/30 text-red-300",
  },
  {
    title: "Database Maintenance",
    desc: "Cleanup retention, health alerts, performance snapshot, and VACUUM controls.",
    path: "/tools/database-maintenance",
    Icon: Database,
    accent: "from-cyan-500/15 to-blue-500/5 border-cyan-400/30 text-cyan-300",
  },
  {
    title: "Automation Status",
    desc: "Live scheduler status, last run, and activity source breakdown.",
    path: "/tools/repricer/automation-status",
    Icon: Clock,
    accent: "from-blue-500/15 to-sky-500/5 border-blue-400/30 text-blue-300",
  },
  {
    title: "Workers",
    desc: "Shard load per worker -- spot an overloaded or unprovisioned shard before it becomes a problem.",
    path: "/tools/repricer/workers",
    Icon: Server,
    accent: "from-slate-500/15 to-zinc-500/5 border-slate-400/30 text-slate-300",
  },
  {
    title: "Cron Diagnostics",
    desc: "Inspect scheduled jobs, queues, and platform health.",
    path: "/tools/cron-diagnostics",
    Icon: Stethoscope,
    accent: "from-amber-500/15 to-amber-500/5 border-amber-400/30 text-amber-300",
  },
];

// Repricer admin tools -- moved out of the Repricer page's own tab bar so
// Assignments/Rules/Settings stay the only tabs everyone sees there.
const REPRICER_ADMIN_CARDS: StandaloneCard[] = [
  {
    title: "Automation Status",
    desc: "Live scheduler status, last run, and activity source breakdown.",
    path: "/tools/repricer/automation-status",
    Icon: Clock,
    accent: "from-blue-500/15 to-sky-500/5 border-blue-400/30 text-blue-300",
  },
  {
    title: "Activity Log",
    desc: "Recent repricer scheduler and dispatch activity for your account.",
    path: "/tools/repricer/activity-log",
    Icon: Activity,
    accent: "from-slate-500/15 to-zinc-500/5 border-slate-400/30 text-slate-300",
  },
  {
    title: "Price History",
    desc: "Review every automated price change the repricer has made over time.",
    path: "/tools/price-history",
    Icon: LineChart,
    accent: "from-purple-500/15 to-indigo-500/5 border-purple-400/30 text-purple-300",
  },
  {
    title: "AI Insights",
    desc: "See the Smart Engine's reasoning behind recent pricing decisions.",
    path: "/tools/ai-insights",
    Icon: Brain,
    accent: "from-fuchsia-500/15 to-purple-500/5 border-fuchsia-400/30 text-fuchsia-300",
  },
  {
    title: "Change History",
    desc: "A history of rule and settings changes made across your repricer.",
    path: "/tools/repricer/change-history",
    Icon: FileText,
    accent: "from-blue-500/15 to-indigo-500/5 border-blue-400/30 text-blue-300",
  },
  {
    title: "Rule Behavior",
    desc: "How each rule is actually behaving in production.",
    path: "/tools/repricer/rule-behavior",
    Icon: FlaskConical,
    accent: "from-violet-500/15 to-purple-500/5 border-violet-400/30 text-violet-300",
  },
  {
    title: "Rule Performance",
    desc: "Per-preset Buy Box %, units/revenue/profit-per-day, ROI, ASP, and raise-safety — built to monitor Momentum Smart against its siblings.",
    path: "/tools/repricer/rule-performance",
    Icon: BarChart3,
    accent: "from-emerald-500/15 to-teal-500/5 border-emerald-400/30 text-emerald-300",
  },
  {
    title: "Checked ASINs",
    desc: "ASINs the repricer has evaluated most recently.",
    path: "/tools/repricer/checked-asins",
    Icon: Search,
    accent: "from-cyan-500/15 to-blue-500/5 border-cyan-400/30 text-cyan-300",
  },
  {
    title: "Simulation",
    desc: "Test how a rule would behave before applying it live.",
    path: "/tools/repricer/simulation",
    Icon: TestTubes,
    accent: "from-teal-500/15 to-cyan-500/5 border-teal-400/30 text-teal-300",
  },
  {
    title: "Account Control",
    desc: "Account-level repricer controls and overrides.",
    path: "/tools/repricer/account-control",
    Icon: Users,
    accent: "from-rose-500/15 to-pink-500/5 border-rose-400/30 text-rose-300",
  },
  {
    title: "Workers",
    desc: "Manage parallel dispatch worker (shard) assignment as the user base grows.",
    path: "/tools/repricer/workers",
    Icon: Server,
    accent: "from-slate-500/15 to-zinc-500/5 border-slate-400/30 text-slate-300",
  },
  {
    title: "Error Log",
    desc: "System Error Log -- review flagged customer patterns (refunds, replacements, high volume + returns).",
    path: "/tools/error-log",
    Icon: HeartPulse,
    accent: "from-red-500/15 to-rose-500/5 border-red-400/30 text-red-300",
  },
  {
    title: "Analytics",
    desc: "Preset queries to measure engine health, optimization impact, and business outcomes.",
    path: "/tools/repricer/analytics",
    Icon: TrendingUp,
    accent: "from-emerald-500/15 to-green-500/5 border-emerald-400/30 text-emerald-300",
  },
  {
    title: "Smart Engine",
    desc: "Smart Engine self-review and learning over time.",
    path: "/tools/repricer/smart-engine",
    Icon: Sparkles,
    accent: "from-indigo-500/15 to-blue-500/5 border-indigo-400/30 text-indigo-300",
  },
];

// The entire former "Admin & Settings" category, moved as a group.
const ADMIN_SETTINGS_CARDS: StandaloneCard[] = [
  {
    title: "User Management",
    desc: "Assign roles and control module access for every user.",
    path: "/tools/admin-users",
    Icon: Users,
    accent: "from-rose-500/15 to-pink-500/5 border-rose-400/30 text-rose-300",
    badge: "Admin",
  },
  {
    title: "Admin Management",
    desc: "Manage admin profiles, names, and avatars.",
    path: "/tools/admin-management",
    Icon: ShieldCheck,
    accent: "from-violet-500/15 to-purple-500/5 border-violet-400/30 text-violet-300",
    badge: "Admin",
  },
  {
    title: "Amazon SP-API Connection",
    desc: "Manage encrypted LWA credentials and test the Amazon connection.",
    path: "/tools/amazon-connection",
    Icon: Plug,
    accent: "from-amber-500/15 to-orange-500/5 border-amber-400/30 text-amber-300",
    badge: "Admin",
  },
  // The two Chrome extension downloads MOVED OUT of here on 2026-11-04.
  // They are not admin tooling -- they are how a seller uses the product on
  // Amazon's pages -- so they now live in the public "Browser Extensions"
  // category in src/config/moduleCategories.ts, visible at /tools to everyone.
  // Do not re-add them here; one owner for those two URLs.
  {
    title: "Database Maintenance",
    desc: "Cleanup retention, health alerts, performance snapshot, and VACUUM controls.",
    path: "/tools/database-maintenance",
    Icon: Database,
    accent: "from-cyan-500/15 to-blue-500/5 border-cyan-400/30 text-cyan-300",
    badge: "Admin",
  },
  {
    title: "Dev Environment Setup",
    desc: "One-liner PowerShell bootstrap for a new Windows dev machine — Node.js, Git, Claude Code, both repos cloned and installed.",
    path: "/tools/dev-environment-setup",
    Icon: Terminal,
    accent: "from-slate-500/15 to-zinc-500/5 border-slate-400/30 text-slate-300",
    badge: "Admin",
  },
  {
    title: "Email Center",
    desc: "Search connected Gmail inboxes by keyword, saved filters, and reply as support@inventorysprint.com.",
    path: "/tools/email-center",
    Icon: Mail,
    accent: "from-blue-500/15 to-cyan-500/5 border-blue-400/30 text-blue-300",
    badge: "Admin",
  },
];

function CardGrid({ cards }: { cards: StandaloneCard[] }) {
  return (
    <div className="grid gap-5 sm:grid-cols-2">
      {cards.map((c) => {
        const isDownload = !!c.downloadUrl;
        const inner = (
          <>
            <div className="inline-flex items-center justify-center h-12 w-12 rounded-xl bg-white/10 border border-white/10 shrink-0">
              <c.Icon className="h-6 w-6" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-base font-bold text-white">{c.title}</h3>
                {c.badge ? (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider bg-white/10 border border-white/20">
                    <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
                    {c.badge}
                  </span>
                ) : null}
              </div>
              <p className="text-xs text-white/60 mt-0.5">{c.desc}</p>
            </div>
            <div className="text-sm font-medium shrink-0">{isDownload ? "↓ Download .zip" : "Open →"}</div>
          </>
        );
        const className = `group relative flex items-center gap-4 overflow-hidden rounded-2xl border bg-gradient-to-br ${c.accent} p-5 transition-all hover:-translate-y-0.5 hover:shadow-lg`;

        if (isDownload) {
          const download = () => triggerDownload(c.downloadUrl!, c.downloadFilename || "download.zip");
          return (
            <div
              key={c.downloadUrl}
              role="button"
              tabIndex={0}
              onClick={download}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") download(); }}
              className={className}
              aria-label={`Download ${c.title}`}
            >
              {inner}
            </div>
          );
        }

        return (
          <Link key={c.path} to={c.path!} className={className}>
            {inner}
          </Link>
        );
      })}
    </div>
  );
}

const DAILY_FLOW_STEPS = [
  {
    step: "1",
    when: "Morning · 2–5 min",
    title: "Executive Review",
    desc: "Start the day with the high-level health snapshot.",
    path: "/tools/executive",
    Icon: Sun,
    accent: "from-blue-500/15 to-indigo-500/5 border-blue-400/30 text-blue-300",
  },
  {
    step: "2",
    when: "Operational review",
    title: "Operator Queue",
    desc: "Approve, snooze, or escalate today's suggested actions.",
    path: "/tools/repricer/operator-queue",
    Icon: ListChecks,
    accent: "from-emerald-500/15 to-emerald-500/5 border-emerald-400/30 text-emerald-300",
  },
  {
    step: "3",
    when: "Investigate behavior",
    title: "Repricer Monitor",
    desc: "Look into unusual pricing or strategy behavior.",
    path: "/tools/repricer/monitor",
    Icon: Activity,
    accent: "from-violet-500/15 to-violet-500/5 border-violet-400/30 text-violet-300",
  },
  {
    step: "4",
    when: "Diagnose performance",
    title: "Cron Diagnostics",
    desc: "Inspect jobs, queues, and platform health.",
    path: "/tools/cron-diagnostics",
    Icon: Stethoscope,
    accent: "from-amber-500/15 to-amber-500/5 border-amber-400/30 text-amber-300",
  },
];

export default function AdminOnlySettings() {
  return (
    <div className="space-y-10">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Shield className="h-5 w-5 text-rose-300" />
          <h2 className="text-xl font-bold text-white">Admin Only</h2>
        </div>
        <p className="text-sm text-gray-400">
          Internal tools moved out of the main Tools Hub — visible only to admin accounts.
        </p>
      </div>

      <section>
        <header className="mb-5">
          <h3 className="text-lg font-bold text-white flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-red-300" />
            Alerts & Monitoring
          </h3>
          <p className="text-sm text-gray-400">Errors, health checks, and worker load -- everything that flags a problem, in one place.</p>
        </header>
        <CardGrid cards={ALERTS_CARDS} />
      </section>

      <section>
        <CardGrid cards={STANDALONE_CARDS} />
      </section>

      <section>
        <header className="mb-5">
          <h3 className="text-lg font-bold text-white">Repricer</h3>
          <p className="text-sm text-gray-400">Diagnostics and internal tools moved out of the Repricer page's own tabs.</p>
        </header>
        <CardGrid cards={REPRICER_ADMIN_CARDS} />
      </section>

      <section>
        <header className="mb-5">
          <h3 className="text-lg font-bold text-white">Sourcing & Product Research</h3>
          <p className="text-sm text-gray-400">Where the money is made.</p>
        </header>
        <CardGrid cards={SOURCING_CARDS} />
      </section>

      <section>
        <header className="mb-5">
          <h3 className="text-lg font-bold text-white">Supplier Intelligence</h3>
          <p className="text-sm text-gray-400">Advanced AI sourcing layer.</p>
        </header>
        <CardGrid cards={SUPPLIER_INTEL_CARDS} />
      </section>

      <section>
        <header className="mb-5">
          <h3 className="text-lg font-bold text-white">Tools & Calculators</h3>
          <p className="text-sm text-gray-400">Quick math utilities.</p>
        </header>
        <CardGrid cards={CALCULATOR_CARDS} />
      </section>

      <section>
        <header className="mb-5">
          <h3 className="text-lg font-bold text-white">Admin & Settings</h3>
          <p className="text-sm text-gray-400">Restricted access.</p>
        </header>
        <CardGrid cards={ADMIN_SETTINGS_CARDS} />
      </section>

      <section>
        <header className="mb-5">
          <h3 className="text-lg font-bold text-white">Admin Daily Flow</h3>
          <p className="text-sm text-gray-400">Your routine: review → operate → investigate → diagnose.</p>
        </header>
        <div className="grid gap-5 sm:grid-cols-2">
          {DAILY_FLOW_STEPS.map(({ step, when, title, desc, path, Icon, accent }) => (
            <Link
              key={path}
              to={path}
              className={`group relative block overflow-hidden rounded-2xl border bg-gradient-to-br ${accent} p-5 transition-all hover:-translate-y-0.5 hover:shadow-lg`}
            >
              <div className="flex items-start justify-between mb-3">
                <div className="inline-flex items-center justify-center h-11 w-11 rounded-xl bg-white/10 border border-white/10">
                  <Icon className="h-5 w-5" />
                </div>
                <span className="text-[10px] font-bold uppercase tracking-wider text-white/60">
                  Step {step}
                </span>
              </div>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-white/50 mb-1">
                {when}
              </div>
              <h4 className="text-lg font-bold text-white mb-1">{title}</h4>
              <p className="text-xs text-white/70 leading-relaxed">{desc}</p>
              <div className="mt-3 text-xs font-medium text-white/80 group-hover:text-white">
                Open →
              </div>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
