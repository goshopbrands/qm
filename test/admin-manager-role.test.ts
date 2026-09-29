import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer, createServer } from "../src/api/server.ts";
import { buildApp, serverDeps } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import { adminStatusFromGrants, parseAdminGrants } from "../src/admin/admin-service.ts";
import { managerAccessFor, managerRefusal } from "../src/admin/manager-access.ts";
import { adminRoutes } from "../src/api/routes/admin.ts";
import { skillPackRoutes } from "../src/api/routes/skill-packs.ts";
import { apiRoutes, rawRoutes } from "../src/api/routes/index.ts";
import { unattendedGrantRefusal } from "../src/cron/authority.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS, CONTROL_PLANE_AUD } from "../src/auth/capability-token.ts";

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
    const teammate = await s.asManager("POST", "/v1/admin/users/invite", { email: "admin-bob@example.com" });
    assert.equal(teammate.status, 403);
    const link = await s.asManager("POST", "/v1/admin/principal-links", {
      principalId: "mia-second-login",
      canonicalId: "admin-alice",
    });
    assert.equal(link.status, 403);
    assert.equal((await s.asManager("DELETE", "/v1/admin/principal-links/admin-bob")).status, 403);
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

test("a manager can promote skills org-wide and give their crons unattended grants", async () => {
  const s = await start();
  try {
    const skill = async (owner: string) =>
      (await s.built.app.createOwnedSkill({
        principalId: owner,
        name: `notes-${owner}`,
        description: "notes",
        body: `${owner} private`,
      }))!;
    const theirs = await skill(OTHER);
    const mine = await skill(MANAGER);
    await assert.rejects(s.built.app.promoteSkill(mine.id, ORG, OTHER, true), /only an org admin/);
    await assert.rejects(s.built.app.promoteSkill(theirs.id, ORG, MANAGER, true), /spaces they can read/);
    assert.equal((await s.built.app.promoteSkill(mine.id, ORG, MANAGER, true)).scopeId, ORG);
    const own = (owner: string) => ({ owner, ownerScopeId: `personal:${owner}` });
    const live = (actorId: string) => ({ actorId, liveActor: true });
    assert.equal(await unattendedGrantRefusal(s.built.app, s.built.admin, own(MANAGER), live(MANAGER)), null);
    assert.match(
      String(await unattendedGrantRefusal(s.built.app, s.built.admin, own(OTHER), live(OTHER))),
      /current org admin/,
    );
  } finally {
    await s.close();
  }
});

test("a manager imports skill packs only into spaces they can read and cannot repoint another person's pack", async () => {
  const s = await start();
  try {
    const pack = await s.built.app.registerSkillPack({
      kind: "git",
      url: "https://github.com/acme/skills-pack.git",
      ref: "main",
      syncMode: "pinned",
      trustTier: "third-party",
      targetScopeId: ORG,
      subset: "all",
      createdBy: "admin-alice",
    });
    const importInto = (scopeIds: string[]) =>
      s.asManager("POST", `/v1/admin/skill-packs/${pack.id}/import`, { selected: "all", scopeIds });
    assert.equal((await importInto([`personal:${OTHER}`])).status, 403);
    assert.equal((await importInto(["channel:CPUB", "channel:CHR"])).status, 403);
    assert.notEqual((await importInto(["channel:CPUB"])).status, 403);
    const repoint = await s.asManager("PATCH", `/v1/admin/skill-packs/${pack.id}`, {
      url: "https://github.com/acme/private.git",
    });
    assert.equal(repoint.status, 403);
    assert.equal((await s.built.app.getSkillPack(pack.id))!.url, "https://github.com/acme/skills-pack.git");
    assert.equal((await s.asManager("PATCH", `/v1/admin/skill-packs/${pack.id}`, { syncMode: "tracked" })).status, 200);
    assert.equal(
      (await s.asManager("POST", `/v1/admin/scopes/${q(ORG)}/auto-flagger/test`, {})).status,
      403,
      "the auto flagger test samples every scope's messages",
    );
  } finally {
    await s.close();
  }
});

