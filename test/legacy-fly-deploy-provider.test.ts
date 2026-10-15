import { test } from "node:test";
import assert from "node:assert/strict";
import { extract } from "tar-stream";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createFlyDeployApi,
  createLegacyFlyDeployProvider,
  type FlyApp,
  type FlyDeployApi,
  type FlyMachine,
  type FlyMachineConfig,
  type FlyMachineEvent,
  type FlyVolume,
} from "../src/deploy/legacy-fly-deploy-provider.ts";
import type { Deployment, DeploymentVersion } from "../src/deploy/deploy-store.ts";
import type { BlobTransferStore } from "../src/persistence/blob-transfer.ts";
import { Readable } from "node:stream";
import { asChunks } from "../src/util/bytes.ts";
import { scopeId } from "../src/types.ts";

const ID = "550e8400-e29b-41d4-a716-446655440000";
const APP = "example-d-550e8400e29b41d4";
const IMAGE = "registry.fly.io/example-sandboxes@sha256:abc";

function deployment(): Deployment {
  return {
    id: ID,
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    currentVersion: 1,
    status: "stopped",
    endpoint: null,
    versions: [],
  };
}

function snapshot(file: string, contents: string): string {
  const root = mkdtempSync(join(tmpdir(), "fly-deploy-"));
  const target = join(root, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
  return root;
}

function version(number: number, root: string, over: Partial<DeploymentVersion> = {}): DeploymentVersion {
  return {
    version: number,
    createdAt: 0,
    entrypoint: "node server.js",
    snapshotDir: root,
    env: { API_KEY: "secret", PORT: "9999", DATA_DIR: "/wrong" },
    ...over,
  };
}

function fakeApi() {
  const apps = new Map<string, FlyApp>();
  const volumes = new Map<string, FlyVolume[]>();
  const machines = new Map<string, FlyMachine[]>();
  const configs: FlyMachineConfig[] = [];
  const history = new Map<string, FlyMachineConfig[]>();
  const events = new Map<string, FlyMachineEvent[]>();
  const remember = (id: string, config: FlyMachineConfig): void => {
    history.set(id, [...(history.get(id) ?? []), config]);
  };
  const machineRegions: string[] = [];
  const calls = {
    createApp: 0,
    flycast: 0,
    createVolume: 0,
    createMachine: 0,
    updateMachine: 0,
    start: 0,
    waitStopped: 0,
    wait: 0,
    delete: 0,
  };
  let machineNumber = 0;
  const api: FlyDeployApi = {
    async getApp(name) {
      return apps.get(name) ?? null;
    },
    async createApp(name, org) {
      calls.createApp++;
      apps.set(name, { name, organization: { slug: org } });
    },
    async ensureFlycast() {
      calls.flycast++;
    },
    async listVolumes(name) {
      return volumes.get(name) ?? [];
    },
    async createVolume(name) {
      calls.createVolume++;
      const volume = { id: `vol-${calls.createVolume}`, name: "qm_data", state: "created", region: "sjc" };
      volumes.set(name, [volume]);
      return volume;
    },
    async listMachines(name) {
      return machines.get(name) ?? [];
    },
    async listMachineConfigs(_name, id) {
      return history.get(id) ?? [];
    },
    async listMachineEvents(_name, id) {
      return events.get(id) ?? [];
    },
    async createMachine(name, region, config) {
      calls.createMachine++;
      machineRegions.push(region);
      configs.push(config);
      const machine = {
        id: `machine-${++machineNumber}`,
        instance_id: `instance-${machineNumber}`,
        state: "created",
        config,
      };
      machines.set(name, [machine]);
      remember(machine.id, config);
      const volume = volumes.get(name)?.[0];
      if (volume) volume.attached_machine_id = machine.id;
      return machine;
    },
    async updateMachine(name, id, config) {
      calls.updateMachine++;
      configs.push(config);
      const machine = { id, instance_id: `instance-${++machineNumber}`, state: "created", config };
      machines.set(name, [machine]);
      remember(id, config);
      return machine;
    },
    async startMachine(name, id) {
      calls.start++;
      const machine = machines.get(name)?.find((candidate) => candidate.id === id);
      assert.equal(machine?.state, "stopped");
      if (machine) machine.state = "started";
    },
    async waitMachineStopped(name, id, instanceId) {
      calls.waitStopped++;
      const machine = machines.get(name)?.find((candidate) => candidate.id === id);
      assert.equal(machine?.instance_id, instanceId);
      assert.equal(machine?.state, "created");
      machine!.state = "stopped";
    },
    async waitMachine(name, id) {
      calls.wait++;
      const machine = machines.get(name)?.find((candidate) => candidate.id === id);
      if (machine) machine.state = "started";
    },
    async deleteMachine(name, id) {
      calls.delete++;
      machines.set(
        name,
        (machines.get(name) ?? []).filter((machine) => machine.id !== id),
      );
      const volume = volumes.get(name)?.[0];
      if (volume?.attached_machine_id === id) volume.attached_machine_id = null;
    },
  };
  return { api, apps, volumes, machines, configs, history, events, machineRegions, calls };
}

function recordingBlobs() {
  const payloads = new Map<string, Buffer>();
  const deleted: string[] = [];
  let sequence = 0;
  const store: BlobTransferStore = {
    async put(source) {
      const chunks: Buffer[] = [];
      for await (const chunk of asChunks(source)) chunks.push(Buffer.from(chunk));
      const data = Buffer.concat(chunks);
      const blobId = (++sequence).toString(16).padStart(32, "0");
      payloads.set(blobId, data);
      return { blobId, sizeBytes: data.length, sha256: "a".repeat(63) + sequence };
    },
    async open(blobId) {
      const data = payloads.get(blobId);
      return data ? { sizeBytes: data.length, stream: Readable.from(data) } : null;
    },
    async delete(blobId) {
      deleted.push(blobId);
      payloads.delete(blobId);
    },
    async sweep() {
      return 0;
    },
  };
  return { store, payloads, deleted };
}

function provider(api: FlyDeployApi, probes: Array<{ host: string; port: number }>, blobs = recordingBlobs()) {
  return createLegacyFlyDeployProvider({
    token: "FlyV1-test",
    org: "personal",
    region: "sjc",
    image: IMAGE,
    appPrefix: "example-d",
    apiBaseUrl: "https://example-core.fly.dev",
    capabilitySecret: "test-capability-secret",
    releaseStore: blobs.store,
    api,
    probe: async (endpoint) => void probes.push(endpoint),
  });
}

async function untar(raw: Uint8Array): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const unpack = extract();
  const complete = new Promise<Map<string, string>>((resolve, reject) => {
    unpack.on("finish", () => resolve(files));
    unpack.on("error", reject);
  });
  unpack.on("entry", (header, stream, next) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => {
      files.set(header.name, Buffer.concat(chunks).toString());
      next();
    });
    stream.resume();
  });
  unpack.end(Buffer.from(raw));
  return complete;
}

