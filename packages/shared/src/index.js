export function normalizeChannelUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Discord channel URL expected: ${rawUrl}`);
  }
  const match = url.pathname.match(/^\/channels\/(\d+)\/(\d+)\/?$/);
  if (url.protocol !== "https:" || url.hostname !== "discord.com" || !match) {
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
  const retry = Object.hasOwn(input, "retry") ? input.retry : {};
  if (!retry || typeof retry !== "object" || Array.isArray(retry)) {
    throw new Error("retry must be an object");
  }
  const maxAttempts = integerInRange(retry, "maxAttempts", 3, 1, 10, "retry.maxAttempts");
  const baseDelayMs = integerInRange(retry, "baseDelayMs", 2000, 250, 60000, "retry.baseDelayMs");
  if (Object.hasOwn(input, "mappings") && !Array.isArray(input.mappings)) {
    throw new Error("mappings must be an array");
  }
  const mappings = Object.hasOwn(input, "mappings") ? input.mappings : [];
  const sendPacingMs = integerInRange(input, "sendPacingMs", 1500, 250, 60000, "sendPacingMs");
  const freshness = validateFreshness(Object.hasOwn(input, "freshness") ? input.freshness : {});
  return {
    enabled: input.enabled !== false,
    retry: { maxAttempts, baseDelayMs },
    freshness,
    sendPacingMs,
    mappings: mappings.map((mapping, index) => validateMapping(mapping, index))
  };
}

function validateFreshness(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("freshness must be an object");
  }
  return {
    enabled: input.enabled === true,
    maxAgeMinutes: integerInRange(input, "maxAgeMinutes", 10, 1, 1440, "freshness.maxAgeMinutes"),
    requireTimestamp: input.requireTimestamp !== false
  };
}

function integerInRange(input, key, defaultValue, min, max, label) {
  if (!Object.hasOwn(input, key)) {
    return defaultValue;
  }
  const value = input[key];
  if (!Number.isInteger(value)) {
    throw new Error(`${label} must be an integer`);
  }
  if (value < min || value > max) {
    throw new Error(`${label} must be between ${min} and ${max}`);
  }
  return value;
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
  const text = typeof input.text === "string" ? input.text.trim() : "";
  const embeds = Array.isArray(input.embeds) ? input.embeds.map(validateEmbed).filter(hasEmbedContent) : [];
  const labels = Array.isArray(input.labels)
    ? input.labels
        .filter((label) => typeof label === "string")
        .map((label) => label.trim())
        .filter(Boolean)
    : [];
  const attachmentUrls = Array.isArray(input.attachmentUrls)
    ? input.attachmentUrls
        .filter((url) => typeof url === "string")
        .map((url) => url.trim())
        .filter(Boolean)
    : [];
  if (!text && embeds.length === 0 && attachmentUrls.length === 0) {
    throw new Error("Alert payload must include visible content");
  }
  const author = typeof input.author === "string" ? input.author.trim() : "";
  const timestampText = typeof input.timestampText === "string" ? input.timestampText.trim() : "";
  const timestampIso = normalizeTimestampIso(input.timestampIso);
  const messageId =
    typeof input.messageId === "string" && input.messageId.trim()
      ? input.messageId.trim()
      : createFallbackMessageId({
          sourceUrl: source.url,
          author,
          timestampText,
          timestampIso,
          text,
          embeds,
          attachmentUrls
        });
  return {
    sourceUrl: source.url,
    sourceChannelId: source.channelId,
    messageId,
    author,
    timestampText,
    timestampIso,
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
        .map((field) => ({ name: field.name.trim(), value: field.value.trim() }))
        .filter((field) => field.name && field.value)
    : [];
  return {
    title: typeof embed?.title === "string" ? embed.title.trim() : "",
    description: typeof embed?.description === "string" ? embed.description.trim() : "",
    fields,
    footer: typeof embed?.footer === "string" ? embed.footer.trim() : ""
  };
}

function hasEmbedContent(embed) {
  return Boolean(embed.title || embed.description || embed.fields.length || embed.footer);
}

function createFallbackMessageId(input) {
  const basis = JSON.stringify({
    sourceUrl: input.sourceUrl,
    author: input.author,
    timestampText: input.timestampText,
    timestampIso: input.timestampIso,
    text: input.text,
    embeds: input.embeds,
    attachmentUrls: input.attachmentUrls
  });
  let hash = 0;
  for (const character of basis) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return `visible-${hash.toString(16)}`;
}

function normalizeTimestampIso(value) {
  if (typeof value !== "string" || !value.trim()) {
    return "";
  }
  const date = new Date(value.trim());
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
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
  if (valid.attachmentUrls.length) {
    lines.push("");
    lines.push("Visible attachment URLs:");
    lines.push(...valid.attachmentUrls);
  }
  return lines.join("\n").trim();
}

export function evaluatePayloadFreshness(payload, freshness = {}, now = new Date()) {
  const enabled = freshness?.enabled === true;
  const maxAgeMinutes = Number.isInteger(freshness?.maxAgeMinutes) ? freshness.maxAgeMinutes : 10;
  const requireTimestamp = freshness?.requireTimestamp !== false;
  const maxAgeMs = maxAgeMinutes * 60 * 1000;
  if (!enabled) {
    return { fresh: true, reason: "freshness disabled", ageMs: null, maxAgeMs };
  }

  const timestampIso = typeof payload?.timestampIso === "string" ? payload.timestampIso.trim() : "";
  if (!timestampIso) {
    return requireTimestamp
      ? { fresh: false, reason: "missing Discord timestamp", ageMs: null, maxAgeMs }
      : { fresh: true, reason: "timestamp not required", ageMs: null, maxAgeMs };
  }

  const messageMs = Date.parse(timestampIso);
  if (!Number.isFinite(messageMs)) {
    return requireTimestamp
      ? { fresh: false, reason: "invalid Discord timestamp", ageMs: null, maxAgeMs }
      : { fresh: true, reason: "timestamp not required", ageMs: null, maxAgeMs };
  }

  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const ageMs = nowMs - messageMs;
  if (ageMs > maxAgeMs) {
    return { fresh: false, reason: "message older than freshness window", ageMs, maxAgeMs };
  }

  return { fresh: true, reason: "fresh", ageMs, maxAgeMs };
}
