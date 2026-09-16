// COG on record for the repricer.
//
// ---- WHY THIS EXISTS -------------------------------------------------------
//
// Since 2026-09-16 every repricer path resolves a unit cost in this order:
//
//   1. asin_cost_overrides, latest effective on or before today
//   2. COG on record, via the view asin_cog_for_repricer
//   3. whatever that path used before (inventory.cost, created_listings, ...)
//
// Same precedence as Inventory Valuation (2026-09-15), so the seller maintains
// ONE cost per ASIN on the COG page and the repricer, P&L and stock value all
// follow it.
//
// The view, not the table, is read on purpose. It excludes COGs flagged
// needs_review and unreviewed non-manual COGs under $2. 119 imported COGs were
// $1.00 placeholder lots; trusted, they let repricer-auto-lower-min treat
// break-even as ~$5-7 on products like B0725P2SY3 ($50.99 min) and cut its
// floor ~30% per run. The rule lives in the view (migration 20260916020000)
// so every path and the Repricer page apply exactly the same one.
//
// Both loaders paginate and chunk. PostgREST caps a response at 1,000 rows
// whatever .limit() says, and the seller has ~3,000 COGs; a silent short read
// here would quietly fall back to the old cost source for the missing ASINs.

const ASIN_CHUNK = 150;
const PAGE = 1000;

// deno-lint-ignore no-explicit-any
type Client = any;

export type RepricerCostSource = "cost_override" | "cog_on_record";

export interface RepricerCost {
  unitCost: number;
  source: RepricerCostSource;
}

const key = (userId: string, asin: string) => `${userId}::${asin}`;

async function loadPaged(
  supabase: Client,
  table: string,
  columns: string,
  userIds: string[],
  asins: string[],
  // deno-lint-ignore no-explicit-any
  extra?: (q: any) => any,
  // deno-lint-ignore no-explicit-any
): Promise<any[]> {
  const out: unknown[] = [];
  const uniqueAsins = [...new Set(asins.filter(Boolean))];
  const uniqueUsers = [...new Set(userIds.filter(Boolean))];
  if (!uniqueAsins.length || !uniqueUsers.length) return out;

  for (let i = 0; i < uniqueAsins.length; i += ASIN_CHUNK) {
    const chunk = uniqueAsins.slice(i, i + ASIN_CHUNK);
    for (let from = 0; ; from += PAGE) {
      let q = supabase
        .from(table)
        .select(columns)
        .in("user_id", uniqueUsers)
        .in("asin", chunk);
      if (extra) q = extra(q);
      const { data, error } = await q.range(from, from + PAGE - 1);
      // Throw rather than return a partial map: a short read silently hands
      // those ASINs back to the old cost source, which is the bug this
      // module exists to remove.
      if (error) throw new Error(`${table}: ${error.message}`);
      out.push(...(data ?? []));
      if (!data || data.length < PAGE) break;
    }
  }
  // deno-lint-ignore no-explicit-any
  return out as any[];
}

/**
 * Cost override + usable COG per (user, ASIN), for batch paths.
 * Key: `${user_id}::${asin}`. ASINs with neither are absent -- the caller
 * falls back to its previous source.
 */
export async function loadRepricerCostMap(
  supabase: Client,
  userIds: string[],
  asins: string[],
): Promise<Map<string, RepricerCost>> {
  const today = new Date().toISOString().slice(0, 10);
  const [overrides, cogs] = await Promise.all([
    loadPaged(
      supabase,
      "asin_cost_overrides",
      "user_id, asin, unit_cost, effective_from, created_at",
      userIds,
      asins,
      (q) => q.lte("effective_from", today).gt("unit_cost", 0),
    ),
    loadPaged(supabase, "asin_cog_for_repricer", "user_id, asin, unit_cost", userIds, asins),
  ]);

  const map = new Map<string, RepricerCost>();

  for (const c of cogs) {
    const cost = Number(c.unit_cost);
    if (Number.isFinite(cost) && cost > 0) map.set(key(c.user_id, c.asin), { unitCost: cost, source: "cog_on_record" });
  }

  // Overrides win. Same selection as resolve_cog_for_date: latest effective_from,
  // then latest created_at.
  const bestOverride = new Map<string, { eff: string; created: string; cost: number }>();
  for (const o of overrides) {
    const cost = Number(o.unit_cost);
    if (!Number.isFinite(cost) || cost <= 0) continue;
    const k = key(o.user_id, o.asin);
    const eff = String(o.effective_from ?? "");
    const created = String(o.created_at ?? "");
    const prev = bestOverride.get(k);
    if (!prev || eff > prev.eff || (eff === prev.eff && created > prev.created)) {
      bestOverride.set(k, { eff, created, cost });
    }
  }
  for (const [k, o] of bestOverride) map.set(k, { unitCost: o.cost, source: "cost_override" });

  return map;
}

/** Single-ASIN form of loadRepricerCostMap, for per-assignment paths. */
export async function loadRepricerCost(
  supabase: Client,
  userId: string,
  asin: string,
): Promise<RepricerCost | null> {
  const map = await loadRepricerCostMap(supabase, [userId], [asin]);
  return map.get(key(userId, asin)) ?? null;
}

export const repricerCostKey = key;
