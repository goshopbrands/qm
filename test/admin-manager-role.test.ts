import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp, serverDeps } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import { adminStatusFromGrants, parseAdminGrants } from "../src/admin/admin-service.ts";
import { managerAccessFor, managerRefusal } from "../src/admin/manager-access.ts";
import { adminRoutes } from "../src/api/routes/admin.ts";
import { skillPackRoutes } from "../src/api/routes/skill-packs.ts";
import { apiRoutes, rawRoutes } from "../src/api/routes/index.ts";

const ORG = "org:default-org";
const ALICE = { id: "admin-alice", type: "internal" as const };
const MANAGER = "mgr-mia";
const OTHER = "user-uma";

async function start() {
  const config = testConfig({ dataDir: mkdtempSync(join(tmpdir(), "admin-manager-")) });
  const built = buildApp(config);
  await built.admin.createGrant(ALICE, { principalId: MANAGER, role: "org_manager", scopeId: ORG });
  await built.directory.replaceChannels(
    [
      { channelId: "CPUB", name: "general", isPrivate: false },
      { channelId: "CLEADS", name: "leads", isPrivate: true },
      { channelId: "CHR", name: "hr", isPrivate: true },
    ],
    [
      { channelId: "CPUB", principalId: OTHER },
      { channelId: "CLEADS", principalId: MANAGER },
      { channelId: "CHR", principalId: OTHER },
    ],
  );
  await built.directory.replaceGroups(
    [
      { groupId: "GMINE", principalId: MANAGER },
      { groupId: "GMINE", principalId: OTHER },
      { groupId: "GTHEIRS", principalId: OTHER },
      { groupId: "GTHEIRS", principalId: "user-ursula" },
    ],
    Date.now(),
    ["GMINE", "GTHEIRS"],
    ["GMINE", "GTHEIRS"],
  );
  const sessionIds: Record<string, string> = {};
  for (const [thread, kind, scope] of [
    ["T-own-dm", "dm", `personal:${MANAGER}`],
    ["T-other-dm", "dm", `personal:${OTHER}`],
    ["T-public", "channel", "channel:CPUB"],
    ["T-leads", "channel", "channel:CLEADS"],
    ["T-hr", "channel", "channel:CHR"],
    ["T-group-mine", "group", "group:GMINE"],
    ["T-group-theirs", "group", "group:GTHEIRS"],
  ] as const) {
    const session = await built.sessions.getOrCreateByThread(thread, kind, scope);
    await built.sessions.addParticipant(session.id, OTHER);
    const { lease } = await built.sessions.acquireLease(session.id);
    await built.sessions.append(lease!, { type: "user", payload: { text: `said in ${thread}` }, scopeLabel: scope });
    await built.sessions.releaseLease(lease!);
    sessionIds[scope] = session.id;
  }
  await built.memory.replace(`personal:${OTHER}`, "a private note", OTHER);
  for (const scope of [`personal:${OTHER}`, "channel:CPUB", "group:GTHEIRS"]) {
    await built.app.createCron({
      ownerScopeId: scope,
      owner: OTHER,
      createdBy: OTHER,
      schedule: { everyMs: 60_000 },
      action: `ping ${scope}`,
    });
  }
  const server = createInsecureTestServer(built.app, serverDeps(config, built));
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const call = (actor: string, method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { "x-admin-actor": `${actor}@default-org`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return {
    built,
    sessionIds,
    asManager: (method: string, path: string, body?: unknown) => call(MANAGER, method, path, body),
    asAdmin: (method: string, path: string, body?: unknown) => call("admin-alice", method, path, body),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const q = encodeURIComponent;

test("an org admin grant outranks a manager grant, and ADMIN_GRANTS accepts both roles", () => {
  const grants = [
    { principalId: "p", scopeId: ORG, role: "org_manager" as const },
    { principalId: "p", scopeId: ORG, role: "org_admin" as const },
    { principalId: "m", scopeId: ORG, role: "org_manager" as const },
  ];
  assert.deepEqual(adminStatusFromGrants(grants, "p"), { isAdmin: true, role: "org_admin", scopeId: ORG });
  assert.deepEqual(adminStatusFromGrants(grants, "m"), { isAdmin: true, role: "org_manager", scopeId: ORG });
  assert.deepEqual(
    parseAdminGrants("a@x.com:org_admin,b@x.com:org_manager,c@x.com:root", "default-org")?.map((g) => g.role),
    ["org_admin", "org_manager"],
  );
});

test("whoami reports the manager role", async () => {
  const s = await start();
  try {
    const r = await s.asManager("GET", "/v1/admin/whoami");
    assert.equal(r.status, 200);
    const body: any = await r.json();
    assert.equal(body.isAdmin, true);
    assert.equal(body.role, "org_manager");
  } finally {
    await s.close();
  }
});

test("a manager cannot grant, revoke, or impersonate", async () => {
  const s = await start();
  try {
    for (const role of ["org_admin", "org_manager"]) {
      const r = await s.asManager("POST", "/v1/admin/grants", { principalId: OTHER, role, scopeId: ORG });
      assert.equal(r.status, 403, `grant ${role}`);
    }
    for (const [who, role] of [
      ["admin-bob", "org_admin"],
      [MANAGER, "org_manager"],
    ]) {
      const r = await s.asManager("DELETE", `/v1/admin/grants/${who}?scope=${q(ORG)}&role=${role}`);
      assert.equal(r.status, 403, `revoke ${who}`);
    }
    assert.equal((await s.asManager("POST", "/v1/admin/impersonate", { target: OTHER })).status, 403);
    assert.equal((await s.asManager("POST", "/v1/admin/impersonate/stop", { target: OTHER })).status, 403);
    const invite = await s.asManager("POST", "/v1/admin/external-users", {
      email: "guest@example.com",
      role: "org_admin",
      expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10),
    });
    assert.equal(invite.status, 403);
    const roles = (await s.built.admin.listGrants()).map((g) => `${g.principalId}:${g.role}`).sort();
    assert.deepEqual(roles, ["admin-alice:org_admin", "admin-bob:org_admin", `${MANAGER}:org_manager`]);
  } finally {
    await s.close();
  }
});

test("an org admin can grant and revoke the manager role, and still impersonates", async () => {
  const s = await start();
  try {
    const grant = await s.asAdmin("POST", "/v1/admin/grants", {
      principalId: OTHER,
      role: "org_manager",
      scopeId: ORG,
    });
    assert.equal(grant.status, 200);
    assert.equal((await s.built.admin.adminStatusOf({ id: OTHER, type: "internal" })).role, "org_manager");
    const revoke = await s.asAdmin("DELETE", `/v1/admin/grants/${OTHER}?scope=${q(ORG)}&role=org_manager`);
    assert.equal(revoke.status, 200);
    assert.equal((await s.built.admin.adminStatusOf({ id: OTHER, type: "internal" })).isAdmin, false);
    assert.equal((await s.asAdmin("POST", "/v1/admin/impersonate", { target: OTHER })).status, 200);
  } finally {
    await s.close();
  }
});

test("a manager keeps org-level admin work", async () => {
  const s = await start();
  try {
    for (const path of [
      "/v1/admin/users",
      "/v1/admin/model-providers",
      "/v1/admin/custom-providers",
      "/v1/admin/mcp-servers",
      "/v1/admin/resources",
      `/v1/admin/scopes/${q(ORG)}`,
      `/v1/admin/memory?scope=${q(ORG)}`,
      `/v1/admin/users/${MANAGER}`,
    ]) {
      assert.equal((await s.asManager("GET", path)).status, 200, path);
    }
  } finally {
    await s.close();
  }
});

test("a manager reads conversations only in spaces they belong to or that are public", async () => {
  const s = await start();
  try {
    const readable = [`personal:${MANAGER}`, "channel:CPUB", "channel:CLEADS", "group:GMINE"];
    const hidden = [`personal:${OTHER}`, "channel:CHR", "group:GTHEIRS"];
    for (const scope of readable) {
      assert.equal((await s.asManager("GET", `/v1/admin/sessions?scope=${q(scope)}`)).status, 200, scope);
      const id = s.sessionIds[scope]!;
      assert.equal((await s.asManager("GET", `/v1/admin/sessions/${id}?scope=${q(ORG)}`)).status, 200, scope);
    }
    for (const scope of hidden) {
      assert.equal((await s.asManager("GET", `/v1/admin/sessions?scope=${q(scope)}`)).status, 403, scope);
      const id = s.sessionIds[scope]!;
      for (const via of [ORG, scope, "channel:CPUB"]) {
        assert.equal((await s.asManager("GET", `/v1/admin/sessions/${id}?scope=${q(via)}`)).status, 403, scope);
        assert.equal((await s.asManager("GET", `/v1/admin/sessions/${id}/llm?scope=${q(via)}`)).status, 403, scope);
      }
      for (const path of ["runs", "errors", "audit", "egress", "metrics", "deliveries/shadow", "memory", "files"]) {
        assert.equal((await s.asManager("GET", `/v1/admin/${path}?scope=${q(scope)}`)).status, 403, `${path} ${scope}`);
      }
      assert.equal((await s.asManager("PUT", `/v1/admin/memory?scope=${q(scope)}`, { content: "x" })).status, 403);
      assert.equal((await s.asManager("GET", `/v1/admin/scopes/${q(scope)}`)).status, 403, scope);
    }
    assert.equal((await s.built.memory.read(`personal:${OTHER}`)).trim(), "a private note");
    for (const path of ["sessions", "runs", "errors", "audit", "egress", "metrics", "deliveries/shadow"]) {
      assert.equal((await s.asManager("GET", `/v1/admin/${path}?scope=${q(ORG)}`)).status, 403, `${path} org-wide`);
    }
    assert.equal((await s.asManager("GET", `/v1/admin/users/${OTHER}`)).status, 403);
    assert.equal((await s.asManager("POST", `/v1/admin/users/${OTHER}/reset`)).status, 403);
    assert.equal(
      (await s.asManager("PUT", `/v1/admin/users/${OTHER}/onboarding`, { status: "completed" })).status,
      403,
    );
    assert.equal((await s.built.memory.read(`personal:${OTHER}`)).trim(), "a private note");
    assert.ok(await s.built.sessions.get(s.sessionIds[`personal:${OTHER}`]!), "the DM survives");
    const publicId = s.sessionIds["channel:CPUB"]!;
    assert.equal((await s.asManager("GET", `/v1/admin/sessions/${publicId}/llm?scope=${q(ORG)}`)).status, 403);
    const cron = (await s.built.app.listCrons()).find((c) => c.ownerScopeId === "channel:CPUB")!;
    const move = await s.asManager("PUT", `/v1/admin/crons/${cron.id}/destination?scope=${q(ORG)}`, {
      destination: { type: "slack", target: "CHR" },
    });
    assert.equal(move.status, 403);
    assert.equal(
      (
        await s.asManager("POST", "/v1/admin/skill-packs/x/import", {
          selected: "all",
          scopeIds: [`personal:${OTHER}`],
        })
      ).status,
      403,
    );
  } finally {
    await s.close();
  }
});

test("org-wide lists shown to a manager leave out spaces they cannot read", async () => {
  const s = await start();
  try {
    const scopes: any = await (await s.asManager("GET", "/v1/admin/scopes")).json();
    const listed = new Set(scopes.scopes.map((row: any) => row.scopeId));
    for (const scope of [ORG, `personal:${MANAGER}`, "channel:CPUB", "channel:CLEADS", "group:GMINE"]) {
      assert.ok(listed.has(scope), `lists ${scope}`);
    }
    for (const scope of [`personal:${OTHER}`, "channel:CHR", "group:GTHEIRS"]) {
      assert.ok(!listed.has(scope), `hides ${scope}`);
    }
    const memory: any = await (await s.asManager("GET", "/v1/admin/memory/scopes")).json();
    assert.ok(!memory.scopes.some((row: any) => row.scopeId === `personal:${OTHER}`));
    const crons: any = await (await s.asManager("GET", `/v1/admin/crons?scope=${q(ORG)}`)).json();
    assert.deepEqual(
      crons.crons.map((c: any) => c.ownerScopeId),
      ["channel:CPUB"],
    );
    const adminScopes: any = await (await s.asAdmin("GET", "/v1/admin/scopes")).json();
    assert.ok(
      adminScopes.scopes.some((row: any) => row.scopeId === `personal:${OTHER}`),
      "admins still see every scope",
    );
    const adminCrons: any = await (await s.asAdmin("GET", `/v1/admin/crons?scope=${q(ORG)}`)).json();
    assert.equal(adminCrons.crons.length, 3);
  } finally {
    await s.close();
  }
});

test("views that mix every space's messages are org-admin only", async () => {
  const s = await start();
  try {
    for (const path of [
      "/v1/admin/slack-mirror",
      "/v1/admin/slack-mirror/messages?q=x",
      "/v1/admin/ambient-judgments",
      "/v1/admin/ack-emoji-picks",
      "/v1/admin/keychain",
      "/v1/admin/security/flags",
    ]) {
      assert.equal((await s.asManager("GET", path)).status, 403, path);
      assert.notEqual((await s.asAdmin("GET", path)).status, 403, path);
    }
    assert.equal((await s.asManager("POST", `/v1/admin/scopes/${q(ORG)}/auto-flagger/test`, {})).status, 403);
  } finally {
    await s.close();
  }
});

test("org admins keep full visibility", async () => {
  const s = await start();
  try {
    assert.equal((await s.asAdmin("GET", `/v1/admin/sessions?scope=${q(ORG)}`)).status, 200);
    const id = s.sessionIds[`personal:${OTHER}`]!;
    assert.equal((await s.asAdmin("GET", `/v1/admin/sessions/${id}?scope=${q(ORG)}`)).status, 200);
    assert.equal((await s.asAdmin("GET", `/v1/admin/users/${OTHER}`)).status, 200);
  } finally {
    await s.close();
  }
});

function samplePath(path: string): string {
  return path.replace(/:[A-Za-z]+/g, "x");
}

test("every admin route has an explicit manager rule, so new admin routes are refused to managers until classified", () => {
  const routes = [...adminRoutes, ...skillPackRoutes, ...apiRoutes, ...rawRoutes];
  const unclassified: string[] = [];
  for (const r of routes) {
    if (!("path" in r) || !r.path.startsWith("/v1/admin")) continue;
    const found = managerAccessFor(r.method, samplePath(r.path));
    if (!found || found.rule.path !== r.path || (found.rule.method !== "*" && found.rule.method !== r.method))
      unclassified.push(`${r.method} ${r.path}`);
  }
  for (const [method, path] of [
    ["GET", "/v1/admin/crons"],
    ["GET", "/v1/admin/deployments"],
    ["GET", "/v1/admin/skills"],
    ["GET", "/v1/admin/deployments/x/proxy"],
    ["POST", "/v1/admin/deployments/x/proxy/api/save"],
  ] as const) {
    if (!managerAccessFor(method, path)) unclassified.push(`${method} ${path}`);
  }
  assert.deepEqual(unclassified, []);
});

test("an unclassified admin route is refused to a manager", async () => {
  const refusal = await managerRefusal(
    { method: "GET", url: "/v1/admin/some-new-view?scope=org:default-org" },
    ORG,
    async () => true,
  );
  assert.ok(refusal);
});
