import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  createDedupeKey,
  formatRepostMessage,
  validateAlertPayload,
  validateConfig
} from "@extension-external/shared";
import { nextRetryDelayMs } from "./retry.js";

const emptyState = () => ({ jobs: [], events: [], seen: {} });

export async function createJsonStore(filePath) {
  let state = await loadState(filePath);

  async function persist() {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
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

      state.seen[dedupeKey] = {
        sourceChannelId: payload.sourceChannelId,
        messageId: payload.messageId,
        seenAt: now.toISOString()
      };

      if (createdJobs.length === 0) {
        appendEvent(
          "no_matching_mapping",
          {
            dedupeKey,
            sourceChannelId: payload.sourceChannelId
          },
          now
        );
      }

      await persist();
      return { skippedDuplicate: false, createdJobs };
    },

    async claimNextJob(clientId, now = new Date()) {
      const nowTime = now.getTime();
      const job = state.jobs.find(
        (candidate) =>
          (candidate.status === "queued" || candidate.status === "retry_wait") &&
          new Date(candidate.dueAt).getTime() <= nowTime
      );

      if (!job) {
        return null;
      }

      job.status = "in_progress";
      job.attempt += 1;
      job.clientId = clientId;
      job.updatedAt = now.toISOString();
      appendEvent(
        "in_progress",
        {
          jobId: job.id,
          attempt: job.attempt,
          clientId
        },
        now
      );
      await persist();
      return clone(job);
    },

    async recordJobResult({ jobId, status, reason = "", retry, degradation = [], now = new Date() }) {
      const job = state.jobs.find((candidate) => candidate.id === jobId);
      if (!job) {
        throw new Error(`Job not found: ${jobId}`);
      }

      if (status === "sent") {
        job.status = "sent";
        job.reason = reason;
        job.degradation = degradation;
        job.completedAt = now.toISOString();
        job.updatedAt = now.toISOString();
        appendEvent("sent", { jobId, degradation }, now);
        await persist();
        return clone(job);
      }

      if (status !== "failed") {
        throw new Error(`Unsupported job result status: ${status}`);
      }

      const retryConfig = normalizeRetry(retry);
      job.reason = reason;
      job.degradation = degradation;
      job.updatedAt = now.toISOString();

      if (job.attempt < retryConfig.maxAttempts) {
        const delayMs = nextRetryDelayMs(job.attempt, retryConfig.baseDelayMs);
        job.status = "retry_wait";
        job.dueAt = new Date(now.getTime() + delayMs).toISOString();
        appendEvent(
          "retry_wait",
          {
            jobId,
            attempt: job.attempt,
            delayMs,
            dueAt: job.dueAt,
            reason
          },
          now
        );
      } else {
        job.status = "failed";
        job.completedAt = now.toISOString();
        appendEvent(
          "failed",
          {
            jobId,
            attempt: job.attempt,
            reason
          },
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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
