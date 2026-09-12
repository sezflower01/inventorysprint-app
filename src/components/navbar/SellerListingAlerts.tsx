/**
 * New-listing alerts for watched sellers, in the navbar.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 *
 * These detections used to arrive by email through Resend, from two places:
 * check-seller-watchlist sent one message per watch that gained ASINs, and
 * classify-listing-brands sent a digest per user per run. With 400+ active
 * watches the first of those alone exhausted Resend's 100-messages-a-day team
 * quota on 2026-09-12.
 *
 * That quota is shared with auth-email-hook, which sends password resets and
 * signup confirmations from the same Resend account -- so burning it on
 * detection alerts takes account email down with it. Both senders were removed
 * in favour of this panel.
 *
 * ── WHY brand_notified_at IS THE READ MARKER ──────────────────────────────
 *
 * The column already existed, stamped once a listing had been emailed. With
 * the email gone it is free to mean "surfaced to the user", which is the same
 * question one layer up -- so unread state needed no new table, no new column
 * and no migration. NULL means not yet seen; opening this panel stamps it.
 *
 * ── WHAT IS SHOWN ─────────────────────────────────────────────────────────
 *
 * Only brand_match_state = 'matched' rows, and only those past
 * DETECTION_TRUST_BOUNDARY. That is deliberately NARROWER than the email was:
 * the per-watch email fired on any new ASIN at all, which is both the reason
 * for the volume and the reason it was mostly unactionable. Everything else
 * remains visible in the Seller Analyzer panel -- filtered here, not hidden.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { PackagePlus, Copy } from "lucide-react";
import { useNavigate } from "react-router-dom";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import {
  isQueryCircuitOpen,
  isTimeoutError,
  recordDbFailure,
  recordDbSuccess,
  getBackoffMultiplier,
} from "@/hooks/use-db-pressure";
import { DETECTION_TRUST_BOUNDARY } from "@/hooks/use-seller-new-listings";

interface ListingRow {
  id: string;
  asin: string;
  title: string | null;
  brand: string | null;
  seller_id: string;
  marketplace: string;
  detected_at: string;
  amazon_price_cents: number | null;
}

interface SellerGroup {
  key: string;
  sellerId: string;
  marketplace: string;
  sellerName: string | null;
  listings: ListingRow[];
  lastDetectedAt: string;
}

/**
 * Rows pulled per poll.
 *
 * The badge count is a separate head:true COUNT, so this bound limits what is
 * rendered and what one "mark read" can stamp -- never what is reported. A
 * backlog above this clears 200 at a time and the badge returns with the rest,
 * which is honest about there being more rather than silently dropping it.
 */
const PAGE_LIMIT = 200;

const MARKETPLACE_FLAGS: Record<string, string> = {
  US: "🇺🇸",
  CA: "🇨🇦",
  MX: "🇲🇽",
  BR: "🇧🇷",
};

