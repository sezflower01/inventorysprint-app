# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## ⚠️ Read this first: the naming trap

This repository has **five different names** across its layers. They all refer to the same single product. Nothing is mis-linked, nothing is a leftover from a different app, and no second checkout exists on the machine.

| Layer | Name it carries |
| --- | --- |
| Local folder | `quick-start-genesis` (Lovable scaffold name) |
| GitHub repo | `sezflower01/inventorysprint-app` (renamed 2026-08-15 from `arbiproseller-app`) |
| Vercel project | `arbiproseller-app` (`.vercel/project.json`) — renamed separately from the repo |
| Supabase project | `CloudArbi` — ref `mstibdszibcheodvnprm` |
| Package name | `vite_react_shadcn_ts` (Lovable default) |
| **The actual product** | **InventorySprint** — `inventorysprint.com` |

The product is an **Amazon FBA seller-operations platform**: repricing, inventory, sourcing, P&L, shipments, and label printing. When the user says "InventorySprint", "the app", or "the site", they mean this repo. Do not go looking for another project.

## Commands

- `npm run dev` — Vite dev server (port 8080)
- `npm run build` — builds extension zips, then `vite build`
- `npm run build:dev` — unminified build, for debugging build-only issues
- `npm run lint` — ESLint over the repo
- `npm run db:status` — `supabase migration list`
- `npm run db:push` — `supabase db push`

**Package manager is npm.** `package-lock.json` is the live lockfile (`node_modules/.package-lock.json` confirms it). `bun.lock` and `bun.lockb` are Lovable residue — ignore them, don't update them, don't switch to bun.

`npm run build` runs `scripts/build-extension-zips.js` **before** Vite. A build failure may originate there, not in the frontend.

### Tests

There is no `npm test` script, but **Vitest IS available and there ARE test files in `src`** — e.g. `src/lib/repricer/__tests__/assignmentStatus.test.ts`, `src/lib/sales/__tests__/currencyConversion.test.ts`. Run them directly:

```bash
npx vitest run src/lib/repricer/__tests__/assignmentStatus.test.ts
```

⚠️ This paragraph previously read "no frontend test runner — no Jest, no Vitest, no test files in `src`". Verified false 2026-08-26: vitest ran 6 tests in that file and passed. Do not skip writing or running frontend tests on the strength of the old claim.

Edge-function logic is tested with **Deno** (~20 `*_test.ts` files):

```bash
deno test --allow-net --allow-env --allow-read supabase/functions/_tests/repricer-ai-evaluate/presets_snapshot_test.ts
```

Shared-module tests sit beside their source (`_shared/module-access-guard_test.ts`); larger suites live in `supabase/functions/_tests/`.

## Architecture

**Frontend** — React 18 + TypeScript + Vite + shadcn-ui (Radix) + Tailwind, deployed to Vercel. ~126 pages in `src/pages`, feature-grouped components in `src/components/<feature>/` (repricer, sales, profitloss, inventory, shipment, seller-analyzer, admin, access, …). i18n via `src/locales`.

**Backend** — Supabase: Postgres (**891 migrations**), Auth, Realtime, and **253 Deno Edge Functions** in `supabase/functions/*`, one `index.ts` per function. Edge functions are **not** built or bundled by `npm run build`; they deploy independently.

**Also in the repo** — a Chrome extension (`extension/`, `extension-create/`) and a self-contained Windows .NET print client (`print-clients/windows/`).

### External integrations

Amazon SP-API (LWA + AWS creds), **Keepa** (product/seller data), Rainforest, ScrapingBee, Google CSE, Gemini, Resend (email). All secrets live in **Supabase edge-function secrets**, never in the repo. The local `.env` holds only public `VITE_*` values — there is no Keepa or SP-API key on the dev machine, so anything needing one must run server-side.

## Critical patterns

### Shared rate gates — always use them, never call a metered API directly

Third-party quotas are **account-wide**, so independent callers will silently starve each other. Two gates exist, both using the same atomic claim pattern (`last_called_at` on a shared row):

