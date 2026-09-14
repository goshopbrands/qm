import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type IncomingHttpHeaders } from "node:http";
import { connect, type AddressInfo } from "node:net";

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

const seen: Seen[] = [];
const appRequests = (): Seen[] => seen.filter((s) => String(s.headers.host).endsWith(".apps.qm.example.com"));
const core = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    seen.push({
      method: req.method ?? "",
      url: req.url ?? "",
      headers: req.headers,
      body: Buffer.concat(chunks).toString(),
    });
    res.writeHead(200, {
      "content-type": "application/json",
      "set-cookie": "dpl_owner=owner-token; HttpOnly; Secure; SameSite=Lax; Path=/",
    });
    res.end(JSON.stringify({ rows: 1335 }));
  });
});
await new Promise<void>((r) => core.listen(0, r));
const coreUrl = `http://localhost:${(core.address() as AddressInfo).port}`;

process.env.PORTAL_PUBLIC_URL = "https://qm.example.com";
process.env.PORTAL_SESSION_SECRET = "apps-host-forwarding-portal-secret";
process.env.CORE_SIGNING_SECRET = "apps-host-forwarding-core-secret";
process.env.WEB_UI_UPSTREAM = coreUrl;
process.env.ADMIN_UPSTREAM = coreUrl;
process.env.CORE_API_URL = coreUrl;
process.env.DEPLOY_APPS_DOMAIN = "apps.qm.example.com";

const { server } = await import("../src/index.ts");
await new Promise<void>((r) => server.listen(0, r));
const port = (server.address() as AddressInfo).port;

test.after(() => {
  server.close();
  core.close();
});

function send(
  host: string,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "localhost", port, method: opts.method ?? "GET", path, headers: { host, ...opts.headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on("error", reject);
    req.end(opts.body);
  });
}

test("an app host under the apps domain reaches core with its host and sign-in cookies intact", async () => {
  seen.length = 0;
  const res = await send("invoice-review.apps.qm.example.com", "/api/items?status=pending", {
    headers: { cookie: "portal_session=sealed; dpl_owner=owner-token", accept: "application/json" },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { rows: 1335 });
  const forwarded = appRequests();
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0]!.url, "/api/items?status=pending");
  assert.equal(forwarded[0]!.headers.host, "invoice-review.apps.qm.example.com");
  assert.equal(forwarded[0]!.headers.cookie, "portal_session=sealed; dpl_owner=owner-token");
});

test("core's app cookies come back to the browser and the portal adds no frame denial", async () => {
  const res = await send("invoice-review.apps.qm.example.com", "/");
  assert.match(String(res.headers["set-cookie"]), /dpl_owner=owner-token/);
  assert.equal(res.headers["x-frame-options"], undefined);
});

test("request bodies pass through to core unchanged", async () => {
  seen.length = 0;
  const body = JSON.stringify({ uid: "invoice-1", decision: "approved" });
  const res = await send("invoice-review.apps.qm.example.com", "/api/decide", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) },
    body,
  });
  assert.equal(res.status, 200);
  const forwarded = appRequests()[0]!;
  assert.equal(forwarded.method, "POST");
  assert.equal(forwarded.headers["content-type"], "application/json");
  assert.equal(forwarded.body, body);
});

test("a browser cannot smuggle core trust headers through an app host", async () => {
  seen.length = 0;
  await send("invoice-review.apps.qm.example.com", "/", {
    headers: {
      "x-signature": "forged",
      "x-timestamp": "1",
      "x-as-principal": "admin@example.com",
      "x-admin-actor": "admin@example.com",
      "x-agent-capability": "forged",
      "x-portal-identity": "forged",
    },
  });
  const headers = appRequests()[0]!.headers;
  for (const name of [
    "x-signature",
    "x-timestamp",
    "x-as-principal",
    "x-admin-actor",
    "x-agent-capability",
    "x-portal-identity",
  ]) {
    assert.equal(headers[name], undefined, `${name} must not reach core`);
  }
});

test("the portal's own host and look-alike hosts are not forwarded to core", async () => {
  seen.length = 0;
  for (const host of [
    "qm.example.com",
    "apps.qm.example.com",
    "invoice-review.apps.qm.example.com.evil.com",
    "notapps.qm.example.com",
    "invoice-review.apps.qm.example.com.",
  ]) {
    const res = await send(host, "/healthz");
    assert.equal(res.status, 200, host);
    assert.deepEqual(JSON.parse(res.body), { ok: true }, host);
  }
  assert.deepEqual(
    seen.filter((s) => s.url === "/healthz"),
    [],
  );
  assert.deepEqual(appRequests(), []);
});

function sendRaw(raw: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "localhost", () => socket.write(raw));
    socket.on("error", reject);
    socket.on("data", () => undefined);
    setTimeout(() => {
      socket.destroy();
      resolve();
    }, 500);
  });
}

test("a body on a GET cannot smuggle a second request to core", async () => {
  const inner = "GET /smuggled HTTP/1.1\r\nHost: core\r\nx-as-principal: admin@example.com\r\n\r\n";
  for (const framing of [
    `Transfer-Encoding: chunked\r\n\r\n${inner.length.toString(16)}\r\n${inner}\r\n0\r\n\r\n`,
    `Content-Length: ${inner.length}\r\n\r\n${inner}`,
  ]) {
    seen.length = 0;
    await sendRaw(`GET / HTTP/1.1\r\nHost: invoice-review.apps.qm.example.com\r\n${framing}`);
    assert.deepEqual(
      seen.filter((s) => s.url === "/smuggled"),
      [],
    );
    assert.equal(appRequests().length, 1);
    assert.equal(appRequests()[0]!.body, inner);
  }
});

test("a chunked request body reaches core intact", async () => {
  seen.length = 0;
  const body = JSON.stringify({ uid: "invoice-2", decision: "denied" });
  await sendRaw(
    `POST /api/decide HTTP/1.1\r\nHost: invoice-review.apps.qm.example.com\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n${body.length.toString(16)}\r\n${body}\r\n0\r\n\r\n`,
  );
  assert.equal(appRequests().length, 1);
  assert.equal(appRequests()[0]!.body, body);
});
