import { useEffect, useMemo, useState } from "react";
import { Activity, Clock3, ShieldCheck, Sparkles, TrendingUp, BrainCircuit } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatDistanceToNowStrict } from "date-fns";
import { getAiInsightHeadline, insightToneClasses } from "@/lib/aiInsightHeadline";

export interface LiveAiSchedulerState {
  is_enabled: boolean;
  is_running: boolean;
  last_run_at: string | null;
  next_run_at: string | null;
}

export interface LiveAiStateItem {
  asin: string;
  title?: string;
  image_url?: string;
  event_type?: string | null;
  current_price?: number | null;
  recommended_price?: number | null;
  buy_box_price?: number | null;
  last_evaluated_at?: string | null;
  last_action_at?: string | null;
  last_action_type?: string | null;
  last_action_label?: string | null;
  trigger_source?: string | null;
  /** "pro" | "flash" | null — drives the "AI-reviewed by Gemini" badge */
  model_tier?: string | null;
  /** Raw model id (e.g. "gemini-2.5-flash") — tooltip only */
  model_used?: string | null;
  reviewed_at?: string | null;
}

interface Props {
  items: LiveAiStateItem[];
  scheduler: LiveAiSchedulerState | null;
  lastUpdatedAt?: string | null;
}

const formatRelativeShort = (value?: string | null) => {
  if (!value) return "—";
  try {
    return `${formatDistanceToNowStrict(new Date(value))} ago`;
  } catch {
    return "—";
  }
};

const formatCountdown = (value?: string | null) => {
  if (!value) return "—";
  const diff = new Date(value).getTime() - Date.now();
  if (diff <= 0) return "now";

  const totalSeconds = Math.floor(diff / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes <= 0) return `${seconds}s`;
  if (minutes < 60) return `${minutes}m ${seconds}s`;

  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
};

const getLiveLabel = (item: LiveAiStateItem) => {
  if (item.last_action_type === "price_changed") return "Price updated";
  if (item.last_action_type?.includes("blocked")) return "Protected";
  if (item.last_action_type === "no_change") return "Holding";
  if (item.event_type === "raised") return "Raising";
  if (item.event_type === "winner") return "Winning";
  if (item.event_type === "bb_loss") return "Competing";
  if (item.event_type === "constrained") return "Protected";
  return "Monitoring";
};

const getLiveBadgeClass = (item: LiveAiStateItem) => {
  if (item.last_action_type === "price_changed") return "border-primary/30 bg-primary/10 text-primary";
  if (item.last_action_type?.includes("blocked") || item.event_type === "constrained") return "border-accent/40 bg-accent text-accent-foreground";
  return "border-border/60 bg-muted/40 text-foreground";
};