test("apply creates a private Fly app, persistent volume, and one owned Machine", async () => {
  const fake = fakeApi();
  const blobs = recordingBlobs();
  const probes: Array<{ host: string; port: number }> = [];
  const endpoint = await provider(fake.api, probes, blobs).apply(
    deployment(),
    version(1, snapshot("public/index.html", "<h1>hello</h1>")),
  );

  assert.deepEqual(endpoint, { host: `${APP}.flycast`, port: 80, image: IMAGE });
  assert.deepEqual(probes, [{ host: `${APP}.flycast`, port: 80 }]);
  assert.equal(fake.calls.createApp, 1);
  assert.equal(fake.calls.flycast, 1);
  assert.equal(fake.calls.createVolume, 1);
  assert.equal(fake.calls.createMachine, 1);
  assert.equal(fake.calls.start, 0);
  assert.equal(fake.calls.wait, 1);
  const config = fake.configs[0]!;
  assert.equal(config.metadata?.qm_deployment_id, ID);
  assert.equal(config.metadata?.qm_deployment_version, "1");
  assert.deepEqual(config.env, { API_KEY: "secret", PORT: "8080", DATA_DIR: "/data", HOME: "/root" });
  assert.deepEqual(config.mounts, [{ volume: "vol-1", path: "/data" }]);
  assert.deepEqual(config.services, [
    {
      protocol: "tcp",
      internal_port: 8080,
      autostop: "stop",
      autostart: true,
      min_machines_running: 0,
      ports: [{ port: 80, handlers: ["http"] }],
    },
  ]);
  assert.equal(config.files, undefined);
  assert.match(
    JSON.stringify(config.init),
    /https:\/\/example-core\.fly\.dev\/v1\/deploy-releases\/00000000000000000000000000000001/,
  );
  assert.doesNotMatch(JSON.stringify(config.init), /\/data\/\.qm\/releases/);
  const archived = await untar(blobs.payloads.values().next().value!);
  assert.equal(archived.get("app/public/index.html"), "<h1>hello</h1>");
  assert.deepEqual(blobs.deleted, []);
});