test("a manager must re-enter a stored secret to change where it is sent", async () => {
  const s = await start();
  try {
    const cred = `/v1/admin/scopes/${q(ORG)}/service-credentials`;
    assert.equal(
      (await s.asAdmin("PUT", cred, { slug: "gh", name: "GitHub", host: "api.github.com", secret: "s3cret" })).status,
      200,
    );
    const version = async () =>
      ((await (await s.asAdmin("GET", `/v1/admin/scopes/${q(ORG)}`)).json()) as any).serviceCredentials[0].updatedAt;
    const moved = { slug: "gh", name: "GitHub", host: "evil.example.com" };
    assert.equal((await s.asManager("PUT", cred, { ...moved, expectedUpdatedAt: await version() })).status, 403);
    assert.equal(
      (await s.asManager("PUT", cred, { ...moved, secret: "new", expectedUpdatedAt: await version() })).status,
      200,
    );

    const provider = "/v1/admin/custom-providers/gateway";
    const spec = {
      name: "Gateway",
      protocol: "openai",
      baseUrl: "https://gateway.example.com/v1",
      models: [{ id: "gw-1" }],
      validate: false,
    };
    assert.equal((await s.asAdmin("PUT", provider, { ...spec, apiKey: "sk-admin" })).status, 200);
    const repointed = { ...spec, baseUrl: "https://evil.example.com/v1" };
    assert.equal((await s.asManager("PUT", provider, repointed)).status, 403);
    assert.equal((await s.asManager("PUT", provider, { ...repointed, apiKey: "sk-mine" })).status, 200);

    const mcp = "/v1/admin/mcp-servers/tools";
    const server = { url: "https://mcp.example.com/mcp", auth: "bearer", validate: false };
    assert.equal((await s.asAdmin("PUT", mcp, { ...server, bearerToken: "admin-token" })).status, 200);
    assert.equal((await s.asManager("PUT", mcp, { ...server, url: "https://evil.example.com/mcp" })).status, 403);
    assert.equal((await s.asManager("PUT", mcp, { ...server, bearerToken: "mine" })).status, 200);
    const perUser = { auth: "none", credentialScope: "per-user", credentialHost: "github.com", validate: false };
    const perUserServer = "/v1/admin/mcp-servers/gh";
    assert.equal(
      (await s.asManager("PUT", perUserServer, { ...perUser, url: "https://evil.example.com/mcp" })).status,
      403,
    );
    assert.equal(
      (await s.asManager("PUT", perUserServer, { ...perUser, url: "https://api.github.com/mcp" })).status,
      200,
    );
  } finally {
    await s.close();
  }
});

test("a manager can open Spend and redirect output only for crons in spaces they can read", async () => {
  const s = await start();
  try {
    assert.notEqual((await s.asManager("GET", "/v1/admin/spend")).status, 403);
    const crons = await s.built.app.listCrons();
    const inScope = (scope: string) => crons.find((c) => c.ownerScopeId === scope)!.id;
    const redirect = (scope: string) =>
      s.asManager("PUT", `/v1/admin/crons/${q(inScope(scope))}/destination?scope=${q(ORG)}`, {
        destination: { type: "slack", target: "CPUB" },
      });
    assert.equal((await redirect("channel:CPUB")).status, 200);
    assert.equal((await redirect("group:GTHEIRS")).status, 403);
    const send = (destination: unknown) =>
      s.asManager("PUT", `/v1/admin/crons/${q(inScope("channel:CPUB"))}/destination?scope=${q(ORG)}`, {
        destination,
      });
    assert.equal((await send({ type: "slack", target: "CLEADS" })).status, 200);
    assert.equal((await send({ type: "slack", target: "CHR" })).status, 403);
    assert.equal((await send({ type: "principal", target: "outsider@example.com" })).status, 403);
    assert.equal((await send({ type: "principal", target: MANAGER })).status, 200);
    assert.equal((await send({ type: "principal", target: OTHER })).status, 200);
    assert.equal((await send({ type: "principal", target: MANAGER, audienceScopeId: "channel:CPUB" })).status, 403);
  } finally {
    await s.close();
  }
});

