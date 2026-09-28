import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfigFromFile } from "../src/config.js";
import { nextRetryDelayMs } from "../src/retry.js";
import { createServer } from "../src/server.js";
import { createJsonStore } from "../src/store.js";

const sourceUrl = "https://discord.com/channels/111111111111111111/222222222222222222";
const firstDestinationUrl = "https://discord.com/channels/333333333333333333/444444444444444444";
const secondDestinationUrl = "https://discord.com/channels/333333333333333333/555555555555555555";
const authToken = "test-token";
const maxFetchPortAttempts = 25;
const fetchBlockedPorts = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101,
  102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389,
  427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636,
  989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665,
  6666, 6667, 6668, 6669, 6679, 6697, 10080
]);

const sampleConfig = {
  enabled: true,
  retry: { maxAttempts: 3, baseDelayMs: 2000 },
  sendPacingMs: 1500,
  mappings: [
    {
      id: "map-1",
      enabled: true,
      sourceUrl,
      destinationUrls: [firstDestinationUrl, secondDestinationUrl],
      prefix: "[mirror]"
    }
  ]
};

const samplePayload = {
  sourceUrl,
  messageId: "999999999999999999",
  author: "Alert Bot",
  timestampText: "Today at 12:00 PM",
  text: "Entry alert",
  embeds: [],
  labels: [],
  attachmentUrls: [],
  capturedAt: "2026-06-24T17:00:00.000Z"
};

const singleDestinationConfig = {
  ...sampleConfig,
  mappings: [
    {
      ...sampleConfig.mappings[0],
      destinationUrls: [firstDestinationUrl]
    }
  ]
};

const freshnessConfig = {
  ...singleDestinationConfig,
  freshness: {
    enabled: true,
    maxAgeMinutes: 10,
    requireTimestamp: true
  }
};

async function startHelperHttpServer(store, config = sampleConfig) {
  let lastBlockedPort = "";
  for (let attempt = 0; attempt < maxFetchPortAttempts; attempt += 1) {
    const server = createServer({ config, store, authToken });
    await listenOnEphemeralPort(server);
    const { port } = server.address();
    if (!isFetchBlockedPort(port)) {
      return { server, baseUrl: `http://127.0.0.1:${port}` };
    }

    lastBlockedPort = port;
    await closeHelperHttpServer(server);
  }

  throw new Error(`Could not start helper HTTP test server on a fetch-allowed port; last blocked port: ${lastBlockedPort}`);
}

