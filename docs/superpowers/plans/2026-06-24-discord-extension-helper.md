# Sentinel Link Helper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a monorepo with a local helper app, a Discord copy/repost Chrome extension, and a trading bridge integration area for authorized alert testing through the visible Discord web UI.

**Architecture:** The helper app owns durable configuration, queueing, dedupe, retry state, and logs through a localhost HTTP API. The copy/repost extension extracts visible Discord alert data from configured source tabs, asks the helper for destination jobs, and posts through the visible Discord composer. The trading bridge area exposes the same helper client contract so the currently installed Sentinel Link Trading Bridge can be adapted without coupling it to the copy/repost extension internals.

**Tech Stack:** Node.js 20+ ESM, built-in `node:test`, built-in `http`, JSON files for durable local state, Chrome Manifest V3, vanilla JavaScript content scripts, localhost HTTP polling.

---

## Branch Order

Run these branches in order so each slice can merge into `main` cleanly:

1. `feature/external-helper-app`
2. `feature/copy-repost-extension`
3. `feature/trading-bridge-extension`

Before starting the first branch, verify the accepted spec is committed:

```powershell
git status --short --branch
git log --oneline --decorate --max-count=5
```

Expected: `main` is clean or only ahead of `origin/main` with accepted spec commits.

## File Structure

Create or modify these files across the three branches:

- `package.json`: root npm workspace scripts.
- `.gitignore`: ignore dependency installs, logs, helper state, and local config overrides.
- `packages/shared/package.json`: shared schema package metadata.
- `packages/shared/src/index.js`: shared validation, dedupe, channel parsing, and formatting functions.
- `packages/shared/test/shared.test.js`: tests for config validation, payload validation, dedupe keys, and repost formatting.
- `apps/external-helper/package.json`: helper app package metadata.
- `apps/external-helper/config/config.example.json`: example mappings and retry settings.
- `apps/external-helper/src/config.js`: load and validate helper config.
- `apps/external-helper/src/store.js`: JSON-backed durable queue and event log store.
- `apps/external-helper/src/retry.js`: exponential backoff calculations.
- `apps/external-helper/src/server.js`: localhost HTTP API.
- `apps/external-helper/src/main.js`: CLI entrypoint.
- `apps/external-helper/test/helper.test.js`: queue, dedupe, retry, and API tests.
- `extensions/copy-repost/manifest.json`: Chrome extension manifest.
- `extensions/copy-repost/src/parser.js`: Discord DOM extraction helpers.
- `extensions/copy-repost/src/content.js`: source observation and destination composer automation.
- `extensions/copy-repost/src/background.js`: helper polling and tab coordination.
- `extensions/copy-repost/src/popup.html`: extension status popup.
- `extensions/copy-repost/src/popup.js`: popup status behavior.
- `extensions/copy-repost/src/styles.css`: popup styles.
- `extensions/copy-repost/test/parser.test.js`: parser unit tests with fake DOM nodes.
- `extensions/copy-repost/README.md`: loading, config, and manual test instructions.
- `extensions/trading-bridge/README.md`: trading bridge import and adapter instructions.
- `extensions/trading-bridge/helper-client.js`: reusable helper API client for the installed Sentinel Link Trading Bridge.

## Shared Helper Protocol

The extension and helper communicate with this HTTP API:

- `GET /health`: returns helper status.
- `GET /config`: returns enabled mappings and retry settings.
- `POST /events`: accepts a normalized alert payload and queues destination jobs.
- `GET /jobs/next?clientId=<id>`: returns the next due job for an extension client.
- `POST /jobs/:id/result`: records `sent` or `failed`, then either completes, schedules retry, or marks final failure.
- `GET /status`: returns queue counts and recent log entries.

The first implementation uses HTTP polling instead of WebSocket so the helper has no runtime dependencies beyond Node.

---

### Task 1: External Helper Branch And Workspace Foundation

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `packages/shared/package.json`
- Create: `packages/shared/src/index.js`
- Create: `packages/shared/test/shared.test.js`

- [ ] **Step 1: Create the external helper feature branch**

Run:

```powershell
git switch main
git switch -c feature/external-helper-app
```

Expected: branch changes to `feature/external-helper-app`.

- [ ] **Step 2: Add the root workspace files**

Create `package.json` with:

```json
{
  "name": "sentinel-link",
  "private": true,
  "type": "module",
  "workspaces": [
    "apps/*",
    "packages/*"
  ],
  "scripts": {
    "test": "node --test packages/shared/test/*.test.js apps/external-helper/test/*.test.js extensions/copy-repost/test/*.test.js",
    "test:shared": "node --test packages/shared/test/*.test.js",
    "test:helper": "node --test apps/external-helper/test/*.test.js",
    "test:copy-repost": "node --test extensions/copy-repost/test/*.test.js",
    "helper:start": "node apps/external-helper/src/main.js"
  },
  "engines": {
    "node": ">=20"
  }
}
```

Create `.gitignore` with:

```gitignore
node_modules/
npm-debug.log*
.DS_Store
Thumbs.db

apps/external-helper/data/
apps/external-helper/config/config.local.json
*.log
```

- [ ] **Step 3: Add the shared package metadata**

Create `packages/shared/package.json` with:

```json
{
  "name": "@sentinel-link/shared",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.js",
  "exports": {
    ".": "./src/index.js"
  }
}
```

- [ ] **Step 4: Write shared schema tests first**

Create `packages/shared/test/shared.test.js` with:

