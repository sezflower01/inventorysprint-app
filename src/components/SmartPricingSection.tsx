
import { TrendingUp, FlaskConical, ShieldCheck, ArrowUpCircle, Zap, Clock } from 'lucide-react';

const points = [
  { icon: TrendingUp, text: "Doesn't blindly lower prices" },
  { icon: ArrowUpCircle, text: "Raises prices when the market allows" },
  { icon: Zap, text: "Reacts instantly — no delays" },
  { icon: Clock, text: "Monitors your prices around the clock" },
  { icon: FlaskConical, text: "Tests every change before trusting it" },
  { icon: ShieldCheck, text: "Every change is proven before it goes live" },
];

const SmartPricingSection = () => {
  return (
    <section className="py-20 bg-gradient-to-br from-[hsl(222,84%,4.9%)] to-[hsl(230,50%,10%)] relative overflow-hidden">
      <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.015)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.015)_1px,transparent_1px)] bg-[size:80px_80px]" />
      <div className="container mx-auto px-4 relative z-10">
        <div className="max-w-3xl mx-auto text-center">
          <h2 className="text-3xl md:text-4xl font-bold text-white mb-4">
            AI-Reviewed Pricing, Powered by <span className="bg-gradient-to-r from-primary to-purple-400 bg-clip-text text-transparent">Gemini</span>
          </h2>
          <p className="text-muted-foreground mb-10 text-lg">
            Smart pricing that protects your margins — not a bot racing to the bottom.
          </p>
          <div className="grid grid-cols-1 gap-3 max-w-xl mx-auto">
            {points.map((p, i) => {
              const Icon = p.icon;
              return (
                <div key={i} className="flex items-center gap-4 bg-white/5 border border-white/10 rounded-xl px-5 py-3.5">
                  <Icon className="w-5 h-5 text-primary flex-shrink-0" />
                  <span className="text-gray-200 text-base">{p.text}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
};

export default SmartPricingSection;
