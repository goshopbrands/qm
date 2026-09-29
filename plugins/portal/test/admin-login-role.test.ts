import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";

const claimed: string[] = [];
const upstream = createServer((req: IncomingMessage, res) => {
  if (req.url === "/api/whoami") {
    const sub = decodeURIComponent((req.headers.cookie ?? "").match(/admin=([^;]+)/)?.[1] ?? "");
    res.writeHead(200, { "content-type": "application/json" });
    return void res.end(
      JSON.stringify(sub === "member@example.com" ? { isAdmin: false } : { isAdmin: true, role: "org_admin" }),
    );
  }
  if (req.url?.startsWith("/v1/auth/broker/claim")) claimed.push(req.url);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ claimed: true }));
});
await new Promise<void>((r) => upstream.listen(0, r));
const upstreamUrl = `http://localhost:${(upstream.address() as AddressInfo).port}`;

const PUBLIC = "http://portal.test";
const SECRET = "admin-login-role-portal-secret-0123456789";
process.env.PORTAL_PUBLIC_URL = PUBLIC;
process.env.PORTAL_SESSION_SECRET = SECRET;
process.env.CORE_SIGNING_SECRET = "admin-login-role-core-secret";
process.env.WEB_UI_UPSTREAM = upstreamUrl;
process.env.ADMIN_UPSTREAM = upstreamUrl;
process.env.CORE_API_URL = upstreamUrl;

const { server } = await import("../src/index.ts");
const { deriveKey, seal } = await import("../src/session.ts");
await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;

test.after(() => {
  server.close();
  upstream.close();
});

function loginToken(sub: string): string {
  const iat = Math.floor(Date.now() / 1000);
  return seal(
    { k: "admin-login", sub, aud: PUBLIC, iat, exp: iat + 300, jti: randomBytes(18).toString("base64url") },
    deriveKey(SECRET, "portal.admin-login.v1"),
  );
}

test("an admin login link for an account without admin access signs nobody in", async () => {
  const res = await fetch(`${base}/auth/admin-login`, {
    method: "POST",
    headers: { origin: PUBLIC, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: loginToken("member@example.com") }),
    redirect: "manual",
  });
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("set-cookie"), null);
  assert.deepEqual(claimed, []);
});