```javascript
import test from "node:test";
import assert from "node:assert/strict";
import {
  createDedupeKey,
  formatRepostMessage,
  normalizeChannelUrl,
  validateAlertPayload,
  validateConfig
} from "../src/index.js";

test("normalizeChannelUrl extracts guild and channel ids", () => {
  assert.deepEqual(
    normalizeChannelUrl("https://discord.com/channels/111/222"),
    {
      url: "https://discord.com/channels/111/222",
      guildId: "111",
      channelId: "222"
    }
  );
});

test("validateConfig accepts enabled source to multiple destinations mapping", () => {
  const config = validateConfig({
    enabled: true,
    retry: { maxAttempts: 3, baseDelayMs: 2000 },
    mappings: [
      {
        id: "alerts-to-test",
        enabled: true,
        sourceUrl: "https://discord.com/channels/111/222",
        destinationUrls: [
          "https://discord.com/channels/333/444",
          "https://discord.com/channels/333/555"
        ],
        prefix: "[mirror]"
      }
    ]
  });

  assert.equal(config.enabled, true);
  assert.equal(config.mappings[0].destinationUrls.length, 2);
});

test("validateAlertPayload requires visible source fields and content", () => {
  const payload = validateAlertPayload({
    sourceUrl: "https://discord.com/channels/111/222",
    sourceChannelId: "222",
    messageId: "999",
    author: "Alert Bot",
    timestampText: "Today at 12:00 PM",
    text: "Entry alert",
    embeds: [{ title: "AAPL", description: "Breakout", fields: [{ name: "Price", value: "190" }] }],
    labels: ["Open Chart"],
    attachmentUrls: ["https://cdn.discordapp.com/file.png"],
    capturedAt: "2026-06-24T17:00:00.000Z"
  });

  assert.equal(payload.text, "Entry alert");
  assert.equal(payload.embeds[0].fields[0].name, "Price");
});

test("createDedupeKey is stable for the same source message", () => {
  const payload = validateAlertPayload({
    sourceUrl: "https://discord.com/channels/111/222",
    sourceChannelId: "222",
    messageId: "999",
    text: "Entry alert",
    embeds: [],
    labels: [],
    attachmentUrls: [],
    capturedAt: "2026-06-24T17:00:00.000Z"
  });

  assert.equal(createDedupeKey(payload), "222:999");
});

test("formatRepostMessage includes rich visible fields and degraded URL content", () => {
  const message = formatRepostMessage(
    {
      sourceUrl: "https://discord.com/channels/111/222",
      sourceChannelId: "222",
      messageId: "999",
      author: "Alert Bot",
      timestampText: "Today at 12:00 PM",
      text: "Entry alert",
      embeds: [
        {
          title: "AAPL",
          description: "Breakout",
          fields: [{ name: "Price", value: "190" }],
          footer: "Trading alerts"
        }
      ],
      labels: ["Open Chart"],
      attachmentUrls: ["https://cdn.discordapp.com/file.png"],
      capturedAt: "2026-06-24T17:00:00.000Z"
    },
    { prefix: "[mirror]" }
  );

  assert.match(message, /\[mirror\]/);
  assert.match(message, /Alert Bot/);
  assert.match(message, /AAPL/);
  assert.match(message, /Open Chart/);
  assert.match(message, /https:\/\/cdn.discordapp.com\/file.png/);
});
```

- [ ] **Step 5: Run shared tests and confirm failure**

Run:

```powershell
npm run test:shared
```

Expected: failure because `packages/shared/src/index.js` does not exist.

- [ ] **Step 6: Implement the shared package**

Create `packages/shared/src/index.js` with:

```javascript
export function normalizeChannelUrl(rawUrl) {
  const url = new URL(rawUrl);
  const match = url.pathname.match(/^\/channels\/([^/]+)\/([^/]+)/);
  if (!match) {
    throw new Error(`Discord channel URL expected: ${rawUrl}`);
  }
  return {
    url: `${url.origin}/channels/${match[1]}/${match[2]}`,
    guildId: match[1],
    channelId: match[2]
  };
}

export function validateConfig(input) {
  if (!input || typeof input !== "object") {
    throw new Error("Config must be an object");
  }
  const retry = input.retry ?? {};
  const maxAttempts = Number.isInteger(retry.maxAttempts) ? retry.maxAttempts : 3;
  const baseDelayMs = Number.isInteger(retry.baseDelayMs) ? retry.baseDelayMs : 2000;
  if (maxAttempts < 1 || maxAttempts > 10) {
    throw new Error("retry.maxAttempts must be between 1 and 10");
  }
  if (baseDelayMs < 250 || baseDelayMs > 60000) {
    throw new Error("retry.baseDelayMs must be between 250 and 60000");
  }
  const mappings = Array.isArray(input.mappings) ? input.mappings : [];
  return {
    enabled: input.enabled !== false,
    retry: { maxAttempts, baseDelayMs },
    sendPacingMs: Number.isInteger(input.sendPacingMs) ? input.sendPacingMs : 1500,
    mappings: mappings.map((mapping, index) => validateMapping(mapping, index))
  };
}

function validateMapping(mapping, index) {
  if (!mapping || typeof mapping !== "object") {
    throw new Error(`Mapping ${index} must be an object`);
  }
  if (!mapping.id || typeof mapping.id !== "string") {
    throw new Error(`Mapping ${index} requires id`);
  }
  const source = normalizeChannelUrl(mapping.sourceUrl);
  const destinationUrls = ensureStringArray(mapping.destinationUrls, `Mapping ${mapping.id} destinationUrls`);
  if (destinationUrls.length === 0) {
    throw new Error(`Mapping ${mapping.id} requires at least one destination`);
  }
  return {
    id: mapping.id,
    enabled: mapping.enabled !== false,
    sourceUrl: source.url,
    sourceChannelId: source.channelId,
    destinationUrls: destinationUrls.map((destinationUrl) => normalizeChannelUrl(destinationUrl).url),
    prefix: typeof mapping.prefix === "string" ? mapping.prefix : ""
  };
}

function ensureStringArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value;
}

export function validateAlertPayload(input) {
  if (!input || typeof input !== "object") {
    throw new Error("Alert payload must be an object");
  }
  const source = normalizeChannelUrl(input.sourceUrl);
  const text = typeof input.text === "string" ? input.text : "";
  const embeds = Array.isArray(input.embeds) ? input.embeds.map(validateEmbed) : [];
  const labels = Array.isArray(input.labels) ? input.labels.filter((label) => typeof label === "string") : [];
  const attachmentUrls = Array.isArray(input.attachmentUrls)
    ? input.attachmentUrls.filter((url) => typeof url === "string")
    : [];
  if (!text.trim() && embeds.length === 0 && labels.length === 0 && attachmentUrls.length === 0) {
    throw new Error("Alert payload must include visible content");
  }
  return {
    sourceUrl: source.url,
    sourceChannelId: typeof input.sourceChannelId === "string" ? input.sourceChannelId : source.channelId,
    messageId: typeof input.messageId === "string" && input.messageId ? input.messageId : createFallbackMessageId(input),
    author: typeof input.author === "string" ? input.author : "",
    timestampText: typeof input.timestampText === "string" ? input.timestampText : "",
    text,
    embeds,
    labels,
    attachmentUrls,
    capturedAt: typeof input.capturedAt === "string" ? input.capturedAt : new Date().toISOString()
  };
}

function validateEmbed(embed) {
  const fields = Array.isArray(embed?.fields)
    ? embed.fields
        .filter((field) => field && typeof field.name === "string" && typeof field.value === "string")
        .map((field) => ({ name: field.name, value: field.value }))
    : [];
  return {
    title: typeof embed?.title === "string" ? embed.title : "",
    description: typeof embed?.description === "string" ? embed.description : "",
    fields,
    footer: typeof embed?.footer === "string" ? embed.footer : ""
  };
}

function createFallbackMessageId(input) {
  const basis = `${input.sourceUrl ?? ""}|${input.author ?? ""}|${input.timestampText ?? ""}|${input.text ?? ""}`;
  let hash = 0;
  for (const character of basis) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return `visible-${hash.toString(16)}`;
}

export function createDedupeKey(payload) {
  const valid = validateAlertPayload(payload);
  return `${valid.sourceChannelId}:${valid.messageId}`;
}

export function formatRepostMessage(payload, options = {}) {
  const valid = validateAlertPayload(payload);
  const lines = [];
  if (options.prefix) {
    lines.push(options.prefix);
  }
  lines.push(`Source: ${valid.sourceUrl}`);
  if (valid.author || valid.timestampText) {
    lines.push(`From: ${[valid.author, valid.timestampText].filter(Boolean).join(" - ")}`);
  }
  if (valid.text.trim()) {
    lines.push("");
    lines.push(valid.text.trim());
  }
  for (const embed of valid.embeds) {
    lines.push("");
    if (embed.title) lines.push(`Embed: ${embed.title}`);
    if (embed.description) lines.push(embed.description);
    for (const field of embed.fields) {
      lines.push(`${field.name}: ${field.value}`);
    }
    if (embed.footer) lines.push(embed.footer);
  }
  if (valid.labels.length) {
    lines.push("");
    lines.push(`Labels: ${valid.labels.join(", ")}`);
  }
  if (valid.attachmentUrls.length) {
    lines.push("");
    lines.push("Visible attachment URLs:");
    lines.push(...valid.attachmentUrls);
  }
  return lines.join("\n").trim();
}
```