test("large snapshots stay in the durable release store rather than Machine config", async () => {
  const fake = fakeApi();
  const blobs = recordingBlobs();
  const root = snapshot("public/bundle.js", "x".repeat(2 * 1024 * 1024));
  await provider(fake.api, [], blobs).apply(deployment(), version(1, root));

  assert.ok(blobs.payloads.values().next().value!.length > 2 * 1024 * 1024);
  assert.ok(JSON.stringify(fake.configs[0]).length < 10_000);
  assert.equal(fake.configs[0]!.files, undefined);
});

test("redeploy updates the existing Machine and preserves its data volume", async () => {
  const fake = fakeApi();
  const blobs = recordingBlobs();
  const p = provider(fake.api, [], blobs);
  const d = deployment();
  await p.apply(d, version(1, snapshot("server.js", "v1")));
  await p.apply(d, version(2, snapshot("server.js", "v2")));

  assert.equal(fake.calls.createApp, 1);
  assert.equal(fake.calls.createVolume, 1);
  assert.equal(fake.calls.createMachine, 1);
  assert.equal(fake.calls.updateMachine, 1);
  assert.deepEqual(fake.configs[1]!.mounts, [{ volume: "vol-1", path: "/data" }]);
  assert.equal(fake.configs[1]!.metadata?.qm_deployment_version, "2");
  assert.deepEqual(blobs.deleted, ["00000000000000000000000000000001"]);
});

test("redeploy waits for a stopped Machine update version before explicitly starting it", async () => {
  const fake = fakeApi();
  const blobs = recordingBlobs();
  const p = provider(fake.api, [], blobs);
  const d = deployment();
  await p.apply(d, version(1, snapshot("server.js", "v1")));
  fake.machines.get(APP)![0]!.state = "stopped";

  await p.apply(d, version(2, snapshot("server.js", "v2")));

  assert.equal(fake.calls.updateMachine, 1);
  assert.equal(fake.calls.waitStopped, 1);
  assert.equal(fake.calls.start, 1);
  assert.equal(fake.calls.wait, 2);
  assert.equal(fake.machines.get(APP)?.[0]?.state, "started");
});

test("archive removes only the Machine and restore reattaches the retained volume", async () => {
  const fake = fakeApi();
  const blobs = recordingBlobs();
  const p = provider(fake.api, [], blobs);
  const d = deployment();
  const v = version(1, snapshot("server.js", "v1"));
  await p.apply(d, v);
  await p.destroy(d);

  assert.equal(fake.calls.delete, 1);
  assert.deepEqual(blobs.deleted, ["00000000000000000000000000000001"]);
  assert.ok(fake.apps.has(APP));
  assert.equal(fake.volumes.get(APP)?.[0]?.id, "vol-1");
  assert.equal(await p.resolveEndpoint!(d, v), null);

  await p.apply(d, v);
  assert.equal(fake.calls.createVolume, 1);
  assert.equal(fake.calls.createMachine, 2);
  assert.deepEqual(fake.configs[1]!.mounts, [{ volume: "vol-1", path: "/data" }]);
});

test("restore creates the replacement Machine in the retained volume region", async () => {
  const fake = fakeApi();
  const blobs = recordingBlobs();
  const d = deployment();
  const v = version(1, snapshot("server.js", "v1"));
  await provider(fake.api, [], blobs).apply(d, v);
  await provider(fake.api, [], blobs).destroy(d);
  await createLegacyFlyDeployProvider({
    token: "FlyV1-test",
    org: "personal",
    region: "iad",
    image: IMAGE,
    appPrefix: "example-d",
    apiBaseUrl: "https://example-core.fly.dev",
    capabilitySecret: "test-capability-secret",
    releaseStore: blobs.store,
    api: fake.api,
    probe: async () => undefined,
  }).apply(d, v);

  assert.deepEqual(fake.machineRegions, ["sjc", "sjc"]);
});

test("reconcile stages the durable git bundle instead of a stale snapshot", async () => {
  const fake = fakeApi();
  const blobs = recordingBlobs();
  const p = provider(fake.api, [], blobs);
  const d = deployment();
  const commit = "a".repeat(40);
  await p.reconcile!(d, version(2, "/unused", { commit }), {
    gitBundle: Buffer.from("bundle"),
    changedPaths: ["server.js"],
    deletedPaths: [],
    allPaths: ["server.js"],
  });

  const config = fake.configs[0]!;
  assert.equal(config.files, undefined);
  const archived = await untar(blobs.payloads.values().next().value!);
  assert.equal(archived.get("bundle"), "bundle");
  assert.match(JSON.stringify(config.init), new RegExp(`refs/deploy-commits/${commit}`));
});

