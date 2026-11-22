import React from "react";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Helmet } from "react-helmet-async";
import {
  Brain, ShieldCheck, BarChart3, Zap, Package, Globe, TrendingUp, Eye, Clock,
  Activity, Target, Layers, RefreshCw, AlertTriangle, Sparkles, Users, ArrowRight,
  DollarSign, LineChart, Settings, Shield, CheckCircle2
} from "lucide-react";
import { Link } from "react-router-dom";

const features = [
  {
    icon: Brain,
    title: "AI-Powered Repricing Engine",
    color: "blue",
    content: [
      "This isn't a rule-based tool that blindly matches the lowest price. The engine evaluates multiple signals before every decision: Buy Box status, competitor strength, price gaps, profit margins, and market volatility.",
      "It uses adaptive logic that escalates aggression when you're losing the Buy Box and pulls back when you're winning — extracting profit instead of chasing pennies.",
    ],
    highlight: "Every price change has a reason. Every hold has a purpose.",
  },
  {
    icon: ShieldCheck,
    title: "Profit Protection & ROI Floors",
    color: "emerald",
    content: [
      "The system enforces a dual-floor architecture: your manual minimum price (strategic floor) and an ROI-calculated floor (economic floor). It always uses the higher of the two.",
      "Before any downward move, the engine checks your cost, Amazon fees, and target ROI. If lowering the price breaks your profit — it won't do it. Period.",
    ],
    highlight: "Your margins are protected at every level — no exceptions.",
  },
  {
    icon: Activity,
    title: "Live Sales Tracking",
    color: "violet",
    content: [
      "See your sales as they happen — not hours later. The Live Sales popup shows real-time units sold, revenue, and product-level breakdowns for today and this month.",
      "Sales data syncs automatically in the background and updates every 60 seconds when open. You get revenue charts, per-ASIN breakdowns with images, and multi-marketplace support.",
    ],
    highlight: "Know exactly what's selling right now — not what sold yesterday.",
  },
  {
    icon: BarChart3,
    title: "Full P&L Sales Report",
    color: "amber",
    content: [
      "A complete profit and loss breakdown for any period — revenue, Amazon fees, FBA fees, referral fees, refunds, COGS, expenses, inbound fees, and net profit.",
      "Every order is enriched with cost data, fee breakdowns, and live refund tracking. You see true ROI, true margin, and estimated payout — not just top-line revenue.",
    ],
    highlight: "The most accurate picture of your Amazon business profitability.",
  },
  {
    icon: Layers,
    title: "Strategy Presets & Custom Rules",
    color: "cyan",
    content: [
      "Choose from built-in strategy profiles — Momentum Builder, Aggressive Capture, and Profit Extractor — each with different aggression levels, raise caps, and cooldown timers.",
      "Or build your own custom rules with full control over undercut amounts, raise triggers, cooldowns, and competitive behavior. Assign different rules to different products.",
    ],
    highlight: "One size doesn't fit all. Your strategy should match your product.",
  },
  {
    icon: Package,
    title: "Inventory-Aware Pricing",
    color: "orange",
    content: [
      "The Stock Overlay intelligence layer adjusts pricing based on your inventory health. Low stock? It raises prices and slows sales to maximize profit per unit.",
      "High stock or aging inventory? It becomes more competitive to move units faster. The system calculates days-of-stock using your sales velocity and adjusts automatically.",
    ],
    highlight: "Same product, different strategy — based on what your inventory needs.",
  },
  {
    icon: Globe,
    title: "Multi-Marketplace Support",
    color: "indigo",
    content: [
      "Reprice across US, Canada, Mexico, and Brazil — all from one dashboard. Each marketplace has isolated assignments with marketplace-specific rules and currency handling.",
      "FX rates are fetched automatically. Costs, fees, and floors are converted to local currency. International listings are discovered and propagated from your US catalog.",
    ],
    highlight: "One system, four marketplaces — fully synchronized.",
  },
  {
    icon: Target,
    title: "Buy Box Intelligence",
    color: "rose",
    content: [
      "The engine knows exactly who owns the Buy Box, at what price, and whether you're close to winning it. It tracks your Buy Box win rate, loss patterns, and recovery speed.",
      "When you lose the Buy Box, recovery aggression escalates over time. When you win it, the system shifts to profit extraction — raising prices gradually while maintaining ownership.",
    ],
    highlight: "Win the Buy Box. Keep the Buy Box. Maximize profit from it.",
  },
  {
    icon: AlertTriangle,
    title: "Oscillation Detection & Safe Mode",
    color: "yellow",
    content: [
      "If two sellers keep undercutting each other in a loop, the system detects it. It identifies oscillation patterns, applies cooldown holds, and switches to defensive strategies.",
      "A circuit breaker safe mode activates if too many rapid changes happen — protecting your listings from runaway price wars. It auto-resumes when the market stabilizes.",
    ],
    highlight: "Smart enough to stop a price war before it destroys your margin.",
  },
  {
    icon: Clock,
    title: "Adaptive Cooldowns & Timing",
    color: "teal",
    content: [
      "The engine doesn't change prices constantly. It uses a 5-tier adaptive cooldown system based on your current position: winning, losing close, losing wide, suppressed, or holding.",
      "Anti-flip direction cooldowns prevent back-and-forth pricing. But urgent corrections — like being significantly overpriced — bypass cooldowns immediately.",
    ],
    highlight: "The right move at the right time — not just the fastest move.",
  },
  {
    icon: TrendingUp,
    title: "Profit Extraction & Smart Raises",
    color: "emerald",
    content: [
      "When you own the Buy Box and competition is weak, the system gradually raises your price to capture more margin. Raises are controlled with caps and trigger thresholds.",
      "A Fragile Ownership Guard prevents raises when your position is unstable. Monopoly mode activates when competition drops to zero — maximizing profit on exclusive listings.",
    ],
    highlight: "Don't just win — extract every dollar the market will give you.",
  },
  {
    icon: Eye,
    title: "Full Transparency & Diagnostics",
    color: "blue",
    content: [
      "Every decision is logged with a full trace: what the engine saw, what it considered, what it decided, and why. The Rule Behavior panel shows exactly how each rule performs.",
      "Position Proof shows landed-price comparisons against competitors. Action logs display side-by-side before/after states. You never have to wonder what your repricer is doing.",
    ],
    highlight: "No black box. Every decision is explainable.",
  },
  {
    icon: Sparkles,
    title: "Smart Engine Learning",
    color: "purple",
    content: [
      "The engine records outcomes. It tracks which price changes won the Buy Box, which raises held, and which drops were unnecessary — so the patterns are visible instead of guessed at.",
      "An AI review system analyzes decision patterns twice daily and suggests tuning improvements. All changes require manual approval — safety-critical values are never auto-tuned.",
    ],
    highlight: "An engine that records why it did what it did.",
  },
  {
    icon: RefreshCw,
    title: "Autopilot Onboarding",
    color: "green",
    content: [
      "New inventory is automatically prepared for repricing. The system calculates an ROI-safe minimum price from your cost, fees, and target ROI — then assigns your default rule.",
      "If the current price is below the safe floor, it immediately raises the price to protect your margin on day one. No manual setup required for new listings.",
    ],
    highlight: "List it. Forget it. The system handles the rest.",
  },
  {
    icon: Shield,
    title: "Suppressed Buy Box Handling",
    color: "red",
    content: [
      "When Amazon suppresses the Buy Box (no winner shown), most repricers panic. This system anchors to the lowest filtered competitor and applies controlled micro-undercuts.",
      "A Raw Competition Override ensures you maintain the lowest position even in suppressed markets. The engine doesn't chase ghost prices — it targets real, active competitors.",
    ],
    highlight: "Even when the Buy Box disappears — the system knows what to do.",
  },
  {
    icon: Zap,
    title: "Restock Snap-Back & FBM Intelligence",
    color: "amber",
    content: [
      "When stock transitions from zero to available, a high-priority re-entry pricing mode activates — positioning your price aggressively to recapture market share immediately.",
      "FBM-specific logic handles FBM-vs-FBA and FBM-vs-FBM competition differently. Micro-raise strategies maintain competitive advantage without triggering price wars.",
    ],
    highlight: "Back in stock? Back in the game — instantly.",
  },
  {
    icon: LineChart,
    title: "Repricer Analytics & Insights",
    color: "sky",
    content: [
      "A dedicated analytics dashboard shows Buy Box win rates, price change frequency, profit trends, and engine performance over time.",
      "AI Action Insights let you see exactly how the AI made each decision — with transparent reasoning, rule names, and outcome tracking for every evaluated ASIN.",
    ],
    highlight: "Data-driven visibility into every aspect of your repricing.",
  },
  {
    icon: Settings,
    title: "Price Simulation & Testing",
    color: "slate",
    content: [
      "Before going live, test any rule against real market data. The simulation tab shows exactly what the engine would do — without changing any prices.",
      "AI Rule Test dialog fetches live competitor offers and runs the full evaluation pipeline, showing the recommended price, reasoning, and all safety checks.",
    ],
    highlight: "Test before you commit. See the result before it happens.",
  },
];

