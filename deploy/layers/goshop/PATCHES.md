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