- [ ] **Step 7: Run shared tests and commit**

Run:

```powershell
npm run test:shared
```

Expected: all shared tests pass.

Commit:

```powershell
git add package.json .gitignore packages/shared
git commit -m "feat: add shared helper schemas"
```

---

### Task 2: External Helper Queue And Retry Core

**Files:**
- Create: `apps/external-helper/package.json`
- Create: `apps/external-helper/config/config.example.json`
- Create: `apps/external-helper/src/retry.js`
- Create: `apps/external-helper/src/config.js`
- Create: `apps/external-helper/src/store.js`
- Create: `apps/external-helper/test/helper.test.js`

- [ ] **Step 1: Add helper package metadata and example config**

Create `apps/external-helper/package.json` with:

```json
{
  "name": "@sentinel-link/helper",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "dependencies": {
    "@sentinel-link/shared": "file:../../packages/shared"
  }
}
```

Create `apps/external-helper/config/config.example.json` with:

```json
{
  "enabled": true,
  "retry": {
    "maxAttempts": 3,
    "baseDelayMs": 2000
  },
  "sendPacingMs": 1500,
  "mappings": [
    {
      "id": "alerts-to-bot-test",
      "enabled": true,
      "sourceUrl": "https://discord.com/channels/111111111111111111/222222222222222222",
      "destinationUrls": [
        "https://discord.com/channels/333333333333333333/444444444444444444"
      ],
      "prefix": "[copied-alert]"
    }
  ]
}
```

- [ ] **Step 2: Write helper core tests first**

Create `apps/external-helper/test/helper.test.js` with:

```javascript
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfigFromFile } from "../src/config.js";
import { nextRetryDelayMs } from "../src/retry.js";
import { createJsonStore } from "../src/store.js";

const sampleConfig = {
  enabled: true,
  retry: { maxAttempts: 3, baseDelayMs: 2000 },
  mappings: [
    {
      id: "map-1",
      enabled: true,
      sourceUrl: "https://discord.com/channels/111/222",
      destinationUrls: [
        "https://discord.com/channels/333/444",
        "https://discord.com/channels/333/555"
      ],
      prefix: "[mirror]"
    }
  ]
};

const samplePayload = {
  sourceUrl: "https://discord.com/channels/111/222",
  sourceChannelId: "222",
  messageId: "999",
  author: "Alert Bot",
  timestampText: "Today at 12:00 PM",
  text: "Entry alert",
  embeds: [],
  labels: [],
  attachmentUrls: [],
  capturedAt: "2026-06-24T17:00:00.000Z"
};

test("nextRetryDelayMs doubles from base delay by retry attempt", () => {
  assert.equal(nextRetryDelayMs(1, 2000), 2000);
  assert.equal(nextRetryDelayMs(2, 2000), 4000);
  assert.equal(nextRetryDelayMs(3, 2000), 8000);
});

test("loadConfigFromFile validates JSON config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "helper-config-"));
  try {
    const configPath = join(dir, "config.json");
    await import("node:fs/promises").then((fs) => fs.writeFile(configPath, JSON.stringify(sampleConfig), "utf8"));
    const config = await loadConfigFromFile(configPath);
    assert.equal(config.mappings[0].destinationUrls.length, 2);
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
    assert.equal(snapshot.events.at(-1).type, "skipped_duplicate");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("store marks failed job for retry twice and final failure on third failed attempt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "helper-retry-"));
  try {
    const store = await createJsonStore(join(dir, "state.json"));
    await store.enqueueAlert(sampleConfig, samplePayload);

    const firstJob = await store.claimNextJob("copy-repost", new Date("2026-06-24T17:00:00.000Z"));
    assert.equal(firstJob.attempt, 1);

    const retryOne = await store.recordJobResult({
      jobId: firstJob.id,
      status: "failed",
      reason: "composer not found",
      retry: sampleConfig.retry,
      now: new Date("2026-06-24T17:00:00.000Z")
    });
    assert.equal(retryOne.status, "retry_wait");

    const secondJob = await store.claimNextJob("copy-repost", new Date("2026-06-24T17:00:02.000Z"));
    assert.equal(secondJob.attempt, 2);

    const retryTwo = await store.recordJobResult({
      jobId: secondJob.id,
      status: "failed",
      reason: "composer not found",
      retry: sampleConfig.retry,
      now: new Date("2026-06-24T17:00:02.000Z")
    });
    assert.equal(retryTwo.status, "retry_wait");

    const thirdJob = await store.claimNextJob("copy-repost", new Date("2026-06-24T17:00:06.000Z"));
    assert.equal(thirdJob.attempt, 3);

    const final = await store.recordJobResult({
      jobId: thirdJob.id,
      status: "failed",
      reason: "composer not found",
      retry: sampleConfig.retry,
      now: new Date("2026-06-24T17:00:06.000Z")
    });
    assert.equal(final.status, "failed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run helper tests and confirm failure**

Run:

```powershell
npm run test:helper
```

Expected: failure because helper source files do not exist.

- [ ] **Step 4: Implement retry calculation**

Create `apps/external-helper/src/retry.js` with:

```javascript
export function nextRetryDelayMs(attempt, baseDelayMs) {
  const retryIndex = Math.max(0, attempt - 1);
  return baseDelayMs * 2 ** retryIndex;
}
```

- [ ] **Step 5: Implement config loading**

Create `apps/external-helper/src/config.js` with:

```javascript
import { readFile } from "node:fs/promises";
import { validateConfig } from "@sentinel-link/shared";

