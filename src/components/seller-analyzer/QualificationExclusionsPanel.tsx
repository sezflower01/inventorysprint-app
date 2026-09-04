import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Loader2, Plus, X } from "lucide-react";
import { CATEGORY_MAP, MAPPED_VALUES } from "@/lib/amazon-display-groups";
import { supabase } from "@/integrations/supabase/client";
import {
  useQualificationExclusions,
  normalizeForKind,
  type ExclusionKind,
  type PreviewEntry,
  type ExcludedTerm,
} from "@/hooks/use-qualification-exclusions";
import { useToast } from "@/hooks/use-toast";

/**
 * One switch per Amazon department. ON = search it, OFF = never search it.
 *
 * A label covers SEVERAL real API values, so the switch moves all of them
 * together. "Partly off" is possible only if something edited the underlying
 * values individually; it is shown rather than hidden, and flipping the switch
 * resolves it.
 */
function CategoryToggles({
  terms,
  counts,
  busy,
  setExcluded,
}: {
  terms: ExcludedTerm[];
  counts: PreviewEntry[];
  busy: boolean;
  setExcluded: (kind: ExclusionKind, values: string[], excluded: boolean) => Promise<void>;
}) {
  const { toast } = useToast();
  // Muted shared terms are excluded from this set deliberately: the user
  // opted out of them, so the toggle must read as OFF.
  const excludedValues = new Set(
    terms.filter((t) => t.kind === "category" && !t.muted).map((t) => t.value),
  );
  const countByValue = new Map(counts.map((c) => [c.value, c.n]));

  const guard = (p: Promise<unknown>) =>
    p.catch((e) => toast({ title: "Could not save", description: (e as Error).message, variant: "destructive" }));

  // Real values in the listings that no mapped label reaches. Without these the
  // category would be unreachable from this card entirely.
  const unmapped = counts.filter((c) => !MAPPED_VALUES.has(c.value));

  const rows: Array<{ label: string; values: string[]; observed?: boolean }> = [
    ...CATEGORY_MAP,
    ...unmapped.map((c) => ({ label: c.label, values: [c.value], observed: true })),
  ];

  return (
    <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
      {rows.map((cat) => {
        const offCount = cat.values.filter((v) => excludedValues.has(v)).length;
        const searched = offCount === 0;
        const partial = offCount > 0 && offCount < cat.values.length;
        const n = cat.values.reduce((sum, v) => sum + (countByValue.get(v) ?? 0), 0);

        return (
          <label
            key={cat.label}
            className="flex items-center justify-between gap-3 py-1.5 cursor-pointer select-none"
          >
            <span className="min-w-0 flex-1">
              <span className={`text-sm ${searched ? "" : "text-muted-foreground line-through"}`}>
                {cat.label}
              </span>
              {/* The count is the whole point: a mapping that reaches nothing
                  says so instead of looking like a working switch. */}
              <span className="ml-2 text-xs text-muted-foreground">
                {n > 0 ? `${n.toLocaleString()} listing${n === 1 ? "" : "s"}` : "none yet"}
              </span>
              {partial && <span className="ml-2 text-xs text-amber-600">partly off</span>}
            </span>
            <Switch
              checked={searched}
              disabled={busy}
              onCheckedChange={(on) => guard(setExcluded("category", cat.values, !on))}
              aria-label={`Search ${cat.label}`}
            />
          </label>
        );
      })}
    </div>
  );
}

