/**
 * Brands to WATCH FOR — the positive counterpart to QualificationExclusionsPanel.
 *
 * That panel answers "never show me this". This one answers "tell me when a
 * watched seller lists this", and they are separate lists on purpose: excluding
 * Generic has nothing to do with wanting Milwaukee.
 *
 * Two ways a brand gets here:
 *   inventory  derived from stock held, via refresh_user_brands()
 *   manual     typed in below, including brands never carried
 *
 * Both match identically. `source` exists only so refresh_user_brands() knows
 * not to zero a manual row — a brand never carried has no inventory to be
 * missing from, and zeroing it would report "sold out" for something that was
 * never stocked.
 *
 * Removing uses status = 'ignore' rather than DELETE for inventory-derived
 * brands: the next refresh would simply recreate a deleted row, so deletion
 * would appear to work and then silently undo itself. Manual rows have no such
 * source and are deleted outright.
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

type Row = {
  brand: string;
  asin_count: number;
  unit_count: number;
  source: "inventory" | "manual";
  match_mode: "exact" | "prefix";
  status: string | null;
};

export default function WatchedBrandsPanel() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const { data, error } = await supabase
      .from("user_brands")
      .select("brand, asin_count, unit_count, source, match_mode, status")
      .eq("user_id", user.id)
      .order("asin_count", { ascending: false })
      .limit(2000);
    if (error) console.warn("[watched-brands]", error.message);
    setRows((data ?? []) as Row[]);
    setLoading(false);
  }, [user]);

  useEffect(() => { void load(); }, [load]);

  const watched = rows.filter((r) => (r.status ?? "") !== "ignore");
  const ignored = rows.filter((r) => (r.status ?? "") === "ignore");

  const add = async () => {
    const name = draft.trim();
    if (!name || !user) return;
    setBusy(true);
    // Upsert, not insert: the brand may already exist from inventory and be
    // marked ignore. Typing it again should bring it back, not fail on the
    // primary key.
    const { error } = await supabase
      .from("user_brands")
      .upsert(
        { user_id: user.id, brand: name, source: "manual", status: null },
        { onConflict: "user_id,brand" },
      );
    setBusy(false);
    if (error) { toast.error(`Could not add: ${error.message}`); return; }
    setDraft("");
    toast.success(`Watching ${name}`);
    void load();
  };

  const remove = async (r: Row) => {
    if (!user) return;
    setBusy(true);
    const q = supabase.from("user_brands");
    const { error } = r.source === "manual"
      ? await q.delete().eq("user_id", user.id).eq("brand", r.brand)
      // Inventory-derived: mark ignored. Deleting would be undone by the next
      // refresh, which would look like the removal silently failing.
      : await q.update({ status: "ignore" }).eq("user_id", user.id).eq("brand", r.brand);
    setBusy(false);
    if (error) { toast.error(error.message); return; }
    void load();
  };

  const restore = async (r: Row) => {
    if (!user) return;
    setBusy(true);
    const { error } = await supabase.from("user_brands")
      .update({ status: null }).eq("user_id", user.id).eq("brand", r.brand);
    setBusy(false);
    if (error) { toast.error(error.message); return; }
    void load();
  };

  const togglePrefix = async (r: Row) => {
    if (!user) return;
    const next = r.match_mode === "prefix" ? "exact" : "prefix";
    // Under 3 characters the classifier refuses a prefix anyway -- it would
    // match most of the catalogue. Say so rather than letting the toggle look
    // set while being ignored server-side.
    if (next === "prefix" && r.brand.trim().length < 3) {
      toast.error("Prefix matching needs at least 3 characters");
      return;
    }
    setBusy(true);
    const { error } = await supabase.from("user_brands")
      .update({ match_mode: next }).eq("user_id", user.id).eq("brand", r.brand);
    setBusy(false);
    if (error) { toast.error(error.message); return; }
    void load();
  };

  return (
    <div className="space-y-3">
      <div>
        <div className="text-sm font-medium">Watched Brands</div>
        <div className="text-xs text-muted-foreground">
          {watched.length} watched. A new listing from a watched seller is checked against
          these automatically and emailed to you if it matches. Brands you stock are added
          for you; type any others below, including ones you have never carried.
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-4">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading brands…
        </div>
      ) : (
        <div className="flex max-h-[260px] flex-wrap gap-1.5 overflow-y-auto rounded border p-2">
          {watched.map((r) => (
            <span
              key={r.brand}
              className="inline-flex items-center gap-1 rounded border bg-muted/40 pl-2 pr-1 py-0.5 text-xs"
            >
              <span className="font-medium">{r.brand}</span>
              {r.asin_count > 0 && <span className="text-muted-foreground">· {r.asin_count}</span>}
              {r.source === "manual" && (
                <Badge variant="outline" className="text-[9px] px-1 py-0 h-4">watch</Badge>
              )}
              <button
                type="button"
                onClick={() => togglePrefix(r)}
                disabled={busy}
                title={
                  r.match_mode === "prefix"
                    ? `Also matches brands starting with "${r.brand}" — click for exact only`
                    : `Exact match only — click to also match brands starting with "${r.brand}"`
                }
                className={`rounded px-1 text-[9px] ${
                  r.match_mode === "prefix"
                    ? "bg-primary/15 text-primary"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {r.match_mode === "prefix" ? "abc*" : "abc"}
              </button>
              <button
                type="button"
                onClick={() => remove(r)}
                disabled={busy}
                title={r.source === "manual" ? "Remove" : "Stop watching this brand"}
                className="rounded p-0.5 text-muted-foreground hover:text-destructive"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <form
        onSubmit={(e) => { e.preventDefault(); void add(); }}
        className="flex items-center gap-2"
      >
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="e.g. Bosch"
          className="h-8 w-[220px] text-xs"
        />
        <Button type="submit" size="sm" className="h-8 gap-1" disabled={busy || !draft.trim()}>
          <Plus className="h-3.5 w-3.5" /> Watch
        </Button>
      </form>

      {ignored.length > 0 && (
        <div className="pt-2 border-t">
          <div className="text-xs text-muted-foreground mb-1.5">
            {/* Shown rather than hidden: the user asked to see what the rule is
                doing rather than trust it silently, and a brand that vanished
                with no way back is indistinguishable from a bug. */}
            Not watched ({ignored.length}) — click to start watching again
          </div>
          <div className="flex max-h-[160px] flex-wrap gap-1.5 overflow-y-auto rounded border p-2">
            {ignored.map((r) => (
              <button
                key={r.brand}
                type="button"
                onClick={() => restore(r)}
                disabled={busy}
                className="inline-flex items-center gap-1 rounded border border-dashed px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground hover:border-solid"
              >
                {r.brand}
                {r.asin_count > 0 && <span>· {r.asin_count}</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
