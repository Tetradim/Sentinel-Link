import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import {
  createDedupeKey,
  formatRepostMessage,
  validateAlertPayload,
  validateConfig
} from "@extension-external/shared";
import { nextRetryDelayMs } from "./retry.js";

const emptyState = () => ({ jobs: [], events: [], seen: {} });
const defaultLeaseMs = 30_000;

export async function createJsonStore(filePath) {
  let state = await loadState(filePath);
  let writeChain = Promise.resolve();

  function persist() {
    const stateToWrite = clone(state);
    const write = writeChain.catch(() => {}).then(() => writeState(filePath, stateToWrite));
    writeChain = write;
    return write;
  }

  function appendEvent(type, fields = {}, now = new Date()) {
    const event = {
      id: randomUUID(),
      type,
      at: now.toISOString(),
      ...fields
    };
    state.events.push(event);
    return event;
  }

  function resetExpiredLeases(now) {
    const nowTime = now.getTime();
    let changed = false;

    for (const job of state.jobs) {
      if (job.status !== "in_progress") {
        continue;
      }

      if (job.leaseExpiresAt) {
        const leaseExpiresTime = new Date(job.leaseExpiresAt).getTime();
        if (Number.isFinite(leaseExpiresTime) && leaseExpiresTime > nowTime) {
          continue;
        }
      }

      const previousClientId = job.clientId;
      job.status = "retry_wait";
      job.dueAt = now.toISOString();
      job.clientId = "";
      job.leaseExpiresAt = "";
      job.updatedAt = now.toISOString();
      appendEvent(
        "retry_wait",
        jobEventFields(job, {
          clientId: previousClientId,
          dueAt: job.dueAt,
          reason: "lease_expired"
        }),
        now
      );
      changed = true;
    }

    return changed;
  }

  if (resetExpiredLeases(new Date())) {
    await persist();
  }

  return {
    async enqueueAlert(config, payloadInput) {
      const validConfig = validateConfig(config);
      const payload = validateAlertPayload(payloadInput);
      const dedupeKey = createDedupeKey(payload);
      const now = new Date();

      if (state.seen[dedupeKey]) {
        appendEvent(
          "skipped_duplicate",
          {
            dedupeKey,
            sourceChannelId: payload.sourceChannelId,
            messageId: payload.messageId
          },
          now
        );
        await persist();
        return { skippedDuplicate: true, createdJobs: [] };
      }

      const mappings = validConfig.enabled
        ? validConfig.mappings.filter(
            (mapping) => mapping.enabled && mapping.sourceChannelId === payload.sourceChannelId
          )
        : [];
      const createdJobs = [];

      for (const mapping of mappings) {
        const messageText = formatRepostMessage(payload, { prefix: mapping.prefix });
        for (const destinationUrl of mapping.destinationUrls) {
          const job = {
            id: randomUUID(),
            status: "queued",
            mappingId: mapping.id,
            dedupeKey,
            sourceChannelId: payload.sourceChannelId,
            destinationUrl,
            messageText,
            payload,
            attempt: 0,
            dueAt: now.toISOString(),
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
            clientId: "",
            reason: "",
            degradation: []
          };
          state.jobs.push(job);
          createdJobs.push(clone(job));
          appendEvent(
            "queued",
            {
              jobId: job.id,
              dedupeKey,
              mappingId: mapping.id,
              destinationUrl
            },
            now
          );
        }
      }

      if (createdJobs.length === 0) {
        appendEvent(
          "no_matching_mapping",
          {
            dedupeKey,
            sourceChannelId: payload.sourceChannelId
          },
          now
        );
      } else {
        state.seen[dedupeKey] = {
          sourceChannelId: payload.sourceChannelId,
          messageId: payload.messageId,
          seenAt: now.toISOString()
        };
      }

      await persist();
      return { skippedDuplicate: false, createdJobs };
    },

    async claimNextJob(clientId, now = new Date()) {
      const nowTime = now.getTime();
      const recoveredLeases = resetExpiredLeases(now);
      const job = state.jobs.find(
        (candidate) =>
          (candidate.status === "queued" || candidate.status === "retry_wait") &&
          new Date(candidate.dueAt).getTime() <= nowTime
      );

      if (!job) {
        if (recoveredLeases) {
          await persist();
        }
        return null;
      }

      job.status = "in_progress";
      job.attempt += 1;
      job.clientId = clientId;
      job.leaseExpiresAt = new Date(nowTime + defaultLeaseMs).toISOString();
      job.updatedAt = now.toISOString();
      appendEvent(
        "in_progress",
        jobEventFields(job),
        now
      );
      await persist();
      return clone(job);
    },

    async recordJobResult({ jobId, status, reason = "", retry, degradation = [], clientId, now = new Date() }) {
      const job = state.jobs.find((candidate) => candidate.id === jobId);
      if (!job) {
        throw new Error(`Job not found: ${jobId}`);
      }

      if (status !== "sent" && status !== "failed") {
        throw new Error(`Unsupported job result status: ${status}`);
      }

      if (job.status === "sent" || job.status === "failed") {
        throw new Error(`Job already terminal: ${jobId}`);
      }

      if (job.status !== "in_progress") {
        throw new Error(`Job must be in progress before recording result: ${jobId}`);
      }

      if (!clientId) {
        throw new Error(`clientId is required to record job result: ${jobId}`);
      }

      if (job.clientId !== clientId) {
        throw new Error(`Job ${jobId} is leased to a different client`);
      }

      if (status === "sent") {
        job.status = "sent";
        job.reason = reason;
        job.degradation = degradation;
        job.completedAt = now.toISOString();
        job.leaseExpiresAt = "";
        job.updatedAt = now.toISOString();
        appendEvent("sent", jobEventFields(job, { degradation, reason }), now);
        await persist();
        return clone(job);
      }

      const retryConfig = normalizeRetry(retry);
      job.reason = reason;
      job.degradation = degradation;
      job.updatedAt = now.toISOString();
      job.leaseExpiresAt = "";

      if (job.attempt < retryConfig.maxAttempts) {
        const delayMs = nextRetryDelayMs(job.attempt, retryConfig.baseDelayMs);
        job.status = "retry_wait";
        job.dueAt = new Date(now.getTime() + delayMs).toISOString();
        appendEvent(
          "retry_wait",
          jobEventFields(job, {
            delayMs,
            dueAt: job.dueAt,
            degradation,
            reason
          }),
          now
        );
        job.clientId = "";
      } else {
        job.status = "failed";
        job.completedAt = now.toISOString();
        appendEvent(
          "failed",
          jobEventFields(job, {
            degradation,
            reason
          }),
          now
        );
      }

      await persist();
      return clone(job);
    },

    async snapshot() {
      return clone(state);
    }
  };
}

async function writeState(filePath, state) {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  const handle = await open(tempPath, "w");
  try {
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tempPath, filePath);
}

async function loadState(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
      events: Array.isArray(parsed.events) ? parsed.events : [],
      seen: parsed.seen && typeof parsed.seen === "object" && !Array.isArray(parsed.seen) ? parsed.seen : {}
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return emptyState();
    }
    throw error;
  }
}

function normalizeRetry(retry = {}) {
  const maxAttempts = Number.isInteger(retry.maxAttempts) ? retry.maxAttempts : 3;
  const baseDelayMs = Number.isInteger(retry.baseDelayMs) ? retry.baseDelayMs : 2000;
  return { maxAttempts, baseDelayMs };
}

function jobEventFields(job, fields = {}) {
  return {
    jobId: job.id,
    attempt: job.attempt,
    mappingId: job.mappingId,
    destinationUrl: job.destinationUrl,
    clientId: job.clientId,
    ...fields
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