test("an existing foreign Machine is refused without deleting it", async () => {
  const fake = fakeApi();
  fake.apps.set(APP, { name: APP, organization: { slug: "personal" } });
  fake.machines.set(APP, [
    { id: "foreign", state: "started", config: { image: IMAGE, metadata: { qm_deployment_id: "other" } } },
  ]);
  await assert.rejects(
    () => provider(fake.api, []).apply(deployment(), version(1, snapshot("server.js", "v1"))),
    /not owned by deployment/,
  );
  assert.equal(fake.calls.delete, 0);
  assert.equal(fake.calls.flycast, 0);
  assert.equal(fake.machines.get(APP)?.[0]?.id, "foreign");
});

test("readiness retries Fly proxy startup responses before accepting the endpoint", async () => {
  const fake = fakeApi();
  let attempts = 0;
  const p = createLegacyFlyDeployProvider({
    token: "FlyV1-test",
    org: "personal",
    region: "sjc",
    image: IMAGE,
    appPrefix: "example-d",
    apiBaseUrl: "https://example-core.fly.dev",
    capabilitySecret: "test-capability-secret",
    releaseStore: recordingBlobs().store,
    api: fake.api,
    fetchImpl: (async () => new Response(null, { status: ++attempts === 1 ? 503 : 200 })) as typeof fetch,
    readyTimeoutMs: 2_000,
  });

  await p.apply(deployment(), version(1, snapshot("server.js", "v1")));
  assert.equal(attempts, 2);
});

test("failed redeploy restores the previous Machine config and removes the failed release", async () => {
  const fake = fakeApi();
  const blobs = recordingBlobs();
  const d = deployment();
  await provider(fake.api, [], blobs).apply(d, version(1, snapshot("server.js", "v1")));
  const prior = fake.machines.get(APP)?.[0]?.config;
  const failing = createLegacyFlyDeployProvider({
    token: "FlyV1-test",
    org: "personal",
    region: "sjc",
    image: IMAGE,
    appPrefix: "example-d",
    apiBaseUrl: "https://example-core.fly.dev",
    capabilitySecret: "test-capability-secret",
    releaseStore: blobs.store,
    api: fake.api,
    probe: async () => {
      throw new Error("not ready");
    },
    rollbackRetryDelayMs: 0,
  });

  await assert.rejects(() => failing.apply(d, version(2, snapshot("server.js", "v2"))), /not ready/);
  assert.equal(fake.calls.updateMachine, 2);
  assert.deepEqual(fake.machines.get(APP)?.[0]?.config, prior);
  assert.deepEqual(blobs.deleted, ["00000000000000000000000000000002"]);
});

test("failed redeploy of a stopped Machine restarts the restored version", async () => {
  const fake = fakeApi();
  const blobs = recordingBlobs();
  const d = deployment();
  await provider(fake.api, [], blobs).apply(d, version(1, snapshot("server.js", "v1")));
  fake.machines.get(APP)![0]!.state = "stopped";
  const failing = createLegacyFlyDeployProvider({
    token: "FlyV1-test",
    org: "personal",
    region: "sjc",
    image: IMAGE,
    appPrefix: "example-d",
    apiBaseUrl: "https://example-core.fly.dev",
    capabilitySecret: "test-capability-secret",
    releaseStore: blobs.store,
    api: fake.api,
    probe: async () => {
      throw new Error("not ready");
    },
    rollbackRetryDelayMs: 0,
  });

  await assert.rejects(() => failing.apply(d, version(2, snapshot("server.js", "v2"))), /not ready/);
  assert.equal(fake.calls.waitStopped, 2);
  assert.equal(fake.calls.start, 2);
  assert.equal(fake.machines.get(APP)?.[0]?.state, "started");
  assert.deepEqual(blobs.deleted, ["00000000000000000000000000000002"]);
});

test("an accepted update with a lost API response is rolled back", async () => {
  const fake = fakeApi();
  const blobs = recordingBlobs();
  const d = deployment();
  const p = provider(fake.api, [], blobs);
  await p.apply(d, version(1, snapshot("server.js", "v1")));
  const prior = fake.machines.get(APP)?.[0]?.config;
  const update = fake.api.updateMachine.bind(fake.api);
  let loseResponse = true;
  fake.api.updateMachine = async (name, id, config) => {
    const result = await update(name, id, config);
    if (loseResponse) {
      loseResponse = false;
      throw new Error("response lost");
    }
    return result;
  };

  await assert.rejects(() => p.apply(d, version(2, snapshot("server.js", "v2"))), /response lost/);
  assert.equal(fake.calls.updateMachine, 2);
  assert.deepEqual(fake.machines.get(APP)?.[0]?.config, prior);
});

