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

test("normalizeChannelUrl rejects non-discord hosts and non-digit ids", () => {
  assert.throws(
    () => normalizeChannelUrl("https://example.com/channels/111/222"),
    /Discord channel URL expected/
  );
  assert.throws(
    () => normalizeChannelUrl("https://discord.com/channels/not-a-guild/222"),
    /Discord channel URL expected/
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

test("validateConfig rejects malformed provided fields", () => {
  assert.throws(
    () => validateConfig({ retry: "soon", mappings: [] }),
    /retry must be an object/
  );
  assert.throws(
    () => validateConfig({ mappings: "alerts" }),
    /mappings must be an array/
  );
  assert.throws(
    () => validateConfig({ sendPacingMs: 100, mappings: [] }),
    /sendPacingMs must be between 250 and 60000/
  );
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

test("validateAlertPayload derives source channel id from the source URL", () => {
  const payload = validateAlertPayload({
    sourceUrl: "https://discord.com/channels/111/222",
    sourceChannelId: "999",
    messageId: "abc",
    text: "Entry alert",
    embeds: [],
    labels: [],
    attachmentUrls: []
  });

  assert.equal(payload.sourceChannelId, "222");
  assert.equal(createDedupeKey(payload), "222:abc");
});

test("validateAlertPayload rejects payloads without normalized visible content", () => {
  assert.throws(
    () =>
      validateAlertPayload({
        sourceUrl: "https://discord.com/channels/111/222",
        text: "   ",
        embeds: [
          {
            title: " ",
            description: "",
            fields: [{ name: " ", value: " " }],
            footer: " "
          }
        ],
        labels: ["  "],
        attachmentUrls: [" "]
      }),
    /Alert payload must include visible content/
  );
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

test("fallback message ids include rich visible content", () => {
  const first = validateAlertPayload({
    sourceUrl: "https://discord.com/channels/111/222",
    author: "Alert Bot",
    timestampText: "Today at 12:00 PM",
    text: "",
    embeds: [{ title: "AAPL", description: "Breakout", fields: [], footer: "" }],
    labels: [],
    attachmentUrls: []
  });
  const second = validateAlertPayload({
    sourceUrl: "https://discord.com/channels/111/222",
    author: "Alert Bot",
    timestampText: "Today at 12:00 PM",
    text: "",
    embeds: [{ title: "MSFT", description: "Breakout", fields: [], footer: "" }],
    labels: [],
    attachmentUrls: []
  });

  assert.notEqual(first.messageId, second.messageId);
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
