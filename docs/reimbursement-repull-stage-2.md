# Stage 2: applying the 2026 adjustment re-pull

**Status: NOT STARTED. All eight pending months measured and gate-clear.
Proposed start: Sunday 2026-10-26, 15:00 UTC (08:00 Pacific).**

Why that slot:

- **Sunday is the lowest-volume day** — roughly 86 orders against Thursday's
  ~150 — so the fewest live figures are moving while the P&L is being compared.
- **15:00 UTC is clear of the unexplained 12:33 UTC pg_cron stall**, which is
  still not root-caused. No reason to run financial writes near a window where
  the scheduler froze once.
- It is before the week's repricing ramps, and the Finances API work is tiny:
  the three measured runs took 36–47 seconds each with **zero** rate-limit hits.

Budget **45–60 minutes** for all eight: about 8 minutes of fetching, the rest
verification between months. Oldest first, February through September.

Nothing starts without your word on the date.

This is the procedure, written down for approval before anything runs. Stage 1
(dry runs) is complete; stage 2 is the part that writes.

---

## What stage 2 changes, and what it must not

The re-pull replaces the `event_type = 'adjustment'` rows in
`financial_events_cache` for one month with a fresh pull from Amazon's Finances
API, routed through `adjustment-router.ts`. It exists because
`COMPENSATED_CLAWBACK` was never stored at all — 0 rows across 22 months — so
every clawback Amazon took back is missing from the P&L.

It must not touch:

- **2025.** Out of scope by instruction.
- **Liquidations.** `event_type = 'liquidation'` comes from
  `RemovalShipmentEventList`, which this function does not fetch. The scope was
  narrowed to `event_type = 'adjustment'` after a guard caught that 62 January
  liquidations would have been deleted and could not have been replaced.
- **Shipments and service fees.** Same month, different `event_type`, untouched.
- **Any FBA-dependent figure on an existing row.** Nothing recomputes fees.

## Why this is operator-triggered and not scheduled

A pg_cron driver was built for stage 1 and then **removed**. It is not coming
back, for a recorded reason: `repull_reports.month` is written as `2026-06-01`
by one writer and `2026-06` by the other, the driver matched only one form, and
so it re-ran June five times and then marked it failed. `repull_find_report`
now matches on `left(month,7)`, but the lesson stands — an unattended driver
turned one month into five invocations against a 0.5 req/sec Amazon endpoint.

Stage 2 runs **one month per operator-triggered invocation**, each one read and
checked before the next is fired.

A note on the trigger itself: the intended path was the browser, but the
preview pane has no signed-in session and I will not enter credentials. A direct
HTTPS call also fails, because the function compares the bearer against
`SUPABASE_SERVICE_ROLE_KEY`, which this project now injects as the new
`sb_secret_` key, and the CLI masks that value. So each invocation is fired
through `repull_fire(...)`, which reads `INTERNAL_SYNC_SECRET` from Vault. This
is safe in a way it was not when July first failed: the function calls
`persistReport()` on **every** exit path, so a dropped pg_net response can no
longer lose a run — the result is in `repull_reports` either way.

## The months

Read from the data on 2026-10-24, not from the report table — January was
applied before `persistReport` existed, so it has no report row and the report
table alone makes it look outstanding.

A month with clawback rows stored has been applied. A month with zero has not.

All ten months are now measured. Every dry run reports
`api_items_via_catchall = 0` with `api_catchall_types = {}`, and every residual
is independently reproduced by summing the per-column deltas.

| Month | Pages | Items | Catch-all | Clawbacks | Residual | State |
| --- | --- | --- | --- | --- | --- | --- |
| January | — | — | — | **−$230.38** | — | **applied** |
| February | — | — | 0 | −$227.95 | +$0.13 | pending |
| March | — | — | 0 | −$182.54 | +$0.59 | pending |
| April | — | — | 0 | −$193.44 | +$2.37 | pending |
| May | 38 | 103 | 0 | −$187.96 | **$0.00** | pending |
| June | — | — | 0 | −$209.69 | +$0.13 | pending |
| July | 59 | 135 | 0 | −$246.44 | +$10.48 | pending |
| August | 47 | 192 | 0 | −$132.08 | +$25.11 | pending |
| September | 37 | 112 | 0 | −$213.20 | +$20.14 | pending |
| October | — | — | — | **−$143.89** | — | live sync |

**Eight months pending, all with a clean gate.** Zero rate-limit hits on all
three of the final runs.

### The two numbers, which are not the same

- **Clawbacks pending: −$1,593.30.** This is the money Amazon took back that
  the P&L has never shown.
- **Net P&L change if all eight are applied: −$1,534.35.** The difference is
  **+$58.95** of reimbursement restatement — Amazon has posted more
  reimbursement detail since the original pulls. Each month's residual is
  attributed to a column:
  - February +$0.13, March +$0.59, April +$2.37, June +$0.13 — rounding-scale
  - May **$0.00** — every non-clawback column delta is exactly zero
  - July +$10.48 — `warehouse_damage` +$8.88, `reversal_reimbursement` +$1.60
  - August +$25.11 — `reversal_reimbursement` +$16.54,
    `free_replacement_refund_items` +$8.57
  - September +$20.14 — `reversal_reimbursement` +$10.82,
    `warehouse_lost` +$9.32