test("an accepted create with a lost API response is cleaned up", async () => {
  const fake = fakeApi();
  const create = fake.api.createMachine.bind(fake.api);
  fake.api.createMachine = async (name, region, config) => {
    await create(name, region, config);
    throw new Error("response lost");
  };

  await assert.rejects(
    () => provider(fake.api, []).apply(deployment(), version(1, snapshot("server.js", "v1"))),
    /response lost/,
  );
  assert.equal(fake.calls.delete, 1);
  assert.deepEqual(fake.machines.get(APP), []);
});

test("rollback failure is surfaced and keeps the release needed by the accepted config", async () => {
  const fake = fakeApi();
  const blobs = recordingBlobs();
  const d = deployment();
  await provider(fake.api, [], blobs).apply(d, version(1, snapshot("server.js", "v1")));
  const update = fake.api.updateMachine.bind(fake.api);
  fake.api.updateMachine = async (name, id, config) => {
    if (config.metadata?.qm_deployment_version === "1") throw new Error("rollback rejected");
    return update(name, id, config);
  };
  const failing = createLegacyFlyDeployProvider({
    token: "FlyV1-test",
    org: "personal",
    region: "sjc",
    image: IMAGE,
    appPrefix: "example-d",
    apiBaseUrl: "https://example-core.fly.dev",
    capabilitySecret: "test-capability-secret",
    releaseStore: blobs.store,
    api: fake.api,
    probe: async () => {
      throw new Error("not ready");
    },
    rollbackRetryDelayMs: 0,
  });

  await assert.rejects(
    () => failing.apply(d, version(2, snapshot("server.js", "v2"))),
    (error: Error) => {
      assert.match(error.message, /deployment failed and recovery failed \(rollback rejected\)/);
      return true;
    },
  );
  assert.deepEqual(blobs.deleted, []);
});

function failingProvider(api: FlyDeployApi, blobs: ReturnType<typeof recordingBlobs>) {
  return createLegacyFlyDeployProvider({
    token: "FlyV1-test",
    org: "personal",
    region: "sjc",
    image: IMAGE,
    appPrefix: "example-d",
    apiBaseUrl: "https://example-core.fly.dev",
    capabilitySecret: "test-capability-secret",
    releaseStore: blobs.store,
    api,
    probe: async () => {
      throw new Error("not ready");
    },
    rollbackRetryDelayMs: 0,
  });
}

test("failed redeploy restores the applied version when an earlier rollback stranded a failed release", async () => {
  const fake = fakeApi();
  const blobs = recordingBlobs();
  const d = deployment();
  await provider(fake.api, [], blobs).apply(d, version(1, snapshot("server.js", "v1")));
  const applied = fake.machines.get(APP)?.[0]?.config;
  const update = fake.api.updateMachine.bind(fake.api);
  let rejectedRollbacks = 0;
  fake.api.updateMachine = async (name, id, config) => {
    if (rejectedRollbacks < 3 && config.metadata?.qm_deployment_version === "1") {
      rejectedRollbacks++;
      throw new Error("machine has an automatic restart pending");
    }
    return update(name, id, config);
  };
  const failing = failingProvider(fake.api, blobs);
  const live = { ...d, appliedVersion: 1 };

  await assert.rejects(() => failing.apply(live, version(2, snapshot("server.js", "v2"))), /recovery failed/);
  assert.equal(fake.machines.get(APP)?.[0]?.config?.metadata?.qm_deployment_version, "2");

  await assert.rejects(() => failing.apply(live, version(3, snapshot("server.js", "v3"))), /not ready/);
  assert.deepEqual(fake.machines.get(APP)?.[0]?.config, applied);
  assert.deepEqual(blobs.deleted, ["00000000000000000000000000000003"]);
});

test("failed redeploy keeps the current config when the applied version's release is gone", async () => {
  const fake = fakeApi();
  const blobs = recordingBlobs();
  const d = deployment();
  const p = provider(fake.api, [], blobs);
  await p.apply(d, version(1, snapshot("server.js", "v1")));
  await p.apply(d, version(2, snapshot("server.js", "v2")));
  const running = fake.machines.get(APP)?.[0]?.config;

  await assert.rejects(
    () => failingProvider(fake.api, blobs).apply({ ...d, appliedVersion: 1 }, version(3, snapshot("server.js", "v3"))),
    /not ready/,
  );
  assert.deepEqual(fake.machines.get(APP)?.[0]?.config, running);
  assert.deepEqual(blobs.deleted, ["00000000000000000000000000000001", "00000000000000000000000000000003"]);
});

