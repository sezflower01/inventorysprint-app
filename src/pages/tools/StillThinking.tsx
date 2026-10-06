import { useState, useEffect, useMemo } from "react";
import { Helmet } from "react-helmet-async";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Trash2, ExternalLink, ShoppingCart, Loader2, Lightbulb, RefreshCw, AlertTriangle, Store, Plus } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { generateSKU } from "@/utils/skuGenerator";
import { Link } from "react-router-dom";

const PUBLISH_PREF_KEY = "still_thinking_publish_to_amazon";

interface SupplierLink { link: string; discount_code: string; }

interface StillThinkingRow {
  id: string;
  asin: string;
  title: string | null;
  image_url: string | null;
  /**
   * Every retailer being considered for this ASIN, [{link, discount_code}] --
   * the same shape created_listings uses, so Convert hands it straight through.
   *
   * supplier_url / supplier_domain / discount_code below are the legacy single
   * retailer. They are NOT a second source of truth: a database trigger
   * (still_thinking_sync_suppliers) mirrors them to element 0 whenever this
   * array is written, and conversely builds this array when the extension
   * writes only the singles. Read supplier_links here; never write both.
   */
  supplier_links: SupplierLink[] | null;
  supplier_url: string | null;
  supplier_domain: string | null;
  supplier_id: string | null;
  discount_code: string | null;
  marketplace: string | null;
  notes: string | null;
  status: string;
  converted_at: string | null;
  created_at: string;
}

/** Display-side only. The database normalizes on write; this just keeps a
 *  half-typed editor row from rendering as a retailer. */
const linksOf = (r: Pick<StillThinkingRow, "supplier_links" | "supplier_url" | "discount_code">): SupplierLink[] => {
  const arr = Array.isArray(r.supplier_links) ? r.supplier_links : [];
  const clean = arr
    .map(l => ({ link: String(l?.link ?? "").trim(), discount_code: String(l?.discount_code ?? "").trim() }))
    .filter(l => l.link);
  if (clean.length) return clean;
  // Pre-trigger rows, and anything written before this column existed.
  return r.supplier_url ? [{ link: r.supplier_url, discount_code: (r.discount_code || "").trim() }] : [];
};

const domainOf = (url: string) => {
  try { return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, ""); }
  catch { return url; }
};

/**
 * The one place a database row becomes a StillThinkingRow.
 *
 * supplier_links is jsonb, so its TYPE at the boundary is "whatever a client
 * wrote" -- PostgREST cannot promise it is an array of {link, discount_code}.
 * Narrow it once, here, instead of casting at every use site.
 */
const toRow = (d: unknown): StillThinkingRow => {
  const row = d as StillThinkingRow & { supplier_links?: unknown };
  return {
    ...row,
    supplier_links: Array.isArray(row.supplier_links) ? (row.supplier_links as SupplierLink[]) : null,
  };
};