- **Keepa** — `_shared/keepa-rate-gate.ts` → `acquireKeepaGlobalSlot()`, backed by `keepa_daily_usage`
- **SP-API** — `sp_api_rate_limit_state` table, per `(user_id, operation)`

Callers currently sharing the Keepa gate: `repricer-sp-api-pricing` (live and critical), `check-seller-watchlist`, `find-source-candidates`, `seller-storefront-snapshot`. **Adding a new Keepa caller without the gate will degrade repricing.**

Two distinct usage styles, and picking the wrong one is a real bug:
- **Background cron** — if no slot is free, skip and retry next run.
- **Interactive request** — wait briefly and retry, so the user gets data instead of an empty screen (`seller-storefront-snapshot` does this).

### Keepa cost model

The account plan is **25 tokens/min** (5 Pro + 20 API). The gate meters **tokens, not calls**, and guards at **20 tokens/min** — see `KEEPA_GUARD_LIMIT` in `_shared/keepa-rate-gate.ts`, which is the authority.

⚠️ This paragraph previously read "5 tokens/min" and "guards at 4 calls/min, and meters calls not tokens". Both were wrong by 2026-08-23. Call-counting was the ORIGINAL design and it was the bug: 4 calls/min of `/seller?storefront=1` at 10 tokens each is 40 tokens/min, so it under-protected expensive calls while starving cheap ones — a single extension panel view could eat most of a minute's slots. The gate is token-aware now. Trust the constant in the source over any prose, including this.

Per-call costs are in `KEEPA_COST`: `/seller?storefront=1` is a flat 10 tokens regardless of catalog size; `/product` is 1 token per ASIN. Every Keepa response carries `tokensLeft`, `tokensConsumed`, `refillRate` and `refillIn` — read them when reasoning about capacity, and report them back via `reportKeepaTokensLeft()` even from callers that do not gate, or the shared budget silently drifts from Keepa's own accounting.

Keepa API gotchas already learned the hard way:
- `/product` `offers` must be **0 or ≥20**. `offers=10` returns HTTP 200 with an `{error:...}` body, which naive code reads as "zero offers".
- Always check `json.error` on a 200 response — Keepa signals failure in-body.

### Cron jobs

Scheduled with **pg_cron inside migrations**, calling edge functions over `net.http_post` with an `x-internal-secret` header from Vault. Cron-triggered functions must authenticate via `INTERNAL_SYNC_SECRET` **or** a service-role bearer, and must never be publicly callable — they read all users' data and spend metered API quota.

⚠️ **A new cron-invoked function MUST get `verify_jwt = false` in `supabase/config.toml`.** pg_cron sends `x-internal-secret` and **no `Authorization` header**, so with the default `verify_jwt = true` Supabase's gateway rejects the call *before your function runs* — no function log, no error, just a worker that silently never executes. Diagnose by calling it unauthenticated and reading the error **shape**: `{"code":"UNAUTHORIZED_NO_AUTH_HEADER"}` is the platform, `{"error":"Unauthorized"}` is your own guard. Cost a real debugging cycle on 2026-08-16.

The same trap applies one call deeper: when a cron worker invokes **another** edge function that legitimately keeps `verify_jwt = true` (because the browser also calls it), send **both** a service-role `Authorization` bearer to satisfy the gateway *and* `x-internal-secret` for the target's own logic. `auto-source-new-listings` → `find-source-candidates` is the worked example.

Stagger new jobs off the existing ones (e.g. `check-price-alerts` at `:00`, `check-seller-watchlist` at `:15`) so quota-consuming jobs don't burst together.

Wrap long fan-out jobs in `withCronLock(...)` from `_shared/cron-lock.ts` — it prevents overlapping runs and records observability rows in `cron_run_history`.

### Access control

- `_shared/module-access-guard.ts` — per-user module permissions; admins (`user_roles.role = 'admin'`) always pass
- `_shared/marketplace-guard.ts` — per-marketplace access
- Admin-only functions verify via the `has_role` RPC (see `admin-vacuum-full`)
- RLS is on throughout; user-facing tables scope by `auth.uid() = user_id`

