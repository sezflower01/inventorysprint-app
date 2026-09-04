import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export type ExclusionKind = "category" | "brand" | "title_keyword";

export interface ExcludedTerm {
  id: string;
  kind: ExclusionKind;
  value: string;
  label: string | null;
  /**
   * 'catalog' rows are shared by the platform and belong to no user, so they
   * can be MUTED but never deleted; 'user' rows are the caller's own.
   */
  scope: "user" | "catalog";
  /** Only meaningful for catalog rows: this user opted out of it. */
  muted: boolean;
}

/** A value present in the user's own listings, with how many carry it. */
export interface PreviewEntry {
  value: string;
  label: string;
  n: number;
}

/** Matching must agree exactly with source-qualification.ts: trim + lowercase. */
export function normalizeTerm(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Title keywords normalise differently, mirroring
 * supabase/functions/_shared/title-exclusions.ts (the source of truth, which
 * the edge functions import directly). Duplicated here rather than imported
 * because that module is Deno edge code and does not belong in the browser
 * bundle — but ONLY the normalisation is copied, never the matching rule.
 *
 * Diacritics are stripped so "Pokémon" and "pokemon" are one entry rather than
 * two that both appear to work.
 */
export function normalizeTitleTerm(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** The stored `value` for a term of this kind. */
export function normalizeForKind(kind: ExclusionKind, raw: string): string {
  return kind === "title_keyword" ? normalizeTitleTerm(raw) : normalizeTerm(raw);
}

/**
 * Category and brand exclusions, plus what each rule would actually affect.
 *
 * The preview exists because Amazon's productGroup is coarse and sometimes
 * wrong — live data returned "Apparel" for a LEGO minifigure and "Shoes" for
 * reading glasses. Excluding a category by name is a guess unless you can see
 * what actually carries that label in your own listings.
 */
export function useQualificationExclusions() {
  const [terms, setTerms] = useState<ExcludedTerm[]>([]);
  const [categoryCounts, setCategoryCounts] = useState<PreviewEntry[]>([]);
  const [brandCounts, setBrandCounts] = useState<PreviewEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  /**
   * Admins publish by default, matching how shops behave.
   *
   * Without this an admin adding a category would write it to their OWN list
   * and no user would ever see it -- the exact gap shops had, where "I added
   * it and nobody got it" was the symptom. Kept in the hook rather than
   * threaded through props so every write path consults it without each
   * sub-panel having to know it exists.
   */
  const [shareNew, setShareNew] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      // Shared UNION own MINUS nothing -- muted rows come back flagged rather
      // than missing, because the panel has to show what was opted out in
      // order to offer opting back in. Callers that DECIDE with this list
      // filter on `muted` themselves.
      const [{ data, error }, { data: preview }] = await Promise.all([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (supabase as any).rpc("get_effective_excluded_terms"),
        supabase.rpc("qualification_exclusion_preview"),
      ]);
      if (error) throw new Error(error.message);
      setTerms(((data || []) as ExcludedTerm[]).map((t) => ({
        ...t,
        scope: t.scope === "catalog" ? "catalog" : "user",
        muted: t.muted === true,
      })));
      const p = (preview || {}) as { categories?: PreviewEntry[]; brands?: PreviewEntry[] };
      setCategoryCounts(p.categories || []);
      setBrandCounts(p.brands || []);

      const { data: auth } = await supabase.auth.getUser();
      if (auth?.user?.id) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: admin } = await (supabase as any).rpc("has_role", {
          _user_id: auth.user.id, _role: "admin",
        });
        setIsAdmin(admin === true);
      }
    } catch (e) {
      console.error("[useQualificationExclusions] refresh failed", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const add = useCallback(async (kind: ExclusionKind, raw: string) => {
    const value = normalizeForKind(kind, raw);
    if (!value) throw new Error("Enter a value first.");
    if (terms.some((t) => t.kind === kind && t.value === value)) {
      throw new Error(`"${raw.trim()}" is already excluded.`);
    }
    const { data: auth } = await supabase.auth.getUser();
    const userId = auth?.user?.id;
    if (!userId) throw new Error("Please log in to change this setting.");

    setBusy(true);
    try {
      // RLS is the real gate: a non-admin writing to catalog_excluded_terms is
      // refused by policy, not by this flag.
      const { error } = isAdmin && shareNew
        ? await supabase.from("catalog_excluded_terms")
            .insert({ kind, value, label: raw.trim() })
        : await supabase.from("source_excluded_terms")
            .insert({ user_id: userId, kind, value, label: raw.trim() });
      if (error) throw new Error(error.message);
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [terms, refresh]);

  /**
   * Removing a shared term MUTES it rather than deleting it: the row belongs
   * to the platform, and deleting it would remove it for every other tenant.
   * Muting is per-user and reversible, which is the behaviour a user actually
   * wants from "I don't want this one".
   */
  const remove = useCallback(async (id: string) => {
    setBusy(true);
    try {
      const term = terms.find((t) => t.id === id);
      if (term?.scope === "catalog") {
        const { data: auth } = await supabase.auth.getUser();
        const userId = auth?.user?.id;
        if (!userId) throw new Error("Please log in to change this setting.");
        const { error } = await supabase.from("user_catalog_mutes").upsert(
          { user_id: userId, kind: "excluded_term", target_id: id },
          { onConflict: "user_id,kind,target_id" },
        );
        if (error) throw new Error(error.message);
      } else {
        const { error } = await supabase.from("source_excluded_terms").delete().eq("id", id);
        if (error) throw new Error(error.message);
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [terms, refresh]);

  /** Undo a mute -- put a shared term back into effect for this user. */
  const unmute = useCallback(async (id: string) => {
    setBusy(true);
    try {
      const { data: auth } = await supabase.auth.getUser();
      const userId = auth?.user?.id;
      if (!userId) throw new Error("Please log in to change this setting.");
      const { error } = await supabase.from("user_catalog_mutes").delete()
        .eq("user_id", userId).eq("kind", "excluded_term").eq("target_id", id);
      if (error) throw new Error(error.message);
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  /**
   * Exclude or re-allow a whole set of API values at once.
   *
   * A friendly category label maps to several real websiteDisplayGroupName
   * values ("Movies & TV" -> dvd, video, video dvd, blu-ray), so a toggle has
   * to move all of them together. Done as one insert and one delete rather
   * than a loop of single calls, so a half-applied toggle cannot leave a label
   * in a state its own switch does not describe.
   */
  const setExcluded = useCallback(async (kind: ExclusionKind, values: string[], excluded: boolean) => {
    if (!values.length) return;
    const { data: auth } = await supabase.auth.getUser();
    const userId = auth?.user?.id;
    if (!userId) throw new Error("Please log in to change this setting.");

    setBusy(true);
    try {
      // A toggle has to move BOTH halves of the effective list, or the switch
      // and the rule disagree: switching a shared category off while only
      // deleting own rows would leave the shared one still filtering.
      const inScope = terms.filter((t) => t.kind === kind && values.includes(t.value));
      const sharedIds = inScope.filter((t) => t.scope === "catalog").map((t) => t.id);

      if (excluded) {
        const covered = new Set(
          inScope.filter((t) => t.scope === "user" || !t.muted).map((t) => t.value),
        );
        const missing = values.filter((v) => !covered.has(v));
        if (missing.length) {
          const { error } = isAdmin && shareNew
            ? await supabase.from("catalog_excluded_terms")
                .insert(missing.map((v) => ({ kind, value: v, label: v })))
            : await supabase.from("source_excluded_terms")
                .insert(missing.map((v) => ({ user_id: userId, kind, value: v, label: v })));
          if (error) throw new Error(error.message);
        }
        // Re-enabling a category the user had muted must lift the mute, not
        // add a duplicate own row alongside a still-muted shared one.
        if (sharedIds.length) {
          const { error } = await supabase.from("user_catalog_mutes").delete()
            .eq("user_id", userId).eq("kind", "excluded_term").in("target_id", sharedIds);
          if (error) throw new Error(error.message);
        }
      } else {
        const { error } = await supabase
          .from("source_excluded_terms")
          .delete()
          .eq("kind", kind)
          .in("value", values);
        if (error) throw new Error(error.message);
        // An admin switching a shared category off means "this should not be
        // shared any more", not "hide it from me" -- muting it for themselves
        // would leave it in force for every other tenant while their own switch
        // read OFF.
        if (isAdmin && sharedIds.length) {
          const { error: dErr } = await supabase.from("catalog_excluded_terms")
            .delete().in("id", sharedIds);
          if (dErr) throw new Error(dErr.message);
        } else if (sharedIds.length) {
          const { error: mErr } = await supabase.from("user_catalog_mutes").upsert(
            sharedIds.map((id) => ({ user_id: userId, kind: "excluded_term", target_id: id })),
            { onConflict: "user_id,kind,target_id" },
          );
          if (mErr) throw new Error(mErr.message);
        }
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [terms, refresh, isAdmin, shareNew]);

  /**
   * How many current listings a rule would hit. null = none seen in your data.
   *
   * Title keywords deliberately return null: the preview RPC counts distinct
   * category and brand VALUES, which a word-boundary match inside a sentence
   * cannot be expressed as. Guessing with a SQL LIKE would show a number that
   * disagrees with the rule that actually runs, which is worse than showing
   * none — the "Apply to existing listings" preview uses the real matcher
   * instead.
   */
  const impactOf = useCallback((kind: ExclusionKind, value: string): number | null => {
    if (kind === "title_keyword") return null;
    const list = kind === "category" ? categoryCounts : brandCounts;
    const hit = list.find((e) => e.value === value);
    return hit ? hit.n : null;
  }, [categoryCounts, brandCounts]);

  return {
    terms, categoryCounts, brandCounts, loading, busy,
    isAdmin, shareNew, setShareNew,
    add, remove, unmute, setExcluded, refresh, impactOf,
  };
}
