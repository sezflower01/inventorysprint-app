import React from "react";
import { Helmet } from "react-helmet-async";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import ScrollIndicator from "@/components/ScrollIndicator";
import {
  Search,
  Shield,
  TrendingUp,
  Package,
  Chrome,
  Truck,
  Calculator,
  CheckCircle2,
  Store,
} from "lucide-react";

/**
 * Landing page for the "Amazon arbitrage software" keyword family.
 *
 * Routed at /amazon-online-arbitrage-software. A root-level keyword path is
 * used rather than /products/... because this page exists to rank, and the
 * existing /products/* pages target their own feature keywords.
 *
 * Deliberately says nothing about any previous brand name. The keyword is
 * earned by covering what an OA seller actually searches for -- sourcing,
 * fulfillment-aware repricing, ROI floors, the Chrome extension -- not by
 * naming a former brand.
 */
const OnlineArbitrageSoftware = () => {
  const navigate = useNavigate();

  const handleStartTrial = () => {
    if (typeof window.gtag !== "undefined") {
      window.gtag("event", "cta_click", {
        event_category: "conversion",
        event_label: "online_arbitrage_start_trial",
      });
    }
    navigate("/signup");
  };

  const pillars = [
    {
      icon: Search,
      title: "Sourcing that keeps its working",
      desc: "Scan supplier sites, keep every candidate with its ASIN, cost and margin, and come back to the ones you passed on. Each listing remembers where it was bought from.",
    },
    {
      icon: TrendingUp,
      title: "Fulfillment-aware repricing",
      desc: "FBA and FBM are priced differently because they compete differently. The repricer knows which channel a listing is on and what the Buy Box actually belongs to before it moves a price.",
    },
    {
      icon: Shield,
      title: "ROI floors that hold",
      desc: "Set a floor as a return, not a guess at a price. Referral fees, the FBA fee for the real dimensions, and your cost on record are all in the number before a price is allowed to drop.",
    },
    {
      icon: Chrome,
      title: "Chrome extension on the product page",
      desc: "Open an Amazon listing and see the Buy Box, offer depth, fee breakdown and eligibility without leaving the page. Create a listing and print its FNSKU label from the same panel.",
    },
  ];

  const detail = [
    {
      icon: Calculator,
      title: "Fees priced on what Amazon bills",
      desc: "Bulky items are billed on dimensional weight, not actual weight. The fee basis is read per ASIN instead of looked up in a tier table, so a heavy item does not quietly show a profit it never had.",
    },
    {
      icon: Package,
      title: "One cost per ASIN, used everywhere",
      desc: "A single average cost on record values your stock and prices your sales. The P&L, the inventory valuation and the repricer floor all read the same number.",
    },
    {
      icon: Truck,
      title: "Shipments and labels",
      desc: "Build an FBA shipment, then print thermal FNSKU labels straight to a Zebra or Rollo over a local print bridge — no PDF round trip.",
    },
    {
      icon: Store,
      title: "Four marketplaces, one pool",
      desc: "US, Canada, Mexico and Brazil draw on one inventory pool, with per-marketplace access and currency handled for you.",
    },
  ];

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Helmet>
        <title>Amazon Online Arbitrage Software | InventorySprint</title>
        <meta
          name="description"
          content="Online arbitrage software for Amazon sellers: source deals, reprice with Buy Box and fulfillment awareness, hold real ROI floors, and check any ASIN from the Chrome extension. 60-day free trial, no credit card."
        />
        <meta
          name="keywords"
          content="amazon online arbitrage software, amazon arbitrage software, online arbitrage tool, OA sourcing software, amazon arbitrage repricer, retail arbitrage software, amazon FBA arbitrage tools, buy box repricer, ROI calculator amazon FBA"
        />
        <link rel="canonical" href="https://inventorysprint.com/amazon-online-arbitrage-software" />

        <meta property="og:type" content="website" />
        <meta property="og:url" content="https://inventorysprint.com/amazon-online-arbitrage-software" />
        <meta property="og:title" content="Amazon Online Arbitrage Software | InventorySprint" />
        <meta
          property="og:description"
          content="Source deals, reprice with Buy Box and fulfillment awareness, and hold real ROI floors — built for Amazon online arbitrage sellers."
        />
        <meta property="og:image" content="https://inventorysprint.com/logo-icon.png" />
        <meta property="og:site_name" content="InventorySprint" />

        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:url" content="https://inventorysprint.com/amazon-online-arbitrage-software" />
        <meta name="twitter:title" content="Amazon Online Arbitrage Software | InventorySprint" />
        <meta
          name="twitter:description"
          content="Source deals, reprice with Buy Box and fulfillment awareness, and hold real ROI floors — built for Amazon online arbitrage sellers."
        />
        <meta name="twitter:image" content="https://inventorysprint.com/logo-icon.png" />

        <script type="application/ld+json">{`
          {
            "@context": "https://schema.org",
            "@type": "SoftwareApplication",
            "name": "InventorySprint",
            "applicationCategory": "BusinessApplication",
            "applicationSubCategory": "Amazon Online Arbitrage Software",
            "operatingSystem": "Web",
            "offers": {
              "@type": "Offer",
              "price": "0",
              "priceCurrency": "USD",
              "description": "60-day free trial, no credit card required"
            },
            "description": "Online arbitrage software for Amazon sellers: sourcing, fulfillment-aware repricing, ROI floors, shipment building and FNSKU label printing.",
            "featureList": "Supplier sourcing, Buy Box repricing, FBA and FBM aware pricing, ROI floors, Chrome extension ASIN analyzer, FBA shipment builder, FNSKU thermal labels, profit and loss reporting",
            "url": "https://inventorysprint.com/amazon-online-arbitrage-software"
          }
        `}</script>
      </Helmet>

      <Navbar />

      {/* Hero */}
      <section className="pt-32 pb-20 px-4 bg-gradient-to-b from-[hsl(222,84%,4.9%)] via-[hsl(222,84%,6%)] to-[hsl(222,84%,4.9%)]">
        <div className="container mx-auto max-w-5xl text-center">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border border-primary/30 bg-primary/10 mb-6">
            <Search className="h-3.5 w-3.5 text-primary" />
            <span className="text-xs font-semibold uppercase tracking-wider text-primary">
              For online arbitrage sellers
            </span>
          </div>
          <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold mb-6 bg-gradient-to-r from-white to-white/70 bg-clip-text text-transparent leading-tight">
            Amazon online arbitrage software —<br className="hidden md:block" /> from the source to the sale
          </h1>
          <p className="text-lg md:text-xl text-muted-foreground mb-3 max-w-2xl mx-auto">
            Find the deal, know the real fee, list it, and let a repricer that understands your
            fulfillment channel defend the margin.
          </p>
          <p className="text-sm text-muted-foreground/70 max-w-2xl mx-auto mb-8">
            One cost per ASIN, used by your P&amp;L, your stock valuation and your price floor alike.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center items-center">
            <Button size="lg" className="text-base px-8" onClick={handleStartTrial}>
              Start 60-Day Free Trial
            </Button>
            <span className="text-sm text-muted-foreground">No credit card required</span>
          </div>
        </div>
      </section>

      {/* Four pillars */}
      <section className="py-20 px-4">
        <div className="container mx-auto max-w-6xl">
          <h2 className="text-3xl md:text-4xl font-bold text-center mb-4">
            What an arbitrage seller actually needs
          </h2>
          <p className="text-center text-muted-foreground mb-12 max-w-2xl mx-auto">
            Sourcing and repricing are the same job seen from two ends. Treating them as one system
            is the point.
          </p>
          <div className="grid md:grid-cols-2 gap-6">
            {pillars.map((p) => (
              <div
                key={p.title}
                className="rounded-xl border border-border/60 bg-card/50 p-6 hover:border-primary/40 transition-colors"
              >
                <p.icon className="h-6 w-6 text-primary mb-4" />
                <h3 className="text-xl font-semibold mb-2">{p.title}</h3>
                <p className="text-muted-foreground leading-relaxed">{p.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Detail */}
      <section className="py-20 px-4 bg-[hsl(222,60%,18%)]">
        <div className="container mx-auto max-w-6xl">
          <div className="text-center mb-12">
            <h2 className="text-3xl md:text-4xl font-bold mb-3 text-white">
              The details that decide whether a deal was real
            </h2>
            <p className="text-white/70 max-w-2xl mx-auto">
              Most arbitrage losses are not bad buys. They are good buys measured with the wrong
              number.
            </p>
          </div>
          <div className="grid md:grid-cols-2 gap-6">
            {detail.map((d) => (
              <div key={d.title} className="rounded-xl bg-white/5 border border-white/10 p-6">
                <d.icon className="h-6 w-6 text-primary mb-4" />
                <h3 className="text-lg font-semibold mb-2 text-white">{d.title}</h3>
                <p className="text-white/70 leading-relaxed">{d.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Workflow */}
      <section className="py-20 px-4">
        <div className="container mx-auto max-w-4xl">
          <h2 className="text-3xl md:text-4xl font-bold text-center mb-12">
            A sourcing run, end to end
          </h2>
          <ol className="space-y-6">
            {[
              "Scan a supplier site, or open an Amazon page with the Chrome extension, and read the Buy Box, offer depth and fee breakdown in place.",
              "Keep the candidate with its cost, its fee basis and its margin. Nothing is lost when you move on.",
              "Create the listing on Amazon and print its FNSKU thermal label from the same panel.",
              "Build the FBA shipment, or sell FBM — the repricer prices each channel on its own terms.",
              "Set an ROI floor and leave it. Prices move inside it, not through it.",
              "Read the P&L that used the same cost per ASIN as the floor did.",
            ].map((step, i) => (
              <li key={i} className="flex gap-4">
                <span className="flex-shrink-0 w-8 h-8 rounded-full bg-primary/15 border border-primary/30 flex items-center justify-center text-sm font-semibold text-primary">
                  {i + 1}
                </span>
                <p className="text-muted-foreground leading-relaxed pt-1">{step}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Close */}
      <section className="py-20 px-4 bg-[hsl(222,60%,18%)]">
        <div className="container mx-auto max-w-3xl text-center">
          <h2 className="text-3xl md:text-4xl font-bold mb-4 text-white">
            Try it on your own catalog
          </h2>
          <p className="text-white/70 mb-8">
            Sixty days, no credit card. Connect your seller account and point it at a supplier list.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center items-center">
            <Button size="lg" className="text-base px-8" onClick={handleStartTrial}>
              Start 60-Day Free Trial
            </Button>
            <Button
              size="lg"
              variant="outline"
              className="text-base px-8 bg-transparent text-white border-white/30 hover:bg-white/10"
              onClick={() => navigate("/pricing")}
            >
              See pricing
            </Button>
          </div>
          <div className="flex flex-wrap justify-center gap-4 mt-8 text-sm text-white/60">
            <span className="flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4" /> US, CA, MX and BR
            </span>
            <span className="flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4" /> FBA and FBM
            </span>
            <span className="flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4" /> Chrome extension included
            </span>
          </div>
        </div>
      </section>

      <Footer />
      <ScrollIndicator />
    </div>
  );
};

export default OnlineArbitrageSoftware;
