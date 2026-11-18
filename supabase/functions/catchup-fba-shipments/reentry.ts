/**
 * When may the wrapper call the inner sync again?
 *
 * ── WHY THIS IS A SEPARATE, PURE MODULE ───────────────────────────────────
 *
 * Measured 2026-11-18 14:13Z. The wrapper started at 14:13:37.151 and the old
 * rule was `while (calls < MAX_INNER_CALLS && Date.now() - t0 < DEADLINE_MS)`
 * with DEADLINE_MS = 110_000. Reconstructed from the phase breadcrumbs:
 *
 *   14:13:37.151  wrapper 'started'
 *   14:13:41.022  inner #1 phase-1-complete   (at_ms 3614, so inner T0 ~14:13:37.41)
 *   14:14:55.105  inner #1 item-budget-exhausted (at_ms 77690)
 *   14:15:08.93   inner #2 begins             (next phase-1 at_ms 3419 @14:15:12.351)
 *   14:16:47.173  inner #2 item-budget-exhausted (at_ms 98246)
 *
 * Inner #1 therefore ran ~91.5s wall, and at re-entry the wrapper's own
 * elapsed was ~91.8s. 91.8s < 110s, so the old rule happily started a second
 * call that could itself run ~100s -- putting the wrapper at ~190s against a
 * platform that kills the request at 150s. It was killed at ~14:16:07, which
 * is exactly why there is a 'started' row at 14:13:37 and no 'success' or
 * 'failed' row after it, while the inner function's own phase rows carry on to
 * 14:16:47 (a separate request, still alive after its caller is gone).
 *
 * The defect is that the old rule compared elapsed time against the ceiling
 * while ignoring how long the call it was about to start could take. A
 * deadline that does not account for the duration of the work it admits is not
 * a deadline. So the rule is now:
 *
 *     elapsed + innerWorstCase + slack <= hardCeiling
 *
 * and the inner call is given a HARD total budget it honours, so
 * `innerWorstCase` is a contract rather than a hope.
 *
 * It lives in its own module, not in index.ts, because this arithmetic is the
 * thing that failed and it needs a test. It is NOT in _shared/ on purpose: a
 * change there redeploys all ~262 functions.
 */

export interface ReentryInput {
  /** Wall-clock ms since the wrapper began its own request. */
  elapsedMs: number;
  /** How many inner calls have already completed this run. */
  callsMade: number;
  /** Hard cap on inner calls per run, whatever the arithmetic allows. */
  maxCalls: number;
  /** Did the last inner call report work still outstanding? */
  moreWork: boolean;
  /**
   * The longest the inner call may take. This must be the inner function's
   * CONTRACTUAL total budget (its own `totalBudgetMs`), not a measured
   * average -- re-entry is a decision about the worst case.
   */
  innerWorstCaseMs: number;
  /** Headroom for the wrapper's own recording and return. */
  slackMs: number;
  /** The wrapper must always return within this. Below the platform's 150s. */
  hardCeilingMs: number;
}

export interface ReentryDecision {
  reenter: boolean;
  /** Human-readable, and recorded into cron_run_history detail. */
  reason: string;
  /** The ceiling arithmetic, so a declined re-entry is auditable. */
  projectedMs: number;
}

/**
 * The only place that decides whether to call the inner sync again.
 *
 * Declining is always safe: the inner sync's cursor means the next run resumes
 * rather than redoing finished shipments, so an undone slice costs a wait, not
 * duplicated Amazon quota.
 */
export function shouldReenter(input: ReentryInput): ReentryDecision {
  const {
    elapsedMs,
    callsMade,
    maxCalls,
    moreWork,
    innerWorstCaseMs,
    slackMs,
    hardCeilingMs,
  } = input;

  const projectedMs = elapsedMs + innerWorstCaseMs + slackMs;

  if (!moreWork) {
    return { reenter: false, reason: 'inner call reported no work remaining', projectedMs };
  }
  if (callsMade >= maxCalls) {
    return {
      reenter: false,
      reason: `inner-call cap reached (${callsMade}/${maxCalls})`,
      projectedMs,
    };
  }
  if (projectedMs > hardCeilingMs) {
    return {
      reenter: false,
      reason:
        `would breach ceiling: elapsed ${elapsedMs}ms + inner worst case ` +
        `${innerWorstCaseMs}ms + slack ${slackMs}ms = ${projectedMs}ms > ${hardCeilingMs}ms`,
      projectedMs,
    };
  }
  return {
    reenter: true,
    reason: `fits: projected ${projectedMs}ms <= ceiling ${hardCeilingMs}ms`,
    projectedMs,
  };
}

/**
 * How long to let a single inner fetch run before aborting it.
 *
 * The re-entry rule above keeps us from STARTING a call that cannot finish in
 * time, but it cannot help if the inner call overruns its own contract or
 * hangs. So every inner fetch also carries an AbortController armed with this,
 * which guarantees the wrapper regains control with `recordingReserveMs` still
 * in hand to write its history row. "The job ran" and "the job worked" must
 * not share a state, and a wrapper that never returns records neither.
 *
 * Returns 0 when there is no time left at all; callers must treat 0 as "do not
 * start", never as "no timeout".
 */
export function innerCallTimeoutMs(
  elapsedMs: number,
  hardCeilingMs: number,
  recordingReserveMs: number,
): number {
  return Math.max(0, hardCeilingMs - elapsedMs - recordingReserveMs);
}