test("failed redeploy still rolls back when the Machine version history is unavailable", async () => {
  const fake = fakeApi();
  const blobs = recordingBlobs();
  const d = deployment();
  await provider(fake.api, [], blobs).apply(d, version(1, snapshot("server.js", "v1")));
  const prior = fake.machines.get(APP)?.[0]?.config;
  fake.api.listMachineConfigs = async () => {
    throw new Error("versions unavailable");
  };

  await assert.rejects(
    () => failingProvider(fake.api, blobs).apply({ ...d, appliedVersion: 7 }, version(2, snapshot("server.js", "v2"))),
    /not ready/,
  );
  assert.deepEqual(fake.machines.get(APP)?.[0]?.config, prior);
  assert.deepEqual(blobs.deleted, ["00000000000000000000000000000002"]);
});

test("failed redeploy keeps the current config when Fly has no record of the applied version", async () => {
  const fake = fakeApi();
  const blobs = recordingBlobs();
  const d = deployment();
  await provider(fake.api, [], blobs).apply(d, version(1, snapshot("server.js", "v1")));
  const prior = fake.machines.get(APP)?.[0]?.config;
  fake.history.clear();

  await assert.rejects(
    () => failingProvider(fake.api, blobs).apply({ ...d, appliedVersion: 7 }, version(2, snapshot("server.js", "v2"))),
    /not ready/,
  );
  assert.deepEqual(fake.machines.get(APP)?.[0]?.config, prior);
  assert.deepEqual(blobs.deleted, ["00000000000000000000000000000002"]);
});

test("an app that exits while starting is named in the deploy error", async () => {
  const fake = fakeApi();
  const blobs = recordingBlobs();
  const d = deployment();
  await provider(fake.api, [], blobs).apply(d, version(1, snapshot("server.js", "v1")));
  const wait = fake.api.waitMachine.bind(fake.api);
  fake.api.waitMachine = async (name, id) => {
    await wait(name, id);
    fake.events.set(id, [
      { type: "exit", timestamp: 40, request: { exit_event: { exit_code: 0, requested_stop: true } } },
      { type: "exit", timestamp: 30, request: { MonitorEvent: { exit_event: { exit_code: 127 } } } },
      { type: "exit", timestamp: 25, request: { exit_event: { exit_code: 0, requested_stop: true } } },
      { type: "update", timestamp: 20 },
      { type: "exit", timestamp: 10, request: { exit_event: { exit_code: 1 } } },
    ]);
  };

  await assert.rejects(
    () =>
      failingProvider(fake.api, blobs).apply(d, version(2, snapshot("server.js", "v2"), { entrypoint: "server.js" })),
    (error: Error) => {
      assert.equal(
        error.message,
        'Fly app exited with code 127 (command not found) while starting; boot downloads and unpacks the release, then runs the entrypoint "server.js"',
      );
      assert.match(String((error.cause as Error).message), /not ready/);
      return true;
    },
  );
});

test("an app that never reports started is still diagnosed from its exits", async () => {
  const fake = fakeApi();
  const blobs = recordingBlobs();
  const d = deployment();
  await provider(fake.api, [], blobs).apply(d, version(1, snapshot("server.js", "v1")));
  const id = fake.machines.get(APP)![0]!.id;
  const wait = fake.api.waitMachine.bind(fake.api);
  let failWait = true;
  fake.api.waitMachine = async (name, machineId) => {
    if (failWait) {
      failWait = false;
      fake.events.set(id, [
        { type: "update", timestamp: 20 },
        { type: "exit", timestamp: 30, request: { exit_event: { exit_code: 127 } } },
      ]);
      throw new Error("Fly API wait timed out (408)");
    }
    return wait(name, machineId);
  };

  await assert.rejects(
    () =>
      failingProvider(fake.api, blobs).apply(d, version(2, snapshot("server.js", "v2"), { entrypoint: "server.js" })),
    /exited with code 127 \(command not found\) while starting; .* entrypoint "server.js"/,
  );
});

test("exits from before the latest placement are not blamed on the new entrypoint", async () => {
  const fake = fakeApi();
  const blobs = recordingBlobs();
  const d = deployment();
  await provider(fake.api, [], blobs).apply(d, version(1, snapshot("server.js", "v1")));
  const id = fake.machines.get(APP)![0]!.id;
  fake.events.set(id, [
    { type: "start", timestamp: 30 },
    { type: "update", timestamp: 20 },
    { type: "exit", timestamp: 10, request: { exit_event: { exit_code: 127 } } },
  ]);

  await assert.rejects(
    () => failingProvider(fake.api, blobs).apply(d, version(2, snapshot("server.js", "v2"))),
    (error: Error) => {
      assert.equal(error.message, "not ready");
      return true;
    },
  );
});

