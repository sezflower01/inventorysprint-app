// Preset behavior-lock: snapshot + uniqueness.
//
// Real incident this guards against: _presets.ts held stale values (old
// undercut_amount, monopoly settings, stock_overlay_enabled) that had
// already been fixed in index.ts's inline copy but never propagated back
// here, because index.ts never imported this file and no test ever ran it.
// index.ts now imports PROFILE_PRESETS/PROFILE_KEY_TO_LABEL/
// USER_CONTROLLED_FIELDS from here directly — there is exactly one copy,
// so this test locks its exact values and proves the 3 presets stay
// semantically distinct from each other.
//
// Run: deno test --allow-net --allow-env --allow-read \
//   supabase/functions/_tests/repricer-ai-evaluate/presets_snapshot_test.ts

import { assertEquals, assertNotEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  PROFILE_KEY_TO_LABEL,
  PROFILE_PRESETS,
  USER_CONTROLLED_FIELDS,
} from '../../repricer-ai-evaluate/_presets.ts';

// SMART_MATCH (2026-08-11, 1866687) and MOMENTUM_SMART (2026-08-13,
// f1cc8ca / a10fb14) were added to _presets.ts without being added here, so
// this suite failed on every push touching repricer-ai-evaluate from
// 2026-08-11 on -- and the preset most assignments actually run on
// (MOMENTUM_SMART: 863 of 929 enabled assignments, measured 2026-09-16) was
// never under the behavior lock at all. Both are locked below at the values
// shipped in those commits.
const PROFILE_KEYS = [
  'VELOCITY_DOMINATOR', 'MOMENTUM_BUILDER', 'PROFIT_EXTRACTOR',
  'MATCH_BUYBOX', 'MATCH_LOWEST', 'SMART_MATCH', 'MOMENTUM_SMART',
] as const;

// Presets whose whole purpose is opportunistic profit-taking (raise beyond
// the anchor, proactive monopoly pricing). MATCH_BUYBOX/MATCH_LOWEST/
// SMART_MATCH are intentionally excluded — they exist to track an anchor and
// stop, nothing more, so both flags are deliberately false.
const RAISE_AND_MONOPOLY_PROFILES = ['VELOCITY_DOMINATOR', 'MOMENTUM_BUILDER', 'PROFIT_EXTRACTOR', 'MOMENTUM_SMART'] as const;

// "Match, never chase" presets: no undercut, no smart-raise, no monopoly.
const MATCH_ONLY_PROFILES = ['MATCH_BUYBOX', 'MATCH_LOWEST', 'SMART_MATCH'] as const;

Deno.test('exactly 7 presets exist, matching the 7 UI-facing profile keys', () => {
  assertEquals(Object.keys(PROFILE_PRESETS).sort(), [...PROFILE_KEYS].sort());
  assertEquals(Object.keys(PROFILE_KEY_TO_LABEL).sort(), [...PROFILE_KEYS].sort());
});

Deno.test('snapshot: VELOCITY_DOMINATOR (Aggressive Capture)', () => {
  assertEquals(PROFILE_PRESETS.VELOCITY_DOMINATOR, {
    undercut_amount: 0.02,
    enable_smart_raise: true,
    enable_monopoly_mode: true,
    monopoly_mode_type: 'conservative',
    monopoly_cooldown_minutes: 60,
    use_ai_tuning: true,
    cooldown_minutes: 5,
    skip_lower_when_bb_owner: true,
    stock_overlay_enabled: true,
    only_raise_when_buybox_owner: true,
    ignore_fbm_unless_buybox_owner: true,
    raise_trigger_percent: 3,
    max_raise_step_dollars: 0.30,
    max_raise_step_percent: 2,
  });
});