## Deployment

- **Frontend** — Vercel auto-deploys from GitHub `main`.
- **Edge functions** — ⚠️ **committing an edge function does NOT ship it. Deploy by hand:**

  ```
  npx supabase functions deploy <name> --project-ref mstibdszibcheodvnprm
  ```

  `.github/workflows/deploy-edge-functions.yml` is meant to auto-deploy on push to `main`, but the
  repo secret `SUPABASE_ACCESS_TOKEN` has never been set, so the workflow hits this guard:

  ```
  if [ -z "$SUPABASE_ACCESS_TOKEN" ]; then
    echo "::warning::SUPABASE_ACCESS_TOKEN not set — skipping deploy."
    exit 0    # <-- green tick, nothing deployed
  fi
  ```

  It is a `::warning::` and an `exit 0`, so **every run reports success while deploying nothing**.
  Measured 2026-08-19 across all 205 runs in the API window (2026-08-03 onward): the "Determine
  changed functions and deploy" step took **0 seconds** on every run sampled, and the token-missing
  annotation is present on the earliest, middle and latest. Run duration varies 14–108s, but that is
  runner and CLI-install overhead — the deploy step itself never did anything. The long runs are the
  trap: they look like real deploys.

  Consequence: the fleet is stale by an unknown amount, and only what someone deployed by hand is
  live. `npx supabase functions list --project-ref mstibdszibcheodvnprm` gives each function's
  `version` and `updated_at` — that, not the commit log, is the truth about what is running.

  To actually fix it: add `SUPABASE_ACCESS_TOKEN` under repo Settings → Secrets and variables →
  Actions. Worth making that guard `exit 1` at the same time, so a missing token fails loudly rather
  than reporting a green tick for a no-op.

  Note `_shared/**` changes redeploy **every** function (~255) by design, since import graphs are not
  parsed — so a shared-module edit is an expensive deploy, not a cheap one.
- **Migrations** — not auto-applied; run `npm run db:push` deliberately.
- Other workflows: `build-print-client.yml`, `repricer-preset-tests.yml`, `supabase-db-lint.yml`.

Work happens directly on `main` — that is the established workflow here.

## Analysing sales data

`sales_orders` carries **two date fields in different timezones**, and mixing them silently corrupts any daily figure:

- `order_date` — **local** (Amazon US default, Pacific). Complete.
- `purchase_timestamp_utc` — **UTC**, as named. NULL on ~10% of rows.

Measured 2026-08-16 over 1,865 rows: **23% land on different calendar days**, every one differing by exactly +1 (a just-after-midnight-UTC order is the previous day in Pacific). Choosing a different field moves roughly a quarter of rows between days — this produced three different answers for "orders today" in one sitting.

**Pick one field per analysis and state which.** Also account for day-of-week before calling anything a slowdown: Sunday averages ~86 orders against Thursday's ~150, so a Sunday compared to a weekday-weighted mean looks like a 23% collapse when it is entirely normal.

## Reference docs

- `docs/module-access-control.md` — source of truth for module permissions
- `docs/realtime-channels.md` — every `supabase.channel(...)` must be scoped and registered here
- `docs/verify-jwt-hardening.md` — cron `verify_jwt` hardening, run via SQL Editor

## Working style in this repo

Edge functions carry **substantial header comments** explaining *why* a design was chosen — cost tradeoffs, bugs previously hit, live-confirmed API behaviour with dates. This is deliberate institutional memory. Match it: when fixing a non-obvious bug, record the reasoning in the file rather than only the fix.

Lovable residue (the scaffold README, `.lovable/`, bun lockfiles, the generic package name) is a normal migration artifact — not a bug to fix reflexively. `.lovable/` holds only markdown notes and memory files; nothing in this repo is wired to Lovable, and the Lovable↔GitHub connection was disconnected on 2026-08-15, so nothing external pushes here. Historical `arbiproseller` references inside `.lovable/` are left alone deliberately — they are a record of what was true when written.