test("a crash loop that fills the event window is still diagnosed", async () => {
  const fake = fakeApi();
  const blobs = recordingBlobs();
  const d = deployment();
  await provider(fake.api, [], blobs).apply(d, version(1, snapshot("server.js", "v1")));
  const id = fake.machines.get(APP)![0]!.id;
  fake.events.set(
    id,
    Array.from({ length: 50 }, (_, index) =>
      index % 2
        ? { type: "start", timestamp: 100 - index }
        : { type: "exit", timestamp: 100 - index, request: { exit_event: { exit_code: 127 } } },
    ),
  );

  await assert.rejects(
    () => failingProvider(fake.api, blobs).apply(d, version(2, snapshot("server.js", "v2"))),
    /exited with code 127 \(command not found\)/,
  );
});

test("a rollback refused while a restart is pending is retried", async () => {
  const fake = fakeApi();
  const blobs = recordingBlobs();
  const d = deployment();
  await provider(fake.api, [], blobs).apply(d, version(1, snapshot("server.js", "v1")));
  const prior = fake.machines.get(APP)?.[0]?.config;
  const update = fake.api.updateMachine.bind(fake.api);
  let refusals = 2;
  fake.api.updateMachine = async (name, id, config) => {
    if (refusals > 0 && config.metadata?.qm_deployment_version === "1") {
      refusals--;
      throw new Error("machine has an automatic restart pending");
    }
    return update(name, id, config);
  };

  await assert.rejects(
    () => failingProvider(fake.api, blobs).apply(d, version(2, snapshot("server.js", "v2"))),
    /not ready/,
  );
  assert.deepEqual(fake.machines.get(APP)?.[0]?.config, prior);
  assert.deepEqual(blobs.deleted, ["00000000000000000000000000000002"]);
});

test("a history config on a different volume is not restored", async () => {
  const fake = fakeApi();
  const blobs = recordingBlobs();
  const d = deployment();
  const p = provider(fake.api, [], blobs);
  await p.apply(d, version(1, snapshot("server.js", "v1")));
  const id = fake.machines.get(APP)![0]!.id;
  fake.history.set(
    id,
    fake.history.get(id)!.map((config) => ({ ...config, mounts: [{ volume: "vol-old", path: "/data" }] })),
  );
  await p.apply(d, version(2, snapshot("server.js", "v2")));
  const running = fake.machines.get(APP)?.[0]?.config;
  fake.history.set(
    id,
    fake.history.get(id)!.filter((config) => config.metadata?.qm_deployment_version === "1"),
  );
  blobs.payloads.set("00000000000000000000000000000001", Buffer.from("v1"));

  await assert.rejects(
    () => failingProvider(fake.api, blobs).apply({ ...d, appliedVersion: 1 }, version(3, snapshot("server.js", "v3"))),
    /not ready/,
  );
  assert.deepEqual(fake.machines.get(APP)?.[0]?.config, running);
});

test("Fly API refuses an app with a public IP address", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({ data: { app: { ipAddresses: { nodes: [{ type: "shared_v4" }] } } } }),
    )) as typeof fetch;
  const api = createFlyDeployApi("FlyV1-test", fetchImpl, "https://machines.test", "https://graphql.test");
  await assert.rejects(() => api.ensureFlycast(APP), /public IP addresses \(shared_v4\)/);
});

