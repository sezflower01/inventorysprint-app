import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { routeBatch, type RouterCase, type RoutingDecision } from "../_shared/caseRouter.ts";
import { requireInternalOrUser } from '../_shared/require-internal.ts';
import { resolveNextCompetitorPrice } from './competitorPrice.ts';

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// Phase 2: Flash/Pro routing for the cron-driven auto-review path.
const FLASH_MODEL = "gemini-flash-latest";
const PRO_MODEL   = "gemini-pro-latest";
const PROMPT_VERSION_AUTO = "v2.1-routed-auto";

const TOOL_SCHEMA = {
  type: "function" as const,
  function: {
    name: "analyze_cases",
    description: "Return analysis for each ASIN case",
    parameters: {
      type: "object",
      properties: {
        analyses: {
          type: "array",
          items: {
            type: "object",
            properties: {
              asin: { type: "string" },
              judgment: { type: "string", enum: ["optimal", "contextual_correct", "needs_review"] },
              reasoning: { type: "string" },
              suggestion: { type: "string" },
              confidence: { type: "string", enum: ["high", "medium", "low"] },
            },
            required: ["asin", "judgment", "reasoning", "suggestion", "confidence"],
            additionalProperties: false,
          },
        },
      },
      required: ["analyses"],
      additionalProperties: false,
    },
  },
};

function buildSummaries(cases: any[]): string {
  return cases.map((c, i) =>
    `Case ${i + 1}: ASIN ${c.asin} (${c.marketplace})
- Event: ${c.event_type} | Decision: ${c.decision_label}
- My Price: $${c.current_price?.toFixed(2) ?? "?"} | BB: $${c.buy_box_price?.toFixed(2) ?? "?"} | Lowest FBA: $${c.lowest_fba_price?.toFixed(2) ?? "?"}
- Next Competitor: $${c.next_competitor_price?.toFixed(2) ?? "?"} | Min: $${c.min_price?.toFixed(2) ?? "?"} | Max: $${c.max_price?.toFixed(2) ?? "?"}
- Floor: $${c.profit_floor?.toFixed(2) ?? "?"} | BB Owner: ${c.was_bb_owner ? "Yes" : "No"}
- Engine Mode: ${c.engine_mode ?? "?"} | Price Changed: ${c.was_price_changed ? "Yes" : "No"}
- Constraints: ${JSON.stringify(c.constraints_json ?? [])}
- Signal: ${c.tuning_signal ?? "none"}`
  ).join("\n\n");
}

const SYSTEM_PROMPT = `You are an expert Amazon repricing analyst. Analyze repricer decisions.
For each ASIN case, provide:
1. judgment: "optimal", "contextual_correct", or "needs_review"
2. reasoning: 1-2 sentence explanation
3. suggestion: What to adjust if needs_review, else "No change needed."
4. confidence: "high", "medium", or "low"

Rules:
- Holding when already lowest FBA is ALWAYS correct (self-undercut prevention)
- Holding when BB winner is FBM/filtered is correct
- Raising near next competitor ceiling is optimal
- Not chasing BB below profit floor is correct
- No competitor data means monitoring-only hold is correct
- Price oscillation guards are protective and correct
- If constraints include "min_floor" or "min_price", or the reason text says something like "blocked by user min floor", the engine wanted to move lower/more-competitive but correctly refused to cross the seller's own configured min price. This is working as designed, not a defect — judge it "optimal" or "contextual_correct". If you suggest anything, frame it as the seller possibly wanting to reconsider their min price on that ASIN, never as the engine needing to "chase" or "be more aggressive" past a floor the seller set.
- Raising to a price a few percent above the live Buy Box price (while still owning it) is intentional, capped profit-taking, not a bug — even if the Buy Box is lost afterward. Only flag as needs_review if the overshoot is clearly disproportionate (far beyond a small, reasonable margin) or this pattern repeats for the same ASIN without any profit benefit.

Respond with JSON array via the tool call.`;

