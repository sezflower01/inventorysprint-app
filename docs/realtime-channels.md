# Realtime Channel Inventory

Every `supabase.channel(...)` site in `src/` has one of four scopings. Any new
channel must pick one and document it here.

See `src/lib/realtime/scopedChannel.ts` for the helpers and the reasoning
behind the contract.

## Categories

- **user-scoped** — channel name includes `user.id`. Default choice for any
  tenant-owned table. Bounds Realtime fan-out to a single account's tabs and
  bounds any future RLS regression to that account's data.
- **session-scoped** — channel name is keyed by a per-user secret (e.g. a
  chat session id). RLS on the underlying table must independently gate the
  session id to its participants.
- **shared-admin** — channel name is deliberately shared across all admin
  tabs. Only valid when the underlying table has admin-only RLS SELECT
  (`has_role(auth.uid(), 'admin')`) AND the caller gates `subscribe()`
  behind an `isAdmin` check.
- **legacy-shared** — historical shared channel names kept temporarily for
  compatibility. New code must not add these; convert to user-scoped.
- **db-broadcast** — a `broadcast` channel fed by a database trigger rather
  than by `postgres_changes`, on a private channel. Use when subscribers want
  only a few columns of a table that is written far more often than those
  columns change: a trigger `WHEN` clause suppresses the event entirely, which
  no publication-level mechanism can do. The channel name must still be
  user-scoped, AND a policy on `realtime.messages` must gate the topic to
  `auth.uid()` — on a private channel that policy is the actual access control,
  not the name.
- **global-broadcast** — deliberately shared by every client of every account,
  and carrying `broadcast` messages only. Valid ONLY when there is no table
  behind the channel (so no RLS to regress and no row content to leak) and the
  fan-out to every tab is the actual purpose. The single legitimate case today
  is announcing a new build. Do not use for anything tenant-owned.

## Inventory (audited 2026-07-03)

| Site | Channel | Category | Table RLS |
| --- | --- | --- | --- |
| `LiveChatWidget.tsx` | `chat-msg-${sessionId}` | session-scoped | `chat_messages` participant-only |
| `LiveChatWidget.tsx` | `chat-sess-${sessionId}` | session-scoped | `chat_sessions` participant-only |
| `AdminChatPanel.tsx` | `admin-chat-msg-${sessionId}` | session-scoped | `chat_messages` admin OR participant |
| `AdminChatNotification.tsx` | `admin-chat-sessions` | shared-admin | `chat_sessions` admin SELECT |
| `AdminErrorNotification.tsx` | `admin-error-reports` | shared-admin | `error_reports` admin SELECT |
| `AdminErrorNotification.tsx` | `admin-repricer-errors` | shared-admin | `repricer_price_actions` admin SELECT |
| `AssignmentsTable.tsx` | `repricer-inventory-live-${user.id}-${mkt}` | user-scoped | `inventory` `user_id = auth.uid()` |
| `AssignmentsTable.tsx` | `assignment-ui-${user.id}` | db-broadcast (added 2026-08-27) | `realtime.messages` topic = `assignment-ui-` \|\| `auth.uid()` |
| `AssignmentsTable.tsx` | `assignments-lock-${user.id}` | user-scoped — **transitional, delete after 20260827120002** | `repricer_assignments` `user_id = auth.uid()` |
| `AutomationSearch.tsx` | `automation-results-${user.id}-${runId}` | user-scoped (fixed 2026-07-03) | `automation_results` via `automation_runs.user_id = auth.uid()` |
| `AutomationSearch.tsx` | `automation-runs-${user.id}-${runId}` | user-scoped (fixed 2026-07-03) | `automation_runs` `user_id = auth.uid()` |
| `CheckedRecentlyPanel.tsx` | `checked-recently-${user.id}` | user-scoped (fixed 2026-07-03) | `repricer_price_actions` `user_id = auth.uid()` |
| `AppVersionGate.tsx` | `app-version` | global-broadcast (added 2026-08-23) | none — no table; payload is a git SHA |

## Adding a new channel