const hrefOf = (url: string) => (/^https?:\/\//i.test(url) ? url : `https://${url}`);

interface SupplierOpt { id: string; supplier_name: string | null; domain: string | null; }

const amazonUrl = (asin: string, mkt: string | null) => {
  const tld: Record<string, string> = {
    US: "com", CA: "ca", MX: "com.mx", BR: "com.br", UK: "co.uk", DE: "de", FR: "fr", IT: "it", ES: "es", JP: "co.jp",
  };
  return `https://www.amazon.${tld[mkt || "US"] || "com"}/dp/${asin}`;
};

export default function StillThinking() {
  const { user } = useAuth();
  const [rows, setRows] = useState<StillThinkingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [suppliers, setSuppliers] = useState<SupplierOpt[]>([]);

  // Retailer editor state. Edits a draft, not the row, so Cancel really cancels.
  const [supplierRow, setSupplierRow] = useState<StillThinkingRow | null>(null);
  const [draftLinks, setDraftLinks] = useState<SupplierLink[]>([]);
  const [savingLinks, setSavingLinks] = useState(false);

  // Convert dialog state
  const [convertOpen, setConvertOpen] = useState(false);
  const [convertRow, setConvertRow] = useState<StillThinkingRow | null>(null);
  const [totalCost, setTotalCost] = useState("");
  const [units, setUnits] = useState("1");
  const [sellPrice, setSellPrice] = useState("");
  const [supplierId, setSupplierId] = useState<string>("");
  const [converting, setConverting] = useState(false);
  const [publishToAmazon, setPublishToAmazon] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    const v = window.localStorage.getItem(PUBLISH_PREF_KEY);
    return v === null ? true : v === "1";
  });
  useEffect(() => {
    try { window.localStorage.setItem(PUBLISH_PREF_KEY, publishToAmazon ? "1" : "0"); } catch {}
  }, [publishToAmazon]);

  const cog = useMemo(() => {
    const t = parseFloat(totalCost), u = parseInt(units || "0", 10);
    if (!t || !u || u <= 0) return "";
    return (t / u).toFixed(2);
  }, [totalCost, units]);

  const load = async () => {
    if (!user) return;
    setLoading(true);
    const { data, error } = await supabase
      .from("still_thinking_listings")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });
    if (error) toast.error(error.message);
    else setRows((data ?? []).map(toRow));
    setLoading(false);
  };

  const loadSuppliers = async () => {
    if (!user) return;
    const { data } = await supabase
      .from("suppliers")
      .select("id, supplier_name, domain")
      .eq("user_id", user.id)
      .order("supplier_name", { ascending: true });
    setSuppliers((data as SupplierOpt[]) || []);
  };

  useEffect(() => { 
    load(); 
    loadSuppliers(); 
  }, [user?.id]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(r =>
      r.asin.toLowerCase().includes(q) ||
      (r.title || "").toLowerCase().includes(q) ||
      // Every retailer and every code, not only the first -- searching for the
      // shop you remember should find the row whichever slot it landed in.
      linksOf(r).some(l =>
        l.link.toLowerCase().includes(q) || l.discount_code.toLowerCase().includes(q)),
    );
  }, [rows, search]);

  const remove = async (id: string) => {
    if (!confirm("Delete this Still Thinking record?")) return;
    const { error } = await supabase.from("still_thinking_listings").delete().eq("id", id);
    if (error) { toast.error(error.message); return; }
    setRows(prev => prev.filter(r => r.id !== id));
    if (selectedId === id) setSelectedId(null);
    toast.success("Removed");
  };

  /**
   * Retailers, editable on the page that holds the decision.
   *
   * Still Thinking exists to park an ASIN while you hunt for the cheapest
   * source, so a row legitimately has several candidate shops -- and until now
   * it had room for exactly one, written only by the extension from whatever
   * tab the save came from. An ASIN saved straight off Amazon got none, the
   * column was read-only, and re-saving reported "refreshed" without changing
   * anything. 2 of 109 rows are in that state.
   *
   * Saving an empty list is allowed on purpose: removing the last retailer has
   * to be expressible, or this would add and edit but never delete.
   */
  const openSuppliers = (row: StillThinkingRow) => {
    const existing = linksOf(row);
    setSupplierRow(row);
    setDraftLinks(existing.length ? existing : [{ link: "", discount_code: "" }]);
  };

  const saveSuppliers = async () => {
    if (!supplierRow) return;
    const clean = draftLinks
      .map(l => ({ link: l.link.trim(), discount_code: l.discount_code.trim() }))
      .filter(l => l.link);
    setSavingLinks(true);
    try {
      // Write the array only. The trigger mirrors supplier_url /
      // supplier_domain / discount_code from element 0 -- sending both from
      // here is how the two would drift apart.
      const { data, error } = await supabase
        .from("still_thinking_listings")
        .update({ supplier_links: clean })
        .eq("id", supplierRow.id)
        .select("*")
        .single();
      if (error) throw error;
      setRows(prev => prev.map(r => (r.id === supplierRow.id ? toRow(data) : r)));
      setSupplierRow(null);
      toast.success(clean.length
        ? `Saved ${clean.length} retailer${clean.length > 1 ? "s" : ""}`
        : "Retailers cleared");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save retailers");
    } finally {
      setSavingLinks(false);
    }
  };

  const openConvert = (row: StillThinkingRow) => {
    setConvertRow(row);
    setTotalCost("");
    setUnits("1");
    setSellPrice("");
    setSupplierId(row.supplier_id || "");
    setConvertOpen(true);
  };

  const submitConvert = async () => {
    if (!user || !convertRow) return;
    const t = parseFloat(totalCost);
    const u = parseInt(units, 10);
    const p = parseFloat(sellPrice);
    if (!(t > 0)) { toast.error("Total cost required"); return; }
    if (!(u > 0)) { toast.error("Units required"); return; }
    if (!(p > 0)) { toast.error("Sell price required"); return; }

    setConverting(true);
    let createdListingId: string | null = null;
    try {
      const supplierMatch = suppliers.find(s => s.id === supplierId) || null;
      // Carry EVERY retailer into the listing, not just the first. The ones you
      // rejected are still the record of what you compared against, and
      // created_listings.supplier_links holds the same shape, so it is a
      // hand-off rather than a conversion.
      const fromRow = linksOf(convertRow);
      const supplier_links = fromRow.length
        ? fromRow
        : (supplierMatch?.domain
            ? [{ link: `https://${supplierMatch.domain}`, discount_code: (convertRow.discount_code || "").trim() }]
            : []);

      const today = new Date();
      const yyyymmdd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      const sku = generateSKU();

      // 1) Always save the purchase record first — never lose user data.
      const insertRow = {
        user_id: user.id,
        asin: convertRow.asin,
        sku,
        title: convertRow.title || convertRow.asin,
        image_url: convertRow.image_url,
        price: p,
        cost: t,
        amount: t / u,
        units: u,
        supplier_links: supplier_links as any,
        date_created: yyyymmdd,
        fba_blocked: false,
        validation_status: (publishToAmazon ? "PENDING_VALIDATION" : "ACTIVE") as any,
        validation_started_at: publishToAmazon ? new Date().toISOString() : null,
      };
      const { data: inserted, error: insErr } = await supabase
        .from("created_listings")
        .insert([insertRow])
        .select("id")
        .single();
      if (insErr) throw insErr;
      createdListingId = inserted?.id ?? null;

      // 2) Mark Still Thinking as converted + link the new listing.
      await supabase
        .from("still_thinking_listings")
        .update({
          status: "converted",
          converted_at: new Date().toISOString(),
          supplier_id: supplierId || null,
          linked_created_listing_id: createdListingId,
        })
        .eq("id", convertRow.id);

      // 3) Optionally publish to Amazon Seller Central via SP-API.
      let amazonWarning: string | null = null;
      if (publishToAmazon) {
        try {
          const { data: { session } } = await supabase.auth.getSession();
          if (!session) throw new Error("Not authenticated");
          const { MARKETPLACE_CONFIGS } = await import("@/lib/marketplaceCurrency");
          const mpCode = (convertRow.marketplace || "US").toUpperCase();
          const mpConfig = (MARKETPLACE_CONFIGS as any)[mpCode] || (MARKETPLACE_CONFIGS as any).US;

          const { data: listingData, error: listingError } = await supabase.functions.invoke(
            "create-amazon-listing",
            {
              body: {
                asin: convertRow.asin.toUpperCase(),
                sku,
                price: p,
                quantity: u,
                condition: "new_new",
                fulfillmentChannel: "FBA",
                cost: t,
                marketplaceId: mpConfig?.marketplaceId,
                marketplaceCode: mpCode,
                createdListingId,
              },
              headers: { Authorization: `Bearer ${session.access_token}` },
            },
          );
          if (listingError) throw listingError;
          const issues = (listingData as any)?.issues;
          if (Array.isArray(issues) && issues.length > 0) {
            amazonWarning = `Amazon returned ${issues.length} validation issue(s). Review in Product Library.`;
          }
        } catch (amzErr: any) {
          console.error("[StillThinking] Amazon publish failed:", amzErr);
          amazonWarning = amzErr?.message || "Amazon listing creation failed";
        }
      }

      if (amazonWarning) {
        toast.warning("Purchase saved locally, but Amazon listing creation failed.", {
          description: amazonWarning,
        });
      } else if (publishToAmazon) {
        toast.success("Listing published to Amazon and saved to Product Library.");
      } else {
        toast.success("Saved to Product Library.");
      }

      setConvertOpen(false);
      load();
    } catch (e: any) {
      toast.error(e?.message || "Convert failed");
    } finally {
      setConverting(false);
    }
  };

  const activeCount = rows.filter(r => r.status === "thinking").length;

  return (
    <div className="min-h-screen flex flex-col bg-[#0f1c3f] text-white">
      <Helmet>
        <title>Still Thinking · InventorySprint</title>
        <meta name="description" content="ASINs you're considering buying — captured from the Chrome extension before you commit." />
      </Helmet>
      <Navbar />
      <main className="flex-1 max-w-7xl w-full mx-auto p-6">
        <div className="flex items-center gap-3 mb-2">
          <Lightbulb className="w-6 h-6 text-amber-300" />
          <h1 className="text-2xl font-semibold">Still Thinking</h1>
          <Badge variant="secondary">{activeCount} active</Badge>
        </div>
        <p className="text-sm text-white/70 mb-6">
          ASINs you saved from the extension while sourcing — not yet purchased. Click <b>Add Purchase</b> when you're ready to buy: it converts the row into a real listing in Product Library, but keeps this record for history.
        </p>

        <Card className="bg-white text-foreground p-4 mb-4">
          <div className="flex flex-wrap gap-3 items-center justify-between">
            <Input
              placeholder="Search ASIN, title, or supplier…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="max-w-md"
            />
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={load} disabled={loading}>
                <RefreshCw className={`w-4 h-4 mr-1 ${loading ? "animate-spin" : ""}`} /> Refresh
              </Button>
              <Button asChild variant="outline" size="sm">
                <a href="/tools/created-listings" target="_blank" rel="noopener noreferrer"><ShoppingCart className="w-4 h-4 mr-1" /> Product Library</a>
              </Button>
            </div>
          </div>
        </Card>

        <Card className="bg-white text-foreground overflow-hidden">
          {loading ? (
            <div className="p-12 flex items-center justify-center text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…
            </div>
          ) : filtered.length === 0 ? (
            <div className="p-12 text-center text-muted-foreground">
              <Lightbulb className="w-10 h-10 mx-auto mb-3 opacity-40" />
              <p className="font-medium">No Still Thinking items yet.</p>
              <p className="text-sm mt-1">Open any Amazon product page and click <b>💭 Save as Still Thinking</b> in the InventorySprint extension.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left">Image</th>
                    <th className="px-3 py-2 text-left">ASIN</th>
                    <th className="px-3 py-2 text-left">Title</th>
                    <th className="px-3 py-2 text-left">Retailers</th>
                    <th className="px-3 py-2 text-left">Saved</th>
                    <th className="px-3 py-2 text-left">Status</th>
                    <th className="px-3 py-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(r => {
                    const selected = r.id === selectedId;
                    const links = linksOf(r);
                    return (
                      <tr
                        key={r.id}
                        onClick={() => setSelectedId(r.id)}
                        className={`border-t cursor-pointer transition-colors ${selected ? "bg-blue-50 ring-2 ring-inset ring-primary/40" : "hover:bg-muted/30"}`}
                      >
                        <td className="px-3 py-2">
                          {r.image_url ? (
                            <img src={r.image_url} alt={r.asin} className="w-12 h-12 min-w-12 min-h-12 object-cover rounded border" />
                          ) : (
                            <div className="w-12 h-12 rounded bg-muted" />
                          )}
                        </td>
                        <td className="px-3 py-2 font-mono">
                          <a
                            href={amazonUrl(r.asin, r.marketplace)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-primary hover:underline"
                            onClick={e => e.stopPropagation()}
                          >
                            {r.asin}
                          </a>
                        </td>
                        <td className="px-3 py-2 max-w-md truncate" title={r.title || ""}>{r.title || "—"}</td>
                        {/* One column, not the old Supplier + Discount Code pair.
                            With several retailers per row, two parallel lists
                            would leave the reader matching a shop to a code by
                            position; keeping each code beside its own shop is
                            the only arrangement that stays readable. */}
                        <td className="px-3 py-2" onClick={e => e.stopPropagation()}>
                          {links.length === 0 ? (
                            <button
                              type="button"
                              onClick={() => openSuppliers(r)}
                              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                            >
                              <Plus className="w-3 h-3" /> Add retailer
                            </button>
                          ) : (
                            <div className="flex flex-col gap-1">
                              {links.map((l, i) => (
                                <div key={`${l.link}-${i}`} className="flex items-center gap-2">
                                  <a
                                    href={hrefOf(l.link)}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-primary hover:underline inline-flex items-center gap-1 max-w-[16rem] truncate"
                                    title={l.link}
                                  >
                                    {domainOf(l.link)} <ExternalLink className="w-3 h-3 shrink-0" />
                                  </a>
                                  {l.discount_code && (
                                    <button
                                      type="button"
                                      onClick={() => { navigator.clipboard?.writeText(l.discount_code); toast.success("Discount code copied"); }}
                                      className="font-mono text-xs px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 hover:bg-emerald-200"
                                      title="Click to copy"
                                    >
                                      {l.discount_code}
                                    </button>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">{new Date(r.created_at).toLocaleDateString()}</td>
                        <td className="px-3 py-2">
                          {r.status === "converted" ? (
                            <Badge className="bg-emerald-100 text-emerald-800">Converted</Badge>
                          ) : (
                            <Badge variant="secondary">Thinking</Badge>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <div className="inline-flex gap-2" onClick={e => e.stopPropagation()}>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => openSuppliers(r)}
                              title="Add, edit or remove retailers"
                            >
                              <Store className="w-4 h-4" />
                            </Button>
                            {r.status !== "converted" && (
                              <Button size="sm" onClick={() => openConvert(r)}>
                                <ShoppingCart className="w-4 h-4 mr-1" /> Add Purchase
                              </Button>
                            )}
                            <Button size="sm" variant="outline" onClick={() => remove(r.id)}>
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </main>

      <Dialog open={!!supplierRow} onOpenChange={o => { if (!o) setSupplierRow(null); }}>
        <DialogContent className="bg-white max-w-2xl">
          <DialogHeader>
            <DialogTitle>Retailers — {supplierRow?.asin}</DialogTitle>
            <DialogDescription>
              Every shop you are considering for this ASIN, each with its own discount code.
              These carry straight into the listing when you click Add Purchase.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {draftLinks.map((l, i) => (
              <div key={i} className="flex gap-2 items-center">
                <Input
                  value={l.link}
                  placeholder="Retailer URL (e.g. target.com/p/…)"
                  onChange={e => setDraftLinks(prev => prev.map((x, j) => j === i ? { ...x, link: e.target.value } : x))}
                  className="flex-1"
                />
                <Input
                  value={l.discount_code}
                  placeholder="Code"
                  onChange={e => setDraftLinks(prev => prev.map((x, j) => j === i ? { ...x, discount_code: e.target.value } : x))}
                  className="w-32"
                />
                <Button
                  size="icon"
                  variant="outline"
                  disabled={!l.link.trim()}
                  title="Open retailer"
                  onClick={() => window.open(hrefOf(l.link.trim()), "_blank", "noopener,noreferrer")}
                >
                  <ExternalLink className="w-4 h-4" />
                </Button>
                <Button
                  size="icon"
                  variant="outline"
                  title="Remove this retailer"
                  onClick={() => setDraftLinks(prev => {
                    const next = prev.filter((_, j) => j !== i);
                    // Never leave the editor with nothing to type into.
                    return next.length ? next : [{ link: "", discount_code: "" }];
                  })}
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            ))}
            <Button
              size="sm"
              variant="outline"
              onClick={() => setDraftLinks(prev => [...prev, { link: "", discount_code: "" }])}
            >
              <Plus className="w-4 h-4 mr-1" /> Add retailer
            </Button>
            <p className="text-xs text-muted-foreground pt-1">
              Blank rows are discarded. Saving with none left removes every retailer from this record.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSupplierRow(null)} disabled={savingLinks}>Cancel</Button>
            <Button onClick={saveSuppliers} disabled={savingLinks}>
              {savingLinks && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={convertOpen} onOpenChange={setConvertOpen}>
        <DialogContent className="bg-white">
          <DialogHeader>
            <DialogTitle>Add Purchase — {convertRow?.asin}</DialogTitle>
            <DialogDescription>
              Enter the cost and units you actually bought. This creates a real listing in Product Library and keeps the Still Thinking record marked as converted.
            </DialogDescription>
          </DialogHeader>
          {convertRow && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 p-3 rounded bg-muted/40">
                {convertRow.image_url && (
                  <img src={convertRow.image_url} alt="" className="w-12 h-12 object-cover rounded border" />
                )}
                <div className="text-sm">
                  <div className="font-medium line-clamp-2">{convertRow.title || convertRow.asin}</div>
                  {/* Show all of them: these are what gets written onto the
                      listing, so the dialog should not imply only one does. */}
                  {linksOf(convertRow).map((l, i) => (
                    <div key={`${l.link}-${i}`} className="text-xs text-muted-foreground truncate max-w-md">
                      {domainOf(l.link)}
                      {l.discount_code && (
                        <span className="text-emerald-700 dark:text-emerald-400"> · <span className="font-mono">{l.discount_code}</span></span>
                      )}
                    </div>
                  ))}
                  {linksOf(convertRow).length === 0 && (
                    <div className="text-xs text-amber-700">No retailer recorded — add one from the list first if you want it on the listing.</div>
                  )}
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <label className="text-sm space-y-1">
                  <div className="text-muted-foreground">Total cost ($)</div>
                  <Input type="number" step="0.01" min="0" value={totalCost} onChange={e => setTotalCost(e.target.value)} />
                </label>
                <label className="text-sm space-y-1">
                  <div className="text-muted-foreground">Units</div>
                  <Input type="number" min="1" value={units} onChange={e => setUnits(e.target.value)} />
                </label>
                <label className="text-sm space-y-1">
                  <div className="text-muted-foreground">COG / unit</div>
                  <Input value={cog} readOnly className="bg-muted" />
                </label>
              </div>
              <label className="text-sm space-y-1 block">
                <div className="text-muted-foreground">Sell price ($)</div>
                <Input type="number" step="0.01" min="0" value={sellPrice} onChange={e => setSellPrice(e.target.value)} />
              </label>
              <label className="text-sm space-y-1 block">
                <div className="text-muted-foreground">Supplier (optional — link existing supplier record)</div>
                <Select value={supplierId || "__none"} onValueChange={v => setSupplierId(v === "__none" ? "" : v)}>
                  <SelectTrigger><SelectValue placeholder="No supplier" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">No supplier</SelectItem>
                    {suppliers.map(s => (
                      <SelectItem key={s.id} value={s.id}>{s.supplier_name || s.domain || s.id}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              <label className="flex items-start gap-2 rounded border p-3 bg-blue-50/60 cursor-pointer">
                <Checkbox
                  checked={publishToAmazon}
                  onCheckedChange={v => setPublishToAmazon(!!v)}
                  className="mt-0.5"
                />
                <div className="text-sm">
                  <div className="font-medium">Create listing on Amazon Seller Central too</div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    Publishes the SKU to Amazon via SP-API (FBA, condition: New) using the marketplace this ASIN was saved from. If Amazon rejects it, your purchase record is still saved.
                  </div>
                </div>
              </label>
              {!publishToAmazon && (
                <div className="flex items-start gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <span>Bookkeeping only — the listing will not appear in Amazon Seller Central or sync into the repricer until you publish it.</span>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConvertOpen(false)} disabled={converting}>Cancel</Button>
            <Button onClick={submitConvert} disabled={converting}>
              {converting && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
              {publishToAmazon ? "Save & Publish to Amazon" : "Save to Product Library"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Footer />
    </div>
  );
}
