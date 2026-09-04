import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { BrandSourceMap } from "@/lib/brandSources";
import { normaliseBrand, normaliseTemplate } from "@/lib/brandSources";

/**
 * Retailers and brand-to-shop links, resolved as shared UNION own MINUS muted.
 *
 * ---- LIVING RESOURCE, NOT A SIGNUP SNAPSHOT ----------------------------
 *
 * Shops come from get_effective_retailers(), which unions the shared catalogue
 * with the user's own at READ TIME. Nothing is copied into an account, so a
 * shop an admin adds today appears for every existing user on their next load
 * -- no sync job, no signup snapshot, nothing to go stale. Copy-on-signup was
 * rejected for exactly this reason: it would have frozen each user's list at
 * the moment they registered.
 *
 * ---- WHAT IS AND IS NOT SHARED -----------------------------------------
 *
 * Shared: shop name + URL pattern, and category exclusions. Generic.
 * Private: the brand list, brand-to-shop mappings, and anything from purchase
 * history -- that is the sourcing research, and it stays on the account that
 * did the work. A user's own additions are never written back to the
 * catalogue.
 *
 * There is no discount field anywhere in the shared path. Discounts are
 * time-limited and tied to one buyer's relationship with a shop; a shared
 * retailer is a plain link and a user finds their own deals.
 */

export interface Retailer {
  id: string;
  label: string;
  url_template: string;
  /** 'catalog' rows are shared by the platform; 'user' rows are the caller's. */
  scope: "user" | "catalog";
  /** Only meaningful for catalog rows: this user opted out of it. */
  muted: boolean;
}

export function useBrandSources() {
  const [retailers, setRetailers] = useState<Retailer[]>([]);
  const [sourceMap, setSourceMap] = useState<BrandSourceMap>({});
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sb = supabase as any;

      const [{ data: rows, error: rErr }, { data: map, error: mErr }] = await Promise.all([
        sb.rpc("get_effective_retailers"),
        sb.rpc("get_brand_sources"),
      ]);
      if (rErr) throw rErr;
      if (mErr) throw mErr;

      setRetailers(
        ((rows as Array<Record<string, unknown>>) || []).map((r) => ({
          id: String(r.id),
          label: String(r.label),
          url_template: String(r.template),
          scope: r.scope === "catalog" ? "catalog" : "user",
          muted: r.muted === true,
        })),
      );
      setSourceMap((map as BrandSourceMap) || {});

      const { data: auth } = await supabase.auth.getUser();
      if (auth?.user?.id) {
        const { data: admin } = await sb.rpc("has_role", {
          _user_id: auth.user.id, _role: "admin",
        });
        setIsAdmin(admin === true);
      }
    } catch (e) {
      // Surfaced, never swallowed. An empty source map looks exactly like "no
      // sources saved", which is how a permissions bug hid in this codebase
      // once already.
      const msg = (e as Error).message || "Could not load your sources";
      console.error("[useBrandSources]", e);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const uid = async () => {
    const { data } = await supabase.auth.getUser();
    const id = data?.user?.id;
    if (!id) throw new Error("Not signed in");
    return id;
  };

  /**
   * `share` writes to the shared catalogue instead of the caller's own list.
   * Admin-only, and enforced by RLS rather than by this flag -- a non-admin
   * passing share:true is refused by the policy, not by the UI.
   */
  const addRetailer = useCallback(async (
    label: string, template: string, share = false,
  ) => {
    const row = { label: label.trim(), url_template: normaliseTemplate(template) };
    if (share) {
      const { error: e } = await supabase.from("catalog_retailers").insert(row);
      if (e) throw e;
    } else {
      const { error: e } = await supabase
        .from("user_retailers").insert({ ...row, user_id: await uid() });
      if (e) throw e;
    }
    await refresh();
  }, [refresh]);

  /** Publish one of your own shops to every user. Admin-only via RLS. */
  const shareRetailer = useCallback(async (r: Retailer) => {
    const { error: e } = await supabase.from("catalog_retailers")
      .insert({ label: r.label, url_template: r.url_template });
    if (e) throw e;
    await refresh();
  }, [refresh]);

  const updateRetailer = useCallback(async (
    id: string, label: string, template: string, scope: "user" | "catalog" = "user",
  ) => {
    const table = scope === "catalog" ? "catalog_retailers" : "user_retailers";
    const { error: e } = await supabase.from(table).update({
      label: label.trim(),
      url_template: normaliseTemplate(template),
      updated_at: new Date().toISOString(),
    }).eq("id", id);
    if (e) throw e;
    await refresh();
  }, [refresh]);

  const deleteRetailer = useCallback(async (
    id: string, scope: "user" | "catalog" = "user",
  ) => {
    const table = scope === "catalog" ? "catalog_retailers" : "user_retailers";
    const { error: e } = await supabase.from(table).delete().eq("id", id);
    if (e) throw e;
    await refresh();
  }, [refresh]);

  /**
   * Opt out of a shared shop without deleting it for anyone else. Without this
   * one bad catalogue entry is every tenant's problem with no escape.
   */
  const setRetailerMuted = useCallback(async (id: string, muted: boolean) => {
    if (muted) {
      const { error: e } = await supabase.from("user_catalog_mutes")
        .upsert({ user_id: await uid(), kind: "retailer", target_id: id },
                { onConflict: "user_id,kind,target_id" });
      if (e) throw e;
    } else {
      const { error: e } = await supabase.from("user_catalog_mutes").delete()
        .eq("user_id", await uid()).eq("kind", "retailer").eq("target_id", id);
      if (e) throw e;
    }
    await refresh();
  }, [refresh]);

  /** Brand mappings are ALWAYS the user's own, even when the shop is shared. */
  const attachBrands = useCallback(async (
    brands: string[], retailerId: string, scope: "user" | "catalog", note?: string | null,
  ) => {
    const userId = await uid();
    const rows = brands.map((b) => b.trim()).filter(Boolean).map((brand) => ({
      user_id: userId,
      brand,
      retailer_id: retailerId,
      retailer_scope: scope,
      note: note?.trim() || null,
    }));
    if (!rows.length) return;
    const { error: e } = await supabase.from("user_brand_sources")
      .upsert(rows, { onConflict: "user_id,brand,retailer_id" });
    if (e) throw e;
    await refresh();
  }, [refresh]);

  const detachBrand = useCallback(async (brand: string, retailerId: string) => {
    const { error: e } = await supabase.from("user_brand_sources").delete()
      .eq("user_id", await uid()).eq("brand", brand).eq("retailer_id", retailerId);
    if (e) throw e;
    await refresh();
  }, [refresh]);

  const setNote = useCallback(async (brand: string, retailerId: string, note: string) => {
    const { error: e } = await supabase.from("user_brand_sources")
      .update({ note: note.trim() || null })
      .eq("user_id", await uid()).eq("brand", brand).eq("retailer_id", retailerId);
    if (e) throw e;
    await refresh();
  }, [refresh]);

  const sourcesFor = useCallback(
    (brand: string) => sourceMap[normaliseBrand(brand)] ?? [],
    [sourceMap],
  );

  return {
    retailers, sourceMap, isAdmin, loading, error, refresh,
    addRetailer, shareRetailer, updateRetailer, deleteRetailer, setRetailerMuted,
    attachBrands, detachBrand, setNote, sourcesFor,
  };
}
