#!/usr/bin/env bash
set -euo pipefail

ref="${1:-}"
if [ -z "$ref" ]; then
  echo "usage: deploy/layers/goshop/check-patches.sh <upstream-ref>   e.g. v0.1.12 or upstream/main" >&2
  exit 2
fi

root="$(git rev-parse --show-toplevel)"
cd "$root"
git rev-parse --verify --quiet "$ref^{commit}" >/dev/null || {
  echo "unknown ref $ref — run: git fetch upstream --tags" >&2
  exit 2
}
base="$(git merge-base HEAD "$ref")"
review=0

upstream_touches() {
  git log --oneline "$base..$ref" -- "$@"
}

report_touches() {
  local changes
  changes="$(upstream_touches "$@")"
  if [ -n "$changes" ]; then
    echo "  upstream changed files this patch touches since $(git rev-parse --short "$base"):"
    echo "$changes" | sed 's/^/    /'
    review=1
  else
    echo "  upstream has not changed the files this patch touches"
  fi
}

echo "== Patch 1: portal forwards app subdomains to core"
report_touches plugins/portal/src/index.ts plugins/portal/src/proxy.ts
tree="$(mktemp -d)"
trap 'git worktree remove --force "$tree" >/dev/null 2>&1 || true; rm -rf "$tree"' EXIT
git worktree add --detach --quiet "$tree" "$ref"
cp plugins/portal/test/apps-host-forwarding.test.ts "$tree/plugins/portal/test/"
ln -s "$root/node_modules" "$tree/node_modules"
if (cd "$tree/plugins/portal" && node --test test/apps-host-forwarding.test.ts >/dev/null 2>&1); then
  echo "  RETIRE CANDIDATE: $ref passes the outcome tests without this patch — upstream appears to route app subdomains itself"
  review=1
else
  echo "  still needed: $ref fails the outcome tests without this patch"
fi

echo "== Patch 2: legacy volume-backed Fly deploy provider"
report_touches src/api/deps.ts src/api/routes/deploy-releases.ts src/api/routes/index.ts src/auth/capability-token.ts \
  src/config.ts src/deploy/deploy-service.ts src/tools/primitives.ts src/wiring.ts
if git show "$ref:src/deploy/fly-deploy-provider.ts" 2>/dev/null | grep -Eq 'profile: \{[^}]*dataDir'; then
  echo "  MIGRATE CANDIDATE: $ref's Fly deploy provider now offers durable app data (dataDir) — the legacy apps can move onto it"
  review=1
else
  echo "  still needed: $ref's Fly deploy provider has no durable app data"
fi

if [ "$review" = 1 ]; then
  echo
  echo "Review deploy/layers/goshop/PATCHES.md before merging this update."
fi
