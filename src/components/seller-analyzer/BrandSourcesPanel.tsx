import { useEffect, useMemo, useState } from "react";
import {
  Loader2, Plus, Trash2, ExternalLink, Pencil, Check, X, Globe, EyeOff, Eye,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { useBrandSources } from "@/hooks/use-brand-sources";
import {
  describeTemplate, normaliseTemplate, resolveSourceUrl, retailerHost,
} from "@/lib/brandSources";

/**
 * Where you buy each brand: retailers defined once, brands attached to them.
 *
 * ---- WHY NOT A URL FIELD PER BRAND -------------------------------------
 *
 * Measured 2026-09-03: 4,088 active brands, and 2,185 of them appear on a
 * watched seller's catalogue. A URL box per brand would be up to 2,185 URLs
 * typed by hand. Defining a retailer once and attaching brands to it turns
 * that into one URL per shop and a click per brand -- which is why the bulk
 * attach below is the primary path, not a convenience.
 *
 * ---- BROKEN RETAILERS STAY VISIBLE -------------------------------------
 *
 * Nothing auto-hides a retailer whose URL has stopped working. A source that
 * silently vanished would be indistinguishable from one never added; a broken
 * one you can see is one you can fix.
 */

interface BrandRow { brand: string; asin_count: number; }

// The filtered list is capped rather than virtualised: 4,088 chips would be a
// scroll wall, and the search box is the real navigation.
const MAX_SHOWN = 120;

export function BrandSourcesPanel() {
  const {
    retailers, sourceMap, isAdmin, loading, error,
    addRetailer, shareRetailer, updateRetailer, deleteRetailer, setRetailerMuted,
    attachBrands, detachBrand, setNote,
  } = useBrandSources();

  const [brands, setBrands] = useState<BrandRow[]>([]);
  const [brandsLoading, setBrandsLoading] = useState(true);

  const [label, setLabel] = useState("");
  const [template, setTemplate] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [editTemplate, setEditTemplate] = useState("");

  const [filter, setFilter] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState<string>("");
  const [note, setNoteDraft] = useState("");
  const [busy, setBusy] = useState(false);
  // Defaults ON for admins. Finding new shops while sourcing is the normal
  // case, and the whole point of the shared catalogue is that those reach
  // users without a separate publishing step. A niche supplier worth keeping
  // private is one unticked box away.
  const [shareNew, setShareNew] = useState(true);

  useEffect(() => {
    void (async () => {
      setBrandsLoading(true);
      const { data, error: e } = await supabase
        .from("user_brands")
        .select("brand, asin_count")
        .neq("status", "ignore")
        .order("brand")
        .range(0, 4999);
      if (e) toast.error(e.message);
      setBrands((data as BrandRow[]) || []);
      setBrandsLoading(false);
    })();
  }, []);

  const attached = useMemo(
    () => Object.entries(sourceMap).sort((a, b) => a[0].localeCompare(b[0])),
    [sourceMap],
  );

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const list = f ? brands.filter((b) => b.brand.toLowerCase().includes(f)) : brands;
    return list.slice(0, MAX_SHOWN);
  }, [brands, filter]);

  const totalMatching = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f ? brands.filter((b) => b.brand.toLowerCase().includes(f)).length : brands.length;
  }, [brands, filter]);

  const run = async (fn: () => Promise<void>, ok: string) => {
    setBusy(true);
    try { await fn(); toast.success(ok); }
    catch (e) { toast.error((e as Error).message); }
    finally { setBusy(false); }
  };

  const toggle = (b: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(b)) next.delete(b); else next.add(b);
      return next;
    });
  };

  return (
    <div className="space-y-4">
      <div>
        <div className="text-sm font-medium">Purchase sources</div>
        <div className="text-xs text-muted-foreground">
          Add the shops you actually buy from, then attach your brands to them. Matched
          listings link straight there instead of to a Google search. Google stays as a
          fallback for brands with no source.
        </div>
      </div>

      {error && (
        <p className="rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          {error}
        </p>
      )}

      {/* ── RETAILERS ─────────────────────────────────────────────────── */}
      <div className="rounded-md border p-3 space-y-2">
        <div className="text-xs font-medium">Your shops</div>

        {loading ? (
          <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
          </div>
        ) : retailers.length === 0 ? (
          <p className="py-1 text-xs text-muted-foreground">
            No shops yet. Add one below — every brand keeps its Google search until you do.
          </p>
        ) : (
          <div className="divide-y rounded border">
            {retailers.map((r) => {
              const count = Object.values(sourceMap)
                .filter((list) => list.some((s) => s.retailer_id === r.id)).length;
              const isEditing = editing === r.id;
              return (
                <div key={r.id} className="flex items-center gap-2 px-2 py-1.5 text-xs">
                  {isEditing ? (
                    <>
                      <Input
                        value={editLabel}
                        onChange={(e) => setEditLabel(e.target.value)}
                        className="h-7 w-[130px] text-xs"
                      />
                      <Input
                        value={editTemplate}
                        onChange={(e) => setEditTemplate(e.target.value)}
                        className="h-7 flex-1 text-xs font-mono"
                      />
                      <Button
                        type="button" size="sm" variant="ghost" className="h-7 px-2"
                        disabled={busy || !editLabel.trim() || !editTemplate.trim()}
                        onClick={() => void run(async () => {
                          await updateRetailer(r.id, editLabel, editTemplate, r.scope);
                          setEditing(null);
                        }, "Shop updated")}
                      >
                        <Check className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        type="button" size="sm" variant="ghost" className="h-7 px-2"
                        onClick={() => setEditing(null)}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </>
                  ) : (
                    <>
                      <span className="w-[130px] shrink-0 truncate font-medium">
                        {r.label}
                        {r.scope === "catalog" && (
                          <Globe
                            className="ml-1 inline h-3 w-3 text-muted-foreground"
                            aria-label="Shared with all users"
                          />
                        )}
                      </span>
                      <span className="flex-1 truncate font-mono text-[11px] text-muted-foreground">
                        {retailerHost(r.url_template)} · {describeTemplate(r.url_template)}
                      </span>
                      <Badge variant="secondary" className="shrink-0 text-[10px]">
                        {count} brand{count === 1 ? "" : "s"}
                      </Badge>
                      <a
                        href={resolveSourceUrl(r.url_template, { brand: "test", title: "test" })}
                        target="_blank" rel="noopener noreferrer"
                        title="Open this shop to check the link still works"
                        className="rounded p-1 text-muted-foreground hover:text-primary"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                      {/* Opting out of a shared shop, rather than deleting it
                          for everyone. A non-admin has no other escape from a
                          catalogue entry that does not suit them. */}
                      {r.scope === "catalog" && (
                        <button
                          type="button"
                          disabled={busy}
                          title={r.muted
                            ? `Show ${r.label} again`
                            : `Hide ${r.label} from your listings`}
                          onClick={() => void run(
                            () => setRetailerMuted(r.id, !r.muted),
                            r.muted ? `${r.label} restored` : `${r.label} hidden`,
                          )}
                          className="rounded p-1 text-muted-foreground hover:text-foreground"
                        >
                          {r.muted
                            ? <Eye className="h-3.5 w-3.5" />
                            : <EyeOff className="h-3.5 w-3.5" />}
                        </button>
                      )}
                      {/* Publish a shop found later. RLS refuses this for
                          non-admins, so the button is a shortcut, not the
                          permission check. */}
                      {isAdmin && r.scope === "user" && (
                        <button
                          type="button"
                          disabled={busy}
                          title={`Share ${r.label} with all users`}
                          onClick={() => void run(
                            () => shareRetailer(r),
                            `${r.label} shared with all users`,
                          )}
                          className="rounded p-1 text-muted-foreground hover:text-primary"
                        >
                          <Globe className="h-3.5 w-3.5" />
                        </button>
                      )}
                      {(r.scope === "user" || isAdmin) && (
                        <button
                          type="button"
                          onClick={() => {
                            setEditing(r.id);
                            setEditLabel(r.label);
                            setEditTemplate(r.url_template);
                          }}
                          className="rounded p-1 text-muted-foreground hover:text-foreground"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={busy || (r.scope === "catalog" && !isAdmin)}
                        title={r.scope === "catalog"
                          ? (isAdmin
                              ? `Remove ${r.label} from the shared catalogue for ALL users`
                              : `${r.label} is shared by the platform — hide it instead`)
                          : `Remove ${r.label} and detach its ${count} brand${count === 1 ? "" : "s"}`}
                        onClick={() => void run(
                          () => deleteRetailer(r.id, r.scope),
                          `${r.label} removed`,
                        )}
                        className="rounded p-1 text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await addRetailer(label, template, isAdmin && shareNew);
              setLabel(""); setTemplate("");
            }, "Shop added");
          }}
          className="flex items-center gap-2 pt-1"
        >
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Walmart"
            className="h-8 w-[130px] text-xs"
          />
          <Input
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
            placeholder="walmart.com/search?q={title}"
            className="h-8 flex-1 font-mono text-xs"
          />
          <Button type="submit" size="sm" className="h-8 gap-1"
                  disabled={busy || !label.trim() || !template.trim()}>
            <Plus className="h-3.5 w-3.5" /> Add
          </Button>
        </form>

        {/* Admins publish by default. Discovering shops while sourcing is
            ongoing, not a setup task, so the shared catalogue only stays
            current if sharing is the default path rather than a second step. */}
        {isAdmin && (
          <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <input
              type="checkbox"
              checked={shareNew}
              onChange={(e) => setShareNew(e.target.checked)}
              className="h-3 w-3"
            />
            Share this shop with all users — they see it immediately, with no
            discount codes and no link to your brands.
          </label>
        )}

        {/* The preview is the explanation. Describing placeholders in prose
            never lands as well as showing the URL that will actually open. */}
        {template.trim() && (
          <p className="text-[11px] text-muted-foreground">
            {describeTemplate(normaliseTemplate(template))} →{" "}
            <span className="font-mono break-all">
              {resolveSourceUrl(normaliseTemplate(template), {
                brand: "Nerf", title: "Nerf Elite 2.0 Commander",
              })}
            </span>
          </p>
        )}
        <p className="text-[11px] text-muted-foreground">
          Use <span className="font-mono">{"{brand}"}</span> to search the brand,{" "}
          <span className="font-mono">{"{title}"}</span> to search the exact product, or
          neither to just open the page.
        </p>
      </div>

      {/* ── ATTACH BRANDS ─────────────────────────────────────────────── */}
      {retailers.length > 0 && (
        <div className="rounded-md border p-3 space-y-2">
          <div className="text-xs font-medium">Attach brands to a shop</div>
          <div className="flex items-center gap-2">
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter brands…"
              className="h-8 w-[200px] text-xs"
            />
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              className="h-8 rounded border bg-background px-2 text-xs"
            >
              <option value="">Choose a shop…</option>
              {retailers.filter((r) => !r.muted).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}{r.scope === "catalog" ? " (shared)" : ""}
                </option>
              ))}
            </select>
            <Input
              value={note}
              onChange={(e) => setNoteDraft(e.target.value)}
              placeholder="Note (optional) — e.g. case pack only"
              className="h-8 flex-1 text-xs"
            />
            <Button
              type="button" size="sm" className="h-8 shrink-0"
              disabled={busy || !target || picked.size === 0}
              onClick={() => void run(async () => {
                await attachBrands(
                  [...picked],
                  target,
                  retailers.find((r) => r.id === target)?.scope ?? "user",
                  note,
                );
                setPicked(new Set()); setNoteDraft("");
              }, `${picked.size} brand${picked.size === 1 ? "" : "s"} attached`)}
            >
              Attach {picked.size > 0 ? picked.size : ""}
            </Button>
          </div>

          {brandsLoading ? (
            <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading brands…
            </div>
          ) : (
            <>
              <div className="flex flex-wrap gap-1.5">
                {shown.map((b) => {
                  const on = picked.has(b.brand);
                  const has = (sourceMap[b.brand.trim().toLowerCase()] ?? []).length;
                  return (
                    <button
                      key={b.brand}
                      type="button"
                      onClick={() => toggle(b.brand)}
                      className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs ${
                        on ? "border-primary bg-primary/10 text-primary" : "bg-muted/40"
                      }`}
                    >
                      {b.brand}
                      {has > 0 && (
                        <span className="text-[9px] text-muted-foreground">·{has}</span>
                      )}
                    </button>
                  );
                })}
              </div>
              {totalMatching > shown.length && (
                <p className="text-[11px] text-muted-foreground">
                  Showing {shown.length} of {totalMatching.toLocaleString()} — narrow the
                  filter to reach the rest.
                </p>
              )}
            </>
          )}
        </div>
      )}

      {/* ── EXISTING ATTACHMENTS ──────────────────────────────────────── */}
      {attached.length > 0 && (
        <div className="rounded-md border p-3 space-y-2">
          <div className="text-xs font-medium">
            Brands with a source ({attached.length.toLocaleString()})
          </div>
          <div className="max-h-[320px] divide-y overflow-y-auto rounded border">
            {attached.map(([brand, list]) => (
              <div key={brand} className="flex flex-wrap items-center gap-2 px-2 py-1.5 text-xs">
                <span className="w-[150px] shrink-0 truncate font-medium">{brand}</span>
                {list.map((s) => (
                  <span
                    key={s.retailer_id}
                    className="inline-flex items-center gap-1 rounded border bg-muted/40 pl-2 pr-1 py-0.5"
                  >
                    {s.label}
                    {s.note && (
                      <span className="text-[10px] text-muted-foreground">· {s.note}</span>
                    )}
                    <button
                      type="button"
                      title="Edit note"
                      onClick={() => {
                        const next = window.prompt(`Note for ${s.brand} at ${s.label}`, s.note ?? "");
                        if (next === null) return;
                        void run(() => setNote(s.brand, s.retailer_id, next), "Note saved");
                      }}
                      className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      title={`Detach ${s.brand} from ${s.label}`}
                      disabled={busy}
                      onClick={() => void run(
                        () => detachBrand(s.brand, s.retailer_id),
                        "Detached",
                      )}
                      className="rounded p-0.5 text-muted-foreground hover:text-destructive"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