test("a manager's agent has the manager's dashboard powers and no way to raise its role", async () => {
  const secret = "manager-agent-capability-secret".repeat(2);
  const config = testConfig({
    dataDir: mkdtempSync(join(tmpdir(), "admin-manager-cap-")),
    signingSecret: secret,
    capabilitySecret: secret,
    apiBaseUrl: "http://core.example.test",
  });
  const built = buildApp(config);
  await built.admin.createGrant(ALICE, { principalId: MANAGER, role: "org_manager", scopeId: ORG });
  const server = createServer(built.app, {
    ...serverDeps(config, built),
    capabilitySecret: secret,
    signingSecret: secret,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const asAgentOf = async (actorId: string, method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-agent-capability": await mintCapabilityToken(
          {
            actorId,
            scopeId: `personal:${actorId}`,
            aud: CONTROL_PLANE_AUD,
            liveActor: true,
            exp: Date.now() + CAPABILITY_TTL_MS,
          },
          secret,
        ),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    const memory = `/v1/admin/memory?scope=${q(ORG)}`;
    const put = await asAgentOf(MANAGER, "PUT", memory, { content: "# Memory\n\n- standup is 9:30" });
    assert.equal(put.status, 200);
    assert.equal((await asAgentOf(MANAGER, "GET", "/v1/admin/users")).status, 200);
    for (const role of ["org_admin", "org_manager"]) {
      const grant = await asAgentOf(MANAGER, "POST", "/v1/admin/grants", { principalId: OTHER, role, scopeId: ORG });
      assert.equal(grant.status, 403, role);
    }
    assert.equal((await asAgentOf(MANAGER, "POST", "/v1/admin/impersonate", { target: OTHER })).status, 403);
    assert.equal((await asAgentOf(MANAGER, "POST", "/v1/admin/users/invite", { email: "a@example.com" })).status, 403);
    assert.deepEqual((await built.admin.listGrants()).map((g) => `${g.principalId}:${g.role}`).sort(), [
      "admin-alice:org_admin",
      "admin-bob:org_admin",
      `${MANAGER}:org_manager`,
    ]);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("a manager's transcript view leaves out raw model requests behind deliveries", async () => {
  const s = await start();
  try {
    const scope = `personal:${MANAGER}`;
    const source = await s.built.sessions.getOrCreateByThread("agent:main:monitor:m-mia", "dm", scope);
    const { lease } = await s.built.sessions.acquireLease(source.id);
    const user = await s.built.sessions.append(lease!, { type: "user", payload: { text: "wake" }, scopeLabel: scope });
    const reply = await s.built.sessions.append(lease!, {
      type: "assistant",
      payload: { text: "Reminder." },
      scopeLabel: scope,
    });
    await s.built.sessions.releaseLease(lease!);
    await s.built.sessions.recordLlmRequest(source.id, {
      turnSeq: user.seq,
      step: 0,
      model: "mock",
      scopeLabel: scope,
      promptEnvelope: { model: "mock", messages: [{ role: "user", content: "wake" }] },
      truncated: false,
    });
    const delivery = await s.built.deliveries.enqueue({
      destination: { type: "principal", target: MANAGER, audienceScopeId: scope, onBehalfOf: MANAGER },
      text: "Reminder.",
      idempotencyKey: "monitor:m-mia:1",
      provenance: {
        trigger: "monitor",
        surface: "monitor",
        fireKey: "monitor:m-mia:1",
        sourceScopeId: scope,
        sourceThreadRef: "agent:main:monitor:m-mia",
        sourceSessionId: source.id,
        sourceUserSeq: user.seq,
        sourceAssistantEntrySeq: reply.seq,
      },
    });
    await s.built.app.recordPrincipalDelivery(delivery.id, "dm:D-mia");
    const recipient = (await s.built.sessions.getByThread("dm:D-mia"))!;
    const path = `/v1/admin/sessions/${q(recipient.id)}?scope=${q(scope)}`;
    const read = async (as: typeof s.asAdmin) => {
      const r = await as("GET", path);
      assert.equal(r.status, 200);
      return ((await r.json()) as any).deliveryEvents[0];
    };
    assert.equal((await read(s.asAdmin)).llmRequests.length, 1);
    assert.equal((await read(s.asManager)).llmRequests, undefined);
  } finally {
    await s.close();
  }
});

test("an org admin sign-in cannot be linked onto a manager identity", async () => {
  const s = await start();
  try {
    const r = await s.asAdmin("POST", "/v1/admin/principal-links", {
      principalId: "admin-bob",
      canonicalId: MANAGER,
      evidence: "same person, confirmed in person",
    });
    assert.equal(r.status, 400);
    assert.match(((await r.json()) as { message: string }).message, /holds an org admin grant/);
    assert.equal((await s.built.admin.adminStatusOf({ id: MANAGER, type: "internal" })).role, "org_manager");
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