export default function SellerListingAlerts() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [rows, setRows] = useState<ListingRow[]>([]);
  const [totalUnread, setTotalUnread] = useState(0);
  const [sellerNames, setSellerNames] = useState<Record<string, string>>({});
  const [isOpen, setIsOpen] = useState(false);
  const [marking, setMarking] = useState(false);
  const consecutiveFailsRef = useRef(0);

  // Seller names live on the watch, not on the listing row. Loaded once per
  // mount rather than per poll: there are 400+ watches and the names do not
  // change between refreshes.
  useEffect(() => {
    if (!user) { setSellerNames({}); return; }
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("seller_watchlist")
        .select("seller_id, marketplace, seller_name")
        .neq("status", "cancelled");
      if (cancelled) return;
      const names: Record<string, string> = {};
      for (const w of (data ?? []) as { seller_id: string; marketplace: string; seller_name: string | null }[]) {
        if (w?.seller_name) names[`${w.seller_id}|${w.marketplace}`] = w.seller_name;
      }
      setSellerNames(names);
    })();
    return () => { cancelled = true; };
  }, [user]);

  const fetchAlerts = useCallback(async () => {
    if (!user) return;
    if (isQueryCircuitOpen("seller_watch_new_listings")) return;

    // Both queries read the BASE table, never seller_new_listings_branded.
    // That view adds is_my_brand through a LATERAL over user_brands, which on
    // an unbounded COUNT runs once per table row and returns HTTP 500 -- the
    // same trap documented in use-seller-new-listings.
    const [listRes, countRes] = await Promise.all([
      supabase
        .from("seller_watch_new_listings")
        .select("id, asin, title, brand, seller_id, marketplace, detected_at, amazon_price_cents")
        .eq("user_id", user.id)
        .eq("brand_match_state", "matched")
        .is("brand_notified_at", null)
        .gte("detected_at", DETECTION_TRUST_BOUNDARY)
        .order("detected_at", { ascending: false })
        .limit(PAGE_LIMIT),
      supabase
        .from("seller_watch_new_listings")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id)
        .eq("brand_match_state", "matched")
        .is("brand_notified_at", null)
        .gte("detected_at", DETECTION_TRUST_BOUNDARY),
    ]);

    if (listRes.error) {
      if (isTimeoutError(listRes.error)) {
        recordDbFailure("seller_watch_new_listings");
        consecutiveFailsRef.current++;
      }
      console.error("[SellerListingAlerts] fetch failed", listRes.error);
      return;
    }
    consecutiveFailsRef.current = 0;
    recordDbSuccess("seller_watch_new_listings");

    setRows((listRes.data ?? []) as unknown as ListingRow[]);
    setTotalUnread(countRes.count ?? (listRes.data?.length ?? 0));
  }, [user]);

  useEffect(() => {
    if (!user) { setRows([]); setTotalUnread(0); return; }
    fetchAlerts();

    // Same backoff contract as the other navbar alert panels: stand down when
    // the shared circuit is open, and slow further after repeated failures.
    const BASE_INTERVAL = 60000;
    let timer: ReturnType<typeof setTimeout>;
    const scheduleNext = () => {
      if (isQueryCircuitOpen("seller_watch_new_listings")) {
        timer = setTimeout(scheduleNext, BASE_INTERVAL * 8);
        return;
      }
      const multiplier = getBackoffMultiplier();
      const failMultiplier = consecutiveFailsRef.current >= 3 ? 4 : 1;
      timer = setTimeout(() => {
        fetchAlerts().then(scheduleNext);
      }, BASE_INTERVAL * multiplier * failMultiplier);
    };
    scheduleNext();
    return () => clearTimeout(timer);
  }, [user, fetchAlerts]);

  /**
   * Stamp the loaded rows read.
   *
   * Chunked at 100 for the same reason deleteListings is: the ids ride in the
   * PATCH query string, and a few hundred UUIDs overflow what proxies accept
   * while failing as an opaque server error.
   *
   * The rows stay on screen after stamping -- clearing the list out from under
   * someone who just opened it is how you lose the thing you came to read.
   */
  const markRead = useCallback(async () => {
    if (!user || rows.length === 0 || marking) return;
    setMarking(true);
    const ids = rows.map((r) => r.id);
    const stamp = new Date().toISOString();
    let stamped = 0;
    try {
      for (let i = 0; i < ids.length; i += 100) {
        const slice = ids.slice(i, i + 100);
        // Cast because src/integrations/supabase/types.ts is stale: it predates
        // the migrations that added brand_match_state and brand_notified_at, so
        // neither column appears in the generated Update type. The string-based
        // select and filter calls above are unaffected (they are not checked
        // against the column list) -- only this object literal is, and
        // regenerating types is a separate, repo-wide change.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error } = await (supabase.from("seller_watch_new_listings") as any)
          .update({ brand_notified_at: stamp })
          .in("id", slice);
        if (error) throw error;
        stamped += slice.length;
      }
      setTotalUnread((prev) => Math.max(0, prev - stamped));
    } catch (e) {
      console.error("[SellerListingAlerts] mark read failed", e);
      toast.error(`Couldn't mark these read (${stamped} of ${ids.length} done)`);
    } finally {
      setMarking(false);
    }
  }, [user, rows, marking]);

  const handleOpenChange = (open: boolean) => {
    setIsOpen(open);
    if (open) void markRead();
  };

  // Group by seller: "Pedu listed 6 items" is the unit of attention, and it is
  // what the email said too. A flat listing list buries which storefront moved.
  const groups: SellerGroup[] = [];
  const byKey = new Map<string, SellerGroup>();
  for (const r of rows) {
    const key = `${r.seller_id}|${r.marketplace}`;
    let g = byKey.get(key);
    if (!g) {
      g = {
        key,
        sellerId: r.seller_id,
        marketplace: r.marketplace,
        sellerName: sellerNames[key] ?? null,
        listings: [],
        lastDetectedAt: r.detected_at,
      };
      byKey.set(key, g);
      groups.push(g);
    }
    g.listings.push(r);
    if (r.detected_at > g.lastDetectedAt) g.lastDetectedAt = r.detected_at;
  }

  const copyAllAsins = async () => {
    const asins = Array.from(new Set(rows.map((r) => r.asin)));
    if (!asins.length) { toast.info("No ASINs to copy"); return; }
    try {
      await navigator.clipboard.writeText(asins.join(", "));
      toast.success(`${asins.length} ASIN${asins.length === 1 ? "" : "s"} copied`);
    } catch {
      toast.error("Failed to copy");
    }
  };

  if (!user) return null;

  return (
    <Popover open={isOpen} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="relative" title="New listings from watched sellers">
          <PackagePlus className="h-4 w-4" />
          {totalUnread > 0 && (
            <Badge
              variant="destructive"
              className="absolute -top-1 -right-1 h-5 min-w-5 px-1 flex items-center justify-center text-xs"
            >
              {totalUnread > 99 ? "99+" : totalUnread}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-96 p-0" align="end">
        <div className="p-3 border-b">
          <h4 className="font-semibold text-sm">New listings from watched sellers</h4>
          <p className="text-xs text-muted-foreground">
            {rows.length === 0
              ? "In brands you already carry"
              : totalUnread > rows.length
                ? `Showing ${rows.length} of ${totalUnread} unread, newest first`
                : `${rows.length} unread across ${groups.length} seller${groups.length === 1 ? "" : "s"}`}
          </p>
        </div>

        {groups.length === 0 ? (
          <div className="p-4 text-center text-sm text-muted-foreground">
            Nothing new right now
          </div>
        ) : (
          <ScrollArea className="h-[320px]">
            <div className="divide-y">
              {groups.map((g) => (
                <button
                  key={g.key}
                  onClick={() => { setIsOpen(false); navigate("/tools/seller-analyzer"); }}
                  className="w-full p-3 text-left hover:bg-muted/50 transition-colors"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium truncate">
                      {g.sellerName || g.sellerId}
                    </span>
                    <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground border border-border shrink-0">
                      {MARKETPLACE_FLAGS[g.marketplace] && <span>{MARKETPLACE_FLAGS[g.marketplace]}</span>}
                      {g.marketplace}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {g.listings.length} new listing{g.listings.length === 1 ? "" : "s"} •{" "}
                    {new Date(g.lastDetectedAt).toLocaleDateString()}
                  </p>
                  <p className="text-xs mt-1 font-mono text-primary/80 truncate">
                    {g.listings.slice(0, 4).map((l) => l.asin).join(", ")}
                    {g.listings.length > 4 ? ` +${g.listings.length - 4}` : ""}
                  </p>
                </button>
              ))}
            </div>
          </ScrollArea>
        )}

        <div className="p-2 border-t flex gap-2">
          <Button variant="outline" size="sm" className="flex-1 text-xs" onClick={copyAllAsins}>
            <Copy className="h-3 w-3 mr-1" />
            Copy ASINs
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="flex-1 text-xs"
            onClick={() => { setIsOpen(false); navigate("/tools/seller-analyzer"); }}
          >
            Open Seller Analyzer →
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