export async function loadConfigFromFile(configPath) {
  const raw = await readFile(configPath, "utf8");
  return validateConfig(JSON.parse(raw));
}
```

- [ ] **Step 6: Implement the JSON store**

Create `apps/external-helper/src/store.js` with:

```javascript
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createDedupeKey, formatRepostMessage, validateAlertPayload } from "@sentinel-link/shared";
import { nextRetryDelayMs } from "./retry.js";

export async function createJsonStore(filePath) {
  const store = new JsonStore(filePath);
  await store.load();
  return store;
}

class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = { jobs: [], events: [], seen: {} };
  }

  async load() {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      this.state = JSON.parse(await readFile(this.filePath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await this.save();
    }
  }

  async save() {
    await writeFile(this.filePath, JSON.stringify(this.state, null, 2), "utf8");
  }

  async enqueueAlert(config, payloadInput) {
    const payload = validateAlertPayload(payloadInput);
    const dedupeKey = createDedupeKey(payload);
    if (this.state.seen[dedupeKey]) {
      this.state.events.push(createEvent("skipped_duplicate", { dedupeKey }));
      await this.save();
      return { skippedDuplicate: true, createdJobs: [] };
    }

    const matchingMappings = config.mappings.filter(
      (mapping) => config.enabled && mapping.enabled && mapping.sourceChannelId === payload.sourceChannelId
    );
    const createdJobs = [];
    for (const mapping of matchingMappings) {
      for (const destinationUrl of mapping.destinationUrls) {
        const job = {
          id: crypto.randomUUID(),
          mappingId: mapping.id,
          dedupeKey,
          status: "queued",
          sourceUrl: payload.sourceUrl,
          destinationUrl,
          payload,
          messageText: formatRepostMessage(payload, { prefix: mapping.prefix }),
          attempt: 0,
          nextAttemptAt: new Date().toISOString(),
          lastError: "",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        this.state.jobs.push(job);
        createdJobs.push(job);
      }
    }
    this.state.seen[dedupeKey] = true;
    this.state.events.push(createEvent("queued", { dedupeKey, jobCount: createdJobs.length }));
    await this.save();
    return { skippedDuplicate: false, createdJobs };
  }

  async claimNextJob(clientId, now = new Date()) {
    const job = this.state.jobs.find(
      (candidate) =>
        ["queued", "retry_wait"].includes(candidate.status) &&
        new Date(candidate.nextAttemptAt).getTime() <= now.getTime()
    );
    if (!job) return null;
    job.status = "in_progress";
    job.clientId = clientId;
    job.attempt += 1;
    job.updatedAt = now.toISOString();
    this.state.events.push(createEvent("in_progress", { jobId: job.id, clientId, attempt: job.attempt }));
    await this.save();
    return job;
  }

  async recordJobResult({ jobId, status, reason = "", retry, degradation = [], now = new Date() }) {
    const job = this.state.jobs.find((candidate) => candidate.id === jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }
    if (status === "sent") {
      job.status = "sent";
      job.degradation = degradation;
      job.updatedAt = now.toISOString();
      this.state.events.push(createEvent("sent", { jobId, degradation }));
      await this.save();
      return job;
    }
    if (job.attempt < retry.maxAttempts) {
      job.status = "retry_wait";
      job.lastError = reason;
      job.nextAttemptAt = new Date(now.getTime() + nextRetryDelayMs(job.attempt, retry.baseDelayMs)).toISOString();
      job.updatedAt = now.toISOString();
      this.state.events.push(createEvent("retry_wait", { jobId, reason, attempt: job.attempt }));
      await this.save();
      return job;
    }
    job.status = "failed";
    job.lastError = reason;
    job.updatedAt = now.toISOString();
    this.state.events.push(createEvent("failed", { jobId, reason, attempt: job.attempt }));
    await this.save();
    return job;
  }

  async snapshot() {
    return structuredClone(this.state);
  }
}

function createEvent(type, detail) {
  return {
    id: crypto.randomUUID(),
    type,
    detail,
    createdAt: new Date().toISOString()
  };
}
```

- [ ] **Step 7: Run helper tests and commit**

Run:

```powershell
npm run test:helper
```

Expected: all helper core tests pass.

Commit:

```powershell
git add apps/external-helper package.json
git commit -m "feat: add helper queue core"
```

---

### Task 3: External Helper HTTP API

**Files:**
- Modify: `apps/external-helper/test/helper.test.js`
- Create: `apps/external-helper/src/server.js`
- Create: `apps/external-helper/src/main.js`
- Modify: `apps/external-helper/package.json`

- [ ] **Step 1: Add HTTP API tests**

Append this test to `apps/external-helper/test/helper.test.js`:

```javascript
import { createServer } from "../src/server.js";

test("helper HTTP API accepts events, returns jobs, and records sent result", async () => {
  const dir = await mkdtemp(join(tmpdir(), "helper-api-"));
  try {
    const store = await createJsonStore(join(dir, "state.json"));
    const server = createServer({ config: sampleConfig, store });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    const eventResponse = await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(samplePayload)
    });
    assert.equal(eventResponse.status, 202);

    const jobResponse = await fetch(`${baseUrl}/jobs/next?clientId=copy-repost`);
    assert.equal(jobResponse.status, 200);
    const job = await jobResponse.json();
    assert.equal(job.destinationUrl, "https://discord.com/channels/333/444");

    const resultResponse = await fetch(`${baseUrl}/jobs/${job.id}/result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "sent", degradation: [] })
    });
    assert.equal(resultResponse.status, 200);

    const statusResponse = await fetch(`${baseUrl}/status`);
    const status = await statusResponse.json();
    assert.equal(status.counts.sent, 1);
    server.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run helper tests and confirm API failure**

Run:

```powershell
npm run test:helper
```

Expected: failure because `apps/external-helper/src/server.js` does not exist.

- [ ] **Step 3: Implement the helper HTTP server**

Create `apps/external-helper/src/server.js` with:

```javascript
import { createServer as createHttpServer } from "node:http";

export function createServer({ config, store }) {
  return createHttpServer(async (request, response) => {
    try {
      await route({ request, response, config, store });
    } catch (error) {
      sendJson(response, 500, { error: error.message });
    }
  });
}

async function route({ request, response, config, store }) {
  const url = new URL(request.url, "http://127.0.0.1");
  if (request.method === "OPTIONS") {
    return sendJson(response, 204, {});
  }
  if (request.method === "GET" && url.pathname === "/health") {
    return sendJson(response, 200, { ok: true, enabled: config.enabled });
  }
  if (request.method === "GET" && url.pathname === "/config") {
    return sendJson(response, 200, sanitizeConfig(config));
  }
  if (request.method === "POST" && url.pathname === "/events") {
    const payload = await readJson(request);
    const result = await store.enqueueAlert(config, payload);
    return sendJson(response, 202, result);
  }
  if (request.method === "GET" && url.pathname === "/jobs/next") {
    const clientId = url.searchParams.get("clientId") || "unknown-client";
    const job = await store.claimNextJob(clientId);
    return sendJson(response, 200, job ?? { job: null });
  }
  const resultMatch = url.pathname.match(/^\/jobs\/([^/]+)\/result$/);
  if (request.method === "POST" && resultMatch) {
    const body = await readJson(request);
    const result = await store.recordJobResult({
      jobId: resultMatch[1],
      status: body.status,
      reason: body.reason || "",
      degradation: Array.isArray(body.degradation) ? body.degradation : [],
      retry: config.retry
    });
    return sendJson(response, 200, result);
  }
  if (request.method === "GET" && url.pathname === "/status") {
    const snapshot = await store.snapshot();
    return sendJson(response, 200, summarize(snapshot));
  }
  sendJson(response, 404, { error: "Not found" });
}

function sanitizeConfig(config) {
  return {
    enabled: config.enabled,
    retry: config.retry,
    sendPacingMs: config.sendPacingMs,
    mappings: config.mappings
  };
}

function summarize(snapshot) {
  const counts = {
    queued: 0,
    in_progress: 0,
    retry_wait: 0,
    sent: 0,
    failed: 0,
    skipped_duplicate: snapshot.events.filter((event) => event.type === "skipped_duplicate").length
  };
  for (const job of snapshot.jobs) {
    counts[job.status] = (counts[job.status] ?? 0) + 1;
  }
  return {
    counts,
    recentEvents: snapshot.events.slice(-25)
  };
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "content-type": "application/json"
  });
  if (statusCode === 204) {
    response.end();
  } else {
    response.end(JSON.stringify(body));
  }
}
```

- [ ] **Step 4: Implement the helper entrypoint**

Create `apps/external-helper/src/main.js` with:

```javascript
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfigFromFile } from "./config.js";
import { createServer } from "./server.js";
import { createJsonStore } from "./store.js";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = process.env.HELPER_CONFIG
  ? resolve(process.env.HELPER_CONFIG)
  : resolve(rootDir, "config", "config.example.json");