Deno.test('snapshot: MOMENTUM_BUILDER', () => {
  assertEquals(PROFILE_PRESETS.MOMENTUM_BUILDER, {
    undercut_amount: 0.00,
    enable_smart_raise: true,
    raise_trigger_percent: 1.5,
    max_raise_step_dollars: 1.00,
    max_raise_step_percent: 5,
    enable_monopoly_mode: true,
    monopoly_mode_type: 'conservative',
    monopoly_cooldown_minutes: 60,
    use_ai_tuning: true,
    cooldown_minutes: 15,
    skip_lower_when_bb_owner: true,
    stock_overlay_enabled: true,
    only_raise_when_buybox_owner: true,
    ignore_fbm_unless_buybox_owner: true,
  });
});

Deno.test('snapshot: PROFIT_EXTRACTOR', () => {
  assertEquals(PROFILE_PRESETS.PROFIT_EXTRACTOR, {
    undercut_amount: 0,
    enable_smart_raise: true,
    raise_trigger_percent: 1,
    max_raise_step_dollars: 1.50,
    max_raise_step_percent: 6,
    enable_monopoly_mode: true,
    monopoly_mode_type: 'aggressive',
    monopoly_cooldown_minutes: 45,
    use_ai_tuning: true,
    cooldown_minutes: 20,
    skip_lower_when_bb_owner: true,
    stock_overlay_enabled: true,
    only_raise_when_buybox_owner: true,
    ignore_fbm_unless_buybox_owner: true,
  });
});

Deno.test('snapshot: MATCH_BUYBOX', () => {
  assertEquals(PROFILE_PRESETS.MATCH_BUYBOX, {
    undercut_amount: 0,
    enable_smart_raise: false,
    enable_monopoly_mode: false,
    use_ai_tuning: true,
    cooldown_minutes: 10,
    skip_lower_when_bb_owner: true,
    stock_overlay_enabled: true,
    only_raise_when_buybox_owner: true,
  });
});

Deno.test('snapshot: MATCH_LOWEST', () => {
  assertEquals(PROFILE_PRESETS.MATCH_LOWEST, {
    undercut_amount: 0,
    enable_smart_raise: false,
    enable_monopoly_mode: false,
    use_ai_tuning: true,
    cooldown_minutes: 10,
    skip_lower_when_bb_owner: true,
    stock_overlay_enabled: true,
    only_raise_when_buybox_owner: true,
  });
});

Deno.test('snapshot: SMART_MATCH', () => {
  assertEquals(PROFILE_PRESETS.SMART_MATCH, {
    undercut_amount: 0,
    enable_smart_raise: false,
    enable_monopoly_mode: false,
    use_ai_tuning: true,
    cooldown_minutes: 10,
    skip_lower_when_bb_owner: true,
    stock_overlay_enabled: true,
    only_raise_when_buybox_owner: true,
  });
});

Deno.test('snapshot: MOMENTUM_SMART (V2)', () => {
  assertEquals(PROFILE_PRESETS.MOMENTUM_SMART, {
    undercut_amount: 0.00,
    enable_smart_raise: true,
    require_market_supported_raise: true,
    min_floor_support_ratio: 0.5,
    post_raise_cooldown_hours: 2,
    raise_trigger_percent: 1.5,
    max_raise_step_dollars: 0.75,
    max_raise_step_percent: 4,
    enable_monopoly_mode: true,
    monopoly_mode_type: 'conservative',
    monopoly_cooldown_minutes: 60,
    use_ai_tuning: true,
    cooldown_minutes: 10,
    cooldown_minutes_losing_bb: 8,
    cooldown_minutes_winning_bb: 20,
    skip_lower_when_bb_owner: true,
    stock_overlay_enabled: true,
    only_raise_when_buybox_owner: true,
    ignore_fbm_unless_buybox_owner: true,
  });
});

