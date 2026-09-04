import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useAutoSourceConfig } from "@/hooks/use-auto-source-config";
import { Loader2, Store, BellPlus, Bell, BellOff } from "lucide-react";
import { useSellerWatchlist, formatDuration, type SellerWatch } from "@/hooks/use-seller-watchlist";
import { useToast } from "@/hooks/use-toast";
import NewListingsPanel from "@/components/seller-analyzer/NewListingsPanel";
import NotifyEmailField from "@/components/seller-analyzer/NotifyEmailField";
import SourceRetailersPanel from "@/components/seller-analyzer/SourceRetailersPanel";
import ExcludedDomainsPanel from "@/components/seller-analyzer/ExcludedDomainsPanel";
import QualificationExclusionsPanel from "@/components/seller-analyzer/QualificationExclusionsPanel";
import WatchedBrandsPanel from "@/components/seller-analyzer/WatchedBrandsPanel";
import { BrandSourcesPanel } from "@/components/seller-analyzer/BrandSourcesPanel";
import BulkAddPanel from "@/components/seller-analyzer/BulkAddPanel";
import { Helmet } from "react-helmet-async";

const MARKETS = ["US", "CA", "MX", "GB", "DE", "FR", "IT", "ES", "JP", "IN", "BR"];

function parseSellerInput(raw: string): { sellerId: string } {
  const t = raw.trim();
  const me = t.match(/[?&]me=([A-Z0-9]+)/i);
  if (me) return { sellerId: me[1] };
  return { sellerId: t };
}

/**
 * Row status. Every watch used to render an identical "Watching" badge, which
 * made three genuinely different states indistinguishable: seeded and quiet,
 * never checked yet, and (before the fair-rotation fix) never going to be
 * checked at all. At scale the queue is legitimately days deep, so the wait
 * has to be visible and explained or a working watch looks broken for a week.
 */
function WatchStatus({ watch }: { watch: SellerWatch }) {
  // last_checked_at and known_asin_list are written together by the worker's
  // first pass, so a null here means "no baseline yet".
  //
  // The seeding ETA is deliberately NOT repeated per row. It is identical for
  // every unseeded watch, so at 400 sellers it printed the same sentence 400
  // times and buried the one thing that differs -- which sellers are still
  // waiting. It now appears once, in the card header.
  if (!watch.last_checked_at) {
    return (
      <Badge variant="secondary" className="gap-1 shrink-0">
        <Loader2 className="h-3 w-3 animate-spin" /> Seeding
      </Badge>
    );
  }

  const checkedAgoDays = (Date.now() - new Date(watch.last_checked_at).getTime()) / 86_400_000;

  return (
    <div className="flex items-center gap-2 shrink-0">
      <span className="text-[11px] text-muted-foreground hidden sm:inline">
        {formatDuration(checkedAgoDays)} ago
      </span>
      <Badge className="gap-1">
        <Bell className="h-3 w-3" /> Watching
      </Badge>
    </div>
  );
}

