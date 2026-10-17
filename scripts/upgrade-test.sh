#!/usr/bin/env bash
# The upgrade path test. An older release migrates an empty database and fills it with a workspace
# through its own server code (scripts/upgrade/seed.ts, which also writes down what that release
# reads back); then this checkout's migrations upgrade the database, and scripts/upgrade-e2e.ts
# checks with this checkout's code that nothing was lost or changed and that the schema is the one a
# fresh install gets.
#
#   DATABASE_URL=postgres://leafdesk:leafdesk@localhost:5432/leafdesk_upg \
#   FRESH_DATABASE_URL=postgres://leafdesk:leafdesk@localhost:5432/leafdesk_upg_fresh \
#     scripts/upgrade-test.sh [tag] [pnpm install flags...]
#
# tag: the release to upgrade from, $UPGRADE_FROM or else v0.5.0. It has to be fetched (CI:
#   actions/checkout with fetch-depth: 0).
# pnpm install flags: passed to the older release's `pnpm install --frozen-lockfile`, e.g. --offline
#   when its packages are in the local store already.
# DATABASE_URL, FRESH_DATABASE_URL: two empty databases. The first is left upgraded, so other e2e
#   scripts can run on it afterwards; the second gets a fresh install to compare the schema with.
# UPGRADE_WORK_DIR: where the older release is unpacked (and kept, so later runs reuse its
#   node_modules) and this run's files go: the manifest, the table dump, the uploaded files. By
#   default leafdesk-upgrade/<tag> in $RUNNER_TEMP, $TMPDIR or /tmp.
# BETTER_AUTH_SECRET and APP_URL are set to test values unless given.
set -euo pipefail

from="${1:-${UPGRADE_FROM:-v0.5.0}}"
if [ $# -gt 0 ]; then shift; fi
root="$(cd "$(dirname "$0")/.." && pwd)"
temp="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
work="${UPGRADE_WORK_DIR:-${temp%/}/leafdesk-upgrade/$from}"
release="$work/release"
run="$work/run"

: "${DATABASE_URL:?set DATABASE_URL to an empty database, the one to upgrade}"
: "${FRESH_DATABASE_URL:?set FRESH_DATABASE_URL to another empty database, for a fresh install}"
if [ "$DATABASE_URL" = "$FRESH_DATABASE_URL" ]; then
  echo "DATABASE_URL and FRESH_DATABASE_URL must be two different databases" >&2
  exit 1
fi
# Both releases get the same values: API tokens and sessions depend on the secret.
export BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET:-upgrade-test-secret-6c1f0b2e9d4a47c8b3e5f1a2d7c9e0b4}"
export APP_URL="${APP_URL:-http://localhost:3000}"
# Absolute, so the upgraded release finds the files the older one stored.
export UPLOAD_DIR="$run/uploads"
export STORAGE_DRIVER=local
export NEXT_TELEMETRY_DISABLED=1

tsx="$root/node_modules/.bin/tsx"
started=$SECONDS
step() { printf '\n== %s (%ss)\n' "$1" "$((SECONDS - started))"; }

step "Checking that both databases are empty"
"$tsx" "$root/scripts/upgrade-e2e.ts" --empty

commit="$(git -C "$root" rev-parse --verify "$from^{commit}")"
if [ "$(cat "$release/.upgrade-commit" 2>/dev/null)" != "$commit" ]; then
  step "Unpacking $from ($commit) into $release"
  rm -rf "$release"
  mkdir -p "$release"
  git -C "$root" archive "$commit" | tar -x -C "$release"
  echo "$commit" > "$release/.upgrade-commit"
fi

step "Installing $from's packages"
(cd "$release" && pnpm install --frozen-lockfile "$@")

step "Migrating the empty database with $from"
(cd "$release" && node_modules/.bin/tsx scripts/migrate.ts)

step "Filling it through $from's code"
rm -rf "$run"
mkdir -p "$run"
cp "$root/scripts/upgrade/seed.ts" "$release/scripts/upgrade-seed.ts"
(cd "$release" && node_modules/.bin/tsx scripts/upgrade-seed.ts "$run/manifest.json")

step "Writing down every table"
"$tsx" "$root/scripts/upgrade-e2e.ts" --dump "$run/before.json"

step "Upgrading it with this checkout's migrations"
(cd "$root" && pnpm db:migrate)

step "Installing this checkout into the fresh database"
(cd "$root" && DATABASE_URL="$FRESH_DATABASE_URL" pnpm db:migrate)

step "Checking the upgraded database with this checkout's code"
"$tsx" "$root/scripts/upgrade-e2e.ts" "$run/manifest.json" "$run/before.json"

step "Upgrade from $from passed"