// The asymmetry is MOMENTUM_SMART's reason to exist (see _presets.ts): react
// faster when losing the Buy Box than when holding it, with the stable-tier
// baseline in between. A single interpolated cooldown would quietly turn it
// back into Momentum Builder.
Deno.test('MOMENTUM_SMART reacts faster when losing the Buy Box than when holding it', () => {
  const p = PROFILE_PRESETS.MOMENTUM_SMART as Record<string, number>;
  if (!(p.cooldown_minutes_losing_bb < p.cooldown_minutes && p.cooldown_minutes < p.cooldown_minutes_winning_bb)) {
    throw new Error(`expected losing < baseline < winning, got ${p.cooldown_minutes_losing_bb} / ${p.cooldown_minutes} / ${p.cooldown_minutes_winning_bb}`);
  }
});

// V2 tightened raises after 5/43 Momentum Smart raises lost the Buy Box: a
// raise needs the competitor floor to move too, not only the Buy Box price.
Deno.test('MOMENTUM_SMART only raises into a market-supported move, and raises more gently than MOMENTUM_BUILDER', () => {
  const s = PROFILE_PRESETS.MOMENTUM_SMART as Record<string, unknown>;
  assertEquals(s.require_market_supported_raise, true);
  if (!((s.min_floor_support_ratio as number) > 0)) throw new Error('min_floor_support_ratio must be > 0');
  if (!((s.post_raise_cooldown_hours as number) > 0)) throw new Error('post_raise_cooldown_hours must be > 0');
  if (!((s.max_raise_step_dollars as number) < PROFILE_PRESETS.MOMENTUM_BUILDER.max_raise_step_dollars)) {
    throw new Error('MOMENTUM_SMART max_raise_step_dollars must stay below MOMENTUM_BUILDER\'s');
  }
});

Deno.test('MATCH_BUYBOX and MATCH_LOWEST both never undercut (undercut_amount === 0)', () => {
  assertEquals(PROFILE_PRESETS.MATCH_BUYBOX.undercut_amount, 0);
  assertEquals(PROFILE_PRESETS.MATCH_LOWEST.undercut_amount, 0);
});

// MATCH_BUYBOX and MATCH_LOWEST are a known, intentional exception to the
// uniqueness check below: their _presets.ts field sets are identical by
// design, because target_anchor (the field that actually differentiates
// "match the Buy Box" from "match the lowest offer") is never stored here —
// same as all 3 pre-existing profiles, target_anchor lives only in
// AiRuleBuilder.tsx's frontend PROFILE_PRESETS and is persisted straight to
// the rule row at creation time, never re-applied by this file's runtime
// override loop (which only touches keys actually present in this object).
//
// SMART_MATCH joins that group for the same reason: its fields match both,
// and its only difference is target_anchor 'smart_recapture' (vs 'buybox' /
// 'lowest_offer'), confirmed in AiRuleBuilder.tsx's PROFILE_PRESETS.
const KNOWN_IDENTICAL_EXCEPT_TARGET_ANCHOR = new Set([
  'MATCH_BUYBOX::MATCH_LOWEST',
  'MATCH_BUYBOX::SMART_MATCH',
  'MATCH_LOWEST::SMART_MATCH',
]);

Deno.test('uniqueness: every preset pair differs in at least one _presets.ts field, except pairs that differ only by frontend-only target_anchor', () => {
  for (let i = 0; i < PROFILE_KEYS.length; i++) {
    for (let j = i + 1; j < PROFILE_KEYS.length; j++) {
      const keyA = PROFILE_KEYS[i];
      const keyB = PROFILE_KEYS[j];
      if (KNOWN_IDENTICAL_EXCEPT_TARGET_ANCHOR.has(`${keyA}::${keyB}`)) continue;
      const a = PROFILE_PRESETS[keyA];
      const b = PROFILE_PRESETS[keyB];
      const aStr = JSON.stringify(a, Object.keys(a).sort());
      const bStr = JSON.stringify(b, Object.keys(b).sort());
      assertNotEquals(aStr, bStr, `${keyA} and ${keyB} must not be identical presets`);
    }
  }
});