test("Fly API client uses the Machines REST API and allocates only a private Flycast address", async () => {
  const requests: Array<{ url: string; method: string; authorization: string; body?: unknown }> = [];
  let waitAttempts = 0;
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    requests.push({ url, method, authorization: headers.get("authorization") ?? "", ...(body ? { body } : {}) });
    if (url === "https://graphql.test") {
      const operation = body as { query: string };
      return operation.query.startsWith("query")
        ? new Response(JSON.stringify({ data: { app: { ipAddresses: { nodes: [] } } } }))
        : new Response(JSON.stringify({ data: { allocateIpAddress: { ipAddress: { id: "private" } } } }));
    }
    if (url.endsWith("/v1/apps/missing")) return new Response("not found", { status: 404 });
    if (url.endsWith("/volumes") && method === "POST") {
      return new Response(JSON.stringify({ id: "vol-1", name: "qm_data", state: "created" }));
    }
    if (url.endsWith("/machines") && method === "POST") {
      return new Response(JSON.stringify({ id: "machine-1", state: "created", config: { image: IMAGE } }));
    }
    if (url.includes("/wait?state=started&timeout=60")) {
      waitAttempts++;
      return waitAttempts === 1 ? new Response("timed out", { status: 408 }) : new Response(null, { status: 200 });
    }
    if (url.endsWith("/machines/machine-1/versions")) {
      return new Response(
        JSON.stringify([
          { version: "01B", user_config: { image: "second" } },
          { version: "01C" },
          { version: "01A", user_config: { image: "first" } },
        ]),
      );
    }
    if (url.includes("/machines/machine-1") && method === "POST") {
      return new Response(JSON.stringify({ id: "machine-1", state: "started", config: { image: IMAGE } }));
    }
    return new Response(null, { status: method === "POST" && url.endsWith("/v1/apps") ? 201 : 200 });
  }) as typeof fetch;
  const api = createFlyDeployApi("FlyV1-test", fetchImpl, "https://machines.test", "https://graphql.test");

  assert.equal(await api.getApp("missing"), null);
  await api.createApp(APP, "personal");
  await api.ensureFlycast(APP);
  await api.createVolume(APP, "sjc");
  await api.createMachine(APP, "sjc", { image: IMAGE });
  await api.updateMachine(APP, "machine-1", { image: IMAGE });
  await api.waitMachineStopped(APP, "machine-1", "instance-2");
  await api.startMachine(APP, "machine-1");
  await api.waitMachine(APP, "machine-1");
  await api.deleteMachine(APP, "machine-1");
  await api.listMachineEvents(APP, "machine-1");
  assert.ok(requests.some((request) => request.url.endsWith("/machines/machine-1/events?limit=50")));
  assert.deepEqual(
    (await api.listMachineConfigs(APP, "machine-1")).map((config) => config.image),
    ["first", "second"],
  );

  assert.ok(requests.every((request) => request.authorization === "Bearer FlyV1-test"));
  assert.deepEqual(
    requests.filter((request) => request.url === "https://graphql.test").map((request) => request.body),
    [
      {
        query: "query ($appName: String!) { app(name: $appName) { ipAddresses { nodes { type } } } }",
        variables: { appName: APP },
      },
      {
        query: "mutation ($input: AllocateIPAddressInput!) { allocateIpAddress(input: $input) { ipAddress { id } } }",
        variables: { input: { appId: APP, type: "private_v6", region: "" } },
      },
    ],
  );
  assert.ok(requests.some((request) => request.url.endsWith("/machines/machine-1/start")));
  assert.deepEqual(
    requests.find((request) => request.url.endsWith("/machines/machine-1") && request.method === "POST")?.body,
    { config: { image: IMAGE }, skip_launch: true },
  );
  assert.ok(
    requests.some((request) =>
      request.url.endsWith("/machines/machine-1/wait?state=stopped&instance_id=instance-2&timeout=60"),
    ),
  );
  assert.equal(requests.filter((request) => request.url.endsWith("/wait?state=started&timeout=60")).length, 2);
  assert.ok(requests.some((request) => request.url.endsWith("/machines/machine-1?force=true")));
});

test("readiness does not follow application redirects into core networks", async () => {
  const fake = fakeApi();
  const blobs = recordingBlobs();
  let checked = false;
  const p = createLegacyFlyDeployProvider({
    token: "FlyV1-test",
    org: "personal",
    region: "sjc",
    image: IMAGE,
    appPrefix: "example-d",
    apiBaseUrl: "https://core.example.com",
    capabilitySecret: "test-capability-secret",
    releaseStore: blobs.store,
    api: fake.api,
    fetchImpl: (async (_input, init) => {
      assert.equal(init?.redirect, "manual");
      checked = true;
      return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } });
    }) as typeof fetch,
  });
  await p.apply(deployment(), version(1, snapshot("server.js", "v1")));
  assert.ok(checked);
});

test("legacy destroy refuses unknown or foreign organization ownership", async () => {
  for (const organization of [undefined, { slug: "another-org" }]) {
    const fake = fakeApi();
    fake.apps.set(APP, { name: APP, ...(organization ? { organization } : {}) });
    await assert.rejects(provider(fake.api, [], recordingBlobs()).destroy(deployment()), /not owned/);
    assert.equal(fake.calls.delete, 0);
  }
});

test("legacy warming probes only while always-on is enabled", async () => {
  const fake = fakeApi();
  const probes: Array<{ host: string; port: number }> = [];
  const p = provider(fake.api, probes, recordingBlobs());
  const d = { ...deployment(), alwaysOn: true };
  await p.apply(d, version(1, snapshot("server.js", "v1")));
  const services = fake.configs[0]!.services as Array<{ autostop: string; min_machines_running: number }>;
  assert.equal(services[0]!.autostop, "stop");
  assert.equal(services[0]!.min_machines_running, 0);
  fake.machines.get(APP)![0]!.state = "stopped";
  const before = probes.length;
  await p.resolveEndpoint!(d, version(1, "unused"));
  assert.equal(probes.length, before + 1);
  await p.resolveEndpoint!({ ...d, alwaysOn: false }, version(1, "unused"));
  assert.equal(probes.length, before + 1);
});