const statePath = process.env.HELPER_STATE
  ? resolve(process.env.HELPER_STATE)
  : resolve(rootDir, "data", "state.json");
const port = Number.parseInt(process.env.HELPER_PORT || "17654", 10);

await mkdir(dirname(statePath), { recursive: true });
const config = await loadConfigFromFile(configPath);
const store = await createJsonStore(statePath);
const server = createServer({ config, store });

server.listen(port, "127.0.0.1", () => {
  console.log(`Sentinel Link Helper listening on http://127.0.0.1:${port}`);
  console.log(`Config: ${configPath}`);
  console.log(`State: ${statePath}`);
});
```

- [ ] **Step 5: Add helper package script**

Modify `apps/external-helper/package.json` to:

```json
{
  "name": "@sentinel-link/helper",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": {
    "start": "node src/main.js"
  },
  "dependencies": {
    "@sentinel-link/shared": "file:../../packages/shared"
  }
}
```

- [ ] **Step 6: Run helper tests and commit**

Run:

```powershell
npm run test:helper
```

Expected: all helper tests pass.

Commit:

```powershell
git add apps/external-helper
git commit -m "feat: add helper http api"
```

- [ ] **Step 7: Merge helper branch back to main**

Run:

```powershell
git switch main
git merge --no-ff feature/external-helper-app -m "merge: external helper app"
```

Expected: merge completes with no conflicts.

---

### Task 4: Copy/Repost Extension Parser

**Files:**
- Create: `extensions/copy-repost/test/parser.test.js`
- Create: `extensions/copy-repost/src/parser.js`

- [ ] **Step 1: Create the copy/repost feature branch**

Run:

```powershell
git switch main
git switch -c feature/copy-repost-extension
```

Expected: branch changes to `feature/copy-repost-extension`.

- [ ] **Step 2: Write parser tests first**

Create `extensions/copy-repost/test/parser.test.js` with:

```javascript
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import vm from "node:vm";

const parserCode = await readFile(resolve("extensions/copy-repost/src/parser.js"), "utf8").catch(() => "");
const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(parserCode, sandbox);
const parser = sandbox.window.DiscordCopyRepostParser;

function textNode(text, href = "") {
  return {
    innerText: text,
    textContent: text,
    href,
    getAttribute(name) {
      if (name === "href") return href;
      return "";
    }
  };
}

function fakeMessageNode() {
  const selectors = new Map([
    ['[class*="username"]', [textNode("Alert Bot")]],
    ['time', [textNode("Today at 12:00 PM")]],
    ['[class*="markup"]', [textNode("Entry alert")]],
    ['[class*="embedTitle"]', [textNode("AAPL")]],
    ['[class*="embedDescription"]', [textNode("Breakout")]],
    ['[class*="embedField"]', [textNode("Price\\n190")]],
    ['[class*="embedFooter"]', [textNode("Trading alerts")]],
    ["button", [textNode("Open Chart")]],
    ["a[href]", [textNode("chart", "https://cdn.discordapp.com/file.png")]]
  ]);
  return {
    id: "chat-messages-222-999",
    getAttribute(name) {
      if (name === "id") return this.id;
      return "";
    },
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    },
    querySelectorAll(selector) {
      return selectors.get(selector) || [];
    }
  };
}

test("parser is exposed for content script and tests", () => {
  assert.equal(typeof parser.extractAlertFromMessageNode, "function");
});

test("parseDiscordChannelIds extracts guild and channel ids from Discord URL", () => {
  assert.deepEqual(
    parser.parseDiscordChannelIds("https://discord.com/channels/111/222"),
    { guildId: "111", channelId: "222" }
  );
});

