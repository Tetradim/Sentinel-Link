import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfigFromFile } from "../src/config.js";
import { nextRetryDelayMs } from "../src/retry.js";
import { createJsonStore } from "../src/store.js";

const sourceUrl = "https://discord.com/channels/111111111111111111/222222222222222222";
const firstDestinationUrl = "https://discord.com/channels/333333333333333333/444444444444444444";
const secondDestinationUrl = "https://discord.com/channels/333333333333333333/555555555555555555";

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
    const secondClaim = await reloaded.claimNextJob("client-2", new Date("2030-01-01T17:00:31.000Z"));

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
    const secondClaim = await reloaded.claimNextJob("client-2", new Date("2030-01-01T17:00:31.000Z"));
    assert.equal(secondClaim.id, firstClaim.id);
    assert.equal(secondClaim.clientId, "client-2");

    await assert.rejects(
      reloaded.recordJobResult({
        jobId: firstClaim.id,
        status: "sent",
        now: new Date("2030-01-01T17:00:32.000Z")
      }),
      /clientId/
    );

    await assert.rejects(
      reloaded.recordJobResult({
        jobId: firstClaim.id,
        status: "sent",
        clientId: "client-1",
        now: new Date("2030-01-01T17:00:32.000Z")
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