**Full-year 2026 clawbacks: −$1,967.57** (January −$230.38 applied, the eight
pending months −$1,593.30, October −$143.89 captured live).

### A correction to a correction

The earlier figures of **−$1,593.30 pending** and **−$1,958.61 full-year** were
retired as unverified. They were right. The pending total is now measured at
exactly −$1,593.30, and the full-year difference from −$1,958.61 is +$8.96,
which is entirely October drifting as the live sync keeps catching new events
(−$134.93 → −$143.89). Retiring them was over-cautious; the earlier unpersisted
slices for August (−$132.08) and September (−$213.20) also both verified exactly.

The figures that remain genuinely wrong are the worker-slot outage mechanism and
the claim that January was unapplied.

## Per-month procedure

Each month is one pass. **Stop at the first month where anything unexpected
moves**, run `fec_restore_month`, and report.

1. **Back up.** `SELECT fec_backup_month(:uid, :month)` — copies the month's
   rows into `fec_repull_backup` before anything is deleted. This is the
   rollback source and it is not optional.

2. **Fingerprint the untouched types.**
   `SELECT fec_other_types_fingerprint(:uid, :month)` — a checksum over the
   `event_type <> 'adjustment'` rows, taken before and compared after. If it
   moves, the scope leaked and the month gets restored.

3. **Dry run first** (skip only where the table above says the dry run is
   already done and nothing has changed since):
   `SELECT repull_fire(:uid, :month, false)`

4. **Read the persisted report:** `SELECT repull_find_report(:month, false)`.
   Three things gate the apply:
   - `api_items_via_catchall` must be **0**. Non-zero means an `AdjustmentType`
     the router does not recognise, and the run stops. Note that a non-empty
     `reimbursements` multiset is *not* evidence of this — negative
     LOST/DAMAGE legitimately routes there with `viaCatchAll: false`. That
     distinction cost a false alarm already.
   - `api_amount_multiset` vs the stored multiset must differ only by the
     clawbacks being added.
   - Paging must be complete and the item count must not be short against what
     is stored.

5. **Apply:** `SELECT repull_fire(:uid, :month, true)`. The write goes through
   `repull_month_adjustments_apply`, which is one transaction and re-checks the
   sync state at execution time, so the month is never left without
   adjustments.

6. **Verify, before moving on:**
   - `SELECT repull_verify_apply(:uid, :month)`
   - `SELECT fec_diff_month(:uid, :month)` — the by-key diff
   - `fec_other_types_fingerprint` again: must be **identical** to step 2
   - **Confirm the P&L.** Compare against `pl_baseline_20261022`. The expected
     move is clawbacks appearing as an expense and nothing else.
   - **Confirm the other months are unchanged.** Every month, not just the
     neighbours.

7. Only then fire the next month.

## Brakes that stay on

- One month in flight. No concurrent slices.
- `apply` defaults to `false` in the function; writing has to be asked for.
- A short fetch, zero items against a non-zero stored count, or incomplete
  paging all refuse to write.
- 100-second internal timeout, and progressive per-page 429 backoff
  (2s → 20s, 8 retries per page, 60 per run) because the endpoint is ~0.5 req/sec.
- If any call stalls, that gets reported rather than retried blind.
- `fec_restore_month(:uid, :month)` is the one-step undo.

## What stage 2 is expected to be worth

**Measured, five months: −$1,060.06.** That is February, March, April, June and
July, each from a dry run whose catch-all gate reads 0.

May, August and September are **not** in that figure. They have no dry run, so
their clawbacks are unknown. The five measured months average −$212, but August
carries 156 adjustment rows against July's 79, so multiplying the average by
three would be a guess dressed up as a number. The honest statement is
**−$1,060.06 measured and three months unmeasured**.

For the accountant, the full-year 2026 picture once stage 2 finishes:

- January, already applied: **−$230.38**
- October, captured live by the forward-only fix: **−$143.89**
- February/March/April/June/July, measured and pending: **−$1,060.06**
- May/August/September: pending measurement

So roughly **−$1,435 is already known**, and the final figure will be that plus
three months. It will not reach the ~$1,960 quoted earlier in the work — that
estimate predated the per-month measurements and should not be used.

This is a reduction in reported profit, not a newly discovered loss. The money
left the account when Amazon took it back; the bookkeeping is catching up.

## Residuals: what a non-zero difference means

Each month's `api_signed_total - stored_signed_total` splits cleanly into the
clawbacks being added plus a small reimbursement-side residual. July's residual
is **+$10.48**, and it decomposes exactly:

- `warehouse_damage`: two further $4.44 items, 5 stored becoming 7 → **+$8.88**
- `reversal_reimbursement`: three amounts leave (15.88, 19.88, 25.56 = 61.32),
  four arrive (7.18, 16.35, 18.92, 20.47 = 62.92) → **+$1.60**
- `warehouse_lost`: **$0.00** — two collision unpacks, 11.98 splitting into
  7.74 + 4.24 and 18.78 into 15.90 + 2.88
- `free_replacement_refund_items`: multisets identical

8.88 + 1.60 = 10.48. A residual made only of collision unpacks is money-neutral
and expected; a residual with new amounts in it, as July has, is Amazon having
posted more reimbursement detail since the original pull. Neither blocks the
apply. What blocks the apply is `api_items_via_catchall` above 0.
