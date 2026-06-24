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
