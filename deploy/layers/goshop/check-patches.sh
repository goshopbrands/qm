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

echo "== Patch 1: the portal relay frames forwarded request bodies"
report_touches plugins/portal/src/proxy.ts
tree="$(mktemp -d)"
trap 'git -C "$root" worktree remove --force "$tree" >/dev/null 2>&1 || true; rm -rf "$tree"' EXIT
git worktree add --detach --quiet "$tree" "$ref"
cp plugins/portal/test/apps-host-forwarding.test.ts "$tree/plugins/portal/test/"
ln -s "$root/node_modules" "$tree/node_modules"
status=0
if (cd "$tree/plugins/portal" && npm ci --ignore-scripts --no-audit --no-fund --silent >/dev/null 2>&1); then
  output="$(cd "$tree/plugins/portal" && node --test test/apps-host-forwarding.test.ts 2>&1)" || status=$?
else
  status=1
  output="could not install $ref's portal dependencies (npm ci failed; network?)"
fi
passed="$(printf '%s\n' "$output" | sed -n 's/^ℹ pass \([0-9]*\)$/\1/p')"
failed="$(printf '%s\n' "$output" | sed -n 's/^ℹ fail \([0-9]*\)$/\1/p')"
if [ "$status" = 0 ]; then
  echo "  RETIRE CANDIDATE: $ref passes the outcome tests without this patch — upstream appears to frame relayed bodies itself"
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
  src/deploy/deploy-service.ts src/deploy/shared-deploy-provider.ts src/tools/primitives.ts src/wiring.ts
provider="$(git show "$ref:src/deploy/fly-deploy-provider.ts" 2>/dev/null || true)"
qa="$(git show "$ref:docs/qa/fly-published-apps.md" 2>/dev/null || true)"
if [ -z "$provider" ]; then
  echo "  PROBE ERROR: $ref has no src/deploy/fly-deploy-provider.ts — upstream reorganized Fly deploys; inspect before deciding"
  review=1
elif grep -q dataDir <<<"$provider" && grep FLY_DEPLOY_DATA_VOLUME_SIZE_GB <<<"$qa" | grep -qi prototype; then
  echo "  still needed: $ref's durable Fly app data is still an opt-in prototype (docs/qa/fly-published-apps.md)"
elif grep -q dataDir <<<"$provider"; then
  echo "  MIGRATE CANDIDATE: $ref's durable Fly app data is no longer described as a prototype — plan the legacy app migration"
  review=1
else
  echo "  still needed: $ref's Fly deploy provider has no durable app data"
fi
direct_calls="$(git diff "$base" "$ref" -- src/deploy/deploy-service.ts | grep -E '^\+.*deps\.provider\.' || true)"
if [ -n "$direct_calls" ]; then
  echo "  upstream added deploy provider calls that bypass providerFor; route each through providerFor(d):"
  printf '%s\n' "$direct_calls" | sed 's/^/    /'
  review=1
fi
shared="$(git show "$ref:src/deploy/shared-deploy-provider.ts" 2>/dev/null || true)"
if grep -q "export function appReporter" <<<"$shared"; then
  echo "  ADOPT CANDIDATE: $ref reports app start failures through appReporter and appLogs (src/deploy/shared-deploy-provider.ts) — wire the legacy provider into them and drop its exit-code diagnosis"
  review=1
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
if git show "$ref:src/skills/seed.ts" 2>/dev/null | grep -q respectArchived; then
  echo "  RETIRE OPTION: $ref keeps admin-archived seed skills archived — restoring the directory is safe once production's browse record is confirmed archived"
fi

echo "== Patch 4: org manager role"
report_touches src/admin/admin-service.ts src/admin/admin-grant-store.ts src/api/routes/shared.ts \
  src/api/routes/admin src/api/routes/admin.ts src/api/routes/skill-packs.ts src/wiring.ts \
  src/core/orchestrator.ts src/api/control-service.ts src/api/routes/surface.ts src/api/routes/auth-broker.ts \
  src/api/routes/deployments.ts src/api/server.ts src/api/app-sessions.ts src/api/routes/admin-resources.ts plugins/portal/src/index.ts \
  plugins/admin/public/index.html plugins/admin/ui/users.ts plugins/admin/ui/user-detail.ts
new_routes="$(git diff "$base" "$ref" -- src/api/routes | grep -E '^\+.*"/v1/admin' || true)"
if [ -n "$new_routes" ]; then
  echo "  upstream added or changed admin routes; ask whether managers should get each, then classify it in src/admin/manager-access.ts:"
  printf '%s\n' "$new_routes" | sed 's/^/    /'
  review=1
