import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { BrandSource, BrandSourceMap } from "@/lib/brandSources";
import { normaliseBrand, normaliseTemplate } from "@/lib/brandSources";

/**
 * The user's retailers and which brands they buy from each.
 *
 * The brand -> sources map comes from get_brand_sources(), which returns ONE
 * jsonb object rather than a row per attachment. PostgREST caps RPC results at
 * 1,000 rows -- that silently truncated a 737-item list earlier the same day --
 * and a user with 2,185 branded attachments would hit the ceiling with no
 * error to show for it. One aggregated value has no such limit.
 */

export interface Retailer {
  id: string;
  label: string;
  url_template: string;
}

export interface BrandAttachment {
  brand: string;
  retailer_id: string;
  note: string | null;
}

export function useBrandSources() {
  const [retailers, setRetailers] = useState<Retailer[]>([]);
  const [sourceMap, setSourceMap] = useState<BrandSourceMap>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data: rows, error: rErr } = await supabase
        .from("user_retailers")
        .select("id, label, url_template")
        .order("label");
      if (rErr) throw rErr;
      setRetailers((rows as Retailer[]) || []);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: map, error: mErr } = await (supabase as any).rpc("get_brand_sources");
      if (mErr) throw mErr;
      setSourceMap((map as BrandSourceMap) || {});
    } catch (e) {
      // Surfaced, not swallowed. A silently empty source map is
      // indistinguishable from "no sources saved yet", which is exactly how a
      // permissions bug hid in this codebase once already today.
      const msg = (e as Error).message || "Could not load your sources";
      console.error("[useBrandSources]", e);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const addRetailer = useCallback(async (label: string, template: string) => {
    const { data: auth } = await supabase.auth.getUser();
    const uid = auth?.user?.id;
    if (!uid) throw new Error("Not signed in");
    const { error: e } = await supabase.from("user_retailers").insert({
      user_id: uid,
      label: label.trim(),
      url_template: normaliseTemplate(template),
    });
    if (e) throw e;
    await refresh();
  }, [refresh]);

  const updateRetailer = useCallback(async (id: string, label: string, template: string) => {
    const { error: e } = await supabase
      .from("user_retailers")
      .update({
        label: label.trim(),
        url_template: normaliseTemplate(template),
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);
    if (e) throw e;
    await refresh();
  }, [refresh]);

  // Attachments cascade with the retailer, so this removes the brand links too.
  const deleteRetailer = useCallback(async (id: string) => {
    const { error: e } = await supabase.from("user_retailers").delete().eq("id", id);
    if (e) throw e;
    await refresh();
  }, [refresh]);

  /** Attach one or many brands to a retailer. Bulk is the point: 2,185 brands. */
  const attachBrands = useCallback(async (
    brands: string[],
    retailerId: string,
    note?: string | null,
  ) => {
    const { data: auth } = await supabase.auth.getUser();
    const uid = auth?.user?.id;
    if (!uid) throw new Error("Not signed in");
    const rows = brands
      .map((b) => b.trim())
      .filter(Boolean)
      .map((brand) => ({
        user_id: uid,
        brand,
        retailer_id: retailerId,
        note: note?.trim() || null,
      }));
    if (!rows.length) return;
    // Re-attaching an already-attached brand updates its note rather than
    // erroring on the primary key.
    const { error: e } = await supabase
      .from("user_brand_sources")
      .upsert(rows, { onConflict: "user_id,brand,retailer_id" });
    if (e) throw e;
    await refresh();
  }, [refresh]);

  const detachBrand = useCallback(async (brand: string, retailerId: string) => {
    const { data: auth } = await supabase.auth.getUser();
    const uid = auth?.user?.id;
    if (!uid) throw new Error("Not signed in");
    const { error: e } = await supabase
      .from("user_brand_sources")
      .delete()
      .eq("user_id", uid)
      .eq("brand", brand)
      .eq("retailer_id", retailerId);
    if (e) throw e;
    await refresh();
  }, [refresh]);

  const setNote = useCallback(async (brand: string, retailerId: string, note: string) => {
    const { data: auth } = await supabase.auth.getUser();
    const uid = auth?.user?.id;
    if (!uid) throw new Error("Not signed in");
    const { error: e } = await supabase
      .from("user_brand_sources")
      .update({ note: note.trim() || null })
      .eq("user_id", uid)
      .eq("brand", brand)
      .eq("retailer_id", retailerId);
    if (e) throw e;
    await refresh();
  }, [refresh]);

  /** What is attached to one brand, for the manager's per-brand row. */
  const sourcesFor = useCallback((brand: string): BrandSource[] => {
    return sourceMap[normaliseBrand(brand)] ?? [];
  }, [sourceMap]);

  return {
    retailers, sourceMap, loading, error, refresh,
    addRetailer, updateRetailer, deleteRetailer,
    attachBrands, detachBrand, setNote, sourcesFor,
  };
}