async function callTier(
  model: string,
  cases: any[],
  apiKey: string,
): Promise<any[]> {
  if (cases.length === 0) return [];
  const summaries = buildSummaries(cases);
  const resp = await fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Analyze these ${cases.length} repricer decisions:\n\n${summaries}\n\nRespond via the tool call.` },
      ],
      tools: [TOOL_SCHEMA],
      tool_choice: { type: "function", function: { name: "analyze_cases" } },
    }),
  });
  if (!resp.ok) {
    console.error(`[auto-review] AI error tier=${model} status=${resp.status}`);
    return [];
  }
  const data = await resp.json();
  const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
  if (toolCall?.function?.arguments) {
    try {
      const parsed = JSON.parse(toolCall.function.arguments);
      return parsed.analyses || [];
    } catch { return []; }
  }
  return [];
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const __forbidden = await requireInternalOrUser(req);
  if (__forbidden) return __forbidden;
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const geminiApiKey = Deno.env.get("GEMINI_API_KEY");
    if (!geminiApiKey) throw new Error("GEMINI_API_KEY not configured");

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Optional targeted-review payload from the UI's "Run AI Review Now" button.
    // When `target_asins` is provided, we scope this run to a single user and
    // build cases directly from their most recent `repricer_ai_decisions` rows
    // for those ASINs — the same data source the AI Insights feed renders from.
    // This guarantees the Gemini badges appear on the cards the user is
    // currently looking at instead of on a sampled background pool.
    let body: { user_id?: string; target_asins?: string[]; marketplace?: string } = {};
    if (req.method === "POST") {
      try { body = await req.json(); } catch { /* allow empty body */ }
    }
    const targetAsins: string[] = Array.isArray(body.target_asins)
      ? body.target_asins.filter((a) => typeof a === "string" && a.length > 0).slice(0, 25)
      : [];
    const targetUserId: string | null = typeof body.user_id === "string" ? body.user_id : null;
    const targetedRun = targetAsins.length > 0 && !!targetUserId;

    // Choose the user pool. Targeted run = single user. Cron run = all active.
    let activeUsers: Array<{ user_id: string }> = [];
    if (targetedRun) {
      activeUsers = [{ user_id: targetUserId! }];
    } else {
      const { data } = await supabase
        .from("repricer_settings")
        .select("user_id")
        .eq("scheduler_enabled", true);
      activeUsers = data ?? [];
    }

    if (!activeUsers || activeUsers.length === 0) {
      return new Response(JSON.stringify({ message: "No active users", batches: 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let totalBatches = 0;

    for (const { user_id } of activeUsers) {
      try {
        // 1. Fetch the candidate decision pool for this user.
        // Cron path: recent price actions from the last 24h (existing behavior).
        // Targeted path: most recent repricer_ai_decisions rows for the
        // user-supplied ASIN list, mapped into the same shape the cron path
        // expects so the rest of the pipeline is unchanged.
        let actions: any[] = [];
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

        if (targetedRun) {
          const { data: decisions } = await supabase
            .from("repricer_ai_decisions")
            .select("*")
            .eq("user_id", user_id)
            .in("asin", targetAsins)
            .order("created_at", { ascending: false })
            .limit(targetAsins.length * 3);

          // Keep only the newest decision per ASIN, then convert to the shape
          // used downstream (mirrors `repricer_price_actions` columns the
          // categorizer reads: asin, marketplace, new_price, old_price,
          // intelligence_factors, action_type, success, intended_price, sku).
          const seenAsin = new Set<string>();
          for (const d of decisions || []) {
            if (seenAsin.has(d.asin)) continue;
            seenAsin.add(d.asin);
            const wasChanged = d.new_price != null && d.price_delta != null && Math.abs(d.price_delta) > 0.001;
            const intelligence: Record<string, any> = {
              eval_mode: d.mode,
              guards_applied: [
                ...(d.cooldown_applied ? ["cooldown"] : []),
                ...(d.max_step_applied ? ["max_step"] : []),
                ...(d.min_price_clamped ? ["min_floor"] : []),
              ],
              position_proof: {
                buy_box_owner_is_me:
                  d.buybox_price != null && d.current_price != null
                    ? Math.abs(d.buybox_price - d.current_price) < 0.02
                    : false,
                // Was `d.lowest_overall_price ?? null`. That field includes
                // OUR OWN offer, so whenever we held the lowest price this
                // handed the model our own price labelled "Next Competitor".
                // See competitorPrice.ts for the full reasoning and tests.
                next_competitor_price: resolveNextCompetitorPrice(
                  d.current_price,
                  d.lowest_overall_price,
                ),
              },
              price_trace: {
                buybox_price: d.buybox_price,
                lowest_fba: d.lowest_fba_price,
                profit_guard: { floor: d.min_price_used },
              },
            };
            actions.push({
              asin: d.asin,
              marketplace: d.marketplace,
              new_price: d.new_price ?? d.current_price,
              old_price: d.current_price,
              intended_price: d.new_price,
              action_type: wasChanged ? "price_changed" : "no_change",
              success: true,
              error_message: null,
              sku: d.sku,
              intelligence_factors: intelligence,
              old_min_price: d.min_price_used,
              old_max_price: d.max_price_used,
              created_at: d.created_at,
            });
          }
        } else {
          const { data } = await supabase
            .from("repricer_price_actions")
            .select("*")
            .eq("user_id", user_id)
            .gte("created_at", since)
            .order("created_at", { ascending: false })
            .limit(500);
          actions = data ?? [];

          // `repricer_price_actions.old_min_price/old_max_price` are almost
          // always null in practice, which used to make the case-builder below
          // fall back to the single US-scoped `inventory.min_price/max_price`
          // row for EVERY marketplace — silently comparing e.g. an MXN price
          // against a USD max price (an ~18-20x mismatch) and generating false
          // "price is 18x over max" alarms for Gemini on every non-US action.
          // repricer_ai_decisions.min_price_used/max_price_used already store
          // the correct per-(asin, marketplace) bound at decision time, so
          // backfill from there instead of ever crossing marketplaces.
          if (actions.length > 0) {
            const pairs = Array.from(new Set(actions.map((a: any) => `${a.asin}::${a.marketplace}`)));
            const asinsForBackfill = Array.from(new Set(actions.map((a: any) => a.asin)));
            const { data: recentDecisions } = await supabase
              .from("repricer_ai_decisions")
              .select("asin, marketplace, min_price_used, max_price_used, created_at")
              .eq("user_id", user_id)
              .in("asin", asinsForBackfill)
              .order("created_at", { ascending: false })
              .limit(2000);

            const boundsByPair = new Map<string, { min: number | null; max: number | null }>();
            for (const d of recentDecisions ?? []) {
              const key = `${d.asin}::${d.marketplace}`;
              if (!pairs.includes(key) || boundsByPair.has(key)) continue;
              boundsByPair.set(key, { min: d.min_price_used, max: d.max_price_used });
            }

            actions = actions.map((a: any) => {
              if (a.old_min_price != null && a.old_max_price != null) return a;
              const bounds = boundsByPair.get(`${a.asin}::${a.marketplace}`);
              return {
                ...a,
                old_min_price: a.old_min_price ?? bounds?.min ?? null,
                old_max_price: a.old_max_price ?? bounds?.max ?? null,
              };
            });
          }
        }

        if (!actions || actions.length === 0) continue;

        // 2. Categorize ASINs
        const bbLoss: any[] = [];
        const raised: any[] = [];
        const constrained: any[] = [];
        const floorHit: any[] = [];
        const winners: any[] = [];

        const seen = new Set<string>();
        for (const a of actions) {
          const key = `${a.asin}-${a.marketplace}`;
          if (seen.has(key)) continue;
          seen.add(key);

          const intel = (a.intelligence_factors as Record<string, any>) || {};
          const guards = intel?.guards_applied || [];
          const posProof = intel?.position_proof || {};
          const delta = (a.new_price ?? 0) - (a.old_price ?? 0);

          if (a.success === false || a.error_message) {
            constrained.push(a);
          } else if (guards.includes("min_floor") || guards.includes("floor_clamp") || guards.includes("profit_guard_block")) {
            floorHit.push(a);
          } else if (posProof.buy_box_owner_is_me === false && delta < -0.005) {
            bbLoss.push(a);
          } else if (delta > 0.005) {
            raised.push(a);
          } else if (posProof.buy_box_owner_is_me === true && delta >= -0.005) {
            winners.push(a);
          } else {
            constrained.push(a);
          }
        }

        // 3. Pick by significance + diversity
        const pickMostSignificant = (arr: any[]) => {
          if (arr.length === 0) return null;
          return [...arr].sort((a, b) => {
            const dA = Math.abs((a.new_price ?? 0) - (a.old_price ?? 0));
            const dB = Math.abs((b.new_price ?? 0) - (b.old_price ?? 0));
            return dB - dA;
          })[0];
        };

        const pickSecond = (arr: any[], exclude: Set<string>) => {
          const filtered = arr.filter(a => !exclude.has(`${a.asin}-${a.marketplace}`));
          if (filtered.length === 0) return null;
          return [...filtered].sort((a, b) => {
            const dA = Math.abs((a.new_price ?? 0) - (a.old_price ?? 0));
            const dB = Math.abs((b.new_price ?? 0) - (b.old_price ?? 0));
            return dB - dA;
          })[0];
        };

        const selected: any[] = [];
        const usedKeys = new Set<string>();
        const pools = [
          { cat: "bb_loss", arr: bbLoss },
          { cat: "raised", arr: raised },
          { cat: "constrained", arr: constrained },
          { cat: "floor_hit", arr: floorHit },
          { cat: "winner", arr: winners },
        ];

        if (targetedRun) {
          // Targeted UI button: review every ASIN the user is currently looking
          // at. We still tag each one with its detected category so the
          // downstream router/prompt context stays meaningful, but we do NOT
          // sub-sample — that's the whole point of this code path.
          for (const p of pools) {
            for (const item of p.arr) {
              const key = `${item.asin}-${item.marketplace}`;
              if (usedKeys.has(key)) continue;
              selected.push({ ...item, _cat: p.cat });
              usedKeys.add(key);
            }
          }
        } else {
          for (const p of pools) {
            const item = pickMostSignificant(p.arr);
            if (item) {
              const key = `${item.asin}-${item.marketplace}`;
              if (!usedKeys.has(key)) {
                selected.push({ ...item, _cat: p.cat });
                usedKeys.add(key);
              }
            }
          }

          if (selected.length < 5) {
            for (const p of pools) {
              if (selected.length >= 5) break;
              const item = pickSecond(p.arr, usedKeys);
              if (item) {
                selected.push({ ...item, _cat: p.cat });
                usedKeys.add(`${item.asin}-${item.marketplace}`);
              }
            }
          }
        }

        if (selected.length === 0) continue;

        // 4. Enrich from inventory
        const asinKeys = selected.map(s => s.asin);
        const { data: invData } = await supabase
          .from("inventory")
          .select("asin, my_price, min_price, max_price, sku")
          .eq("user_id", user_id)
          .in("asin", asinKeys);

        // 5. Build cases for AI
        const cases = selected.map(s => {
          // `inventory` has no marketplace column — it's a single US-scoped
          // row per ASIN. Only use it as a bounds/price fallback for the US
          // marketplace itself; for any other marketplace an empty bound is
          // safer than silently comparing against the wrong currency.
          const isUsMarketplace = (s.marketplace || "US") === "US";
          const inv = (isUsMarketplace ? invData?.find(i => i.asin === s.asin) : null) || {} as any;
          const intel = (s.intelligence_factors as Record<string, any>) || {};
          const trace = intel?.price_trace || {};
          const posProof = intel?.position_proof || {};
          const profitGuard = intel?.profit_guard || {};
          const guards = intel?.guards_applied || [];
          const delta = (s.new_price ?? 0) - (s.old_price ?? 0);

          // Simplified judgment logic (server-side)
          let judgmentReason = "Analyzed by automated batch";
          const tuningSignal = s._cat === "bb_loss" ? "BB loss detected" 
            : s._cat === "raised" ? "Price raised" 
            : s._cat === "floor_hit" ? "Floor protection active"
            : s._cat === "winner" ? "BB winner stable"
            : "Constrained hold";

          return {
            asin: s.asin,
            sku: s.sku || inv.sku,
            marketplace: s.marketplace || "US",
            event_type: s._cat,
            action_type: s.action_type,
            decision_label: judgmentReason,
            tuning_signal: tuningSignal,
            current_price: s.new_price ?? s.old_price ?? inv.my_price,
            target_price: s.intended_price,
            buy_box_price: trace.buybox_price,
            lowest_fba_price: trace.lowest_fba,
            next_competitor_price: posProof.next_competitor_price,
            min_price: s.old_min_price ?? inv.min_price,
            max_price: s.old_max_price ?? inv.max_price,
            profit_floor: trace.profit_guard?.floor,
            constraints_json: guards,
            engine_mode: intel?.eval_mode || s.action_type,
            was_price_changed: Math.abs(delta) > 0.005,
            was_bb_owner: posProof.buy_box_owner_is_me ?? false,
          };
        });

        // 6. PHASE 2: route each case to flash / pro / skip
        const routerCases: RouterCase[] = cases.map((c) => ({
          asin: c.asin,
          marketplace: c.marketplace,
          current_price: c.current_price,
          profit_floor: c.profit_floor,
          was_bb_owner: c.was_bb_owner,
          was_price_changed: c.was_price_changed,
          decision_label: c.decision_label,
          tuning_signal: c.tuning_signal,
        }));

        const { decisions, summary: routeSummary } = await routeBatch(supabase, user_id, routerCases);
        const decisionByAsin = new Map<string, RoutingDecision>(decisions.map((d) => [d.asin, d]));

        const proCases   = cases.filter((c) => decisionByAsin.get(c.asin)?.tier === "pro");
        const flashCases = cases.filter((c) => decisionByAsin.get(c.asin)?.tier === "flash");
        const skipCases  = cases.filter((c) => decisionByAsin.get(c.asin)?.tier === "skip");

        console.log(`[auto-review] user=${user_id} pro=${proCases.length} flash=${flashCases.length} skip=${skipCases.length} cap_used=${routeSummary.cap_used}/${routeSummary.cap}`);

        // 6b. Call both LLM tiers in parallel
        const [proAnalyses, flashAnalyses] = await Promise.all([
          callTier(PRO_MODEL,   proCases,   geminiApiKey),
          callTier(FLASH_MODEL, flashCases, geminiApiKey),
        ]);

        const analyses: any[] = [
          ...proAnalyses.map((a) => ({ ...a, _tier: "pro" })),
          ...flashAnalyses.map((a) => ({ ...a, _tier: "flash" })),
          ...skipCases.map((c) => ({
            asin: c.asin,
            judgment: "optimal",
            reasoning: "Confirmed-correct hold (BB owner, no price change, no new tuning signal). No LLM call required.",
            suggestion: "No change needed.",
            confidence: "high",
            _tier: "skip",
          })),
        ];

        // 7. Persist automated batch
        const optimalCount = analyses.filter(a => a.judgment === "optimal" || a.judgment === "contextual_correct").length;
        const reviewCount = analyses.filter(a => a.judgment === "needs_review").length;
        const topSignal = cases[0]?.tuning_signal || null;

        const { data: batchRow } = await supabase
          .from("smart_engine_review_batches")
          .insert({
            user_id,
            asin_count: selected.length,
            optimal_count: optimalCount,
            review_needed_count: reviewCount,
            top_signal: topSignal,
            trigger_type: "automated",
          })
          .select("id")
          .single();

        if (batchRow?.id) {
          // Save review items
          const itemRows = cases.map(c => {
            const ai = analyses.find(a => a.asin === c.asin) || {};
            return {
              batch_id: batchRow.id,
              user_id,
              asin: c.asin,
              sku: c.sku,
              marketplace: c.marketplace,
              decision_type: c.event_type,
              judgment: ai.judgment || "optimal",
              judgment_reason: ai.reasoning || c.decision_label,
              tuning_signals: [c.tuning_signal],
              current_price: c.current_price,
              buy_box_price: c.buy_box_price,
              lowest_fba_price: c.lowest_fba_price,
              next_competitor_price: c.next_competitor_price,
              min_price: c.min_price,
              max_price: c.max_price,
              bb_owner: c.was_bb_owner,
            };
          });
          await supabase.from("smart_engine_review_items").insert(itemRows);

          // Save AI review batch (Phase 2 — with tier rollup)
          const { data: aiBatchRow } = await supabase
            .from("smart_engine_ai_review_batches")
            .insert({
              user_id,
              selected_case_count: cases.length,
              selection_strategy: targetedRun ? "phase2_router_targeted_ui" : "phase2_router_auto",
              ai_model: `${PRO_MODEL}+${FLASH_MODEL}`,
              ai_summary: `${routeSummary.pro} pro · ${routeSummary.flash} flash · ${routeSummary.skip} skip — ${reviewCount} need review`,
              recommendation_count: reviewCount,
              prompt_version: PROMPT_VERSION_AUTO,
              total_signals_seen: cases.length,
              pro_count: routeSummary.pro,
              flash_count: routeSummary.flash,
              skip_count: routeSummary.skip,
            })
            .select("id")
            .single();

          // Save individual AI reviews with tier + escalation reasons
          if (aiBatchRow?.id) {
            const reviewRows = cases.map(c => {
              const ai = analyses.find(a => a.asin === c.asin) || {};
              const dec = decisionByAsin.get(c.asin);
              const modelUsed =
                dec?.tier === "pro"   ? PRO_MODEL
                : dec?.tier === "flash" ? FLASH_MODEL
                : "rule_based_skip";
              return {
                batch_id: aiBatchRow.id,
                user_id,
                asin: c.asin,
                sku: c.sku,
                marketplace: c.marketplace,
                event_type: c.event_type,
                decision_label: c.decision_label,
                pricing_context: {
                  current_price: c.current_price,
                  buy_box_price: c.buy_box_price,
                  lowest_fba_price: c.lowest_fba_price,
                  next_competitor_price: c.next_competitor_price,
                  min_price: c.min_price,
                  max_price: c.max_price,
                  profit_floor: c.profit_floor,
                  engine_mode: c.engine_mode,
                  was_price_changed: c.was_price_changed,
                  was_bb_owner: c.was_bb_owner,
                },
                constraints_json: c.constraints_json,
                ai_judgment: ai.judgment || null,
                ai_reasoning_summary: ai.reasoning || null,
                ai_tuning_suggestion: ai.suggestion || null,
                ai_confidence: ai.confidence || "medium",
                accepted_status: "pending",
                prompt_version: PROMPT_VERSION_AUTO,
                model_used: modelUsed,
                model_tier: dec?.tier ?? "flash",
                escalation_reasons: dec?.reasons ?? [],
                selection_reason: dec?.cap_exhausted
                  ? "downgraded_pro_to_flash_cap_exhausted"
                  : (dec?.reasons?.[0] ?? null),
              };
            });
            await supabase.from("smart_engine_ai_reviews").insert(reviewRows);
          }

          // Write activity events with deduplication
          const dedupeWindow = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
          const asinList = cases.map(c => c.asin);
          const { data: recentEvents } = await supabase
            .from("smart_engine_activity_events")
            .select("asin, tuning_signal")
            .eq("user_id", user_id)
            .in("asin", asinList)
            .gte("created_at", dedupeWindow);

          const recentKeys = new Set(
            (recentEvents || []).map(e => `${e.asin}::${e.tuning_signal}`)
          );
          const activityRows = cases
            .filter(c => !recentKeys.has(`${c.asin}::${c.tuning_signal}`))
            .map(c => ({
              user_id,
              asin: c.asin,
              sku: c.sku,
              marketplace: c.marketplace,
              event_type: c.event_type,
              action_type: c.action_type,
              decision_label: c.decision_label,
              tuning_signal: c.tuning_signal,
              current_price: c.current_price,
              target_price: c.target_price,
              buy_box_price: c.buy_box_price,
              lowest_fba_price: c.lowest_fba_price,
              next_competitor_price: c.next_competitor_price,
              min_price: c.min_price,
              max_price: c.max_price,
              profit_floor: c.profit_floor,
              constraints_json: c.constraints_json,
              engine_mode: c.engine_mode,
              was_price_changed: c.was_price_changed,
              was_bb_owner: c.was_bb_owner,
              snapshot_json: {},
            }));
          if (activityRows.length > 0) {
            await supabase.from("smart_engine_activity_events").insert(activityRows);
          }
        }

        totalBatches++;
        console.log(`Auto-review completed for user ${user_id}: ${selected.length} ASINs, ${analyses.length} AI analyses`);
      } catch (userErr) {
        console.error(`Auto-review failed for user ${user_id}:`, userErr);
      }
    }

    return new Response(JSON.stringify({
      message: `Auto-review completed`,
      users: activeUsers.length,
      batches: totalBatches,
      targeted: targetedRun,
      target_asin_count: targetAsins.length,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("smart-engine-auto-review error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? (e as Error).message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