const BlogRepricerFeatures = () => {
  const colorMap: Record<string, string> = {
    blue: "from-blue-500/10 to-blue-600/5 border-blue-500/20",
    emerald: "from-emerald-500/10 to-emerald-600/5 border-emerald-500/20",
    violet: "from-violet-500/10 to-violet-600/5 border-violet-500/20",
    amber: "from-amber-500/10 to-amber-600/5 border-amber-500/20",
    cyan: "from-cyan-500/10 to-cyan-600/5 border-cyan-500/20",
    orange: "from-orange-500/10 to-orange-600/5 border-orange-500/20",
    indigo: "from-indigo-500/10 to-indigo-600/5 border-indigo-500/20",
    rose: "from-rose-500/10 to-rose-600/5 border-rose-500/20",
    yellow: "from-yellow-500/10 to-yellow-600/5 border-yellow-500/20",
    teal: "from-teal-500/10 to-teal-600/5 border-teal-500/20",
    purple: "from-purple-500/10 to-purple-600/5 border-purple-500/20",
    green: "from-green-500/10 to-green-600/5 border-green-500/20",
    red: "from-red-500/10 to-red-600/5 border-red-500/20",
    sky: "from-sky-500/10 to-sky-600/5 border-sky-500/20",
    slate: "from-slate-500/10 to-slate-600/5 border-slate-500/20",
  };

  const iconColorMap: Record<string, string> = {
    blue: "text-blue-400", emerald: "text-emerald-400", violet: "text-violet-400",
    amber: "text-amber-400", cyan: "text-cyan-400", orange: "text-orange-400",
    indigo: "text-indigo-400", rose: "text-rose-400", yellow: "text-yellow-400",
    teal: "text-teal-400", purple: "text-purple-400", green: "text-green-400",
    red: "text-red-400", sky: "text-sky-400", slate: "text-slate-400",
  };

  const highlightColorMap: Record<string, string> = {
    blue: "text-blue-300", emerald: "text-emerald-300", violet: "text-violet-300",
    amber: "text-amber-300", cyan: "text-cyan-300", orange: "text-orange-300",
    indigo: "text-indigo-300", rose: "text-rose-300", yellow: "text-yellow-300",
    teal: "text-teal-300", purple: "text-purple-300", green: "text-green-300",
    red: "text-red-300", sky: "text-sky-300", slate: "text-slate-300",
  };

  return (
    <>
      <Helmet>
        <title>Every Feature Inside Our Amazon AI Repricer | InventorySprint</title>
        <meta name="description" content="Discover every feature of our AI Amazon repricer — from live sales tracking and Buy Box intelligence to profit protection, multi-marketplace support, and smart engine learning." />
        <meta name="keywords" content="Amazon AI repricer features, Amazon repricing tool, Buy Box repricer, Amazon profit protection, live sales tracking Amazon, multi-marketplace repricer, Amazon FBA repricer, best Amazon repricer 2025, automated pricing Amazon, inventory sprint, amazon inventory, inventory management amazon" />
        <link rel="canonical" href="https://inventorysprint.com/blog/repricer-features" />
        <meta property="og:type" content="article" />
        <meta property="og:title" content="Every Feature Inside Our Amazon AI Repricer" />
        <meta property="og:description" content="Live sales tracking, Buy Box intelligence, profit protection, multi-marketplace support, and smart engine learning." />
        <meta property="og:url" content="https://inventorysprint.com/blog/repricer-features" />
        <meta name="twitter:title" content="Every Feature Inside Our Amazon AI Repricer" />
        <meta name="twitter:description" content="Live sales tracking, Buy Box intelligence, profit protection, and smart engine learning." />
        <script type="application/ld+json">
          {JSON.stringify({
            "@context": "https://schema.org",
            "@type": "BlogPosting",
            headline: "Every Feature Inside Our Amazon AI Repricer",
            description: "A comprehensive breakdown of every feature in the InventorySprint AI repricer — from live sales and Buy Box intelligence to profit protection and smart learning.",
            author: { "@type": "Person", name: "Sam Shomali" },
            publisher: { "@type": "Organization", name: "InventorySprint" },
            datePublished: "2025-07-15",
            dateModified: "2025-07-15",
            mainEntityOfPage: { "@type": "WebPage", "@id": "https://inventorysprint.com/blog/repricer-features" },
          })}
        </script>
      </Helmet>
      <div className="dark min-h-screen flex flex-col bg-slate-950 text-white">
        <Navbar />
        <main className="flex-1">
          {/* Hero */}
          <section className="relative py-20 overflow-hidden">
            <div className="absolute inset-0 bg-gradient-to-b from-blue-600/8 via-transparent to-transparent" />
            <div className="container mx-auto px-4 max-w-4xl relative z-10">
              <div className="flex items-center gap-2 mb-6">
                <span className="bg-blue-500/10 text-blue-400 px-3 py-1 rounded-full text-sm font-medium border border-blue-500/20">
                  Written by Sam Shomali
                </span>
                <span className="text-slate-500 text-sm">• July 15, 2025</span>
              </div>
              <h1 className="text-4xl md:text-5xl font-bold mb-6 leading-tight">
                Every Feature Inside Our Amazon AI Repricer
              </h1>
              <p className="text-white/80 text-xl mb-6 leading-relaxed">
                Most repricers change prices. Ours reads the market, protects your profit, and records the reason behind every decision. Here's everything it does — and why it matters.
              </p>
              <div className="flex flex-wrap gap-2">
                {["AI Engine", "Live Sales", "Buy Box", "Profit Protection", "Multi-Marketplace", "Analytics"].map((tag) => (
                  <span key={tag} className="bg-white/5 border border-white/10 px-3 py-1 rounded-full text-sm text-white/60">
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          </section>

          {/* Intro */}
          <section className="py-12 bg-slate-900/50">
            <div className="container mx-auto px-4 max-w-3xl">
              <div className="bg-gradient-to-r from-blue-500/5 to-indigo-500/5 border border-blue-500/10 rounded-2xl p-8">
                <h2 className="text-2xl font-bold text-white mb-4">Why This Isn't Just Another Repricer</h2>
                <p className="text-white/80 mb-4">
                  Most repricing tools do one thing: if someone lowers their price, you match it. That's not intelligence — that's a spreadsheet formula.
                </p>
                <p className="text-white/80 mb-4">
                  A real repricing system needs to understand <strong className="text-white">when to lower</strong>, <strong className="text-white">when to raise</strong>, <strong className="text-white">when to hold</strong>, and <strong className="text-white">when to do nothing</strong>.
                </p>
                <p className="text-white/80">
                  It needs to protect your margins, adapt to market changes, learn from outcomes, and work across multiple marketplaces — all without you watching it 24/7.
                </p>
                <p className="text-white font-semibold mt-4">
                  That's what we built. Here's every feature inside it.
                </p>
              </div>
            </div>
          </section>

          {/* Feature count */}
          <section className="py-10">
            <div className="container mx-auto px-4 text-center">
              <div className="inline-flex items-center gap-3 bg-white/5 border border-white/10 rounded-full px-6 py-3">
                <CheckCircle2 className="h-5 w-5 text-emerald-400" />
                <span className="text-white font-semibold text-lg">{features.length} Core Features</span>
                <span className="text-white/50">— each one built for real Amazon sellers</span>
              </div>
            </div>
          </section>

          {/* All features */}
          <section className="py-8 pb-20">
            <div className="container mx-auto px-4 max-w-4xl space-y-6">
              {features.map((feature, idx) => {
                const Icon = feature.icon;
                return (
                  <div
                    key={idx}
                    className={`bg-gradient-to-br ${colorMap[feature.color]} border rounded-2xl p-8 transition-all hover:scale-[1.01]`}
                  >
                    <div className="flex items-start gap-4 mb-4">
                      <div className={`p-3 rounded-xl bg-white/5 ${iconColorMap[feature.color]}`}>
                        <Icon className="h-6 w-6" />
                      </div>
                      <div>
                        <span className="text-white/40 text-sm font-medium">Feature {idx + 1}</span>
                        <h3 className="text-xl font-bold text-white">{feature.title}</h3>
                      </div>
                    </div>
                    <div className="space-y-3 ml-16">
                      {feature.content.map((para, pIdx) => (
                        <p key={pIdx} className="text-white/70 leading-relaxed">{para}</p>
                      ))}
                      <p className={`font-semibold mt-4 ${highlightColorMap[feature.color]}`}>
                        👉 {feature.highlight}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* How it all connects */}
          <section className="py-16 bg-slate-900/50">
            <div className="container mx-auto px-4 max-w-3xl text-center">
              <h2 className="text-3xl font-bold text-white mb-6">🔁 How It All Connects</h2>
              <div className="bg-gradient-to-r from-blue-500/5 to-indigo-500/5 border border-blue-500/10 rounded-2xl p-8">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
                  {[
                    { step: "1", label: "Market Check", desc: "Engine fetches Buy Box, competitors, and your position" },
                    { step: "2", label: "AI Evaluation", desc: "Analyzes signals, checks floors, applies strategy rules" },
                    { step: "3", label: "Smart Decision", desc: "Lower, raise, hold, or wait — with full reasoning" },
                    { step: "4", label: "Safety Validation", desc: "Verifies profit protection, cooldowns, and constraints" },
                    { step: "5", label: "Price Update", desc: "Submits to Amazon via Listings API feed" },
                    { step: "6", label: "Learn & Adapt", desc: "Tracks outcome and improves for next cycle" },
                  ].map((item) => (
                    <div key={item.step} className="bg-white/5 border border-white/10 rounded-xl p-4 text-left">
                      <span className="text-blue-400 font-bold text-lg">Step {item.step}</span>
                      <p className="text-white font-semibold mt-1">{item.label}</p>
                      <p className="text-white/60 text-sm mt-1">{item.desc}</p>
                    </div>
                  ))}
                </div>
                <p className="text-white/80">
                  This cycle runs continuously — evaluating, deciding, and improving with every pass.
                </p>
              </div>
            </div>
          </section>

          {/* The difference */}
          <section className="py-16 bg-slate-950">
            <div className="container mx-auto px-4 max-w-3xl text-center">
              <h2 className="text-3xl font-bold text-white mb-6">🏁 The Real Difference</h2>
              <div className="bg-gradient-to-r from-emerald-500/5 to-teal-500/5 border border-emerald-500/10 rounded-2xl p-8">
                <p className="text-white text-lg mb-4">
                  A simple repricer changes your price.
                </p>
                <p className="text-white/80 mb-6">
                  A real AI system <strong className="text-white">understands the situation</strong>, <strong className="text-white">protects your business</strong>, and <strong className="text-white">gets smarter every day</strong>.
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-lg mx-auto mb-8">
                  <div className="bg-red-500/5 border border-red-500/10 rounded-lg p-4">
                    <p className="text-red-400 font-medium text-sm">❌ Blind price matching</p>
                  </div>
                  <div className="bg-emerald-500/5 border border-emerald-500/10 rounded-lg p-4">
                    <p className="text-emerald-400 font-medium text-sm">✅ Intelligent market decisions</p>
                  </div>
                  <div className="bg-red-500/5 border border-red-500/10 rounded-lg p-4">
                    <p className="text-red-400 font-medium text-sm">❌ Hope it works</p>
                  </div>
                  <div className="bg-emerald-500/5 border border-emerald-500/10 rounded-lg p-4">
                    <p className="text-emerald-400 font-medium text-sm">✅ See exactly why it works</p>
                  </div>
                  <div className="bg-red-500/5 border border-red-500/10 rounded-lg p-4">
                    <p className="text-red-400 font-medium text-sm">❌ One strategy for everything</p>
                  </div>
                  <div className="bg-emerald-500/5 border border-emerald-500/10 rounded-lg p-4">
                    <p className="text-emerald-400 font-medium text-sm">✅ Adaptive per-product strategy</p>
                  </div>
                </div>
                <p className="text-white font-semibold text-lg">
                  This is the repricer we wished existed. So we built it.
                </p>
              </div>
            </div>
          </section>

          {/* CTA */}
          <section className="py-16 bg-gradient-to-b from-slate-950 to-slate-900">
            <div className="container mx-auto px-4 max-w-3xl text-center">
              <h2 className="text-2xl font-bold text-white mb-4">Ready to see it in action?</h2>
              <p className="text-white/60 mb-8">Start your free trial and experience every feature firsthand.</p>
              <Link
                to="/signup"
                className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-8 py-3 rounded-xl font-semibold transition-colors"
              >
                Get Started Free <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          </section>

          {/* More blogs */}
          <section className="py-16 bg-slate-900/30">
            <div className="container mx-auto px-4 max-w-4xl">
              <h2 className="text-2xl font-bold text-white text-center mb-8">More from the Blog</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {[
                  { to: "/blog/ai-repricer-behind-the-scenes", title: "What an AI Repricer Is Actually Doing Behind the Scenes", desc: "A deep dive into the invisible logic that drives every pricing decision." },
                  { to: "/blog/real-ai-decisions-live-asins", title: "Real AI Decisions from Live ASINs", desc: "See actual decisions the engine makes on real products in real time." },
                  { to: "/blog/what-ai-repricer-looks-at", title: "What an AI Repricer Looks At Before Changing Your Price", desc: "The 10 signals the system evaluates before every price change." },
                  { to: "/blog/product-library-amazon-sellers", title: "Why Most Amazon Sellers Keep Starting Over", desc: "How a Product Library turns one-time wins into a repeatable system." },
                ].map((blog) => (
                  <Link key={blog.to} to={blog.to} className="block bg-white/5 border border-white/10 rounded-xl p-5 hover:bg-white/8 transition-colors group">
                    <h3 className="text-white font-semibold mb-2 group-hover:text-blue-400 transition-colors">{blog.title}</h3>
                    <p className="text-white/50 text-sm">{blog.desc}</p>
                  </Link>
                ))}
              </div>
            </div>
          </section>
        </main>
        <Footer />
      </div>
    </>
  );
};

export default BlogRepricerFeatures;
