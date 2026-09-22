#!/usr/bin/env bash
set -euo pipefail

ref="${1:-}"
if [ -z "$ref" ]; then
  echo "usage: deploy/layers/goshop/check-patches.sh <upstream-ref>   e.g. v0.1.12 or upstream/main" >&2
  exit 2
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$root"
git rev-parse --verify --quiet "$ref^{commit}" >/dev/null || {
  echo "unknown ref $ref — run: git fetch upstream --tags" >&2
  exit 2
}
[ -d "$root/node_modules" ] || {
  echo "run npm ci in $root first; the probe needs its node_modules" >&2
  exit 2
}
base="$(git merge-base HEAD "$ref")"
review=0

report_touches() {
  local changes
  changes="$(git log --oneline "$base..$ref" -- "$@")"
  if [ -n "$changes" ]; then
    echo "  upstream changed files this patch depends on since $(git rev-parse --short "$base"):"
    printf '%s\n' "$changes" | sed 's/^/    /'
    review=1
  else
    echo "  upstream has not changed the files this patch depends on"
  fi
}

echo "== Patch 1: portal forwards app subdomains to core"
report_touches plugins/portal/src/index.ts plugins/portal/src/proxy.ts src/api/routes/deployments.ts src/api/server.ts
tree="$(mktemp -d)"
trap 'git -C "$root" worktree remove --force "$tree" >/dev/null 2>&1 || true; rm -rf "$tree"' EXIT
git worktree add --detach --quiet "$tree" "$ref"
cp plugins/portal/test/apps-host-forwarding.test.ts "$tree/plugins/portal/test/"
ln -s "$root/node_modules" "$tree/node_modules"
status=0
output="$(cd "$tree/plugins/portal" && node --test test/apps-host-forwarding.test.ts 2>&1)" || status=$?
passed="$(printf '%s\n' "$output" | sed -n 's/^ℹ pass \([0-9]*\)$/\1/p')"
failed="$(printf '%s\n' "$output" | sed -n 's/^ℹ fail \([0-9]*\)$/\1/p')"
if [ "$status" = 0 ]; then
  echo "  RETIRE CANDIDATE: $ref passes the outcome tests without this patch — upstream appears to route app subdomains itself"
  review=1
elif [ -n "$passed" ] && [ -n "$failed" ] && [ "$passed" -gt 0 ] && [ "$failed" -gt 0 ] && printf '%s\n' "$output" | grep -q AssertionError; then
  echo "  still needed: $ref fails $failed of the outcome tests without this patch"
else
  echo "  PROBE ERROR: the outcome tests could not run against $ref — inspect before deciding:"
  printf '%s\n' "$output" | tail -20 | sed 's/^/    /'
  review=1
fi

echo "== Patch 2: legacy volume-backed Fly deploy provider"
report_touches src/deploy/fly-deploy-provider.ts src/deploy/deploy-provider.ts src/api/deps.ts \
  src/api/routes/deploy-releases.ts src/api/routes/index.ts src/auth/capability-token.ts src/config.ts \
  src/deploy/deploy-service.ts src/tools/primitives.ts src/wiring.ts
provider="$(git show "$ref:src/deploy/fly-deploy-provider.ts" 2>/dev/null || true)"
if [ -z "$provider" ]; then
  echo "  PROBE ERROR: $ref has no src/deploy/fly-deploy-provider.ts — upstream reorganized Fly deploys; inspect before deciding"
  review=1
elif grep -q dataDir <<<"$provider"; then
  echo "  MIGRATE CANDIDATE: $ref's Fly deploy provider mentions dataDir — upstream Fly apps may now get durable storage"
  review=1
else
  echo "  still needed: $ref's Fly deploy provider has no durable app data"
fi

echo "== Patch 3: the browse seed skill is removed"
report_touches skills-seed/browse fly/Dockerfile .github/workflows/release-package.yml
skill="$(git show "$ref:skills-seed/browse/SKILL.md" 2>/dev/null || true)"
if [ -z "$skill" ]; then
  echo "  PROBE ERROR: $ref has no skills-seed/browse/SKILL.md — upstream removed or renamed the skill; inspect before deciding"
  review=1
elif grep -q "do not pip install" <<<"$skill" && grep -q "/opt/browser-engine/venv" <<<"$skill"; then
  echo "  still needed: $ref still tells the agent the runtime is already at /opt/browser-engine/venv"
else
  echo "  RETIRE CANDIDATE: $ref no longer makes the unconditional pre-baked-runtime claim — check whether it now gates by backend or bootstraps the runtime, and verify on a fresh sprite"
  review=1
fi

if [ "$review" = 1 ]; then
  echo
  echo "Review deploy/layers/goshop/PATCHES.md before merging this update."
fi
