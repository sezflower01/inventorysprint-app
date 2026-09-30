import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { AlertTriangle, RefreshCw, ChevronDown, ChevronRight, ShieldAlert, Save, ExternalLink } from "lucide-react";
import { calcRoiAtPrice } from "@/lib/roiCalc";
import { getMarketplaceConfig } from "@/lib/marketplaceCurrency";

interface SuppressedRow {
  id: string;
  sku: string;
  asin: string | null;
  marketplace: string;
  pricing_suppression_raw_code: string | null;
  pricing_suppression_raw_message: string | null;
  pricing_suppression_categories: string[] | null;
  pricing_suppression_enforcement_actions: string[] | null;
  pricing_suppression_severity: string | null;
  pricing_suppression_detected_at: string | null;
  pricing_suppression_pending_clear_at: string | null;
  min_price_override: number | null;
  max_price_override: number | null;
  my_price: number | null;
  isGhost: boolean;
  cost: number | null;
  fees_json: any;
}

interface UnknownRow {
  id: string;
  sku: string;
  asin: string | null;
  marketplace: string;
  listing_issue_unknown_categories: string[] | null;
}

interface Props {
  marketplace: string; // 'US' | 'CA' | 'MX' | 'BR' | 'ALL'
  isAdmin: boolean;
}

// Amazon's raw issue category codes, translated to plain language for display.
// Any code not listed here falls back to a humanized version of the code
// itself (underscores -> spaces, title case) rather than showing it verbatim.
const CATEGORY_LABELS: Record<string, string> = {
  INVALID_PRICE: "Price flagged as invalid",
  INVALID_ATTRIBUTE: "Listing detail needs fixing",
  MISSING_ATTRIBUTE: "Missing required listing info",
  QUALIFICATION_REQUIRED: "Requires seller qualification",
};

// Amazon issue codes we have diagnosed but deliberately keep surfacing, so the
// review row reads as the real problem rather than a bare number.
const ISSUE_CODE_LABELS: Record<string, string> = {
  "18977": "Counterfeit claim — no test buy",
};

