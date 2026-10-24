import React from "react";
import { Helmet } from "react-helmet-async";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import ScrollIndicator from "@/components/ScrollIndicator";
import {
  Zap,
  Shield,
  TrendingUp,
  Brain,
  Activity,
  Eye,
  CheckCircle2,
  Sparkles,
  Timer,
  Target,
} from "lucide-react";

const AiRepricerProduct: React.FC = () => {
  const navigate = useNavigate();

  const handleStartTrial = () => {
    if (typeof window.gtag !== "undefined") {
      window.gtag("event", "cta_click", {
        event_category: "conversion",
        event_label: "ai_repricer_start_trial",
      });
    }
    navigate("/signup");
  };

  const features = [
    {
      icon: Zap,
      title: "Instant Repricing",
      desc: "Reacts to market changes in real time — no delays, no missed opportunities.",
    },
    {
      icon: Shield,
      title: "ROI Protection",
      desc: "Hard floors and dual-floor logic keep your margins safe at all times.",
    },
    {
      icon: Brain,
      title: "Self-Learning Engine",
      desc: "Learns from real outcomes and continuously improves its decisions.",
    },
    {
      icon: Target,
      title: "Cluster Detection",
      desc: "Recognizes price clusters and protects you from racing to the bottom.",
    },
    {
      icon: Timer,
      title: "Smart Cooldowns",
      desc: "Adaptive cooldowns prevent oscillation while staying competitive.",
    },
    {
      icon: Eye,
      title: "Full Transparency",
      desc: "Every decision logged with a clear, human-readable explanation.",
    },
  ];

  const steps = [
    {
      n: "1",
      title: "Connect Amazon",
      desc: "Securely connect your Seller Central account in minutes.",
    },
    {
      n: "2",
      title: "Choose a Strategy",
      desc: "Pick from refined presets or build your own pricing rules.",
    },
    {
      n: "3",
      title: "Let the AI Work",
      desc: "Sit back as the engine wins the Buy Box and protects your profit.",
    },
  ];

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Helmet>
        <title>AI Repricer — Win the Buy Box Without Sacrificing Margins</title>
        <meta
          name="description"
          content="Fully automatic AI repricer that reacts in real time. Win the Buy Box, protect your ROI, and start with a 60-day free trial — no credit card required."
        />
        <meta name="keywords" content="amazon AI repricer, buy box repricer, automated amazon pricing software, amazon repricing tool, inventory sprint repricer" />
        <link rel="canonical" href="https://inventorysprint.com/products/ai-repricer" />
      </Helmet>

      <Navbar />

      {/* Hero */}
      <section className="pt-32 pb-20 px-4 bg-gradient-to-b from-[hsl(222,84%,4.9%)] via-[hsl(222,84%,6%)] to-[hsl(222,84%,4.9%)]">
        <div className="container mx-auto max-w-5xl text-center">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border border-primary/30 bg-primary/10 mb-6">
            <Brain className="h-3.5 w-3.5 text-primary" />
            <span className="text-xs font-semibold uppercase tracking-wider text-primary">
              Powered by Google Gemini
            </span>
          </div>
          <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold mb-6 bg-gradient-to-r from-white to-white/70 bg-clip-text text-transparent leading-tight">
            Gemini reviews your pricing decisions —<br className="hidden md:block" /> your system continuously gets smarter.
          </h1>
          <p className="text-lg md:text-xl text-muted-foreground mb-3 max-w-2xl mx-auto">
            Analyzes outcomes. Finds patterns. Improves future pricing automatically.
          </p>
          <p className="text-sm text-muted-foreground/70 max-w-2xl mx-auto mb-8">
            Every decision is logged, explainable, and continuously improved.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center items-center">
            <Button size="lg" className="text-base px-8" onClick={handleStartTrial}>
              Start 60-Day Free Trial
            </Button>
            <span className="text-sm text-muted-foreground">No credit card required</span>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="py-20 px-4">
        <div className="container mx-auto max-w-5xl">
          <h2 className="text-3xl md:text-4xl font-bold text-center mb-12">How It Works</h2>
          <div className="grid md:grid-cols-3 gap-6">
            {steps.map((s) => (
              <div
                key={s.n}
                className="p-6 rounded-xl border border-white/10 bg-card/50 backdrop-blur-sm"
              >
                <div className="h-10 w-10 rounded-full bg-primary/15 border border-primary/30 flex items-center justify-center text-primary font-bold mb-4">
                  {s.n}
                </div>
                <h3 className="text-lg font-semibold mb-2">{s.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{s.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="py-20 px-4 bg-[hsl(222,60%,18%)]">
        <div className="container mx-auto max-w-6xl">
          <div className="text-center mb-12">
            <h2 className="text-3xl md:text-4xl font-bold mb-3 text-white">Key Features</h2>
            <p className="text-blue-100/80">Everything you need to price smarter, 24/7.</p>
          </div>
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-5">
            {features.map((f) => (
              <div
                key={f.title}
                className="p-6 rounded-xl border border-white/20 bg-white/95 hover:border-primary/50 transition-colors shadow-lg"
              >
                <div className="h-10 w-10 rounded-lg bg-primary/15 flex items-center justify-center mb-4">
                  <f.icon className="h-5 w-5 text-primary" />
                </div>
                <h3 className="text-base font-semibold mb-2 text-blue-900">{f.title}</h3>
                <p className="text-sm text-blue-800 leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Live AI badge section */}
      <section className="py-16 px-4">
        <div className="container mx-auto max-w-4xl">
          <div className="rounded-2xl border border-primary/20 bg-gradient-to-br from-primary/5 to-transparent p-8 md:p-10">
            <div className="flex items-center gap-2 mb-4">
              <Activity className="h-5 w-5 text-primary animate-pulse" />
              <span className="text-xs font-bold uppercase tracking-wider text-primary">
                Real-Time Engine
              </span>
            </div>
            <h3 className="text-2xl md:text-3xl font-bold mb-3">
              Underpricing recovery, automatically
            </h3>
            <p className="text-muted-foreground leading-relaxed">
              When competitors disappear or markets shift, the AI snaps back to recover lost margin
              — instantly and safely.
            </p>
          </div>
        </div>
      </section>

      {/* Powered by Gemini — explicit model attribution */}
      <section className="py-20 px-4 bg-[hsl(222,60%,18%)]">
        <div className="container mx-auto max-w-5xl">
          <div className="text-center mb-10">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-primary/30 bg-primary/10 mb-4">
              <Brain className="h-3.5 w-3.5 text-primary" />
              <span className="text-xs font-bold uppercase tracking-wider text-primary">
                Real AI, Not a Black Box
              </span>
            </div>
            <h2 className="text-3xl md:text-4xl font-bold mb-3 text-white">
              Powered by Google Gemini
            </h2>
            <p className="text-blue-100/80 max-w-2xl mx-auto leading-relaxed">
              InventorySprint uses <span className="font-semibold text-white">Gemini Flash</span> for fast,
              large-scale AI review and <span className="font-semibold text-white">Gemini Pro</span> for
              deeper analysis on high-impact pricing decisions. Every recommendation is logged, explainable, and
              measurable.
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-5">
            <div className="p-6 rounded-xl border border-primary/20 bg-white/95 shadow-lg">
              <div className="flex items-center gap-2 mb-3">
                <Badge className="border-primary/40 bg-primary/10 text-primary gap-1">
                  <Brain className="h-3 w-3" />
                  Gemini Flash
                </Badge>
                <span className="text-xs text-blue-700">High volume</span>
              </div>
              <h3 className="text-lg font-semibold mb-2 text-blue-900">Fast, large-scale AI review</h3>
              <p className="text-sm text-blue-800 leading-relaxed">
                Reviews the majority of pricing decisions in real time — fast, cost-efficient, and consistent.
                Used to validate everyday moves across your full catalog.
              </p>
            </div>

            <div className="p-6 rounded-xl border border-violet-500/30 bg-white/95 shadow-lg">
              <div className="flex items-center gap-2 mb-3">
                <Badge className="border-violet-500/40 bg-violet-500/10 text-violet-700 gap-1">
                  <Brain className="h-3 w-3" />
                  Gemini Pro
                </Badge>
                <span className="text-xs text-blue-700">High-impact cases</span>
              </div>
              <h3 className="text-lg font-semibold mb-2 text-blue-900">Deeper analysis when it matters</h3>
              <p className="text-sm text-blue-800 leading-relaxed">
                Escalated automatically for high-value ASINs, anomalies, repeated Buy Box loss, and divergence
                cases — for sharper reasoning where it counts.
              </p>
            </div>
          </div>

          <p className="text-xs text-blue-200/70 text-center mt-6 max-w-3xl mx-auto">
            Pricing decisions are executed by our deterministic repricer engine for safety and speed. Gemini
            reviews, scores, and tunes the system — every decision is tagged with the model that reviewed it.
          </p>
        </div>
      </section>

      {/* Bottom CTA */}
      <section className="py-20 px-4 text-center">
        <div className="container mx-auto max-w-3xl">
          <h2 className="text-3xl md:text-4xl font-bold mb-4">
            Ready to let AI handle your pricing?
          </h2>
          <p className="text-muted-foreground mb-8">
            60 days free. Cancel anytime. No credit card required.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <Button size="lg" className="text-base px-8" onClick={handleStartTrial}>
              Start Free Trial
            </Button>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <CheckCircle2 className="h-4 w-4 text-primary" />
              <span>Setup in under 5 minutes</span>
            </div>
          </div>
        </div>
      </section>

      <Footer />
      <ScrollIndicator />
    </div>
  );
};

export default AiRepricerProduct;