fi
resources_status=0
unclassified_resources="$(node --input-type=module -e '
const [tree, root] = process.argv.slice(1);
const { ADMIN_RESOURCES } = await import(`${tree}/src/api/routes/admin-resources.ts`);
const { MANAGER_RESOURCES } = await import(`${root}/src/admin/manager-access.ts`);
for (const r of ADMIN_RESOURCES) if (!MANAGER_RESOURCES.has(r.id)) console.log(r.id);
' "$tree" "$root" 2>&1)" || resources_status=$?
if [ "$resources_status" != 0 ]; then
  echo "  PROBE ERROR: could not load $ref's admin resources — inspect before deciding:"
  printf '%s\n' "$unclassified_resources" | tail -10 | sed 's/^/    /'
  review=1
elif [ -n "$unclassified_resources" ]; then
  echo "  $ref has admin resources missing from MANAGER_RESOURCES; ask whether managers should get each, then classify it:"
  printf '%s\n' "$unclassified_resources" | sed 's/^/    /'
  review=1
fi
new_checks="$(git diff "$base" "$ref" -- src plugins | grep -E '^\+.*(adminStatusOf|adminStatusFromGrants|canAdminister|\.isAdmin\b|org_admin|actorIsOrgAdmin|adminProbe|authorizeAdmin|requireScopedAdmin)' || true)"
if [ -n "$new_checks" ]; then
  echo "  upstream added admin-status checks; decide whether each should require role org_admin:"
  printf '%s\n' "$new_checks" | sed 's/^/    /'
  review=1
fi
roles="$(git show "$ref:src/admin/admin-grant-store.ts" 2>/dev/null | grep -E 'AdminRole =' || true)"
if [ -z "$roles" ]; then
  echo "  PROBE ERROR: $ref has no AdminRole in src/admin/admin-grant-store.ts; inspect before deciding"
  review=1
elif grep -q '"org_admin";' <<<"$roles"; then
  echo "  still needed: $ref has a single admin role"
else
  echo "  RETIRE CANDIDATE: $ref's AdminRole is now: $roles"
  review=1
fi

echo "== Patch 5: a broker call without its credential handle explains itself"
report_touches plugins/portal/src/index.ts src/api/server.ts src/api/git-http-broker.ts src/api/credential-broker.ts \
  src/auth/capability-token.ts src/api/agent-api-catalog.ts skills-seed/use-shared-credential
upstream_portal="$(git show "$ref:plugins/portal/src/index.ts" 2>/dev/null || true)"
upstream_skill="$(git show "$ref:skills-seed/use-shared-credential/SKILL.md" 2>/dev/null || true)"
if [ -z "$upstream_portal" ] || [ -z "$upstream_skill" ]; then
  echo "  PROBE ERROR: $ref has no plugins/portal/src/index.ts or skills-seed/use-shared-credential/SKILL.md; inspect before deciding"
  review=1
else
  fixed=""
  grep -q '/v1/credentials/broker' <<<"$upstream_portal" && fixed="$fixed portal-routes-broker"
  git grep -qiE 'capability token required.*handle' "$ref" -- src/api/server.ts src/auth/capability-token.ts && fixed="$fixed core-401-names-handle"
  git grep -qF 'this session is not entitled to that credential' "$ref" -- src/api/credential-broker.ts || fixed="$fixed not-entitled-reworded"
  grep -q '401' <<<"$upstream_skill" && fixed="$fixed skill-explains-401"
  if [ -n "$fixed" ]; then
    echo "  RETIRE CANDIDATE: $ref changed:$fixed; follow Patch 5's retirement steps for those parts"
    review=1
  else
    echo "  still needed: $ref's portal 404s a broker call without a token, core's 401 and 403 do not name the handle, and the skill does not explain a 401"
  fi
fi

echo "== Patch 6: Fly volumes being destroyed are not counted as live"
report_touches src/deploy/fly-deploy-provider.ts
if [ -z "$provider" ]; then
  echo "  PROBE ERROR: $ref has no src/deploy/fly-deploy-provider.ts — inspect before deciding"
  review=1
elif grep -q pending_destroy <<<"$provider"; then
  echo "  RETIRE CANDIDATE: $ref's Fly deploy provider handles pending_destroy volumes; follow Patch 6's retirement steps"
  review=1
else
  echo "  still needed: $ref's Fly deploy provider counts volumes Fly is still destroying"
fi

if [ "$review" = 1 ]; then
  echo
  echo "Review deploy/layers/goshop/PATCHES.md before merging this update."
fi
