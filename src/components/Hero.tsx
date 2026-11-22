
import { Download, CheckCircle, Zap, TrendingUp, FlaskConical, ShieldCheck, ArrowUpCircle, Clock } from 'lucide-react';
import { Button } from "@/components/ui/button";

const Hero = () => {
  const handleDownloadClick = () => {
    if (typeof gtag !== 'undefined') {
      gtag('event', 'cta_click', { event_category: 'engagement', event_label: 'hero_download_button', value: 1 });
    }
    window.location.href = '/signup';
  };

  return (
    <div className="relative min-h-screen flex items-center overflow-hidden bg-gradient-to-br from-[hsl(222,84%,4.9%)] via-[hsl(230,50%,10%)] to-[hsl(260,50%,8%)]">
      {/* Animated gradient orbs */}
      <div className="absolute top-1/4 -left-32 w-96 h-96 bg-primary/20 rounded-full blur-[120px] animate-pulse" />
      <div className="absolute bottom-1/4 -right-32 w-96 h-96 bg-purple-500/15 rounded-full blur-[120px] animate-pulse" style={{ animationDelay: '1s' }} />
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-primary/5 rounded-full blur-[200px]" />

      {/* Grid pattern overlay */}
      <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-[size:64px_64px]" />

      <div className="container mx-auto px-4 py-20 md:py-24 relative z-10">
        <div className="flex justify-center">
          {/* Copy */}
          <div className="w-full max-w-2xl min-w-0 text-center mx-auto">
            <div className="w-full max-w-[calc(100vw-2rem)] min-w-0 rounded-2xl border border-white/10 bg-white/5 p-5 shadow-2xl backdrop-blur-xl sm:p-6 md:p-8">
            <div className="inline-flex items-start gap-2 px-4 py-1.5 rounded-2xl border border-primary/30 bg-primary/10 text-primary text-xs sm:text-sm font-medium mb-6 animate-fade-in max-w-full min-w-0">
              <Zap className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span className="break-words">Not Just a Repricer — A Complete Inventory Management System</span>
            </div>

            <h1 className="text-2xl md:text-3xl lg:text-4xl font-bold mb-4 animate-fade-in leading-tight">
              <span className="text-white">Make better sourcing decisions. Price smarter with AI. Scale with confidence.</span>
            </h1>

            <p className="text-base md:text-lg text-white/90 mb-6 animate-slide-up leading-relaxed" style={{ animationDelay: '0.15s' }}>
              InventorySprint helps you organize proven Amazon products, track suppliers, and automate pricing with margin-aware rules that never sell below your floor.
            </p>

            <div className="mb-7 animate-slide-up text-left w-full" style={{ animationDelay: '0.25s' }}>
              <div className="space-y-2">
                <div className="flex items-start gap-3 text-white/90">
                  <CheckCircle className="w-5 h-5 text-green-400 flex-shrink-0 mt-0.5" />
                  <span className="break-words min-w-0">Organize and store your proven Amazon products</span>
                </div>
                <div className="flex items-start gap-3 text-white/90">
                  <CheckCircle className="w-5 h-5 text-green-400 flex-shrink-0 mt-0.5" />
                  <span className="break-words min-w-0">Track supplier links and product history in one place</span>
                </div>
                <div className="flex items-start gap-3 text-white/90">
                  <CheckCircle className="w-5 h-5 text-green-400 flex-shrink-0 mt-0.5" />
                  <span className="break-words min-w-0">Reorder faster with direct supplier access</span>
                </div>
                <div className="flex items-start gap-3 text-white/90">
                  <CheckCircle className="w-5 h-5 text-green-400 flex-shrink-0 mt-0.5" />
                  <span className="break-words min-w-0">Know what to reorder before you run out</span>
                </div>
                <div className="flex items-start gap-3 text-white/90">
                  <CheckCircle className="w-5 h-5 text-green-400 flex-shrink-0 mt-0.5" />
                  <span className="break-words min-w-0">Automate pricing with rule-based decisions, reviewed by Gemini</span>
                </div>
              </div>
            </div>

            {/* AI Pricing Points */}
            <div className="pt-6 mt-1 border-t border-white/10">
              <h3 className="text-lg font-bold mb-1">
                <span className="bg-gradient-to-r from-primary to-purple-400 bg-clip-text text-transparent">AI-Reviewed Pricing, Powered by Gemini</span>
              </h3>
              <p className="text-white/90 text-sm mb-4">Smart pricing that protects your margins — not a bot racing to the bottom.</p>
              <div className="grid grid-cols-2 gap-3 text-left">
                <div className="flex items-center gap-2 bg-white/5 rounded-lg px-3 py-2">
                  <TrendingUp className="w-4 h-4 text-primary flex-shrink-0" />
                  <span className="text-white/90 text-xs">Doesn't blindly lower prices</span>
                </div>
                <div className="flex items-center gap-2 bg-white/5 rounded-lg px-3 py-2">
                  <ArrowUpCircle className="w-4 h-4 text-primary flex-shrink-0" />
                  <span className="text-white/90 text-xs">Raises prices when the market allows</span>
                </div>
                <div className="flex items-center gap-2 bg-white/5 rounded-lg px-3 py-2">
                  <Zap className="w-4 h-4 text-primary flex-shrink-0" />
                  <span className="text-white/90 text-xs">Reacts instantly — no delays</span>
                </div>
                <div className="flex items-center gap-2 bg-white/5 rounded-lg px-3 py-2">
                  <Clock className="w-4 h-4 text-primary flex-shrink-0" />
                  <span className="text-white/90 text-xs">Monitors your prices around the clock</span>
                </div>
                <div className="flex items-center gap-2 bg-white/5 rounded-lg px-3 py-2">
                  <FlaskConical className="w-4 h-4 text-primary flex-shrink-0" />
                  <span className="text-white/90 text-xs">Tests every change before trusting it</span>
                </div>
                <div className="flex items-center gap-2 bg-white/5 rounded-lg px-3 py-2">
                  <ShieldCheck className="w-4 h-4 text-primary flex-shrink-0" />
                  <span className="text-white/90 text-xs">Every change is proven before it goes live</span>
                </div>
              </div>
            </div>
            </div>

            {/* CTA Button */}
            <div className="hidden justify-center lg:justify-start mb-3 animate-slide-up" style={{ animationDelay: '0.4s' }} aria-hidden="true">
              <Button
                size="lg"
                className="bg-primary hover:bg-primary/90 text-primary-foreground font-semibold text-lg px-8 py-6 h-auto shadow-lg shadow-primary/25 hover:shadow-xl hover:shadow-primary/30 transition-all duration-300 group"
                onClick={handleDownloadClick}
              >
                <Download className="mr-2 group-hover:-translate-y-0.5 transition-transform" size={22} />
                Start Your 60-Day Free Trial
              </Button>
            </div>

            {/* Trust indicators */}
            <div className="hidden flex-wrap items-center justify-center lg:justify-start gap-x-5 gap-y-2 text-sm text-white/90 animate-slide-up" style={{ animationDelay: '0.5s' }} aria-hidden="true">
              <span className="flex items-center">
                <span className="w-2 h-2 bg-green-400 rounded-full mr-2 animate-pulse" />
                No Credit Card Required
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Hero;
