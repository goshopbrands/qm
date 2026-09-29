# GoShop core patches

This fork carries local changes to core qm files. They are not sent upstream. Every
upstream sync must re-check whether each patch is still needed, because upstream may fix
the same problem in its own way.

## Before merging any upstream update

Run the check against the upstream ref being merged (a release tag such as `v0.1.12`, or
`upstream/main`):

```bash
git fetch upstream --tags
deploy/layers/goshop/check-patches.sh v0.1.12
```

For each patch it reports whether upstream changed the files the patch touches and runs the
patch's retirement probe against upstream alone. Paste its output into the sync PR
description. When a patch is reported as a retire or migrate candidate, follow that patch's
retirement steps below instead of carrying the patch forward. If a merge conflicts in a
file listed here, resolve it with this document open: the conflict usually means upstream
reworked the same code.

Merge release tags (`v0.1.x`), not upstream `main`, unless deliberately taking unreleased
changes.

## Patch 1: the portal relay frames forwarded request bodies

**Status:** routing retired 2026-09-29 in the v0.1.13 sync; body framing active since 2026-09-14.

**History.** This patch originally also forwarded app subdomains (`*.apps.qm.goshopbrands.com`)
from the portal to core on Fly. Upstream v0.1.13 does that itself ("Serve isolated app origins
through the portal ingress": `proxyToAppHost` in `plugins/portal/src/proxy.ts`), keyed on the
same `DEPLOY_APPS_DOMAIN` setting, so the fork's routing was dropped in favour of upstream's.
One behavior differs from the old patch: the bare apps domain (`apps.qm.goshopbrands.com`) now
gets a 404 from the portal.

**Problem.** Upstream's shared `relay` pipes request bodies without framing them, so a body on a
GET, HEAD, DELETE, or OPTIONS request reaches core as a second, smuggled request with arbitrary
headers, including core trust headers such as `x-as-principal`. The app-host route is public, so
without this fix the hole is reachable without signing in.

**Change.** `relay` re-frames every forwarded request body from the incoming `Content-Length` or
`Transfer-Encoding` (`framedHeaders` in `plugins/portal/src/proxy.ts`). Nothing else in the portal
differs from upstream for this patch.

**Files.**

- `plugins/portal/src/proxy.ts`: `framedHeaders`, used by `relay`
- `plugins/portal/test/apps-host-forwarding.test.ts`: outcome tests for the app-host route,
  including the smuggling cases; also the retirement probe

**Deployment settings it relies on** (all upstream settings, unchanged by the routing retirement):

- `publicUrl` `https://qm.goshopbrands.com` in the deployment config
- `env.core.DEPLOY_APPS_DOMAIN`, `env.portal.DEPLOY_APPS_DOMAIN`, and `env.web-ui.DEPLOY_APPS_DOMAIN`
  set to `apps.qm.goshopbrands.com`; core and portal must always change together, and web-ui
  needs it to allow the owner shell to frame its chat panel
- `AWS_DEPLOY_GATE_SECRET` (32+ characters) on `goshop-core`
- `PORTAL_SESSION_SECRET` on `goshop-core`, same value as on `goshop-portal`; the CLI does not
  deliver it to core on Fly, so it is set directly with `fly secrets set`, and it must be
  re-copied whenever the portal's value is rotated
- `PUBLIC_API_URL` stays `https://goshop-portal.fly.dev`: legacy app machines have that URL
  baked into their boot command, so `goshop-portal.fly.dev` must keep routing to the portal
- DNS for `qm.goshopbrands.com` and `*.apps.qm.goshopbrands.com` pointing at `goshop-portal`,
  plus `_acme-challenge` CNAMEs, with Fly certificates for both names on `goshop-portal`

**Retirement signal.** `check-patches.sh` copies the outcome tests into a clean checkout of the
upstream ref, installs that ref's portal dependencies, and runs them. If they all pass, upstream
now frames relayed bodies itself.

**Retirement steps.**

1. Take upstream's version of `plugins/portal/src/proxy.ts`.
2. Keep `plugins/portal/test/apps-host-forwarding.test.ts` as a regression test only if it passes
   on upstream code; otherwise delete it.
3. Remove this section.

## Patch 2: legacy volume-backed Fly deploy provider

**Status:** active since 2026-09-11.

**Problem.** Upstream's current Fly deploy provider has no durable app storage: apps restart
from their code bundle and lose anything written to disk. Four GoShop apps were built on the
earlier volume-backed provider and keep data on Fly volumes mounted at `/data`.

**Change.** A second deploy provider for an explicit list of deployment IDs, keeping their
volumes, short app names, release downloads from `/v1/deploy-releases/:id`, sleep and wake,
and archive and restore. See `docs/fly-legacy-deployments.md`.

**Files.** `docs/fly-legacy-deployments.md`, `src/api/deps.ts`,
`src/api/routes/deploy-releases.ts`, `src/api/routes/index.ts`,
`src/auth/capability-token.ts`, `src/config.ts`, `src/deploy/deploy-service.ts`,
`src/deploy/legacy-fly-deploy-provider.ts`, `src/tools/primitives.ts`, `src/wiring.ts`, and
tests `test/legacy-fly-deploy-provider.test.ts`, `test/deploy-provider-selection.test.ts`,
`test/deploy-release-endpoint.test.ts`, `test/config.test.ts`.

Upstream calls the deploy provider from `src/deploy/deploy-service.ts` in several places; every
call must go through `providerFor(d)`, never `deps.provider` directly, or legacy deployments are
sent to the current provider. v0.1.13 added such a call in `setDeploymentAlwaysOn`, fixed in the
sync and covered by `test/deploy-provider-selection.test.ts`. Check new `deps.provider.` calls in
that file on every sync.

Upstream v0.1.13 added optional durable `/data` volumes for its own Fly provider
(`FLY_DEPLOY_DATA_VOLUME_SIZE_GB`, off by default and described upstream as a prototype). Turning
it on refuses redeploys of apps already published without a volume, so it is left off until the
legacy apps are migrated deliberately.

**Deployment settings.** `FLY_LEGACY_DEPLOYMENT_IDS` as a secret on `goshop-core`. Deploy core with `qm up --build-from=<this checkout>`; plain `qm up` pulls
upstream images that lack this patch.

**Apps and their data.**

| App                     | Fly app                     | Data                                                  |
| ----------------------- | --------------------------- | ----------------------------------------------------- |
| invoice-review          | `goshop-d-ca52a5b388844d8a` | SQLite `/data/app.db`, `/data/mailpass`, `/data/raw/` |
| goshop-tasks            | `goshop-d-49b9c170d50542a2` | `/data/tasks.json`                                    |
| goshop-task-tracker     | `goshop-d-11283a786d0d4dae` | `/data/tasks.json`                                    |
| goshop-weekly-dashboard | `goshop-d-1187602d110d430b` | none; `data.json` ships in the app code               |

The other four IDs in the list are archived test deployments.

**Retirement signal.** Upstream v0.1.13 already has opt-in durable `/data` for its Fly provider,
but documents it as a prototype. `check-patches.sh` reports a migrate candidate when
the `FLY_DEPLOY_DATA_VOLUME_SIZE_GB` paragraph of `docs/qa/fly-published-apps.md` stops calling it a
prototype, and lists upstream commits touching
that provider.

**Retirement steps.**

1. Snapshot every legacy volume and restore each snapshot into a separate volume first.
2. Republish each app on the current provider, copy its `/data` contents into the new
   durable storage, and compare record counts (invoice-review `items` and `runs` tables,
   task counts in `tasks.json`).
3. Remove each migrated ID from `FLY_LEGACY_DEPLOYMENT_IDS`; keep the old Fly apps and volumes
   until the migrated apps are validated, then delete them explicitly.
4. When the list is empty, take upstream's versions of the files above, delete the
   legacy-only files, and remove this section.

## Patch 3: the browse seed skill is removed

**Status:** active since 2026-09-22.

**Problem.** Upstream's `browse` seed skill tells the agent the browser runtime is already
on its computer — "The runtime is already on your computer at `/opt/browser-engine/venv` —
do not pip install." That is true only on the `aws` and `local` sandbox backends, which boot
the `qm-sandbox-base` image that `fly/Dockerfile` builds with `INSTALL_BROWSER_ENGINE=1`.
This deployment runs `SANDBOX_BACKEND=sprites`. Sprites is a managed microVM service that
boots its own stock Ubuntu rootfs; the Sprites API takes no image (`createSprite` accepts
only `ramMB`, `cpus`, `region`, `storageGB`), so `/opt/browser-engine` cannot exist there and
never will under this backend. The same holds for `smolmachines`, `e2b`, and `modal`. Core
installs every directory under `skills-seed/` for every org regardless of backend, so the
agent advertises browsing, accepts the task, creates and bills a real Kernel browser, and
only then dies on `ModuleNotFoundError: browser_use`.

A deployment-layer skill cannot override a live seed skill: a layer skill whose name
collides with a published non-layer skill makes the whole layer PUT fail
(`src/deployment/deployment-layer-store.ts`, `deployment layer skill "…" collides with an
existing non-layer skill`), which would take down every layer tool and connector, not just
browse. Archiving the seed record first does clear that collision — `foreignSkillCollision`
skips archived skills — but it does not help, because `src/skills/seed.ts` re-reviews and
re-publishes an archived seed skill on the next core boot, leaving two published `browse`
skills and breaking the layer again. Deleting the seed directory is the only durable
fork-local gate.

**Change.** `skills-seed/browse/` is deleted. Nothing else is touched, to keep the core diff
to a single directory and the retirement to a single `git checkout`.

Core's browse support stays in place and inert: the orchestrator still injects
`BROWSE_LAB_MAX_STEPS`, `BROWSE_LAB_MODEL`, and `BROWSE_LAB_MODEL_PROVIDER` into sandboxes,
and the admin model settings still offer a browse model. Neither resolves a skill, so neither
errors.

Two references to the skill are knowingly left dangling, because removing them would mean
patching 55 more core files and taking a merge conflict on each at every upstream sync:

- `skills-seed/popular-web-designs/templates/*.md` (54 files) each end with "Verify visual
  accuracy with `browse` after generating." These ride into the sandbox as skill assets, so
  an agent rendering a template is pointed at a skill it will not find. The risk is that it
  hunts for the skill, or installs `browser-use` by hand — the very thing this patch exists
  to prevent.
- `plugins/admin/public/index.html` still describes the service-credential delivery picker's
  browser-provider key as being "for the browse skill".

If the template line proves to cause real confusion, remove it in a follow-up patch rather
than folding it into this one.

**One-time operator step.** Deleting the directory stops future installs but does not archive
the record already published in Postgres — the seed installer only ever upserts. Archive the
existing org-scoped `browse` skill once, from the admin Skills tab. It stays archived,
because with the seed directory gone nothing re-publishes it.

**Files.** `skills-seed/browse/` (deleted).

**Deployment settings it relies on.** Deploy core with `qm up --build-from=<this checkout>`.
The deletion only reaches a deployment through `deploy/core/Dockerfile`'s
`COPY skills-seed ./skills-seed`; a plain `qm up` pulls the upstream image, which still ships
`skills-seed/browse`, and its next boot re-publishes the archived record and silently undoes
the one-time step below.

**Retirement signal.** `check-patches.sh` reads upstream's `skills-seed/browse/SKILL.md` and
reports a retire candidate when the unconditional pre-baked-runtime claim is gone — that is,
when upstream has either gated the skill by backend or pointed it at a bootstrap that
installs the runtime on imageless machines. It also lists upstream commits touching the skill
and `fly/Dockerfile`.

**Retirement steps.**

1. Restore upstream's `skills-seed/browse/` (`git checkout <ref> -- skills-seed/browse`).
2. Boot a fresh sprite and confirm the runner reaches
   `{"outcome":"done","answer":"…"}` against `https://example.com` — upstream's fix has to
   work on an imageless backend, not just compile.
3. Un-archive the `browse` skill in the admin Skills tab.
4. Remove this section.

**Merge conflicts.** Because this patch deletes a core directory, any upstream edit to a file
under `skills-seed/browse/` arrives as a modify/delete conflict (`deleted by us`). Keep the
deletion — `git rm -r skills-seed/browse` — unless `check-patches.sh` reports a retire
candidate. This is the one place where the `update-qm` skill's usual "resolve core conflicts
in upstream's favour" rule does not apply.

**If browse is wanted back before upstream fixes it.** The bootstrap belongs in a layer
_tool_, not a layer skill: `install.files` converge by content hash on every provision and
reach imageless machines, and tools do not collide with seed skill names. That needs this
deployment's `sandbox/` directory (absent today, so `up` currently skips layer sync
entirely), plus confirmation that the stock sprite image has `python3-venv` and that
`pypi.org` and `files.pythonhosted.org` pass the egress proxy. The skill text would still
need a core patch, since a layer cannot override a live seed skill by name.

