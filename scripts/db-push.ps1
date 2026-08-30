# Apply pending Supabase migrations.
#
# WHY THIS EXISTS
# ---------------
# `npm run db:push` fails on a fresh machine with:
#
#   WARN: environment variable is unset: SEND_EMAIL_HOOK_SECRET
#   Invalid hook config: auth.hook.send_email.secrets must be formatted as
#   "v1,whsec_<base64_encoded_secret>" with a minimum length of 32 characters.
#
# supabase/config.toml declares an auth hook whose secret comes from
# env(SEND_EMAIL_HOOK_SECRET). The real value lives in Supabase's own auth
# service (Authentication -> Hooks -> Send Email) and deliberately is not in
# this repo. The CLI validates the WHOLE config before running any command, so
# it aborts before it reaches a single migration.
#
# WHY A PLACEHOLDER IS SAFE HERE
# ------------------------------
# The CLI only checks the FORMAT of that string: the prefix, base64 body, and a
# 32-character minimum. For `db push` the value is never used and never sent
# anywhere -- the push applies migration SQL and nothing else.
#
# It would matter for `supabase config push`, which uploads local config and
# would overwrite the real hook secret. That is exactly why this is set INSIDE
# this script rather than committed to .env, where it would silently apply to
# every CLI command including that one.
#
# The placeholder below is 32 'A's -- valid base64, obviously not a credential.

$ErrorActionPreference = 'Stop'
$env:SEND_EMAIL_HOOK_SECRET = 'v1,whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

Write-Host ''
Write-Host 'Applying pending migrations...' -ForegroundColor Cyan
Write-Host ''

npx supabase db push

Write-Host ''
if ($LASTEXITCODE -eq 0) {
  Write-Host 'All migrations applied.' -ForegroundColor Green
} else {
  Write-Host 'Push stopped. Read the migration name in the error above --' -ForegroundColor Yellow
  Write-Host 'the failure is in that file, not necessarily the last one listed.'
  Write-Host ''
  Write-Host 'Known intentional stop: 20260827120002 refuses to run until a'
  Write-Host 'broadcast has been observed. Toggle a padlock on the Repricer'
  Write-Host '(unlock code 1365), then run this again.'
}
Write-Host ''
