# Supabase support request — cron jobs owned by `supabase_read_only_user`

**Project ref:** `mstibdszibcheodvnprm`
**Region/plan:** (fill in from your dashboard)
**Date raised:** 2026-09-11

## What we need

Eleven `pg_cron` jobs are owned by `supabase_read_only_user`. No role available
to us can unschedule, deactivate or delete them.

Please either:

1. **Unschedule jobids 4, 6, 9, 13, 17, 18, 19, 23, 24, 25, 29**, or
2. **Reassign `cron.job.username` for those jobids to `postgres`**, so we can
   remove them ourselves.

Either is fine. We do not need these jobs to keep running — see below.

## The jobs

| jobid | jobname | schedule |
|------:|---------|----------|
| 4  | auto-sync-sales-every-10-minutes    | `*/10 * * * *` |
| 6  | repair-pending-prices-every-15-min  | `*/15 * * * *` |
| 9  | enrich-pending-orders-every-15-min  | `5,20,35,50 * * * *` |
| 13 | invoke-repricer-auto-turbo          | `* * * * *` |
| 17 | repricer-sequential-sweep           | `* * * * *` |
| 18 | repricer-unified-dispatch           | `* * * * *` |
| 19 | repricer-unified-dispatch-worker-b  | `* * * * *` |
| 23 | monitor-snapshot-5min               | `*/5 * * * *` |
| 24 | cleanup-monitor-snapshots-daily     | `0 3 * * *` |
| 25 | clean-ghost-listings-12h            | `0 6,18 * * *` |
| 29 | cleanup-dead-assignments-6h         | `15 */6 * * *` |

All are `active = true`.

## What we already tried

Run 2026-09-11 22:30 UTC as `current_user = postgres`,
`session_user = cli_login_postgres` (Supabase CLI `db push`). Each attempt
targeted jobid 13 and each was caught individually:

| attempt | result |
|---------|--------|
| `cron.unschedule(13::bigint)` | `permission denied for table job` |
| `cron.unschedule('invoke-repricer-auto-turbo')` | `could not find valid entry for job 'invoke-repricer-auto-turbo'` |
| `cron.alter_job(13::bigint, active := false)` | `Job 13 does not exist or you don't own it` |
| `UPDATE cron.job SET active = false WHERE jobid = 13` | `permission denied for table job` |
| `DELETE FROM cron.job WHERE jobid = 13` | `permission denied for table job` |

Job 13 remained scheduled after all five. The same was previously attempted
from the Supabase SQL editor, with the same result.

## Why we want them gone

They authenticate with a hardcoded legacy anon JWT. Since the project moved to
the new API key format, the runtime `SUPABASE_ANON_KEY` no longer equals that
token, so every invocation is rejected — either by the gateway or by the target
function's own auth guard.

Measured over three hours on 2026-09-11: **742 of 2,881 pg_net requests
returned 401**, roughly 26% of all background traffic, about 245 an hour.

The work these jobs used to do is already handled by postgres-owned
replacements that authenticate with `x-internal-secret` read from Vault at run
time, so removing them loses nothing. Our only remaining problems with them are:

- wasted edge function invocations (~5,900 rejected calls a day),
- an error log dominated by these 401s, which masks real failures,
- a latent risk of **double dispatch** if the legacy key ever became valid
  again, since several point at the same functions as their working
  replacements.

## Not requested

We are not asking for anything to be changed about the replacement jobs, the
functions themselves, or the API keys. Only the ownership or removal of the
eleven jobids above.