export default function AiInsightsLiveState({ items, scheduler, lastUpdatedAt }: Props) {
  const [, setNowTick] = useState(Date.now());

  useEffect(() => {
    const interval = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);

  const schedulerMeta = useMemo(() => {
    if (!scheduler) return null;

    return {
      status: scheduler.is_running ? "Evaluating now" : scheduler.is_enabled ? "Active" : "Paused",
      lastRun: formatRelativeShort(scheduler.last_run_at),
      nextRun: formatCountdown(scheduler.next_run_at),
    };
  }, [scheduler]);

  if (!scheduler && items.length === 0) return null;

  return (
    <section className="space-y-3" aria-label="Live repricer state">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Live repricer state</h2>
          <p className="text-xs text-muted-foreground">What the deterministic repricer is doing right now.</p>
        </div>
        {lastUpdatedAt && (
          <Badge variant="outline" className="gap-1 text-[10px]">
            <Activity className="h-3 w-3" />
            Refreshed {formatRelativeShort(lastUpdatedAt)}
          </Badge>
        )}
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1.9fr)]">
        <Card className="border-border/40 bg-card/80">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              Scheduler status
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge className="border-primary/30 bg-primary/10 text-primary">{schedulerMeta?.status ?? "Unavailable"}</Badge>
              {scheduler?.is_enabled === false && <Badge variant="outline">Disabled</Badge>}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-md border border-border/50 bg-muted/30 p-3">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Last run</p>
                <p className="mt-1 text-sm font-semibold text-foreground">{schedulerMeta?.lastRun ?? "—"}</p>
              </div>
              <div className="rounded-md border border-border/50 bg-muted/30 p-3">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Next AI check</p>
                <p className="mt-1 text-sm font-semibold text-foreground">{schedulerMeta?.nextRun ?? "—"}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {items.slice(0, 6).map((item) => {
            const currentPrice = item.current_price ?? item.recommended_price;
            const actionAt = item.last_action_at ?? item.last_evaluated_at;

            return (
              <Card key={item.asin} className="border-border/40 bg-card/80">
                <CardContent className="p-3 space-y-3">
                  <div className="flex items-start gap-3">
                    {item.image_url ? (
                      <img src={item.image_url} alt="" className="h-10 w-10 rounded-md border border-border/40 object-cover" />
                    ) : (
                      <div className="flex h-10 w-10 items-center justify-center rounded-md border border-border/40 bg-muted/40">
                        <Activity className="h-4 w-4 text-muted-foreground" />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono text-xs font-semibold text-foreground">{item.asin}</span>
                        <Badge variant="outline" className={cn("text-[10px]", getLiveBadgeClass(item))}>
                          {getLiveLabel(item)}
                        </Badge>
                      </div>
                      {item.title && <p className="mt-1 truncate text-xs text-muted-foreground">{item.title}</p>}
                    </div>
                  </div>

                  {/* AI observation badge — only when Gemini wrote an observation note for this row.
                      The note does NOT change the repricer's decision. */}
                  {(() => {
                    const tier = (item.model_tier || "").toLowerCase();
                    if (tier !== "pro" && tier !== "flash") return null;
                    const isPro = tier === "pro";
                    const label = isPro
                      ? "AI observation (Gemini Pro)"
                      : "AI observation (Gemini Flash)";
                    return (
                      <div
                        className={cn(
                          "flex items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] font-semibold",
                          isPro
                            ? "border-primary/40 bg-primary/10 text-primary"
                            : "border-accent/40 bg-accent/40 text-accent-foreground",
                        )}
                        title={item.model_used || label}
                      >
                        <BrainCircuit className="h-3 w-3" />
                        <span>🧠 {label}</span>
                      </div>
                    );
                  })()}

                  {/* BIG AI INSIGHT — deterministic headline */}
                  {(() => {
                    const h = getAiInsightHeadline({
                      event_type: item.event_type,
                      action_type: item.last_action_type,
                      was_price_changed: item.last_action_type === "price_changed",
                      current_price: item.current_price,
                      target_price: item.recommended_price,
                      buy_box_price: item.buy_box_price,
                    });
                    const tone = insightToneClasses[h.tone];
                    return (
                      <div className={cn("rounded-md border px-2.5 py-2 flex items-start gap-2", tone.box)}>
                        <span className="text-base leading-none mt-0.5" aria-hidden>{h.emoji}</span>
                        <p className={cn("text-xs font-semibold leading-snug", tone.text)}>{h.text}</p>
                      </div>
                    );
                  })()}

                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-md border border-border/50 bg-muted/30 p-2">
                      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Current</p>
                      <p className="text-sm font-semibold text-foreground">{currentPrice != null ? `$${currentPrice.toFixed(2)}` : "—"}</p>
                    </div>
                    <div className="rounded-md border border-border/50 bg-muted/30 p-2">
                      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Buy Box</p>
                      <p className="text-sm font-semibold text-foreground">{item.buy_box_price != null ? `$${item.buy_box_price.toFixed(2)}` : "—"}</p>
                    </div>
                  </div>

                  <div className="space-y-1.5 text-xs text-muted-foreground">
                    <div className="flex items-center gap-1.5">
                      <Clock3 className="h-3.5 w-3.5" />
                      <span>Evaluated {formatRelativeShort(item.last_evaluated_at)}</span>
                    </div>
                    {item.last_action_label && (
                      <div className="flex items-start gap-1.5 text-foreground">
                        {item.last_action_type === "price_changed" ? <TrendingUp className="mt-0.5 h-3.5 w-3.5 text-primary" /> : <ShieldCheck className="mt-0.5 h-3.5 w-3.5 text-muted-foreground" />}
                        <span className="line-clamp-2">{item.last_action_label}</span>
                      </div>
                    )}
                    <div className="flex items-center justify-between gap-2">
                      <span>{actionAt ? `Updated ${formatRelativeShort(actionAt)}` : "Awaiting fresh action"}</span>
                      {item.trigger_source && <span className="capitalize">{item.trigger_source.replace(/_/g, " ")}</span>}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>
    </section>
  );
}