export default function SellerAnalyzer() {
  const [input, setInput] = useState("");
  const [marketplace, setMarketplace] = useState("US");
  const [tab, setTab] = useState("add");
  const [watchFilter, setWatchFilter] = useState("");
  const { config: autoCfg, usedToday, saving: cfgSaving, update: updateAutoCfg } = useAutoSourceConfig();

  const { toast } = useToast();
  const { watches, createWatch, cancelWatch, cancelWatches, bulkAddWatches, timing } = useSellerWatchlist();
  const [watchToggling, setWatchToggling] = useState(false);

  const typedSellerId = parseSellerInput(input).sellerId;
  const currentWatch = typedSellerId
    ? watches.find((w) => w.seller_id === typedSellerId && w.marketplace === marketplace)
    : undefined;

  const seedingCount = watches.filter((w) => !w.last_checked_at).length;

  const visibleWatches = (() => {
    const q = watchFilter.trim().toLowerCase();
    if (!q) return watches;
    return watches.filter(
      (w) => w.seller_id.toLowerCase().includes(q) || (w.seller_name || "").toLowerCase().includes(q),
    );
  })();

  // Deliberately does NOT switch tabs. Newly added sellers appear in the
  // Watched Sellers card directly below, on this same tab -- and Results holds
  // only new listings, which stay empty for days while the queue seeds. Jumping
  // there after an add would show an empty panel and read as a failure.
  const handleBulkAdd: typeof bulkAddWatches = bulkAddWatches;

  const addWatch = async () => {
    if (!typedSellerId) return;
    setWatchToggling(true);
    try {
      await createWatch(typedSellerId, null, marketplace);
      toast({ title: `Now watching ${typedSellerId}` });
      setInput("");
    } catch (e: any) {
      toast({ title: "Could not watch seller", description: e.message, variant: "destructive" });
    } finally {
      setWatchToggling(false);
    }
  };

  const removeWatch = async (id: string) => {
    try {
      await cancelWatch(id);
      toast({ title: "Watch cancelled" });
    } catch (e: any) {
      toast({ title: "Could not cancel watch", description: e.message, variant: "destructive" });
    }
  };

  // Selection is keyed by watch id and deliberately survives filter changes:
  // narrowing the filter to pick out a handful, then widening it again, must
  // not silently discard what was already ticked.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkRemoving, setBulkRemoving] = useState(false);

  const visibleIds = visibleWatches.map((w) => w.id);
  const selectedVisibleCount = visibleIds.filter((id) => selected.has(id)).length;
  const allVisibleSelected = visibleIds.length > 0 && selectedVisibleCount === visibleIds.length;

  const toggleSelectAllVisible = (checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of visibleIds) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };

  const toggleOne = (id: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const removeSelected = async () => {
    const ids = Array.from(selected);
    if (!ids.length) return;
    setBulkRemoving(true);
    try {
      const n = await cancelWatches(ids);
      setSelected(new Set());
      toast({ title: `Removed ${n.toLocaleString()} seller${n === 1 ? "" : "s"}` });
    } catch (e) {
      toast({ title: "Could not remove sellers", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBulkRemoving(false);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <Helmet>
        <title>Seller Storefront Monitor | InventorySprint</title>
        <meta name="description" content="Watch Amazon seller storefronts and get alerted when they list something new." />
      </Helmet>

      {/* Header — title only. The entry controls moved into the Add tab so
          "what I put in" and "what came back" are never on screen competing
          for the same attention. */}
      <div className="bg-[#0f1c3f] text-white border-b">
        <div className="max-w-[1600px] mx-auto px-4 py-4">
          <div className="flex items-center gap-3">
            <Store className="h-5 w-5" />
            <h1 className="text-xl font-semibold">Seller Storefront Monitor</h1>
          </div>
          <p className="text-sm text-white/70 mt-1">
            Watch Amazon storefronts and get alerted when they list something new.
          </p>
        </div>
      </div>

      <div className="max-w-[1600px] mx-auto px-4 py-6">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="mb-4">
            <TabsTrigger value="add" className="gap-2">
              <BellPlus className="h-4 w-4" /> Add sellers
            </TabsTrigger>
            <TabsTrigger value="results" className="gap-2">
              <Bell className="h-4 w-4" /> Results
            </TabsTrigger>
          </TabsList>

          {/* ---- INPUTS ---- */}
          <TabsContent value="add" className="space-y-6 mt-0">
            <Card>
              <CardContent className="p-4">
                <h2 className="text-sm font-semibold mb-3">Watch a single seller</h2>
                <form
                  onSubmit={(e) => { e.preventDefault(); addWatch(); }}
                  className="flex flex-col md:flex-row items-stretch md:items-center gap-2"
                >
                  <Input
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="Seller ID (e.g. A1B0EBOAJDDILW) or full storefront URL"
                    className="md:max-w-xl"
                  />
                  <Select value={marketplace} onValueChange={setMarketplace}>
                    <SelectTrigger className="md:w-32"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {MARKETS.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  {currentWatch ? (
                    <Button type="button" variant="outline" onClick={() => removeWatch(currentWatch.id)}>
                      <Bell className="h-4 w-4 mr-2 text-emerald-500" /> Watching
                    </Button>
                  ) : (
                    <Button type="submit" disabled={watchToggling || !typedSellerId}>
                      {watchToggling ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <BellPlus className="h-4 w-4 mr-2" />}
                      Watch
                    </Button>
                  )}
                </form>
                <p className="mt-2 text-xs text-muted-foreground">
                  The marketplace chosen here also applies to bulk uploads below.
                </p>
              </CardContent>
            </Card>

            <BulkAddPanel
              marketplace={marketplace}
              currentWatchCount={watches.length}
              onBulkAdd={handleBulkAdd}
            />

            <Card>
              <CardContent className="p-4 space-y-3">
                <div className="flex items-baseline justify-between gap-2">
                  <h2 className="text-sm font-semibold">Automatic source search</h2>
                  <span className="text-xs text-muted-foreground">
                    {usedToday} of {autoCfg.daily_cap} used today
                  </span>
                </div>

                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="text-sm">Search "Needs Approval" listings</div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Gated products are searched by default — a source is often worth finding
                      before deciding whether to apply. Turn this off to spend the daily budget
                      only on products you can already sell.
                    </p>
                  </div>
                  <Switch
                    checked={autoCfg.search_needs_approval}
                    disabled={cfgSaving}
                    onCheckedChange={(v) => {
                      updateAutoCfg({ search_needs_approval: v }).catch((e) =>
                        toast({ title: "Could not save setting", description: e.message, variant: "destructive" }),
                      );
                    }}
                    aria-label="Search Needs Approval listings"
                  />
                </div>

                {/* Stated plainly because it is NOT configurable: a restricted
                    ASIN cannot be sold at any price, so searching one is pure
                    waste no matter how the toggle above is set. */}
                <p className="text-xs text-muted-foreground border-t pt-3">
                  <strong>Restricted</strong> listings are never searched. This setting does not affect them.
                </p>

                {/* Strict mode. Deliberately here rather than in the exclusions
                    card: those rules say what is never sourceable, these say
                    what is not worth spending today's budget on. */}
                <div className="border-t pt-3 space-y-3">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="text-sm">Strict mode</div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Spend the daily budget only on listings that look commercially real.
                        Held listings still appear here with the reason — they just don't use a search.
                      </p>
                    </div>
                    <Switch
                      checked={autoCfg.strict_mode}
                      disabled={cfgSaving}
                      onCheckedChange={(v) => {
                        updateAutoCfg({ strict_mode: v }).catch((e) =>
                          toast({ title: "Could not save setting", description: e.message, variant: "destructive" }),
                        );
                      }}
                      aria-label="Strict mode"
                    />
                  </div>

                  {autoCfg.strict_mode && (
                    <div className="rounded-md border bg-muted/30 p-3 space-y-2.5">
                      <div className="flex items-center justify-between gap-3">
                        <label htmlFor="strict-fba" className="text-xs">
                          Minimum FBA sellers
                        </label>
                        <Input
                          id="strict-fba"
                          type="number"
                          min={0}
                          max={100}
                          className="h-7 w-20 text-xs"
                          value={autoCfg.strict_min_fba_offers}
                          disabled={cfgSaving}
                          onChange={(e) => {
                            const n = Number(e.target.value);
                            if (Number.isFinite(n) && n >= 0 && n <= 100) {
                              updateAutoCfg({ strict_min_fba_offers: n }).catch(() => {});
                            }
                          }}
                        />
                      </div>

                      <div className="flex items-center justify-between gap-3">
                        <label htmlFor="strict-sales" className="text-xs">
                          Minimum est. sales / month
                        </label>
                        <Input
                          id="strict-sales"
                          type="number"
                          min={0}
                          className="h-7 w-20 text-xs"
                          value={autoCfg.strict_min_monthly_sales}
                          disabled={cfgSaving}
                          onChange={(e) => {
                            const n = Number(e.target.value);
                            if (Number.isFinite(n) && n >= 0) {
                              updateAutoCfg({ strict_min_monthly_sales: n }).catch(() => {});
                            }
                          }}
                        />
                      </div>

                      <div className="flex items-start justify-between gap-3">
                        <label htmlFor="strict-seller-fba" className="text-xs min-w-0">
                          Seller's own listing must be FBA
                        </label>
                        <Switch
                          id="strict-seller-fba"
                          checked={autoCfg.strict_require_seller_fba}
                          disabled={cfgSaving}
                          onCheckedChange={(v) => { updateAutoCfg({ strict_require_seller_fba: v }).catch(() => {}); }}
                        />
                      </div>

                      <div className="flex items-start justify-between gap-3">
                        <label htmlFor="strict-rank" className="text-xs min-w-0">
                          Require a sales rank
                        </label>
                        <Switch
                          id="strict-rank"
                          checked={autoCfg.strict_require_rank}
                          disabled={cfgSaving}
                          onCheckedChange={(v) => { updateAutoCfg({ strict_require_rank: v }).catch(() => {}); }}
                        />
                      </div>

                      {/* The two numbers most likely to be set to something
                          that quietly does nothing, so both are explained. */}
                      <p className="text-[11px] text-muted-foreground border-t pt-2 leading-relaxed">
                        Sales are estimated from the sales rank — about {autoCfg.strict_min_monthly_sales}/month
                        corresponds to rank {Math.floor(Math.pow(Math.max(1, autoCfg.strict_min_monthly_sales) / 100000, 1 / -0.6)).toLocaleString()}.
                        Below ~10/month the existing rank limit already filters everything, so a lower number changes nothing.
                        {" "}<strong>Require a sales rank</strong> is the one that matters most: about 60% of detections
                        arrive with no rank at all and skip every rank check today.
                      </p>
                    </div>
                  )}
                </div>

                <NotifyEmailField
                  value={autoCfg.notify_email}
                  saving={cfgSaving}
                  onSave={(email) => updateAutoCfg({ notify_email: email })}
                />
              </CardContent>
            </Card>

            <SourceRetailersPanel
              fallbackEnabled={autoCfg.allow_open_web_fallback}
              fallbackSaving={cfgSaving}
              onFallbackChange={(v) => {
                updateAutoCfg({ allow_open_web_fallback: v }).catch((e) =>
                  toast({ title: "Could not save setting", description: e.message, variant: "destructive" }),
                );
              }}
            />

            <ExcludedDomainsPanel />

            <WatchedBrandsPanel />

            {/* Directly under the brand list, because attaching a shop to a
                brand only makes sense next to the brands themselves. */}
            <BrandSourcesPanel />

            <QualificationExclusionsPanel />

            {/* The watchlist belongs with the controls that manage it, not with
                results. It is the record of what you added, and at 400+ rows it
                would otherwise bury the new-listing feed that is the actual
                payoff of the tool. */}
            {watches.length > 0 ? (
              <Card>
                <CardContent className="p-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h2 className="text-sm font-semibold">Watched Sellers</h2>
                    <span className="text-xs text-muted-foreground">
                      {watches.length.toLocaleString()} watched · full rotation {formatDuration(timing.rotationDays)}
                    </span>
                  </div>

                  {/* Stated once, not on every row. */}
                  {seedingCount > 0 && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {seedingCount.toLocaleString()} still seeding — first alert possible in{" "}
                      {formatDuration(timing.daysToFirstAlert)}. Sellers are checked oldest-first,
                      so every watch is reached in turn.
                    </p>
                  )}

                  {watches.length > 10 && (
                    <Input
                      value={watchFilter}
                      onChange={(e) => setWatchFilter(e.target.value)}
                      placeholder="Filter by seller ID or name…"
                      className="mt-3 h-8 text-sm"
                    />
                  )}

                  {/* Select-all acts on the FILTERED rows, not the whole list.
                      That is what makes "swap the Keepa criteria" workable:
                      filter to the batch you no longer want, select all, remove.
                      The label always names the number it will actually tick, so
                      it can never read "select all" while meaning 400. */}
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-y py-2">
                    <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
                      <Checkbox
                        checked={allVisibleSelected}
                        onCheckedChange={(v) => toggleSelectAllVisible(v === true)}
                        aria-label="Select all shown sellers"
                      />
                      <span>
                        Select all{watchFilter.trim() ? " shown" : ""}
                        {visibleWatches.length > 0 && ` (${visibleWatches.length.toLocaleString()})`}
                      </span>
                    </label>

                    {selected.size > 0 && (
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">
                          {selected.size.toLocaleString()} selected
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => setSelected(new Set())}
                        >
                          Clear
                        </Button>
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button type="button" variant="destructive" size="sm" className="h-7 text-xs" disabled={bulkRemoving}>
                              {bulkRemoving && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                              Remove {selected.size.toLocaleString()}
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>
                                Remove {selected.size.toLocaleString()} seller{selected.size === 1 ? "" : "s"}?
                              </AlertDialogTitle>
                              <AlertDialogDescription>
                                They stop being checked for new listings. Listings already found stay
                                in Results, and re-adding a seller later resumes from its existing
                                baseline rather than seeding again from scratch.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction onClick={removeSelected}>
                                Remove {selected.size.toLocaleString()}
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    )}
                  </div>

                  {/* Scroll the list rather than letting 400 rows run the page
                      to several screens tall. */}
                  <div className="mt-3 max-h-[26rem] overflow-y-auto pr-1 divide-y">
                    {visibleWatches.map((w) => (
                      <div key={w.id} className="flex items-center justify-between gap-2 text-sm py-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <Checkbox
                            checked={selected.has(w.id)}
                            onCheckedChange={(v) => toggleOne(w.id, v === true)}
                            aria-label={`Select ${w.seller_name || w.seller_id}`}
                          />
                          <span className="truncate font-mono text-xs">{w.seller_name || w.seller_id}</span>
                          <span className="text-muted-foreground shrink-0 text-xs">({w.marketplace})</span>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <WatchStatus watch={w} />
                          <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={() => removeWatch(w.id)}>
                            <BellOff className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    ))}
                    {visibleWatches.length === 0 && (
                      <p className="py-6 text-center text-xs text-muted-foreground">
                        No sellers match “{watchFilter}”.
                      </p>
                    )}
                  </div>

                  {watchFilter.trim() && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Showing {visibleWatches.length.toLocaleString()} of {watches.length.toLocaleString()}.
                    </p>
                  )}
                </CardContent>
              </Card>
            ) : (
              <Card><CardContent className="p-10 text-center text-muted-foreground">
                Nothing watched yet — add a seller above, or bulk upload a list.
              </CardContent></Card>
            )}
          </TabsContent>

          {/* ---- RESULTS ---- */}
          <TabsContent value="results" className="mt-0">
            <NewListingsPanel />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