// State is passed down rather than each list calling the hook itself: two
// independent hook instances would each hold their own copy of the terms and
// counts, so adding a brand would leave the category list showing stale
// numbers until a reload.
function ExclusionList({
  kind,
  title,
  blurb,
  placeholder,
  suggestions,
  terms,
  busy,
  add,
  remove,
  impactOf,
}: {
  kind: ExclusionKind;
  title: string;
  blurb: string;
  placeholder: string;
  suggestions: PreviewEntry[];
  terms: ExcludedTerm[];
  busy: boolean;
  add: (kind: ExclusionKind, raw: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  impactOf: (kind: ExclusionKind, value: string) => number | null;
}) {
  const [draft, setDraft] = useState("");
  const { toast } = useToast();

  // `mine` keeps muted rows so they can be shown and restored; `excluded` is
  // what is actually IN EFFECT, which is what the shortlist below reasons
  // about.
  const mine = terms.filter((t) => t.kind === kind);
  const active = mine.filter((t) => !t.muted);
  const excluded = new Set(active.map((t) => t.value));
  // Values present in the listings that are NOT yet excluded — the honest
  // shortlist, since a rule for something you have none of does nothing.
  const available = suggestions.filter((s) => !excluded.has(s.value)).slice(0, 12);
  const draftImpact = draft.trim() ? impactOf(kind, normalizeForKind(kind, draft)) : null;
  // Categories and brands can be counted before saving; a title keyword cannot
  // (see impactOf). Showing "would affect nothing" for one of those would be a
  // plain lie, so the preview line is skipped rather than faked.
  const hasImpactPreview = kind !== "title_keyword";

  const guard = (p: Promise<unknown>) =>
    p.catch((e) => toast({ title: "Could not save", description: (e as Error).message, variant: "destructive" }));

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        <span className="text-xs text-muted-foreground">
          {active.length} excluded
          {mine.length > active.length && ` · ${mine.length - active.length} hidden`}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">{blurb}</p>

      {mine.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {mine.map((t) => {
            const n = impactOf(kind, t.value);
            return (
              <Badge key={t.id} variant="secondary" className="gap-1 pr-1 font-normal">
                {t.label || t.value}
                {/* What this rule is holding back right now. Absent when the
                    value does not appear in the user's listings at all. */}
                {n !== null && <span className="text-muted-foreground">· {n}</span>}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => guard(remove(t.id))}
                  className="rounded-sm hover:text-destructive disabled:opacity-50"
                  aria-label={`Stop excluding ${t.label || t.value}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            );
          })}
        </div>
      )}

      {available.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">In your listings — click to exclude:</p>
          <div className="flex flex-wrap gap-1.5">
            {available.map((s) => (
              <button
                key={s.value}
                type="button"
                disabled={busy}
                onClick={() => guard(add(kind, s.label))}
                className="rounded-full border border-dashed px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50"
              >
                {s.label} · {s.n}
              </button>
            ))}
          </div>
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!draft.trim()) return;
          guard(add(kind, draft).then(() => setDraft("")));
        }}
        className="flex gap-2"
      >
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder}
          className="h-9 text-sm"
          disabled={busy}
        />
        <Button type="submit" size="sm" variant="secondary" disabled={busy || !draft.trim()}>
          <Plus className="h-3.5 w-3.5 mr-1" /> Exclude
        </Button>
      </form>

      {/* Impact BEFORE saving, which is the whole point of the preview. */}
      {hasImpactPreview && draft.trim() && (
        <p className="text-xs text-muted-foreground">
          {draftImpact === null
            ? `No current listings match "${draft.trim()}" — this rule would affect nothing today.`
            : `Would exclude ${draftImpact.toLocaleString()} current listing${draftImpact === 1 ? "" : "s"}.`}
        </p>
      )}
    </div>
  );
}

/**
 * Re-run the title rules over listings that were detected BEFORE they existed.
 *
 * Two steps on purpose. The first click only counts, using the same matcher the
 * write would use, so the number shown is the number that changes -- not an
 * estimate from a different rule. The second click writes. Title matching is
 * the one rule here where a term can behave unlike the user expected ("stand"
 * catching more than intended), and this is where that surfaces before it is
 * applied to years of history rather than after.
 */
function ApplyToExisting({ termCount }: { termCount: number }) {
  const { toast } = useToast();
  const [running, setRunning] = useState(false);
  const [preview, setPreview] = useState<{ matched: number; byTerm: Record<string, number> } | null>(null);
  const [done, setDone] = useState<{ n: number; mode: "mark" | "delete" } | null>(null);

  // The preview is shared by both outcomes on purpose: one count, one matcher,
  // then a choice of what to do with it. Running a separate scan for "delete"
  // would risk showing a number that no longer matches what gets removed.
  const call = async (dryRun: boolean, mode: "mark" | "delete" = "mark") => {
    setRunning(true);
    try {
      const { data, error } = await supabase.functions.invoke("apply-title-exclusions", {
        body: { dryRun, mode },
      });
      if (error) throw new Error(error.message);
      if (data?.error) throw new Error(data.error);
      if (dryRun) {
        setPreview({ matched: data?.matched ?? 0, byTerm: data?.byTerm ?? {} });
        setDone(null);
      } else {
        const n = mode === "delete" ? (data?.deleted ?? 0) : (data?.updated ?? 0);
        setDone({ n, mode });
        setPreview(null);
        toast({
          title: mode === "delete" ? "Deleted" : "Applied",
          description: `${n.toLocaleString()} listing(s) ${mode === "delete" ? "deleted" : "excluded"}.`,
        });
      }
    } catch (e) {
      toast({ title: "Could not apply", description: (e as Error).message, variant: "destructive" });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-2 rounded-md border border-dashed p-3">
      <p className="text-xs text-muted-foreground">
        New words only affect listings found after you add them. Apply them to listings you already
        have. This excludes matches; it does not bring back anything a word you removed had
        excluded earlier.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={running || termCount === 0}
          onClick={() => call(true)}
        >
          {running && !preview ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : null}
          Apply to existing listings
        </Button>
        {termCount === 0 && (
          <span className="text-xs text-muted-foreground">Add a word first.</span>
        )}
        {done !== null && (
          <span className="text-xs text-muted-foreground">
            {done.n.toLocaleString()} listing{done.n === 1 ? "" : "s"}{" "}
            {done.mode === "delete" ? "deleted." : "excluded."}
          </span>
        )}
      </div>

      {preview && (
        <div className="space-y-2">
          {preview.matched === 0 ? (
            <p className="text-xs text-muted-foreground">
              No existing listings match these words. Nothing to change.
            </p>
          ) : (
            <>
              <p className="text-xs">
                {preview.matched.toLocaleString()} existing listing
                {preview.matched === 1 ? "" : "s"} would be excluded:
              </p>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(preview.byTerm).map(([term, n]) => (
                  <Badge key={term} variant="outline" className="font-normal">
                    {term} - {n}
                  </Badge>
                ))}
              </div>
              {/*
                Two outcomes from one preview. "Exclude" keeps the row and
                records WHY it was excluded, which is what makes "why is this
                not being searched" answerable later. "Delete" removes it.

                Delete is deliberately the second, destructive-styled button
                rather than the default: detection compares each seller against
                a stored known-ASIN baseline that updates regardless, so a
                deleted listing is never seen again -- not on the next check,
                and not if the matching word is later removed.
              */}
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" disabled={running} onClick={() => call(false, "mark")}>
                  {running ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : null}
                  Exclude {preview.matched.toLocaleString()}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  disabled={running}
                  onClick={() => call(false, "delete")}
                >
                  {running ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : null}
                  Delete {preview.matched.toLocaleString()} permanently
                </Button>
                <Button type="button" size="sm" variant="ghost" disabled={running} onClick={() => setPreview(null)}>
                  Cancel
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Deleting removes these listings for good. They are not re-detected on the next
                seller check, and they do not come back if you later remove the word that matched
                them. Excluding keeps them, marked with the reason.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Category and brand rules for auto-source qualification.
 *
 * Both lists ship seeded with the values that used to be hardcoded, so
 * behaviour is unchanged until edited. Matching is exact, case-insensitive and
 * trimmed — never substring: "Publisher Unknown" is a real publisher, and a
 * contains-"unknown" rule would wrongly reject it.
 */
export default function QualificationExclusionsPanel() {
  const {
    terms, categoryCounts, brandCounts, loading, busy,
    isAdmin, shareNew, setShareNew,
    add, remove, setExcluded, impactOf,
  } = useQualificationExclusions();
  const shared = { terms, busy, add, remove, impactOf };
  const excludedCategoryValues = new Set(
    terms.filter((t) => t.kind === "category" && !t.muted).map((t) => t.value),
  );

  return (
    <Card>
      {isAdmin && (
        <div className="border-b bg-muted/30 px-6 py-2">
          <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <input
              type="checkbox"
              checked={shareNew}
              onChange={(e) => setShareNew(e.target.checked)}
              className="h-3 w-3"
            />
            Share exclusions you add here with all users. They take effect
            immediately and each user can opt out individually.
          </label>
        </div>
      )}
      <CardContent className="p-4 space-y-5">
        <div>
          <h2 className="text-sm font-semibold">Never auto-search these</h2>
          <p className="text-xs text-muted-foreground mt-1">
            Listings matching these are still detected and shown, but are marked as not worth
            sourcing. Each list matches differently — see the note under each one.
          </p>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-3">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
          </div>
        ) : (
          <>
            <div className="space-y-2">
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="text-sm font-medium">Categories</h3>
                <span className="text-xs text-muted-foreground">
                  {CATEGORY_MAP.filter((c) => c.values.some((v) => excludedCategoryValues.has(v))).length} off
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                Switch a department off to stop auto-searching it. Counts are your own listings —
                a department showing "none yet" cannot affect anything today. Amazon's categories
                are coarse and occasionally wrong (a LEGO minifigure came back as Apparel), so the
                counts are worth a glance before switching one off.
              </p>
              <CategoryToggles
                terms={terms}
                counts={categoryCounts}
                busy={busy}
                setExcluded={setExcluded}
              />
            </div>
            <div className="border-t" />
            <ExclusionList
              kind="brand"
              title="Excluded Brands"
              blurb="Matched exactly against the whole brand — “Generic” is excluded, “Generic Electric” is not. A listing with no brand at all is never excluded by these: a missing brand usually means Amazon had no data, not that the product is unbranded."
              placeholder="e.g. Generic"
              suggestions={brandCounts}
              {...shared}
            />
            <div className="border-t" />
            {/* A SEPARATE list because the matching RULE is different. Merging
                the two would force one behaviour on both, and nothing on a chip
                would tell you which rule had applied to it. */}
            <div className="space-y-3">
              <ExclusionList
                kind="title_keyword"
                title="Excluded Title Words"
                blurb="Matched as whole words anywhere in the title — “stand” excludes “…with Stand” but not “Standing Desk”. Accents are ignored, so “pokemon” catches “Pokémon”. Plurals are separate: add both “card” and “cards” if you want both. A listing with no title yet is never excluded."
                placeholder="e.g. refurbished, pre-order"
                suggestions={[]}
                {...shared}
              />
              <ApplyToExisting
                termCount={terms.filter((t) => t.kind === "title_keyword" && !t.muted).length}
              />
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
