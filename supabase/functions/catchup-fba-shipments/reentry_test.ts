import { assertEquals, assert } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { innerCallTimeoutMs, shouldReenter } from './reentry.ts';

// The live configuration. If index.ts changes these, change them here too --
// the regression test below is only meaningful against the real numbers.
const HARD_CEILING_MS = 140_000;
const INNER_TOTAL_BUDGET_MS = 100_000;
const REENTRY_SLACK_MS = 15_000;
const RECORDING_RESERVE_MS = 5_000;

const base = {
  callsMade: 1,
  maxCalls: 2,
  moreWork: true,
  innerWorstCaseMs: INNER_TOTAL_BUDGET_MS,
  slackMs: REENTRY_SLACK_MS,
  hardCeilingMs: HARD_CEILING_MS,
};

Deno.test('REGRESSION: the 2026-11-18 14:13Z run must not re-enter', () => {
  // The wrapper began 14:13:37.151 and inner #2 began ~14:15:08.93, so its own
  // elapsed at the re-entry decision was ~91.8s. The old rule (elapsed < 110s)
  // admitted it and the wrapper was killed at 150s having recorded nothing.
  const d = shouldReenter({ ...base, elapsedMs: 91_800 });
  assertEquals(d.reenter, false);
  assert(
    d.reason.includes('would breach ceiling'),
    `expected a ceiling refusal, got: ${d.reason}`,
  );
  // 91.8 + 100 + 15 = 206.8s, which is what the old rule failed to compute.
  assertEquals(d.projectedMs, 206_800);
});

Deno.test('the old rule would have allowed it (documents the defect)', () => {
  const OLD_DEADLINE_MS = 110_000;
  assert(
    91_800 < OLD_DEADLINE_MS,
    'the old rule really did admit this call; if this fails the premise changed',
  );
});

Deno.test('re-enters only when the whole projected run fits', () => {
  // 25_000 + 100_000 + 15_000 = 140_000, exactly the ceiling -> allowed.
  assertEquals(shouldReenter({ ...base, elapsedMs: 25_000 }).reenter, true);
  // One ms more cannot fit.
  assertEquals(shouldReenter({ ...base, elapsedMs: 25_001 }).reenter, false);
  assertEquals(shouldReenter({ ...base, elapsedMs: 0 }).reenter, true);
});

Deno.test('never re-enters without outstanding work', () => {
  const d = shouldReenter({ ...base, elapsedMs: 0, moreWork: false });
  assertEquals(d.reenter, false);
  assert(d.reason.includes('no work remaining'));
});

Deno.test('respects the hard call cap even when time allows', () => {
  const d = shouldReenter({ ...base, elapsedMs: 0, callsMade: 2, maxCalls: 2 });
  assertEquals(d.reenter, false);
  assert(d.reason.includes('cap reached'));
});

Deno.test('INVARIANT: an admitted re-entry can never breach the ceiling', () => {
  // The property that actually matters, swept rather than spot-checked.
  for (let elapsed = 0; elapsed <= 200_000; elapsed += 250) {
    for (const innerWorstCaseMs of [30_000, 70_000, INNER_TOTAL_BUDGET_MS, 120_000]) {
      const d = shouldReenter({ ...base, elapsedMs: elapsed, innerWorstCaseMs });
      if (d.reenter) {
        assert(
          elapsed + innerWorstCaseMs <= HARD_CEILING_MS - REENTRY_SLACK_MS,
          `admitted a re-entry that can reach ${elapsed + innerWorstCaseMs}ms ` +
            `against a ${HARD_CEILING_MS}ms ceiling (elapsed ${elapsed}, inner ${innerWorstCaseMs})`,
        );
        // And it must still be inside the platform's own 150s kill.
        assert(elapsed + innerWorstCaseMs < 150_000);
      }
    }
  }
});

Deno.test('the abort timeout always leaves time to record', () => {
  for (let elapsed = 0; elapsed <= 200_000; elapsed += 250) {
    const t = innerCallTimeoutMs(elapsed, HARD_CEILING_MS, RECORDING_RESERVE_MS);
    assert(t >= 0, 'a negative timeout would disable the abort');
    if (t > 0) {
      // While there is time to spend, spending all of it must still stop at
      // the reserve boundary.
      assert(
        elapsed + t <= HARD_CEILING_MS - RECORDING_RESERVE_MS,
        `abort at ${elapsed + t}ms leaves no recording reserve`,
      );
    } else {
      // t === 0 is not "no timeout", it is "there is no time left". It may
      // only occur once the reserve boundary has already passed.
      assert(
        elapsed >= HARD_CEILING_MS - RECORDING_RESERVE_MS,
        `got a 0 timeout at ${elapsed}ms, before the reserve boundary`,
      );
    }
  }
  // Past the ceiling there is no time at all; callers must read 0 as
  // "do not start", never as "no timeout".
  assertEquals(innerCallTimeoutMs(140_000, HARD_CEILING_MS, RECORDING_RESERVE_MS), 0);
  assertEquals(innerCallTimeoutMs(999_999, HARD_CEILING_MS, RECORDING_RESERVE_MS), 0);
});

Deno.test('with the live config a second call is effectively impossible', () => {
  // Stated as a test so that if someone lowers the inner budget to make
  // re-entry viable again, they do it deliberately and see this fail.
  const earliestInnerFinish = 30_000; // inner #1 cannot realistically be faster
  assertEquals(
    shouldReenter({ ...base, elapsedMs: earliestInnerFinish }).reenter,
    false,
    'inner budget must drop below ~25s before a second call can fit',
  );
});