async function listenOnEphemeralPort(server) {
  await new Promise((resolve, reject) => {
    function cleanup() {
      server.off("error", onError);
      server.off("listening", onListening);
    }

    function onError(error) {
      cleanup();
      reject(error);
    }

    function onListening() {
      cleanup();
      resolve();
    }

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
}

async function closeHelperHttpServer(server) {
  if (!server) {
    return;
  }
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function authHeaders(headers = {}) {
  return { "x-helper-token": authToken, ...headers };
}

function isFetchBlockedPort(port) {
  return Number.isInteger(port) && fetchBlockedPorts.has(port);
}

test("listen-only HTTP capture persists rich payload, deduplicates, and never creates repost jobs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "helper-listen-only-"));
  let server;
  try {
    const file = join(dir, "state.json");
    const store = await createJsonStore(file);
    const started = await startHelperHttpServer(store);
    server = started.server;
    const payload = { ...samplePayload, embeds: [{ title: "NVDA Calls", description: "Entry $0.85" }] };
    const submit = () => fetch(`${started.baseUrl}/events`, {
      method: "POST", headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ alert: payload, captureOnly: true })
    });
    const response = await submit();
    assert.equal(response.status, 202);
    const result = await response.json();
    assert.equal(result.capturedOnly, true);
    assert.deepEqual(result.createdJobs, []);
    assert.equal((await (await submit()).json()).skippedDuplicate, true);
    assert.equal(await store.claimNextJob("test-worker"), null);
    const restored = await createJsonStore(file);
    const snapshot = await restored.snapshot();
    assert.equal(snapshot.jobs.length, 0);
    const captures = snapshot.events.filter(event => event.type === "captured_only");
    assert.equal(captures.length, 1);
    assert.equal(captures[0].payload.text, payload.text);
    assert.equal(captures[0].payload.embeds[0].title, "NVDA Calls");
    const status = await (await fetch(`${started.baseUrl}/status`, { headers: authHeaders() })).json();
    assert.equal(status.counts.captured_only, 1);
    const invalid = await fetch(`${started.baseUrl}/events`, {
      method: "POST", headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ alert: { ...payload, messageId: "another" }, captureOnly: "true" })
    });
    assert.equal(invalid.status, 400);
  } finally {
    await closeHelperHttpServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test("nextRetryDelayMs doubles from base delay by retry attempt", () => {
  assert.equal(nextRetryDelayMs(1, 2000), 2000);
  assert.equal(nextRetryDelayMs(2, 2000), 4000);
  assert.equal(nextRetryDelayMs(3, 2000), 8000);
});

test("loadConfigFromFile validates JSON config and preserves two destinations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "helper-config-"));
  try {
    const configPath = join(dir, "config.json");
    await writeFile(configPath, JSON.stringify(sampleConfig), "utf8");

    const config = await loadConfigFromFile(configPath);

    assert.equal(config.mappings[0].sourceChannelId, "222222222222222222");
    assert.deepEqual(config.mappings[0].destinationUrls, [firstDestinationUrl, secondDestinationUrl]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("store queues one job per destination and skips duplicate source message", async () => {
  const dir = await mkdtemp(join(tmpdir(), "helper-store-"));
  try {
    const store = await createJsonStore(join(dir, "state.json"));

    const first = await store.enqueueAlert(sampleConfig, samplePayload);
    const second = await store.enqueueAlert(sampleConfig, samplePayload);
    const snapshot = await store.snapshot();

    assert.equal(first.createdJobs.length, 2);
    assert.equal(second.skippedDuplicate, true);
    assert.equal(snapshot.jobs.length, 2);
    assert.equal(snapshot.jobs[0].messageText.includes("[mirror]"), true);
    assert.equal(snapshot.events.at(-1).type, "skipped_duplicate");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("store makes expired in-progress job claimable after reload without extra attempt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "helper-lease-"));
  try {
    const statePath = join(dir, "state.json");
    const store = await createJsonStore(statePath);
    await store.enqueueAlert(singleDestinationConfig, samplePayload);

    const firstClaim = await store.claimNextJob("client-1", new Date("2030-01-01T17:00:00.000Z"));
    assert.equal(firstClaim.attempt, 1);

    const reloaded = await createJsonStore(statePath);
    const stillLeased = await reloaded.claimNextJob("client-2", new Date("2030-01-01T17:00:31.000Z"));
    assert.equal(stillLeased, null);

    const secondClaim = await reloaded.claimNextJob("client-2", new Date("2030-01-01T17:03:01.000Z"));

    assert.equal(secondClaim.id, firstClaim.id);
    assert.equal(secondClaim.attempt, 2);
    assert.equal(secondClaim.clientId, "client-2");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("store does not mark alert duplicate when no jobs were created", async () => {
  const dir = await mkdtemp(join(tmpdir(), "helper-no-match-"));
  try {
    const store = await createJsonStore(join(dir, "state.json"));
    const disabledConfig = { ...sampleConfig, enabled: false };

    const first = await store.enqueueAlert(disabledConfig, samplePayload);
    const second = await store.enqueueAlert(sampleConfig, samplePayload);
    const snapshot = await store.snapshot();

    assert.equal(first.createdJobs.length, 0);
    assert.equal(second.skippedDuplicate, false);
    assert.equal(second.createdJobs.length, 2);
    assert.equal(snapshot.jobs.length, 2);
    assert.equal(snapshot.events.some((event) => event.type === "no_matching_mapping"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("store rejects terminal result for a queued job before claim", async () => {
  const dir = await mkdtemp(join(tmpdir(), "helper-invalid-result-"));
  try {
    const store = await createJsonStore(join(dir, "state.json"));
    await store.enqueueAlert(singleDestinationConfig, samplePayload);
    const snapshot = await store.snapshot();

    await assert.rejects(
      store.recordJobResult({
        jobId: snapshot.jobs[0].id,
        status: "sent",
        clientId: "client-1",
        now: new Date("2026-06-24T17:00:00.000Z")
      }),
      /in progress/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("store rejects stale claimant after lease expiry and reclaim", async () => {
  const dir = await mkdtemp(join(tmpdir(), "helper-stale-claimant-"));
  try {
    const statePath = join(dir, "state.json");
    const store = await createJsonStore(statePath);
    await store.enqueueAlert(singleDestinationConfig, samplePayload);

    const firstClaim = await store.claimNextJob("client-1", new Date("2030-01-01T17:00:00.000Z"));

    const reloaded = await createJsonStore(statePath);
    const stillLeased = await reloaded.claimNextJob("client-2", new Date("2030-01-01T17:00:31.000Z"));
    assert.equal(stillLeased, null);

    const secondClaim = await reloaded.claimNextJob("client-2", new Date("2030-01-01T17:03:01.000Z"));
    assert.equal(secondClaim.id, firstClaim.id);
    assert.equal(secondClaim.clientId, "client-2");

    await assert.rejects(
      reloaded.recordJobResult({
        jobId: firstClaim.id,
        status: "sent",
        now: new Date("2030-01-01T17:03:02.000Z")
      }),
      /clientId/
    );

    await assert.rejects(
      reloaded.recordJobResult({
        jobId: firstClaim.id,
        status: "sent",
        clientId: "client-1",
        now: new Date("2030-01-01T17:03:02.000Z")
      }),
      /different client/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("store marks failed job for retry twice and final failure on third failed attempt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "helper-retry-"));
  try {
    const store = await createJsonStore(join(dir, "state.json"));
    await store.enqueueAlert(sampleConfig, samplePayload);

    const firstClaimTime = new Date("2030-01-01T00:00:00.000Z");
    const firstClaim = await store.claimNextJob("client-1", firstClaimTime);
    assert.equal(firstClaim.attempt, 1);

    await store.recordJobResult({
      jobId: firstClaim.id,
      status: "failed",
      reason: "composer unavailable",
      retry: sampleConfig.retry,
      clientId: "client-1",
      now: firstClaimTime
    });

    let snapshot = await store.snapshot();
    assert.equal(snapshot.jobs[0].status, "retry_wait");
    assert.equal(snapshot.jobs[0].dueAt, "2030-01-01T00:00:02.000Z");
    assert.equal(snapshot.jobs[0].clientId, "");

    const secondClaimTime = new Date("2030-01-01T00:00:02.000Z");
    const secondClaim = await store.claimNextJob("client-1", secondClaimTime);
    assert.equal(secondClaim.id, firstClaim.id);
    assert.equal(secondClaim.attempt, 2);

    await store.recordJobResult({
      jobId: secondClaim.id,
      status: "failed",
      reason: "composer unavailable",
      retry: sampleConfig.retry,
      clientId: "client-1",
      now: secondClaimTime
    });

    snapshot = await store.snapshot();
    assert.equal(snapshot.jobs[0].status, "retry_wait");
    assert.equal(snapshot.jobs[0].dueAt, "2030-01-01T00:00:06.000Z");
    assert.equal(snapshot.jobs[0].clientId, "");

    const thirdClaimTime = new Date("2030-01-01T00:00:06.000Z");
    const thirdClaim = await store.claimNextJob("client-1", thirdClaimTime);
    assert.equal(thirdClaim.id, firstClaim.id);
    assert.equal(thirdClaim.attempt, 3);

    await store.recordJobResult({
      jobId: thirdClaim.id,
      status: "failed",
      reason: "composer unavailable",
      retry: sampleConfig.retry,
      clientId: "client-1",
      now: thirdClaimTime
    });

    snapshot = await store.snapshot();
    assert.equal(snapshot.jobs[0].status, "failed");
    assert.equal(snapshot.jobs[0].reason, "composer unavailable");
    assert.equal(snapshot.events.at(-1).type, "failed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createServer requires a non-empty helper auth token", () => {
  assert.throws(() => createServer({ config: sampleConfig, store: {}, authToken: "" }), /authToken is required/);
  assert.throws(() => createServer({ config: sampleConfig, store: {} }), /authToken is required/);
});

test("isFetchBlockedPort identifies browser blocked ports", () => {
  assert.equal(isFetchBlockedPort(6000), true);
  assert.equal(isFetchBlockedPort(17654), false);
});

test("HTTP API enqueues, claims, records, and reports helper jobs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "helper-http-"));
  let server;
  try {
    const store = await createJsonStore(join(dir, "state.json"));
    let baseUrl;
    ({ server, baseUrl } = await startHelperHttpServer(store));

    const eventResponse = await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(samplePayload)
    });
    assert.equal(eventResponse.status, 202);

    const nextResponse = await fetch(`${baseUrl}/jobs/next?clientId=copy-repost`, {
      headers: authHeaders()
    });
    assert.equal(nextResponse.status, 200);
    const job = await nextResponse.json();
    assert.equal(job.destinationUrl, firstDestinationUrl);

    const resultResponse = await fetch(`${baseUrl}/jobs/${job.id}/result`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ status: "sent", clientId: "copy-repost", degradation: [] })
    });
    assert.equal(resultResponse.status, 200);

    const statusResponse = await fetch(`${baseUrl}/status`, { headers: authHeaders() });
    assert.equal(statusResponse.status, 200);
    const status = await statusResponse.json();
    assert.equal(status.counts.sent, 1);
  } finally {
    await closeHelperHttpServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test("HTTP API accepts extension-supplied event mappings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "helper-http-runtime-mapping-"));
  let server;
  try {
    const store = await createJsonStore(join(dir, "state.json"));
    let baseUrl;
    const emptyConfig = { ...sampleConfig, mappings: [] };
    ({ server, baseUrl } = await startHelperHttpServer(store, emptyConfig));

    const eventResponse = await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({
        alert: samplePayload,
        mappings: [
          {
            id: "popup-route-222222222222222222",
            enabled: true,
            sourceUrl,
            destinationUrls: [firstDestinationUrl],
            prefix: "[copied-alert]"
          }
        ]
      })
    });
    assert.equal(eventResponse.status, 202);
    const eventBody = await eventResponse.json();
    assert.equal(eventBody.createdJobs.length, 1);
    assert.equal(eventBody.createdJobs[0].destinationUrl, firstDestinationUrl);
    assert.equal(eventBody.createdJobs[0].messageText.includes("[copied-alert]"), true);
  } finally {
    await closeHelperHttpServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test("HTTP API reserves delivery jobs for the configured extension worker", async () => {
  const dir = await mkdtemp(join(tmpdir(), "helper-delivery-client-"));
  let server;
  try {
    const store = await createJsonStore(join(dir, "state.json"));
    const config = {
      ...sampleConfig,
      deliveryClientId: "sentinel-link-extension-0.2.4",
      deliveryExtensionId: "ddpgdbgihdmkfcnchbffjkihakdopdbl"
    };
    const started = await startHelperHttpServer(store, config);
    server = started.server;

    const eventResponse = await fetch(`${started.baseUrl}/events`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(samplePayload)
    });
    assert.equal(eventResponse.status, 202);

    const staleWorkerResponse = await fetch(
      `${started.baseUrl}/jobs/next?clientId=copy-repost-extension`,
      {
        headers: authHeaders({
          origin: "chrome-extension://bfnjhgnbompdhdakmfohoahoohalkhpi"
        })
      }
    );
    assert.equal(staleWorkerResponse.status, 409);
    assert.equal((await staleWorkerResponse.json()).error.code, "delivery_client_mismatch");

    const cachedCurrentWorkerResponse = await fetch(
      `${started.baseUrl}/jobs/next?clientId=copy-repost-extension`,
      {
        headers: authHeaders({
          origin: "chrome-extension://ddpgdbgihdmkfcnchbffjkihakdopdbl"
        })
      }
    );
    assert.equal(cachedCurrentWorkerResponse.status, 200);
    assert.equal((await cachedCurrentWorkerResponse.json()).destinationUrl, firstDestinationUrl);

    const currentVersionedWorkerResponse = await fetch(
      `${started.baseUrl}/jobs/next?clientId=sentinel-link-extension-0.2.4`,
      { headers: authHeaders() }
    );
    assert.equal(currentVersionedWorkerResponse.status, 200);
    assert.equal((await currentVersionedWorkerResponse.json()).destinationUrl, secondDestinationUrl);
  } finally {
    await closeHelperHttpServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test("HTTP API skips stale events before queueing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "helper-http-stale-event-"));
  let server;
  try {
    const store = await createJsonStore(join(dir, "state.json"));
    let baseUrl;
    ({ server, baseUrl } = await startHelperHttpServer(store, freshnessConfig));

    const eventResponse = await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(samplePayload)
    });

    assert.equal(eventResponse.status, 202);
    const eventBody = await eventResponse.json();
    assert.equal(eventBody.skippedStale, true);
    assert.equal(eventBody.reason, "missing Discord timestamp");

    const snapshot = await store.snapshot();
    assert.equal(snapshot.jobs.length, 0);
  } finally {
    await closeHelperHttpServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test("store records a changed message revision without reposting it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "helper-revision-"));
  try {
    const store = await createJsonStore(join(dir, "state.json"));
    const first = await store.enqueueAlert(singleDestinationConfig, {
      ...samplePayload,
      revisionHash: "aaa111"
    });
    const updated = await store.enqueueAlert(singleDestinationConfig, {
      ...samplePayload,
      text: "IN AT $.26 - FILLED",
      revisionHash: "bbb222",
      eventType: "updated"
    });
    const duplicateUpdate = await store.enqueueAlert(singleDestinationConfig, {
      ...samplePayload,
      text: "IN AT $.26 - FILLED",
      revisionHash: "bbb222",
      eventType: "updated"
    });
    const snapshot = await store.snapshot();

    assert.equal(first.createdJobs.length, 1);
    assert.equal(updated.updated, true);
    assert.deepEqual(updated.createdJobs, []);
    assert.equal(duplicateUpdate.skippedDuplicate, true);
    assert.equal(snapshot.jobs.length, 1);
    assert.equal(snapshot.events.filter((event) => event.type === "message_updated").length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("store bounds operational history and archives pruned terminal records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "helper-retention-"));
  try {
    const statePath = join(dir, "state.json");
    const store = await createJsonStore(statePath, {
      maxEvents: 4,
      maxTerminalJobs: 1,
      maxSeen: 2
    });

    for (let index = 0; index < 3; index += 1) {
      await store.enqueueAlert(singleDestinationConfig, {
        ...samplePayload,
        messageId: `message-${index}`,
        text: `Entry alert ${index}`
      });
      const job = await store.claimNextJob("retention-test");
      await store.recordJobResult({ jobId: job.id, status: "sent", clientId: "retention-test" });
    }

    const snapshot = await store.snapshot();
    assert.equal(snapshot.jobs.length, 1);
    assert.ok(snapshot.events.length <= 4);
    assert.ok(Object.keys(snapshot.seen).length <= 2);

    const archiveFiles = await readdir(join(dir, "archive"));
    assert.ok(archiveFiles.some((name) => name.endsWith(".jsonl")));
    const archive = await readFile(join(dir, "archive", archiveFiles[0]), "utf8");
    assert.match(archive, /"recordType":"job"/);
    assert.match(archive, /"recordType":"event"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("independent helper stores do not collide while replacing the same state file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "helper-concurrent-state-"));
  try {
    const statePath = join(dir, "state.json");
    const firstStore = await createJsonStore(statePath);
    const secondStore = await createJsonStore(statePath);

    const writes = Array.from({ length: 20 }, (_, index) => {
      const store = index % 2 === 0 ? firstStore : secondStore;
      return store.captureAlert({
        ...samplePayload,
        messageId: `concurrent-${index}`,
        text: `Concurrent alert ${index}`
      });
    });

    await assert.doesNotReject(Promise.all(writes));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("store skips duplicate visible source message when Discord replaces the message id", async () => {
  const dir = await mkdtemp(join(tmpdir(), "helper-visible-duplicate-"));
  try {
    const store = await createJsonStore(join(dir, "state.json"));
    const first = await store.enqueueAlert(singleDestinationConfig, {
      ...samplePayload,
      messageId: "temporary-local-id",
      author: "Tetradim",
      timestampText: "[ 8:14 AM ]",
      text: "Dedicated"
    });
    const second = await store.enqueueAlert(singleDestinationConfig, {
      ...samplePayload,
      messageId: "confirmed-server-id",
      author: "Tetradim",
      timestampText: "[ 8:14 AM ]",
      text: "Dedicated"
    });
    const snapshot = await store.snapshot();

    assert.equal(first.createdJobs.length, 1);
    assert.equal(second.skippedDuplicate, true);
    assert.equal(snapshot.jobs.length, 1);
    assert.equal(snapshot.events.at(-1).type, "skipped_duplicate");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("store skips same visible alert when Discord reports different seconds-level timestamps", async () => {
  const dir = await mkdtemp(join(tmpdir(), "helper-visible-timestamp-duplicate-"));
  try {
    const store = await createJsonStore(join(dir, "state.json"));
    const first = await store.enqueueAlert(singleDestinationConfig, {
      ...samplePayload,
      messageId: "1520064533064843264",
      author: "Tetradim",
      timestampText: "— 8:53 AM",
      timestampIso: "2026-06-26T13:53:46.117Z",
      text: "tester"
    });
    const second = await store.enqueueAlert(singleDestinationConfig, {
      ...samplePayload,
      messageId: "1520064527658520646",
      author: "Tetradim",
      timestampText: "— 8:53 AM",
      timestampIso: "2026-06-26T13:53:44.827Z",
      text: "tester"
    });
    const snapshot = await store.snapshot();

    assert.equal(first.createdJobs.length, 1);
    assert.equal(second.skippedDuplicate, true);
    assert.equal(snapshot.jobs.length, 1);
    assert.equal(snapshot.events.at(-1).type, "skipped_duplicate");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("HTTP API fails stale queued jobs instead of handing them to clients", async () => {
  const dir = await mkdtemp(join(tmpdir(), "helper-http-stale-queued-"));
  let server;
  try {
    const store = await createJsonStore(join(dir, "state.json"));
    await store.enqueueAlert(singleDestinationConfig, samplePayload);
    let baseUrl;
    ({ server, baseUrl } = await startHelperHttpServer(store, freshnessConfig));

    const nextResponse = await fetch(`${baseUrl}/jobs/next?clientId=copy-repost`, {
      headers: authHeaders()
    });

    assert.equal(nextResponse.status, 200);
    assert.deepEqual(await nextResponse.json(), { job: null });

    const snapshot = await store.snapshot();
    assert.equal(snapshot.jobs[0].status, "failed");
    assert.equal(snapshot.jobs[0].reason, "stale source message: missing Discord timestamp");
  } finally {
    await closeHelperHttpServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test("HTTP API rejects requests without helper token", async () => {
  const dir = await mkdtemp(join(tmpdir(), "helper-http-auth-missing-"));
  let server;
  try {
    const store = await createJsonStore(join(dir, "state.json"));
    let baseUrl;
    ({ server, baseUrl } = await startHelperHttpServer(store));

    const response = await fetch(`${baseUrl}/health`);

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {
      error: {
        code: "unauthorized",
        message: "A valid helper token is required."
      }
    });
  } finally {
    await closeHelperHttpServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test("HTTP API rejects requests with wrong helper token", async () => {
  const dir = await mkdtemp(join(tmpdir(), "helper-http-auth-wrong-"));
  let server;
  try {
    const store = await createJsonStore(join(dir, "state.json"));
    let baseUrl;
    ({ server, baseUrl } = await startHelperHttpServer(store));

    const response = await fetch(`${baseUrl}/health`, {
      headers: { "x-helper-token": "wrong-token" }
    });

    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, "unauthorized");
  } finally {
    await closeHelperHttpServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test("HTTP API accepts OPTIONS preflight without helper token", async () => {
  const dir = await mkdtemp(join(tmpdir(), "helper-http-options-"));
  let server;
  try {
    const store = await createJsonStore(join(dir, "state.json"));
    let baseUrl;
    ({ server, baseUrl } = await startHelperHttpServer(store));

    const response = await fetch(`${baseUrl}/events`, {
      method: "OPTIONS",
      headers: {
        origin: "https://discord.com",
        "access-control-request-headers": "content-type,x-helper-token"
      }
    });

    assert.equal(response.status, 204);
    assert.equal(await response.text(), "");
    assert.equal(response.headers.get("access-control-allow-origin"), "https://discord.com");
    assert.equal(response.headers.get("access-control-allow-headers"), "content-type,x-helper-token");
  } finally {
    await closeHelperHttpServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test("HTTP API rejects missing and blank clientId on next job", async () => {
  const dir = await mkdtemp(join(tmpdir(), "helper-http-client-id-"));
  let server;
  try {
    const store = await createJsonStore(join(dir, "state.json"));
    let baseUrl;
    ({ server, baseUrl } = await startHelperHttpServer(store));

    const missingResponse = await fetch(`${baseUrl}/jobs/next`, {
      headers: authHeaders()
    });
    assert.equal(missingResponse.status, 400);
    assert.equal((await missingResponse.json()).error.code, "missing_client_id");

    const blankResponse = await fetch(`${baseUrl}/jobs/next?clientId=%20%20`, {
      headers: authHeaders()
    });
    assert.equal(blankResponse.status, 400);
    assert.equal((await blankResponse.json()).error.code, "missing_client_id");
  } finally {
    await closeHelperHttpServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test("HTTP API rejects missing and blank clientId on job result", async () => {
  const dir = await mkdtemp(join(tmpdir(), "helper-http-result-client-id-"));
  let server;
  try {
    const store = await createJsonStore(join(dir, "state.json"));
    let baseUrl;
    ({ server, baseUrl } = await startHelperHttpServer(store));

    const missingResponse = await fetch(`${baseUrl}/jobs/any-job/result`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ status: "sent", degradation: [] })
    });
    assert.equal(missingResponse.status, 400);
    assert.equal((await missingResponse.json()).error.code, "missing_client_id");

    const blankResponse = await fetch(`${baseUrl}/jobs/any-job/result`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ status: "sent", clientId: "  ", degradation: [] })
    });
    assert.equal(blankResponse.status, 400);
    assert.equal((await blankResponse.json()).error.code, "missing_client_id");
  } finally {
    await closeHelperHttpServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test("HTTP API rejects invalid JSON with stable error code", async () => {
  const dir = await mkdtemp(join(tmpdir(), "helper-http-invalid-json-"));
  let server;
  try {
    const store = await createJsonStore(join(dir, "state.json"));
    let baseUrl;
    ({ server, baseUrl } = await startHelperHttpServer(store));

    const response = await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: "{"
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: {
        code: "invalid_json",
        message: "Request body must be valid JSON."
      }
    });
  } finally {
    await closeHelperHttpServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test("HTTP API maps wrong result clientId to lease conflict", async () => {
  const dir = await mkdtemp(join(tmpdir(), "helper-http-lease-conflict-"));
  let server;
  try {
    const store = await createJsonStore(join(dir, "state.json"));
    let baseUrl;
    ({ server, baseUrl } = await startHelperHttpServer(store, singleDestinationConfig));

    await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(samplePayload)
    });
    const nextResponse = await fetch(`${baseUrl}/jobs/next?clientId=copy-repost`, {
      headers: authHeaders()
    });
    const job = await nextResponse.json();

    const response = await fetch(`${baseUrl}/jobs/${job.id}/result`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ status: "sent", clientId: "other-client", degradation: [] })
    });

    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, "lease_conflict");
  } finally {
    await closeHelperHttpServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test("HTTP API maps unknown job result to not found", async () => {
  const dir = await mkdtemp(join(tmpdir(), "helper-http-unknown-job-"));
  let server;
  try {
    const store = await createJsonStore(join(dir, "state.json"));
    let baseUrl;
    ({ server, baseUrl } = await startHelperHttpServer(store));

    const response = await fetch(`${baseUrl}/jobs/missing-job/result`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ status: "sent", clientId: "copy-repost", degradation: [] })
    });

    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, "job_not_found");
  } finally {
    await closeHelperHttpServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test("HTTP API rejects oversized JSON payloads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "helper-http-large-payload-"));
  let server;
  try {
    const store = await createJsonStore(join(dir, "state.json"));
    let baseUrl;
    ({ server, baseUrl } = await startHelperHttpServer(store));

    const response = await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ text: "x".repeat(1024 * 1024) })
    });

    assert.equal(response.status, 413);
    assert.equal((await response.json()).error.code, "payload_too_large");
  } finally {
    await closeHelperHttpServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});