function humanizeCategory(code: string): string {
  if (CATEGORY_LABELS[code]) return CATEGORY_LABELS[code];
  // "code:NNNNN" is written by classifyIssues when Amazon suppressed a listing
  // without naming a reason category, leaving the numeric code as the only
  // handle. Show it as a code, not as a fake category name.
  if (code.startsWith("code:")) {
    const num = code.slice(5);
    return ISSUE_CODE_LABELS[num] || `Amazon issue code ${num}`;
  }
  return code
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

const AMAZON_DOMAIN: Record<string, string> = {
  US: 'https://www.amazon.com',
  CA: 'https://www.amazon.ca',
  MX: 'https://www.amazon.com.mx',
  BR: 'https://www.amazon.com.br',
};

const SELLER_CENTRAL_DOMAIN: Record<string, string> = {
  US: 'https://sellercentral.amazon.com',
  CA: 'https://sellercentral.amazon.ca',
  MX: 'https://sellercentral.amazon.com.mx',
  BR: 'https://sellercentral.amazon.com.br',
};

export default function PricingSuppressionsSection({ marketplace, isAdmin }: Props) {
  const [rows, setRows] = useState<SuppressedRow[]>([]);
  const [unknown, setUnknown] = useState<UnknownRow[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [expandedUnknown, setExpandedUnknown] = useState(false);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [edits, setEdits] = useState<Record<string, { min: string; max: string; price: string }>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [reactivationStatus, setReactivationStatus] = useState<Record<string, { type: "sending" | "success" | "error"; message: string }>>({});
  const [showGhosts, setShowGhosts] = useState(false);
  const [fxRateByMarketplace, setFxRateByMarketplace] = useState<Record<string, number>>({});

  const load = async () => {
    setLoading(true);
    try {
      const { data: user } = await supabase.auth.getUser();
      if (!user?.user) return;

      let q = supabase
        .from("repricer_assignments")
        .select("id, sku, asin, marketplace, pricing_suppression_raw_code, pricing_suppression_raw_message, pricing_suppression_categories, pricing_suppression_enforcement_actions, pricing_suppression_severity, pricing_suppression_detected_at, pricing_suppression_pending_clear_at, min_price_override, max_price_override, last_applied_price, intl_listing_status")
        .eq("user_id", user.user.id)
        .eq("is_pricing_suppression", true);
      if (marketplace && marketplace !== "ALL") q = q.eq("marketplace", marketplace);
      const { data } = await q.order("pricing_suppression_detected_at", { ascending: false }).limit(500);
      let rawList = (data || []) as any[];

      // ---- Ghost detection (per-marketplace-appropriate signal) ----
      // Non-US: trust intl_listing_status -- a fresh, marketplace-specific
      // existence check (`verify-intl-listings-existence`). NOT_FOUND / DELETED /
      // INACTIVE / UNKNOWN means the listing genuinely doesn't exist there.
      // US: inventory.listing_status is the shared/canonical field this app
      // already uses everywhere else (Inventory Valuation's "Show Ghost ASINs"
      // toggle) -- NOT_IN_CATALOG / DELETED, or an amzn.gr.* generated SKU.
      // These two signals are NOT interchangeable: a SKU can show
      // inventory.listing_status=NOT_IN_CATALOG (a US-scoped/shared field) while
      // still being genuinely DISCOVERABLE and actively selling in CA/BR/MX --
      // applying the US signal to intl rows would wrongly hide a real,
      // actionable suppression. Tag rows here; hide/show is a display toggle
      // below, not a silent drop, so nothing genuinely gone stays invisible.
      const GHOST_INTL = new Set(["NOT_FOUND", "DELETED", "INACTIVE", "UNKNOWN", "[]", ""]);

      // ---- Current price per (sku, marketplace) ----
      // US price → inventory. Non-US price → asin_my_price_cache (marketplace-scoped).
      // Previously we always read inventory.my_price which returned the US price
      // for CA/MX/BR rows and made reactivated intl edits look like they reverted.
      const usSkus = [...new Set(rawList.filter(r => r.marketplace === "US").map(r => r.sku).filter(Boolean))];
      const intlRows = rawList.filter(r => r.marketplace !== "US");
      // cost/fees_json are needed for EVERY row regardless of marketplace (an
      // ASIN's cost is the same product across marketplaces) so the ROI
      // preview below can use the exact same inputs the active Repricer
      // table uses — not just the US-only rows the price lookup above cares about.
      const allSkus = [...new Set(rawList.map(r => r.sku).filter(Boolean))];

      const usPriceBySku: Record<string, number | null> = {};
      const usListingStatusBySku: Record<string, string | null> = {};
      const costBySku: Record<string, number | null> = {};
      const feesJsonBySku: Record<string, any> = {};
      if (allSkus.length) {
        const { data: invRows } = await supabase
          .from("inventory")
          .select("sku, my_price, price, listing_status, cost, fees_json")
          .eq("user_id", user.user.id)
          .in("sku", allSkus);
        for (const iv of invRows || []) {
          usPriceBySku[iv.sku] = (iv as any).my_price ?? (iv as any).price ?? null;
          usListingStatusBySku[iv.sku] = (iv as any).listing_status ?? null;
          costBySku[iv.sku] = (iv as any).cost ?? null;
          feesJsonBySku[iv.sku] = (iv as any).fees_json ?? null;
        }
      }

      // FX rate per non-US marketplace present, for converting USD cost/fees
      // to local currency in the ROI preview (same source AssignmentsTable uses).
      const fxRateByMp: Record<string, number> = {};
      const intlMarketplaces = [...new Set(intlRows.map(r => r.marketplace).filter(Boolean))];
      if (intlMarketplaces.length) {
        await Promise.all(intlMarketplaces.map(async (mp) => {
          const cfg = getMarketplaceConfig(mp);
          try {
            const { data: fxRow } = await supabase
              .from("fx_rates")
              .select("rate")
              .eq("base", "USD")
              .eq("quote", cfg.currency)
              .order("as_of", { ascending: false })
              .limit(1)
              .maybeSingle();
            if (fxRow?.rate) {
              fxRateByMp[mp] = Number(fxRow.rate);
            } else {
              const fallback: Record<string, number> = { CAD: 1.36, MXN: 17.5, BRL: 5.0, GBP: 0.79, EUR: 0.92 };
              fxRateByMp[mp] = fallback[cfg.currency] || 1;
            }
          } catch {
            const fallback: Record<string, number> = { CAD: 1.36, MXN: 17.5, BRL: 5.0, GBP: 0.79, EUR: 0.92 };
            fxRateByMp[mp] = fallback[cfg.currency] || 1;
          }
        }));
      }
      setFxRateByMarketplace(fxRateByMp);

      const MP_ID: Record<string, string> = {
        CA: "A2EUQ1WTGCTBG2",
        MX: "A1AM78C64UM0Y8",
        BR: "A2Q3Y263D00KWC",
      };
      const intlPriceKey = (asin: string, mpId: string, sku: string) => `${asin}|${mpId}|${sku}`;
      const intlPriceMap: Record<string, number | null> = {};
      if (intlRows.length) {
        const asins = [...new Set(intlRows.map(r => r.asin).filter(Boolean))];
        if (asins.length) {
          const { data: cacheRows } = await supabase
            .from("asin_my_price_cache")
            .select("asin, seller_sku, marketplace_id, my_price")
            .eq("user_id", user.user.id)
            .in("asin", asins);
          for (const c of cacheRows || []) {
            intlPriceMap[intlPriceKey((c as any).asin, (c as any).marketplace_id, (c as any).seller_sku)] = (c as any).my_price ?? null;
          }
        }
      }

      const list: SuppressedRow[] = rawList.map((r) => {
        let px: number | null = null;
        let isGhost: boolean;
        if (r.marketplace === "US") {
          px = usPriceBySku[r.sku] ?? r.last_applied_price ?? null;
          const ls = String(usListingStatusBySku[r.sku] || "").toUpperCase();
          isGhost = ls === "NOT_IN_CATALOG" || ls === "DELETED" || String(r.sku || "").toLowerCase().startsWith("amzn.gr.");
        } else {
          const mpId = MP_ID[r.marketplace];
          px = (mpId && r.asin ? intlPriceMap[intlPriceKey(r.asin, mpId, r.sku)] : null) ?? r.last_applied_price ?? null;
          isGhost = GHOST_INTL.has(String(r.intl_listing_status || "").toUpperCase());
        }
        return { ...r, my_price: px, isGhost, cost: costBySku[r.sku] ?? null, fees_json: feesJsonBySku[r.sku] ?? null };
      });
      setRows(list);
      // Seed edit buffer with current overrides + price
      const seed: Record<string, { min: string; max: string; price: string }> = {};
      for (const r of list) {
        seed[r.id] = {
          min: r.min_price_override != null ? String(r.min_price_override) : "",
          max: r.max_price_override != null ? String(r.max_price_override) : "",
          price: r.my_price != null ? String(r.my_price) : "",
        };
      }
      setEdits(seed);

      if (isAdmin) {
        let uq = supabase
          .from("repricer_assignments")
          .select("id, sku, asin, marketplace, listing_issue_unknown_categories")
          .eq("user_id", user.user.id)
          .eq("listing_issue_unknown_flagged", true);
        if (marketplace && marketplace !== "ALL") uq = uq.eq("marketplace", marketplace);
        const { data: uData } = await uq.limit(200);
        setUnknown((uData || []) as UnknownRow[]);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [marketplace, isAdmin]);

  const runNow = async () => {
    setRunning(true);
    try {
      // Queued + worker-drained instead of one direct bulk call — a single
      // invocation looping a whole large catalog can hit a compute limit and
      // crash partway through. This enqueues the check and kicks the worker
      // once immediately for fast feedback; results land within the next
      // several seconds as the worker processes the batch (already-suppressed
      // rows are prioritized so clears surface quickly).
      const { data, error } = await supabase.functions.invoke("trigger-pricing-suppression-check", { body: {} });
      if (error) throw error;
      const enqueued = data?.enqueued ?? 0;
      const processed = data?.worker?.items_processed ?? 0;
      toast.success(
        enqueued > processed
          ? `Queued ${enqueued} listings for re-check (${processed} processed so far — the rest finish within a minute).`
          : `Checked ${processed || enqueued} listings.`
      );
      await load();
    } catch (e: any) {
      toast.error(`Detection failed: ${e?.message || e}`);
    } finally {
      setRunning(false);
    }
  };

  const saveOverrides = async (row: SuppressedRow) => {
    const buf = edits[row.id];
    if (!buf) return;
    const minStr = buf.min.trim();
    const maxStr = buf.max.trim();
    const priceStr = buf.price.trim();
    // Reactivation flow: require ALL THREE values so Amazon receives a complete,
    // consistent purchasable_offer patch (price + min + max).
    if (priceStr === "" || minStr === "" || maxStr === "") {
      toast.error("Fill Price, Min and Max before reactivating");
      return;
    }
    const minVal = Number(minStr);
    const maxVal = Number(maxStr);
    const priceVal = Number(priceStr);
    if (!Number.isFinite(minVal) || minVal <= 0) { toast.error("Min must be greater than 0"); return; }
    if (!Number.isFinite(maxVal) || maxVal <= 0) { toast.error("Max must be greater than 0"); return; }
    if (!Number.isFinite(priceVal) || priceVal <= 0) { toast.error("Price must be greater than 0"); return; }
    if (minVal > maxVal) { toast.error("Min cannot be greater than Max"); return; }
    if (priceVal < minVal) { toast.error("Price is below Min — widen Min or raise Price"); return; }
    if (priceVal > maxVal) { toast.error("Price is above Max — widen Max or lower Price"); return; }

    setSavingId(row.id);
    setReactivationStatus((prev) => ({
      ...prev,
      [row.id]: { type: "sending", message: "Sending price, min and max to Amazon…" },
    }));
    const toastId = toast.loading(`Sending ${row.marketplace} ${row.sku} to Amazon…`);
    try {
      // 1) Persist min/max override in DB (repricer authoritative source)
      const { error: dbError } = await supabase
        .from("repricer_assignments")
        .update({ min_price_override: minVal, max_price_override: maxVal })
        .eq("id", row.id);
      if (dbError) throw dbError;

      // 2) Push price + min + max to Amazon in a single patch.
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");
      const payload = {
        asin: row.asin,
        sku: row.sku,
        newPrice: priceVal,
        newMinPrice: minVal,
        newMaxPrice: maxVal,
        previousMinPrice: row.min_price_override,
        previousMaxPrice: row.max_price_override,
        marketplace: row.marketplace,
        updateMinMaxOnly: false,
      };
      console.log("[PricingSuppressions] Reactivate push:", payload);
      const { data: syncData, error: syncError } = await supabase.functions.invoke("update-amazon-price", {
        body: payload,
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      console.log("[PricingSuppressions] SP-API response:", syncData, syncError);
      if (syncError) throw new Error(syncError.message || "Amazon call failed");
      if (syncData && syncData.ok === false) {
        throw new Error(syncData.error || syncData.errorMessage || "Amazon rejected the update");
      }
      if (syncData && syncData.success === false) {
        throw new Error(syncData.error || syncData.message || "Amazon rejected the update");
      }

      const subId = (syncData as any)?.submissionId;
      setReactivationStatus((prev) => ({
        ...prev,
        [row.id]: { type: "sending", message: `Amazon accepted the update${subId ? ` (${String(subId).slice(0, 8)}…)` : ""}. Verifying the live listing…` },
      }));

      await new Promise((resolve) => setTimeout(resolve, 3000));

      let verificationMessage = "Seller Central can take a few minutes to reflect it.";
      let statusType: "success" | "error" = "success";
      try {
        const { data: verifyData, error: verifyError } = await supabase.functions.invoke("verify-listing-pricing", {
          body: { asin: row.asin, sku: row.sku, marketplace: row.marketplace },
          headers: { Authorization: `Bearer ${session.access_token}` },
        });

        if (verifyError) throw verifyError;

        const pricing = (verifyData as any)?.pricing || {};
        const liveParts = [
          pricing.price != null ? `price ${pricing.price}` : null,
          pricing.min != null ? `min ${pricing.min}` : null,
          pricing.max != null ? `max ${pricing.max}` : null,
        ].filter(Boolean).join(", ");

        if ((verifyData as any)?.isPricingSuppressed) {
          const issue = (verifyData as any)?.pricingIssues?.[0];
          verificationMessage = `Amazon still reports a pricing suppression${liveParts ? ` (live: ${liveParts})` : ""}: ${issue?.message || "pricing issue remains"}`;
          statusType = "error";
        } else if ((verifyData as any)?.success) {
          verificationMessage = `Live Amazon check no longer reports a pricing suppression${liveParts ? ` (live: ${liveParts})` : ""}. Seller Central may still lag.`;
        }
      } catch (verifyErr: any) {
        verificationMessage = `Amazon accepted it, but live verification failed: ${verifyErr?.message || verifyErr}`;
      }

      const successMessage = `Amazon accepted ${row.marketplace} ${row.sku}: price ${priceVal}, min ${minVal}, max ${maxVal}${subId ? ` (submission ${String(subId).slice(0, 8)}…)` : ""}. ${verificationMessage}`;
      // Full detail lives in the inline row status below -- the toast is just
      // a brief "it's done" pulse, not a second copy of the same long message.
      if (statusType === "error") {
        toast.error(`${row.marketplace} ${row.sku}: still shows a pricing suppression — see details in the row.`, { id: toastId, duration: 6000 });
      } else {
        toast.success(`${row.marketplace} ${row.sku} reactivated.`, { id: toastId, duration: 5000 });
      }
      setReactivationStatus((prev) => ({
        ...prev,
        [row.id]: { type: statusType, message: successMessage },
      }));
      setRows((prev) => prev.map((r) =>
        r.id === row.id
          ? { ...r, min_price_override: minVal, max_price_override: maxVal, my_price: priceVal }
          : r
      ));
    } catch (e: any) {
      console.error("[PricingSuppressions] Save failed:", e);
      const message = `Reactivate failed: ${e?.message || e}`;
      toast.error(`${row.marketplace} ${row.sku}: reactivate failed — see details in the row.`, { id: toastId, duration: 6000 });
      setReactivationStatus((prev) => ({
        ...prev,
        [row.id]: { type: "error", message },
      }));
    } finally {
      setSavingId(null);
    }
  };

  const ghostCount = useMemo(() => rows.filter((r) => r.isGhost).length, [rows]);

  // Ghost ASINs (no longer in catalog / genuinely gone from that marketplace)
  // can never be successfully reactivated, so they're hidden by default --
  // same "hidden unless toggled" convention as Inventory Valuation's
  // "Show Ghost ASINs" button, rather than being silently dropped forever.
  const visibleRows = useMemo(
    () => (showGhosts ? rows : rows.filter((r) => !r.isGhost)),
    [rows, showGhosts],
  );

  const groups = useMemo(() => {
    const g: Record<string, SuppressedRow[]> = {};
    for (const r of visibleRows) (g[r.marketplace] = g[r.marketplace] || []).push(r);
    return g;
  }, [visibleRows]);

  const totalCount = rows.length;
  const visibleCount = visibleRows.length;

  if (totalCount === 0 && unknown.length === 0 && !isAdmin) return null;

  return (
    <div className="space-y-3">
      {(totalCount > 0 || isAdmin) && (
        <div className="rounded-xl border-2 border-amber-500 bg-gradient-to-r from-amber-100 to-orange-100 shadow-lg ring-1 ring-amber-400/40">
          <button
            onClick={() => setExpanded((v) => !v)}
            className="w-full flex items-center justify-between px-4 py-3 text-left"
          >
            <div className="flex items-center gap-2">
              {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              <AlertTriangle className="h-5 w-5 text-amber-700" />
              <span className="font-bold text-amber-950 text-sm">
                Delisted for pricing policy ({visibleCount})
              </span>
              <span className="text-xs text-amber-900/80">
                Listings suppressed by Amazon for price rule violations (min/max, fair pricing)
              </span>
            </div>
            <div className="flex items-center gap-2">
              {ghostCount > 0 && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={(e) => { e.stopPropagation(); setShowGhosts((v) => !v); }}
                  className={`h-9 gap-1.5 text-xs ${showGhosts ? "border-violet-400 text-violet-700" : "border-amber-700 text-amber-900"}`}
                  title="Ghost ASINs (no longer in that marketplace's catalog) can never be successfully reactivated -- hidden by default"
                >
                  {showGhosts ? `👻 Showing Ghost ASINs (${ghostCount})` : `👻 Show Ghost ASINs (${ghostCount})`}
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                onClick={(e) => { e.stopPropagation(); runNow(); }}
                disabled={running}
                className="h-9 gap-1.5 bg-amber-600 hover:bg-amber-700 text-white font-semibold shadow-md border border-amber-700"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${running ? "animate-spin" : ""}`} />
                {running ? "Checking…" : "Check now"}
              </Button>
            </div>
          </button>
          {expanded && (
            <div className="border-t border-amber-300/50 px-4 py-3 space-y-3">
              {loading && <div className="text-xs text-muted-foreground">Loading…</div>}
              {!loading && visibleCount === 0 && (
                <div className="text-xs text-muted-foreground">
                  {totalCount > 0 ? "All current suppressions are ghost ASINs — toggle above to review them." : "No pricing-policy suppressions right now."}
                </div>
              )}
              {Object.entries(groups).map(([mp, list]) => (
                <div key={mp} className="space-y-1.5">
                  <div className="text-xs font-semibold text-amber-900">{mp} — {list.length}</div>
                  <div className="rounded-md border border-amber-200 bg-white/70 overflow-hidden">
                    <table className="w-full text-xs">
                      <thead className="bg-amber-100/60 text-amber-900">
                        <tr>
                          <th className="text-left px-2 py-1.5">SKU</th>
                          <th className="text-left px-2 py-1.5">ASIN</th>
                          <th className="text-left px-2 py-1.5">Reason</th>
                          <th className="text-left px-2 py-1.5">Min</th>
                          <th className="text-left px-2 py-1.5">Max</th>
                          <th className="text-left px-2 py-1.5">Price</th>
                          <th className="text-left px-2 py-1.5">Status</th>
                          <th className="text-left px-2 py-1.5">Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {list.map((r) => {
                          const buf = edits[r.id] || { min: "", max: "", price: "" };
                          const status = reactivationStatus[r.id];
                          const dirty =
                            (buf.min || "") !== (r.min_price_override != null ? String(r.min_price_override) : "") ||
                            (buf.max || "") !== (r.max_price_override != null ? String(r.max_price_override) : "") ||
                            (buf.price || "") !== (r.my_price != null ? String(r.my_price) : "");
                          const domain = AMAZON_DOMAIN[r.marketplace] || 'https://www.amazon.com';
                          const scDomain = SELLER_CENTRAL_DOMAIN[r.marketplace] || 'https://sellercentral.amazon.com';
                          return (
                          <tr key={r.id} className="border-t border-amber-100 align-top">
                            <td className="px-2 py-1.5 font-mono">
                              <div>{r.sku}</div>
                              <a
                                href={`${scDomain}/skucentral?mSku=${encodeURIComponent(r.sku)}${r.asin ? `&asin=${encodeURIComponent(r.asin)}` : ''}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-0.5 text-[10px] text-blue-700 hover:text-blue-900 underline"
                              >
                                Manage <ExternalLink className="h-2.5 w-2.5" />
                              </a>
                            </td>
                            <td className="px-2 py-1.5 font-mono">
                              {r.asin ? (
                                <a
                                  href={`${domain}/dp/${r.asin}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-blue-700 hover:text-blue-900 underline"
                                >
                                  {r.asin}
                                </a>
                              ) : "—"}
                            </td>
                            <td className="px-2 py-1.5 max-w-xs">
                              {r.pricing_suppression_raw_message && (
                                <div className="text-xs text-amber-950">
                                  {r.pricing_suppression_raw_message}
                                </div>
                              )}
                              <div className="flex flex-wrap gap-1 mt-1">
                                {(r.pricing_suppression_categories || []).map((c) => (
                                  <Badge key={c} variant={c === "INVALID_PRICE" ? "destructive" : "secondary"} className="text-[10px] font-normal">
                                    {humanizeCategory(c)}
                                  </Badge>
                                ))}
                              </div>
                            </td>
                            <td className="px-2 py-1.5">
                              <Input
                                type="number"
                                step="0.01"
                                min="0"
                                inputMode="decimal"
                                value={buf.min}
                                placeholder="—"
                                onChange={(e) => setEdits((prev) => ({ ...prev, [r.id]: { min: e.target.value, max: buf.max, price: buf.price } }))}
                                className="h-8 w-24 text-sm font-semibold text-slate-900 bg-white border-2 border-slate-400 focus:border-blue-600 focus:ring-2 focus:ring-blue-500/30 shadow-sm"
                              />
                            </td>
                            <td className="px-2 py-1.5">
                              <Input
                                type="number"
                                step="0.01"
                                min="0"
                                inputMode="decimal"
                                value={buf.max}
                                placeholder="—"
                                onChange={(e) => setEdits((prev) => ({ ...prev, [r.id]: { min: buf.min, max: e.target.value, price: buf.price } }))}
                                className="h-8 w-24 text-sm font-semibold text-slate-900 bg-white border-2 border-slate-400 focus:border-blue-600 focus:ring-2 focus:ring-blue-500/30 shadow-sm"
                              />
                            </td>
                            <td className="px-2 py-1.5">
                              <Input
                                type="number"
                                step="0.01"
                                min="0"
                                inputMode="decimal"
                                value={buf.price}
                                placeholder="—"
                                onChange={(e) => setEdits((prev) => ({ ...prev, [r.id]: { min: buf.min, max: buf.max, price: e.target.value } }))}
                                className="h-8 w-24 text-sm font-semibold text-slate-900 bg-white border-2 border-emerald-500 focus:border-emerald-700 focus:ring-2 focus:ring-emerald-500/30 shadow-sm"
                              />
                              {(() => {
                                const priceNum = parseFloat(buf.price);
                                if (!Number.isFinite(priceNum) || priceNum <= 0) return null;
                                if (!r.cost) {
                                  return <div className="text-[10px] text-muted-foreground mt-0.5">No cost on file</div>;
                                }
                                const fxRate = r.marketplace === "US" ? 1 : (fxRateByMarketplace[r.marketplace] ?? 1);
                                const roi = calcRoiAtPrice(r.cost, r.fees_json, priceNum, fxRate, r.marketplace);
                                if (roi == null) return null;
                                const roiColor = roi < 0 ? "text-red-600" : roi < 15 ? "text-amber-600" : "text-emerald-700";
                                return (
                                  <div className={`text-[10px] font-semibold mt-0.5 ${roiColor}`}>
                                    ROI {roi >= 0 ? "+" : ""}{roi.toFixed(1)}%
                                  </div>
                                );
                              })()}
                            </td>
                            <td className="px-2 py-1.5">
                              <Badge variant="destructive" className="text-[10px]">Suppressed</Badge>
                              <div className="text-[10px] text-muted-foreground mt-0.5">
                                {r.pricing_suppression_detected_at
                                  ? new Date(r.pricing_suppression_detected_at).toLocaleDateString()
                                  : ""}
                              </div>
                            </td>
                            <td className="px-2 py-1.5">
                              <Button
                                size="sm"
                                onClick={() => saveOverrides(r)}
                                disabled={savingId === r.id || !buf.price || !buf.min || !buf.max}
                                className="h-7 gap-1 bg-blue-600 hover:bg-blue-700 text-white text-xs"
                              >
                                <Save className="h-3 w-3" />
                                {savingId === r.id ? "Sending…" : "Reactivate"}
                              </Button>
                              {status && (
                                <div
                                  className={`mt-1 max-w-[220px] text-[10px] leading-snug ${
                                    status.type === "success"
                                      ? "text-emerald-700"
                                      : status.type === "error"
                                        ? "text-red-700"
                                        : "text-blue-700"
                                  }`}
                                >
                                  {status.message}
                                </div>
                              )}
                            </td>
                          </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
              <div className="text-[11px] text-amber-900/70">
                These are listings Amazon flagged with a pricing error. They clear automatically on the next clean check (run nightly, or immediately via Check now / Reactivate) — if the issue recurs, it's flagged again on the following check.
              </div>
            </div>
          )}
        </div>
      )}

      {isAdmin && unknown.length > 0 && (
        <div className="rounded-xl border border-blue-300/60 bg-blue-50/60 backdrop-blur-sm">
          <button
            onClick={() => setExpandedUnknown((v) => !v)}
            className="w-full flex items-center justify-between px-4 py-3 text-left"
          >
            <div className="flex items-center gap-2">
              {expandedUnknown ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              <ShieldAlert className="h-4 w-4 text-blue-700" />
              <span className="font-semibold text-blue-900">
                Admin: unknown suppression categories ({unknown.length})
              </span>
              <span className="text-xs text-blue-800/70">
                LISTING_SUPPRESSED + severity=ERROR from Amazon that isn't yet in our mapping — review to extend classifier
              </span>
            </div>
          </button>
          {expandedUnknown && (
            <div className="border-t border-blue-300/50 px-4 py-3">
              <div className="rounded-md border border-blue-200 bg-white/70 overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="bg-blue-100/60 text-blue-900">
                    <tr>
                      <th className="text-left px-2 py-1.5">Marketplace</th>
                      <th className="text-left px-2 py-1.5">SKU</th>
                      <th className="text-left px-2 py-1.5">ASIN</th>
                      <th className="text-left px-2 py-1.5">Unknown categories</th>
                    </tr>
                  </thead>
                  <tbody>
                    {unknown.map((u) => (
                      <tr key={u.id} className="border-t border-blue-100">
                        <td className="px-2 py-1.5">{u.marketplace}</td>
                        <td className="px-2 py-1.5 font-mono">{u.sku}</td>
                        <td className="px-2 py-1.5 font-mono">{u.asin || "—"}</td>
                        <td className="px-2 py-1.5">
                          <div className="flex flex-wrap gap-1">
                            {(u.listing_issue_unknown_categories || []).map((c) => (
                              <Badge key={c} variant="outline" className="text-[10px]" title={c}>
                                {humanizeCategory(c)}
                              </Badge>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