Deno.test('undercut_amount matches the documented spread: only VELOCITY_DOMINATOR undercuts, every other preset matches exactly', () => {
  assertEquals(PROFILE_PRESETS.VELOCITY_DOMINATOR.undercut_amount, 0.02);
  for (const key of PROFILE_KEYS) {
    if (key === 'VELOCITY_DOMINATOR') continue;
    assertEquals(PROFILE_PRESETS[key].undercut_amount, 0, `${key}.undercut_amount`);
  }
});

Deno.test('VELOCITY_DOMINATOR (Aggressive Capture) undercuts the most of the 3', () => {
  const v = PROFILE_PRESETS.VELOCITY_DOMINATOR.undercut_amount;
  const m = PROFILE_PRESETS.MOMENTUM_BUILDER.undercut_amount;
  const p = PROFILE_PRESETS.PROFIT_EXTRACTOR.undercut_amount;
  if (!(v > m && v > p)) {
    throw new Error(`VELOCITY_DOMINATOR must undercut more than the others: v=${v} m=${m} p=${p}`);
  }
});

Deno.test('PROFIT_EXTRACTOR never undercuts (undercut_amount === 0)', () => {
  assertEquals(PROFILE_PRESETS.PROFIT_EXTRACTOR.undercut_amount, 0);
});

Deno.test('PROFIT_EXTRACTOR has the largest raise step of the 3 raise-capable profiles (its whole purpose is capturing margin via raises)', () => {
  const dollars = RAISE_AND_MONOPOLY_PROFILES.map((k) => PROFILE_PRESETS[k].max_raise_step_dollars);
  assertEquals(Math.max(...dollars), PROFILE_PRESETS.PROFIT_EXTRACTOR.max_raise_step_dollars);
});

Deno.test('match-only presets declare no raise-step fields (enable_smart_raise is false, so no step config is needed)', () => {
  for (const key of MATCH_ONLY_PROFILES) {
    const preset = PROFILE_PRESETS[key] as Record<string, unknown>;
    assertEquals('max_raise_step_dollars' in preset, false, `${key} must not declare max_raise_step_dollars`);
    assertEquals('max_raise_step_percent' in preset, false, `${key} must not declare max_raise_step_percent`);
  }
});

Deno.test('every raise/monopoly-capable preset enables smart_raise, ai_tuning, and monopoly_mode (uniform baseline)', () => {
  for (const key of RAISE_AND_MONOPOLY_PROFILES) {
    const preset = PROFILE_PRESETS[key];
    assertEquals(preset.enable_smart_raise, true, `${key}.enable_smart_raise`);
    assertEquals(preset.use_ai_tuning, true, `${key}.use_ai_tuning`);
    assertEquals(preset.enable_monopoly_mode, true, `${key}.enable_monopoly_mode`);
  }
});

Deno.test('MATCH_BUYBOX, MATCH_LOWEST and SMART_MATCH disable smart_raise and monopoly_mode (pure "match, never chase" identity)', () => {
  for (const key of MATCH_ONLY_PROFILES) {
    const preset = PROFILE_PRESETS[key];
    assertEquals(preset.enable_smart_raise, false, `${key}.enable_smart_raise`);
    assertEquals(preset.enable_monopoly_mode, false, `${key}.enable_monopoly_mode`);
    assertEquals(preset.use_ai_tuning, true, `${key}.use_ai_tuning`);
  }
});

Deno.test('no preset declares enable_profit_guard or profit_guard_mode (removed policy)', () => {
  for (const key of PROFILE_KEYS) {
    const preset = PROFILE_PRESETS[key] as Record<string, unknown>;
    assertEquals('enable_profit_guard' in preset, false, `${key} must not declare enable_profit_guard`);
    assertEquals('profit_guard_mode' in preset, false, `${key} must not declare profit_guard_mode`);
  }
});

Deno.test('USER_CONTROLLED_FIELDS includes undercut_amount and ignore_fbm_unless_buybox_owner', () => {
  assertEquals(USER_CONTROLLED_FIELDS.has('undercut_amount'), true);
  assertEquals(USER_CONTROLLED_FIELDS.has('ignore_fbm_unless_buybox_owner'), true);
});
