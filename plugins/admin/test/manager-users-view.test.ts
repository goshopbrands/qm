import assert from "node:assert/strict";
import test from "node:test";
import { litFixture } from "./lit-fixture.ts";

const users = [
  { principalId: "admin-alice", admin: { isAdmin: true, scopeId: "org:test", role: "org_admin" } },
  { principalId: "mgr-mia", admin: { isAdmin: true, scopeId: "org:test", role: "org_manager" } },
  { principalId: "user-uma", admin: { isAdmin: false } },
];
const data = { users, grants: [{ role: "org_admin" }, { role: "org_manager" }], externalUsers: [] };

function mount(isManager: boolean, calls: unknown[] = []) {
  const f = litFixture();
  const controller = f.ui.users.users(f.root, data, {
    defaultShell() {},
    isManager,
    orgScope: "org:test",
    labelRole: (role: string) => (role === "org_admin" ? "admin" : role.replace(/_/g, " ")),
    confirm: () => true,
    clearCache() {},
    api: async (method: string, path: string, body?: unknown) => {
      if (method !== "GET") calls.push([method, path, ...(body ? [body] : [])]);
      return { ok: true, data: path === "/api/users" ? data : {} };
    },
  });
  const buttons = () => [...f.root.querySelectorAll("button")].map((b) => b.textContent!.trim());
  return { f, controller, buttons };
}

test("a manager sees no role, impersonation, or teammate invite controls", () => {
  const { f, buttons } = mount(true);
  const labels = buttons();
  for (const hidden of ["Invite teammate", "Impersonate ↗", "Make admin", "Make manager", "Revoke"])
    assert.ok(!labels.includes(hidden), hidden);
  f.dom.window.close();
});

test("an org admin can make a member a manager, and revoke a manager while only one admin remains", async () => {
  const calls: unknown[] = [];
  const { f, controller, buttons } = mount(false, calls);
  const labels = buttons();
  assert.ok(labels.includes("Invite teammate"));
  assert.equal(labels.filter((l) => l === "Make manager").length, 1);
  const revokes = [...f.root.querySelectorAll("button")].filter((b) => b.textContent!.trim() === "Revoke");
  assert.deepEqual(
    revokes.map((b) => b.disabled),
    [true, false],
  );
  const event = new f.window.Event("click");
  await controller.admin(users[2], event, "org_manager");
  await controller.admin(users[1], event);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ["POST", "/api/grants", { principalId: "user-uma", role: "org_manager", scopeId: "org:test" }],
    ["DELETE", "/api/grants/mgr-mia?scope=org%3Atest&role=org_manager"],
  ]);
  f.dom.window.close();
});