test("extractAlertFromMessageNode captures visible text, embeds, labels, and URLs", () => {
  const payload = parser.extractAlertFromMessageNode(fakeMessageNode(), "https://discord.com/channels/111/222");
  assert.equal(payload.sourceChannelId, "222");
  assert.equal(payload.messageId, "999");
  assert.equal(payload.author, "Alert Bot");
  assert.equal(payload.text, "Entry alert");
  assert.equal(payload.embeds[0].title, "AAPL");
  assert.equal(payload.embeds[0].fields[0].name, "Price");
  assert.equal(payload.labels[0], "Open Chart");
  assert.equal(payload.attachmentUrls[0], "https://cdn.discordapp.com/file.png");
});
```

- [ ] **Step 3: Run parser tests and confirm failure**

Run:

```powershell
npm run test:copy-repost
```

Expected: failure because parser API is not exposed.

- [ ] **Step 4: Implement the parser as a browser global**

Create `extensions/copy-repost/src/parser.js` with:

```javascript
(function exposeParser(global) {
  function parseDiscordChannelIds(url) {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/channels\/([^/]+)\/([^/]+)/);
    if (!match) return { guildId: "", channelId: "" };
    return { guildId: match[1], channelId: match[2] };
  }

  function extractAlertFromMessageNode(messageNode, pageUrl) {
    const channel = parseDiscordChannelIds(pageUrl);
    const messageId = extractMessageId(messageNode);
    return {
      sourceUrl: normalizePageUrl(pageUrl),
      sourceChannelId: channel.channelId,
      messageId,
      author: readFirstText(messageNode, ['[class*="username"]', '[class*="headerText"]']),
      timestampText: readFirstText(messageNode, ["time"]),
      text: readFirstText(messageNode, ['[class*="markup"]']),
      embeds: extractEmbeds(messageNode),
      labels: readUniqueTexts(messageNode, ["button"]),
      attachmentUrls: extractAttachmentUrls(messageNode),
      capturedAt: new Date().toISOString()
    };
  }

  function extractMessageId(messageNode) {
    const rawId = messageNode.getAttribute?.("id") || messageNode.id || "";
    const match = rawId.match(/(\d+)$/);
    if (match) return match[1];
    return `visible-${Math.random().toString(16).slice(2)}`;
  }

  function normalizePageUrl(pageUrl) {
    const channel = parseDiscordChannelIds(pageUrl);
    if (!channel.guildId || !channel.channelId) return pageUrl;
    return `https://discord.com/channels/${channel.guildId}/${channel.channelId}`;
  }

  function extractEmbeds(root) {
    const titles = readUniqueTexts(root, ['[class*="embedTitle"]']);
    const descriptions = readUniqueTexts(root, ['[class*="embedDescription"]']);
    const footer = readFirstText(root, ['[class*="embedFooter"]']);
    const fields = readUniqueTexts(root, ['[class*="embedField"]']).map(splitEmbedField);
    if (!titles.length && !descriptions.length && !fields.length && !footer) return [];
    return [
      {
        title: titles[0] || "",
        description: descriptions.join("\n"),
        fields,
        footer
      }
    ];
  }

  function splitEmbedField(text) {
    const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
    return {
      name: lines[0] || "Field",
      value: lines.slice(1).join("\n") || ""
    };
  }

  function extractAttachmentUrls(root) {
    return unique(
      queryAll(root, ["a[href]"])
        .map((node) => node.href || node.getAttribute?.("href") || "")
        .filter((href) => /cdn\.discordapp\.com|media\.discordapp\.net|discordapp\.com\/attachments/.test(href))
    );
  }

  function readFirstText(root, selectors) {
    return readUniqueTexts(root, selectors)[0] || "";
  }

  function readUniqueTexts(root, selectors) {
    return unique(
      queryAll(root, selectors)
        .map((node) => (node.innerText || node.textContent || "").trim())
        .filter(Boolean)
    );
  }

  function queryAll(root, selectors) {
    return selectors.flatMap((selector) => Array.from(root.querySelectorAll?.(selector) || []));
  }

  function unique(values) {
    return [...new Set(values)];
  }

  global.DiscordCopyRepostParser = {
    parseDiscordChannelIds,
    extractAlertFromMessageNode
  };
})(typeof window !== "undefined" ? window : globalThis);
```

- [ ] **Step 5: Run parser tests and commit**

Run:

```powershell
npm run test:copy-repost
```

Expected: parser tests pass.

Commit:

```powershell
git add extensions/copy-repost
git commit -m "feat: add copy repost parser"
```

---

### Task 5: Copy/Repost Extension Runtime

**Files:**
- Create: `extensions/copy-repost/manifest.json`
- Create: `extensions/copy-repost/src/content.js`
- Create: `extensions/copy-repost/src/background.js`
- Create: `extensions/copy-repost/src/popup.html`
- Create: `extensions/copy-repost/src/popup.js`
- Create: `extensions/copy-repost/src/styles.css`
- Create: `extensions/copy-repost/README.md`

- [ ] **Step 1: Add Manifest V3 extension metadata**

Create `extensions/copy-repost/manifest.json` with:

```json
{
  "manifest_version": 3,
  "name": "Discord Copy Repost Helper",
  "version": "0.1.0",
  "description": "Copies visible Discord alerts from configured channels and recreates them in configured test channels through the Discord web UI.",
  "permissions": ["tabs", "storage", "scripting"],
  "host_permissions": [
    "https://discord.com/channels/*",
    "http://127.0.0.1:17654/*"
  ],
  "background": {
    "service_worker": "src/background.js"
  },
  "content_scripts": [
    {
      "matches": ["https://discord.com/channels/*"],
      "js": ["src/parser.js", "src/content.js"],
      "run_at": "document_idle"
    }
  ],
  "action": {
    "default_popup": "src/popup.html",
    "default_title": "Copy Repost Helper"
  }
}
```

- [ ] **Step 2: Implement source observation and composer posting**

Create `extensions/copy-repost/src/content.js` with:

```javascript
(function runContentScript() {
  const helperBaseUrl = "http://127.0.0.1:17654";
  const seenMessageIds = new Set();

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "post-job") {
      postJobToComposer(message.job)
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({ ok: false, reason: error.message }));
      return true;
    }
    return false;
  });

  startObserver();

  function startObserver() {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          inspectNode(node);
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    document.querySelectorAll('[id^="chat-messages-"]').forEach(inspectNode);
  }

  function inspectNode(node) {
    if (!(node instanceof HTMLElement)) return;
    const messageNode = node.matches?.('[id^="chat-messages-"]')
      ? node
      : node.querySelector?.('[id^="chat-messages-"]');
    if (!messageNode) return;
    const payload = window.DiscordCopyRepostParser.extractAlertFromMessageNode(messageNode, location.href);
    if (seenMessageIds.has(payload.messageId)) return;
    seenMessageIds.add(payload.messageId);
    submitPayload(payload).catch((error) => console.warn("Copy repost submit failed", error));
  }

  async function submitPayload(payload) {
    const response = await fetch(`${helperBaseUrl}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      throw new Error(`Helper rejected event with ${response.status}`);
    }
  }

  async function postJobToComposer(job) {
    const editor = await waitForComposer();
    editor.focus();
    insertText(editor, job.messageText);
    await delay(250);
    pressEnter(editor);
    return { ok: true, degradation: job.payload?.attachmentUrls?.length ? ["attachments_included_as_urls"] : [] };
  }

  async function waitForComposer() {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const editor = document.querySelector('[role="textbox"][contenteditable="true"]');
      if (editor) return editor;
      await delay(250);
    }
    throw new Error("Discord composer not found");
  }

  function insertText(editor, text) {
    document.execCommand("selectAll", false, null);
    document.execCommand("insertText", false, text);
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  }

  function pressEnter(editor) {
    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
    editor.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
```

- [ ] **Step 3: Implement background polling and tab coordination**

Create `extensions/copy-repost/src/background.js` with:

```javascript
const helperBaseUrl = "http://127.0.0.1:17654";
const clientId = "copy-repost-extension";
const pollMs = 1500;

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ enabled: true, lastStatus: "installed" });
});

setInterval(() => {
  pollHelper().catch((error) => setStatus(`helper error: ${error.message}`));
}, pollMs);

async function pollHelper() {
  const { enabled = true } = await chrome.storage.local.get("enabled");
  if (!enabled) return;
  const response = await fetch(`${helperBaseUrl}/jobs/next?clientId=${encodeURIComponent(clientId)}`);
  if (!response.ok) throw new Error(`jobs/next ${response.status}`);
  const job = await response.json();
  if (!job || job.job === null) {
    await setStatus("idle");
    return;
  }
  await postJob(job);
}

async function postJob(job) {
  try {
    const tab = await openOrReuseTab(job.destinationUrl);
    await chrome.tabs.update(tab.id, { active: true });
    await waitForTabComplete(tab.id);
    const result = await chrome.tabs.sendMessage(tab.id, { type: "post-job", job });
    if (!result?.ok) {
      throw new Error(result?.reason || "content script did not confirm send");
    }
    await reportResult(job.id, { status: "sent", degradation: result.degradation || [] });
    await setStatus(`sent ${job.id}`);
  } catch (error) {
    await reportResult(job.id, { status: "failed", reason: error.message });
    await setStatus(`failed ${job.id}: ${error.message}`);
  }
}

async function openOrReuseTab(destinationUrl) {
  const tabs = await chrome.tabs.query({ url: "https://discord.com/channels/*" });
  const existing = tabs.find((tab) => tab.url?.startsWith(destinationUrl));
  if (existing) return existing;
  return chrome.tabs.create({ url: destinationUrl, active: false });
}

async function waitForTabComplete(tabId) {
  for (let index = 0; index < 60; index += 1) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return;
    await delay(250);
  }
}

async function reportResult(jobId, body) {
  await fetch(`${helperBaseUrl}/jobs/${encodeURIComponent(jobId)}/result`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function setStatus(lastStatus) {
  await chrome.storage.local.set({ lastStatus, lastStatusAt: new Date().toISOString() });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

- [ ] **Step 4: Add popup UI**

Create `extensions/copy-repost/src/popup.html` with:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Copy Repost Helper</title>
    <link rel="stylesheet" href="styles.css">
  </head>
  <body>
    <main>
      <h1>Copy Repost</h1>
      <label>
        <input id="enabled" type="checkbox">
        Enabled
      </label>
      <dl>
        <dt>Helper</dt>
        <dd id="helper">checking</dd>
        <dt>Status</dt>
        <dd id="status">loading</dd>
      </dl>
      <button id="refresh" type="button">Refresh</button>
    </main>
    <script src="popup.js"></script>
  </body>
</html>
```

Create `extensions/copy-repost/src/popup.js` with:

```javascript
const enabled = document.querySelector("#enabled");
const helper = document.querySelector("#helper");
const status = document.querySelector("#status");
const refresh = document.querySelector("#refresh");

refresh.addEventListener("click", load);
enabled.addEventListener("change", async () => {
  await chrome.storage.local.set({ enabled: enabled.checked });
  await load();
});

load();

async function load() {
  const state = await chrome.storage.local.get(["enabled", "lastStatus", "lastStatusAt"]);
  enabled.checked = state.enabled !== false;
  status.textContent = state.lastStatusAt ? `${state.lastStatus} (${state.lastStatusAt})` : state.lastStatus || "idle";
  try {
    const response = await fetch("http://127.0.0.1:17654/health");
    const body = await response.json();
    helper.textContent = body.ok ? "connected" : "unavailable";
  } catch {
    helper.textContent = "not connected";
  }
}
```

Create `extensions/copy-repost/src/styles.css` with:

```css
body {
  width: 260px;
  margin: 0;
  font: 13px/1.4 system-ui, sans-serif;
  color: #111827;
  background: #ffffff;
}

main {
  padding: 12px;
}

h1 {
  margin: 0 0 12px;
  font-size: 16px;
}

label {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 12px;
}

dl {
  display: grid;
  grid-template-columns: 64px 1fr;
  gap: 6px 10px;
  margin: 0 0 12px;
}

dt {
  font-weight: 700;
}

dd {
  margin: 0;
  overflow-wrap: anywhere;
}

button {
  width: 100%;
  height: 32px;
}
```

- [ ] **Step 5: Add copy/repost README**

Create `extensions/copy-repost/README.md` with:

````markdown
# Discord Copy Repost Helper

This Chrome extension watches visible Discord web channels and recreates configured alerts in configured destination channels through the Discord composer.

## Load In Chrome

1. Start the helper from the repo root:

   ```powershell
   npm run helper:start
   ```

2. Open `chrome://extensions`.
3. Enable Developer mode.
4. Click **Load unpacked**.
5. Select `extensions/copy-repost`.
6. Open the configured Discord source channels in Chrome.

## Boundaries

- The extension uses the visible Discord page only.
- It does not read Discord tokens.
- It does not call hidden Discord APIs.
- It posts only jobs returned by the local helper.
- Attachments and images are reproduced as visible URLs when available.
````

- [ ] **Step 6: Run extension tests and commit**

Run:

```powershell
npm run test:copy-repost
```

Expected: parser tests still pass after runtime files are added.

Commit:

```powershell
git add extensions/copy-repost
git commit -m "feat: add copy repost extension runtime"
```

- [ ] **Step 7: Merge copy/repost branch back to main**

Run:

```powershell
git switch main
git merge --no-ff feature/copy-repost-extension -m "merge: copy repost extension"
```

Expected: merge completes with no conflicts.

---

### Task 6: Trading Bridge Integration Branch

**Files:**
- Create: `extensions/trading-bridge/README.md`
- Create: `extensions/trading-bridge/helper-client.js`

- [ ] **Step 1: Create the trading bridge feature branch**

Run:

```powershell
git switch main
git switch -c feature/trading-bridge-extension
```

Expected: branch changes to `feature/trading-bridge-extension`.

- [ ] **Step 2: Add the trading bridge helper client**

Create `extensions/trading-bridge/helper-client.js` with:

```javascript
(function exposeTradingBridgeHelper(global) {
  const defaultHelperBaseUrl = "http://127.0.0.1:17654";

  async function submitTradingBridgeAlert(payload, options = {}) {
    const helperBaseUrl = options.helperBaseUrl || defaultHelperBaseUrl;
    const response = await fetch(`${helperBaseUrl}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      throw new Error(`Helper rejected trading bridge event with ${response.status}`);
    }
    return response.json();
  }

  global.TradingBridgeHelperClient = {
    submitTradingBridgeAlert
  };
})(typeof window !== "undefined" ? window : globalThis);
```

- [ ] **Step 3: Add trading bridge README**

Create `extensions/trading-bridge/README.md` with:

````markdown
# Sentinel Link Trading Bridge

This directory is for the trading bridge Chrome extension currently installed on the trading bots.

## Integration Contract

The helper accepts normalized alert payloads at `POST http://127.0.0.1:17654/events`.

