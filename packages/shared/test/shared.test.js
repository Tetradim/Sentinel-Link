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