1. Import the appropriate helper from `src/lib/realtime/scopedChannel.ts`.
2. Confirm the underlying table's RLS SELECT policy matches the scoping
   category you picked (this doc's last column). If it doesn't, fix the
   RLS first; don't try to compensate with the channel name.
3. Add an entry to the table above in the same PR.


## `app-version` (added 2026-08-23)

The one shared, un-scoped channel in the app, and the reasoning for the
exception is worth keeping.

The scoping rules exist because `postgres_changes` events carry ROW DATA: a
shared channel name is both a leak risk if RLS ever regresses, and a fan-out
cost because every subscribed tab is woken even when RLS filters the payload
away. Neither applies here. `app-version` carries `broadcast` messages only,
there is no table behind it, and the entire payload is a build identifier
(`{ buildId, sentAt }`). Waking every tab is the point — a deploy notification
that reaches only some tabs is useless.

Sent by the `broadcast-app-reload` edge function, consumed by
`src/components/AppVersionGate.tsx`. A client ignores any broadcast whose
`buildId` equals its own, so re-sending is harmless and sending a stale id is a
no-op rather than a reload loop.

⚠️ Do not reach for `globalBroadcastChannel()` for anything else. If a future
payload needs to be different per user, it is user-scoped by definition.


## `repricer_assignments` moved off `postgres_changes` (2026-08-27)

The most expensive thing this app did to Supabase, and the reasoning is worth
keeping because the same shape will recur.

`repricer_assignments` is **185 columns** wide and takes **~9.2 UPDATEs/second**
of machine bookkeeping from `repricer-scheduler`. It was in the
`supabase_realtime` publication, and Realtime broadcasts on **any** row change
regardless of which column moved — so every one of those writes was decoded,
RLS-filtered and fanned out as a 185-column row to every subscribed tab.

Measured 2026-08-20 over a 51.28h `pg_stat_statements` window:

| | Total | Per hour |
| --- | --- | --- |
| `repricer_assignments` UPDATEs | 1,704,493 | 33,239 |
| `realtime.list_changes` calls | 717,900 | 14,000 |
| Realtime buffers touched | 32,481 GB | 633 GB |
| Realtime exec time | 31,370 s | 612 s |

`realtime.list_changes` alone was **93% of the top-15 queries by buffers
touched**, 14× the next entry, against ~290 GB/month of billed egress.

Audited against the code, the subscribers wanted **five fields**:
`id`, `ui_edit_locked`, `min_price_override`, `max_price_override`,
`manual_min_price`. All four meaningful ones are human actions — clicking a
padlock, typing a price — which happen a few times an hour. The overlap with
the hot bookkeeping columns is **zero**, not small.

**What does not work, and why:**

- **Publication row filters** (`ALTER PUBLICATION ... WHERE`) can only
  reference the new row, so they cannot express "this column changed".
- **Publication column lists** shrink the payload but the event still fires on
  every UPDATE — bytes drop, event count does not.
- **`postgres_changes` itself** has no column-scoping. This is the question
  worth putting to Supabase directly.

**What does:** an `AFTER UPDATE ... FOR EACH ROW WHEN (...)` trigger. The
`WHEN` clause is evaluated before the trigger function is called, so a
bookkeeping write costs four `IS DISTINCT FROM` comparisons and stops. It
works even though the table is `REPLICA IDENTITY DEFAULT` (where the
replication `OLD` tuple is only the primary key) because inside a trigger
`OLD` is fully populated regardless.

Shipped as three migrations, deliberately separate:

1. `20260827120000_assignments_ui_broadcast.sql` — trigger + `realtime.messages`
   policy. Additive; both transports deliver.
2. `20260827120001_price_actions_column_list.sql` — narrows
   `repricer_price_actions` 52 → 18 columns. Different treatment on purpose:
   its subscribers **do** want every INSERT, so only the payload is wasteful.
3. `20260827120002_assignments_leave_realtime_publication.sql` — the switch.
   Refuses to run if the trigger is absent.

### ⚠️ `ALTER PUBLICATION ... SET TABLE` is not what it looks like

`SET TABLE` replaces the publication's **entire table list**. Using it to set
one table's column list silently drops every other table out of realtime —
chat, automation runs, `fnsku_map`, `pl_sync_progress`. The only safe way to
change one table's column list is `DROP TABLE` then `ADD TABLE ... (cols)`.
Both migrations above assert afterwards that the other tables survived.

### Verifying the broadcast path

Until migration 3 is applied both transports deliver, so **a working padlock
proves nothing about broadcast** — `postgres_changes` alone would give the
identical result. Check `realtime.messages` directly instead:

```sql
SELECT topic, event, inserted_at
FROM realtime.messages
WHERE topic LIKE 'assignment-ui-%'
ORDER BY inserted_at DESC
LIMIT 20;
```

Toggle a padlock, re-run, confirm a new row with your user id in the topic.