## Patch 4: org manager role

**Status:** active since 2026-09-25.

**Change.** A second grant role, `org_manager`, alongside upstream's `org_admin`. A manager has
an org admin's powers, in the dashboard and through the agent, except in two areas.

- **No role escalation.** Managers cannot grant or revoke roles (including inviting an external
  user as org admin), impersonate, invite teammates (the response can return a working sign-in
  link for any email, including an existing admin's), or create or delete principal links
  (linking a sign-in onto an admin makes that sign-in the admin).
- **Privacy.** Conversation data is limited to scopes they could read as a member (upstream's
  `canReadScope`: org-wide, public channels, and private channels, group DMs, and DMs they
  belong to). Org-wide logs need a specific scope. They cannot read raw model requests
  (including those attached to deliveries in transcripts), the keychain, security flags, the
  Slack mirror, ambient judgments, or ack-emoji picks, reset or edit another user's personal
  data, or use another scope's sandbox through the agent (`canUseSandboxScope`).

Also under privacy: the auto-flagger test (it samples every scope's recent messages) stays org
admin only, and the powers below are fenced to what the manager can read. Promoting a skill
org-wide needs its source scope to be readable, skill-pack import targets must be readable,
only the person who registered a pack can change its `url` or `ref` (the pack fetches with its
creator's GitHub login), and cron output can go only to a readable channel, the manager, or the
cron's owner, with no client-supplied audience. A manager changing an existing service
credential, custom provider, or authenticated MCP server must re-enter its secret, so they
cannot redirect a secret someone else entered; a per-user MCP server they set must live on its
credential host, since it receives each caller's own token.

Everything else is allowed, decided 2026-09-29: org-wide settings, Spend, cron output
destinations and model runtimes for crons in scopes they can read, skill-pack import, sync, and
edit, broker session revocation, promoting a skill org-wide, and unattended cron grants. A
manager's agent has the same API access, but the orchestrator's "Acting for an org admin" prompt
(which tells the agent it may work around refusals) and its org-memory self-write stay org admin
only.

Known risk: a manager can write org-wide skills, org memory, and synced packs that reach every
agent turn, including org admins', so a malicious manager could try prompt injection against an
admin's agent; the audit log records who wrote them.

Org admins are unchanged. Roles are granted in the dashboard's Users view; `ADMIN_GRANTS` also
accepts `:org_manager`.

Enforcement sits in `authorizeAdmin`, which every admin route calls, dashboard or agent. For
managers it looks up the request in the table in `src/admin/manager-access.ts`. Every admin route
is classified there as `allow`, `deny`, a scope check, or `narrowed` (the handler filters or
checks the record itself). A route missing from the table is refused to managers, so an upstream
route added later stays org-admin only until someone classifies it.

**Files.** `src/admin/manager-access.ts` (new), `src/admin/admin-grant-store.ts`,
`src/admin/admin-service.ts`, `src/api/routes/shared.ts`, `src/api/routes/admin/common.ts`,
`src/api/routes/admin/scope-config.ts`, `src/api/routes/admin/memory.ts`,
`src/api/routes/admin/files.ts`, `src/api/routes/admin/artifacts.ts`,
`src/api/routes/admin/users.ts`, `src/api/routes/admin/sessions.ts` (no raw model requests for
managers), `src/api/routes/skill-packs.ts` (readable import targets; pack source changes by its
creator only), `src/api/app-sessions.ts` (promotion from readable scopes), `src/core/orchestrator.ts` (admin
prompt for org admins only), `src/api/routes/admin-resources.ts`,
`src/api/routes/admin/custom-providers.ts`, and `src/api/routes/admin/mcp-servers.ts` (secret
re-entry), `src/api/routes/admin/principal-links.ts` (an org admin sign-in cannot be linked onto a
non-admin identity), `src/wiring.ts` (`canUseSandboxScope` bypass is org admin only),
`plugins/portal/src/index.ts` (impersonation needs `org_admin`; the admin-login link checks
`isAdmin` on the probe result), `plugins/admin/public/index.html` (role from whoami; managers get
no "open web UI as" buttons), `plugins/admin/ui/users.ts` (Make manager; Revoke removes both
roles; no role, impersonation, or teammate invite controls for managers),
`plugins/admin/ui/user-detail.ts` (the keychain card is hidden when refused), and tests
`test/admin-manager-role.test.ts`, `plugins/portal/test/router.test.ts`,
`plugins/portal/test/admin-login-role.test.ts`, `plugins/admin/test/manager-users-view.test.ts`.

**On every upstream sync.** `check-patches.sh` lists admin routes and admin-status checks that
upstream added. For each one, ask the operator whether managers should get it, then add the
route to `src/admin/manager-access.ts` accordingly. `test/admin-manager-role.test.ts` fails
while any `/v1/admin` route is unclassified. Checks that are not routes (anything new that
calls `adminStatusOf`, reads `.isAdmin`, or probes admin status in the portal or plugins)
are not caught by that test, so read those diff lines and decide whether the new behavior
should require `role === "org_admin"`.

**Retirement signal.** `check-patches.sh` reports a retire candidate when upstream's
`AdminRole` gains a role besides `org_admin`, meaning upstream may have its own tiered
admin roles.

**Retirement steps.**

1. Map existing `org_manager` grants onto upstream's equivalent role, if one fits.
2. Take upstream's versions of the files above and delete `src/admin/manager-access.ts` and
   `test/admin-manager-role.test.ts`.
3. Remove this section.