Use `helper-client.js` from a trading bridge content script or background script:

```javascript
await window.TradingBridgeHelperClient.submitTradingBridgeAlert({
  sourceUrl: "https://discord.com/channels/111/222",
  sourceChannelId: "222",
  messageId: "999",
  author: "Alert Bot",
  timestampText: "Today at 12:00 PM",
  text: "Entry alert",
  embeds: [],
  labels: [],
  attachmentUrls: [],
  capturedAt: new Date().toISOString()
});
````

## Source Import

Place the current installed extension source in this directory, preserving its manifest and runtime files. Then wire the point where it parses a Discord alert to call `submitTradingBridgeAlert` with the normalized payload.

## Boundaries

- Do not read Discord tokens.
- Do not call hidden Discord APIs.
- Do not bypass channel permissions.
- Keep the existing trading bridge behavior intact while adding helper event emission.
````

- [ ] **Step 4: Commit trading bridge integration surface**

Run:

```powershell
git add extensions/trading-bridge
git commit -m "feat: add trading bridge helper integration"
```

- [ ] **Step 5: Merge trading bridge branch back to main**

Run:

```powershell
git switch main
git merge --no-ff feature/trading-bridge-extension -m "merge: trading bridge integration"
```

Expected: merge completes with no conflicts.

---

### Task 7: End-To-End Verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add root usage README**

Create `README.md` with:

````markdown
# Sentinel Link

Toolkit for authorized Discord alert testing with Chrome extensions and a local helper app.

## Components

- `apps/external-helper`: localhost helper that owns config, queueing, dedupe, retries, and logs.
- `extensions/copy-repost`: Chrome extension that watches visible Discord channels and recreates alerts in configured destination channels.
- `extensions/trading-bridge`: integration area for the Sentinel Link Trading Bridge currently installed on the trading bots.
- `packages/shared`: shared schemas and formatting helpers.

## Start Helper

```powershell
npm run helper:start
````

