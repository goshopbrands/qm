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

## Patch 1: portal forwards app subdomains to core

**Status:** code merged 2026-09-14; takes effect once the deployment settings below are applied.

**Problem.** Upstream serves published apps signed-in at `/d/<app>/` under a sandbox
content-security policy. The sandbox gives the page an opaque origin, so the app's own
`fetch()` calls to its API or data files fail in the browser and data-driven apps render
empty. Upstream's remedy is `DEPLOY_APPS_DOMAIN`, which serves each app on its own
subdomain through core's `proxyDeploymentSubdomain`. On the Fly target core is private and
the portal is the only public ingress, and upstream's portal ignores the `Host` header, so
app subdomains never reach core.

**Change.** The portal forwards any request whose `Host` is under `DEPLOY_APPS_DOMAIN`
(or `PORTAL_APPS_DOMAIN`) straight to core, preserving `Host`, cookies, and body, and
dropping hop-by-hop headers and core trust headers (`x-signature`, `x-timestamp`,
`x-as-principal`, `x-admin-actor`, `x-agent-capability`, `x-portal-identity`). Host matching
mirrors core's `proxyDeploymentSubdomain` exactly. Sign-in, sharing, and cookie stripping
before the app all remain upstream core behavior. No new settings, URLs, or stored data were
introduced.

The portal's shared `relay` also now re-frames every forwarded request body from the
incoming `Content-Length` or `Transfer-Encoding`. Upstream's `relay` pipes bodies without
framing, so a body on a GET, HEAD, DELETE, or OPTIONS request reaches core as a second,
smuggled request with arbitrary headers. Upstream only exposes that behind portal sign-in;
the app-host route would expose it publicly. Keep this part until upstream frames bodies
itself; the outcome tests cover it.

**Files.**

- `plugins/portal/src/proxy.ts`: `isAppsHost`, `proxyToAppsHost`, `framedHeaders` used by `relay`
- `plugins/portal/src/index.ts`: first line of `handle()` and the import
- `plugins/portal/test/apps-host-forwarding.test.ts`: outcome tests, which also serve as the
  retirement probe

**Deployment settings it relies on** (all upstream settings):

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
  plus `_acme-challenge` CNAMEs, with Fly certificates for both names on `goshop-portal`; the
  certificates must be verified before deploying the settings above

**Retirement signal.** `check-patches.sh` copies the outcome tests into a clean checkout of
the upstream ref and runs them. If they pass without this patch, upstream now routes app
subdomains itself. Upstream may instead fix it by giving core its own public ingress on
Fly; the probe would still fail, but the script also lists upstream commits touching the
portal files and release notes will mention it. Either way the settings and app URLs above
stay upstream's, so retirement needs no data or URL migration.

**Retirement steps.**

1. Take upstream's versions of `plugins/portal/src/proxy.ts` and `plugins/portal/src/index.ts`.
2. Delete `plugins/portal/test/apps-host-forwarding.test.ts` if upstream has its own coverage,
   otherwise keep it as a regression test only if it passes on upstream code.
3. If upstream's fix points the wildcard at a different Fly app, move the
   `*.apps.qm.goshopbrands.com` certificate and DNS record to it.
4. Deploy, then open an app at `https://<app>.apps.qm.goshopbrands.com/` and confirm its data loads.
5. Remove this section.

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

**Retirement signal.** `check-patches.sh` reports a migrate candidate when upstream's
`src/deploy/fly-deploy-provider.ts` mentions `dataDir`, meaning upstream Fly apps may get
durable storage, and lists upstream commits touching that provider.

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

**Change.** A second grant role, `org_manager`, alongside upstream's `org_admin`. Managers use
the admin dashboard, with three differences from an org admin: they cannot grant or revoke
roles (including inviting an external user as org admin), they cannot impersonate, and
conversation data is limited to scopes they could read as a member (upstream's
`canReadScope`: org-wide, public channels, and private channels, group DMs, and DMs they
belong to). Managers also cannot reset or edit another user's personal data, redirect cron
output, import or sync skill packs into scopes, read raw model requests, or use admin powers
through the agent (the orchestrator, agent API listing, and unattended cron grants treat only
`org_admin` as an admin). Managers keep org-wide settings (providers, models, MCP servers,
Slack app, org instructions and memory, egress, credentials): decided 2026-09-25, relying on
the audit log. Org admins are unchanged. Roles are granted in the dashboard's Users view;
`ADMIN_GRANTS` also accepts `:org_manager`.

Enforcement sits in `authorizeAdmin`, which every admin route calls. For managers it looks up
the request in the table in `src/admin/manager-access.ts`. Every admin route is classified
there as `allow`, `deny`, a scope check, or `narrowed` (the handler filters or checks the
record itself). A route missing from the table is refused to managers, so an upstream route
added later stays org-admin only until someone classifies it.

**Files.** `src/admin/manager-access.ts` (new), `src/admin/admin-grant-store.ts`,
`src/admin/admin-service.ts`, `src/api/routes/shared.ts`, `src/api/routes/admin/common.ts`,
`src/api/routes/admin/scope-config.ts`, `src/api/routes/admin/memory.ts`,
`src/api/routes/admin/files.ts`, `src/api/routes/admin/artifacts.ts`,
`src/api/routes/admin/users.ts`, `src/api/routes/admin/sessions.ts`, `src/core/orchestrator.ts`,
`src/api/routes/surface.ts`, `src/api/control-service.ts`, `src/wiring.ts` (`canUseSandboxScope` bypass is org admin
only), `plugins/portal/src/index.ts` (impersonation needs `org_admin`),
`plugins/admin/public/index.html`, and tests `test/admin-manager-role.test.ts`,
`plugins/portal/test/router.test.ts`.

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