By default, the helper reads `apps/external-helper/config/config.example.json` and writes state to `apps/external-helper/data/state.json`.

For local channel mappings, create `apps/external-helper/config/config.local.json` and start with:

```powershell
$env:HELPER_CONFIG="apps/external-helper/config/config.local.json"
npm run helper:start
```

## Load Copy/Repost Extension

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click **Load unpacked**.
4. Select `extensions/copy-repost`.
5. Open configured Discord source channels in Chrome.

## Safety Boundaries

This project uses only visible Discord web UI behavior. It does not read Discord tokens, call hidden Discord APIs, or bypass permissions.
````

- [ ] **Step 2: Run the full automated test suite**

Run:

```powershell
npm test
```

Expected: shared, helper, and copy/repost parser tests pass.

- [ ] **Step 3: Smoke test the helper**

Run:

```powershell
$env:HELPER_PORT="17654"
npm run helper:start
```

Expected console output:

```text
Sentinel Link Helper listening on http://127.0.0.1:17654
```

In a second terminal, run:

```powershell
Invoke-RestMethod http://127.0.0.1:17654/health
```

Expected response includes:

```text
ok enabled
-- -------
True True
```

- [ ] **Step 4: Commit final docs**

Run:

```powershell
git add README.md
git commit -m "docs: add project usage guide"
```

- [ ] **Step 5: Final branch status check**

Run:

```powershell
git status --short --branch
git branch --list
```

Expected: `main` is clean and the three feature branches exist locally.

## Manual Integration Test

Use a private Discord test server and channels that the logged-in Chrome user is authorized to access.

1. Edit `apps/external-helper/config/config.local.json` with real source and destination Discord channel URLs.
2. Start the helper with `HELPER_CONFIG` set to `config.local.json`.
3. Load `extensions/copy-repost` in Chrome.
4. Open each configured source channel in Discord web.
5. Post a test alert in a source channel.
6. Confirm the destination channel receives a recreated message with source URL, author/time when visible, text, embed details, labels, and visible attachment URLs.
7. Stop the helper and inspect `apps/external-helper/data/state.json`.
8. Confirm the job status is `sent` or `failed` after no more than three attempts.

## Spec Coverage Review

- Monorepo layout: Task 1, Task 5, Task 6, Task 7.
- Branch per bot-helper area: Task 1, Task 4, Task 6.
- Helper durable queue and retry: Task 2, Task 3.
- Multiple source and destination mappings: Task 1 shared config validation and Task 2 queue fan-out.
- Copy/repost visible Discord UI only: Task 4 parser and Task 5 runtime.
- Partial rich-content reproduction: Task 1 formatting and Task 5 send degradation.
- No Discord token or hidden API access: Task 5 README and Task 7 root README.
