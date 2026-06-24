import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

const sourceUrl = "https://discord.com/channels/111111111111111111/222222222222222222";
const sourceGuildId = "111111111111111111";
const sourceChannelId = "222222222222222222";
const messageId = "999999999999999999";
const messageNodeId = `chat-messages-${sourceChannelId}-${messageId}`;
const parserPath = path.resolve("extensions/copy-repost/src/parser.js");

async function loadParser() {
  const source = await readFile(parserPath, "utf8");
  const sandbox = {
    window: {},
    URL,
    Date,
    console,
    getComputedStyle: (node) => node.style ?? {}
  };
  sandbox.globalThis = sandbox;

  vm.runInNewContext(source, sandbox, { filename: parserPath });

  return sandbox.window.DiscordCopyRepostParser;
}

function fromSandbox(value) {
  return JSON.parse(JSON.stringify(value));
}

function createElement({ tagName = "div", id = "", className = "", text = "", attrs = {}, children = [] } = {}) {
  const node = {
    tagName: tagName.toUpperCase(),
    id,
    className,
    attrs: { ...attrs },
    children,
    style: { display: "block", visibility: "visible" },
    get textContent() {
      return text || children.map((child) => child.textContent).join("");
    },
    get href() {
      return this.attrs.href;
    },
    getAttribute(name) {
      if (name === "id") return this.id || null;
      if (name === "class") return this.className || null;
      return this.attrs[name] ?? null;
    },
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] ?? null;
    },
    querySelectorAll(selector) {
      return findMatchingDescendants(this, selector);
    },
    getClientRects() {
      return [{}];
    }
  };
  for (const child of children) {
    child.parentElement = node;
  }
  return node;
}

function appendChild(parent, child) {
  parent.children.push(child);
  child.parentElement = parent;
  return child;
}

function findMatchingDescendants(root, selector) {
  const selectors = selector.split(",").map((part) => part.trim()).filter(Boolean);
  const matches = [];
  const visit = (node) => {
    for (const child of node.children ?? []) {
      if (selectors.some((part) => matchesSelector(child, part))) {
        matches.push(child);
      }
      visit(child);
    }
  };
  visit(root);
  return matches;
}

function matchesSelector(node, selector) {
  if (selector === "time") {
    return node.tagName === "TIME";
  }
  if (selector === "button") {
    return node.tagName === "BUTTON";
  }
  if (selector === "a[href]") {
    return node.tagName === "A" && Boolean(node.getAttribute("href"));
  }
  if (selector === '[role="button"]') {
    return node.getAttribute("role") === "button";
  }
  const classContains = selector.match(/^\[class\*="([^"]+)"\]$/);
  if (classContains) {
    return node.className.includes(classContains[1]);
  }
  return false;
}

function buildMessageNode() {
  const embed = createElement({
    className: "embedWrapper",
    children: [
      createElement({ className: "embedTitle", text: "AAPL" }),
      createElement({ className: "embedDescription", text: "Breakout" }),
      createElement({
        className: "embedField",
        children: [
          createElement({ className: "embedFieldName", text: "Price" }),
          createElement({ className: "embedFieldValue", text: "190" })
        ]
      }),
      createElement({ className: "embedFooter", text: "Trading alerts" })
    ]
  });

  return createElement({
    id: messageNodeId,
    children: [
      createElement({ className: "username", text: "Alert Bot" }),
      createElement({ tagName: "time", text: "Today at 12:00 PM" }),
      createElement({ className: "markup", text: "Entry alert" }),
      embed,
      createElement({ tagName: "button", text: "Open Chart" }),
      createElement({
        tagName: "a",
        text: "file.png",
        attrs: { href: "https://cdn.discordapp.com/file.png" }
      })
    ]
  });
}

test("Parser global exposes extractAlertFromMessageNode", async () => {
  const parser = await loadParser();

  assert.equal(typeof parser.extractAlertFromMessageNode, "function");
});

test("parseDiscordChannelIds extracts guild/channel ids from Discord URL", async () => {
  const parser = await loadParser();

  assert.deepEqual(fromSandbox(parser.parseDiscordChannelIds(sourceUrl)), {
    guildId: sourceGuildId,
    channelId: sourceChannelId
  });
  assert.deepEqual(fromSandbox(parser.parseDiscordChannelIds("https://example.com/channels/111/222")), {
    guildId: "",
    channelId: ""
  });
});

test("extractAlertFromMessageNode captures visible Discord message content", async () => {
  const parser = await loadParser();

  const alert = parser.extractAlertFromMessageNode(buildMessageNode(), `${sourceUrl}/333333333333333333`);

  assert.equal(alert.sourceUrl, sourceUrl);
  assert.equal(alert.sourceChannelId, sourceChannelId);
  assert.equal(alert.messageId, messageId);
  assert.equal(alert.author, "Alert Bot");
  assert.equal(alert.timestampText, "Today at 12:00 PM");
  assert.equal(alert.text, "Entry alert");
  assert.deepEqual(fromSandbox(alert.embeds), [
    {
      title: "AAPL",
      description: "Breakout",
      fields: [{ name: "Price", value: "190" }],
      footer: "Trading alerts"
    }
  ]);
  assert.deepEqual(fromSandbox(alert.labels), ["Open Chart"]);
  assert.deepEqual(fromSandbox(alert.attachmentUrls), ["https://cdn.discordapp.com/file.png"]);
  assert.match(alert.capturedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test("extractAlertFromMessageNode handles absent selectors without throwing", async () => {
  const parser = await loadParser();
  const minimalNode = {
    id: messageNodeId,
    getAttribute(name) {
      return name === "id" ? messageNodeId : null;
    }
  };

  const alert = parser.extractAlertFromMessageNode(minimalNode, sourceUrl);

  assert.equal(alert.sourceUrl, sourceUrl);
  assert.equal(alert.sourceChannelId, sourceChannelId);
  assert.equal(alert.messageId, messageId);
  assert.equal(alert.author, "");
  assert.equal(alert.timestampText, "");
  assert.equal(alert.text, "");
  assert.deepEqual(fromSandbox(alert.embeds), []);
  assert.deepEqual(fromSandbox(alert.labels), []);
  assert.deepEqual(fromSandbox(alert.attachmentUrls), []);
});

test("extractAlertFromMessageNode deduplicates nested embed containers", async () => {
  const parser = await loadParser();
  const messageNode = createElement({
    id: messageNodeId,
    children: [
      createElement({
        className: "embedWrapper",
        children: [
          createElement({
            className: "embedFull",
            children: [
              createElement({
                className: "embedGrid",
                children: [
                  createElement({ className: "embedTitle", text: "AAPL" }),
                  createElement({ className: "embedDescription", text: "Breakout" })
                ]
              })
            ]
          })
        ]
      })
    ]
  });

  const alert = parser.extractAlertFromMessageNode(messageNode, sourceUrl);

  assert.deepEqual(fromSandbox(alert.embeds), [
    {
      title: "AAPL",
      description: "Breakout",
      fields: [],
      footer: ""
    }
  ]);
});

test("extractAlertFromMessageNode preserves text-only embed fields", async () => {
  const parser = await loadParser();
  const messageNode = createElement({
    id: messageNodeId,
    children: [
      createElement({
        className: "embedWrapper",
        children: [
          createElement({ className: "embedTitle", text: "AAPL" }),
          createElement({ className: "embedField", text: "Price\n190" })
        ]
      })
    ]
  });

  const alert = parser.extractAlertFromMessageNode(messageNode, sourceUrl);

  assert.deepEqual(fromSandbox(alert.embeds[0].fields), [{ name: "Price", value: "190" }]);
});

test("extractAlertFromMessageNode ignores non-Discord attachment paths", async () => {
  const parser = await loadParser();
  const messageNode = createElement({
    id: messageNodeId,
    children: [
      createElement({
        tagName: "a",
        text: "discord attachment",
        attrs: { href: "https://cdn.discordapp.com/attachments/file.png" }
      }),
      createElement({
        tagName: "a",
        text: "external attachment",
        attrs: { href: "https://example.com/attachments/file.png" }
      })
    ]
  });

  const alert = parser.extractAlertFromMessageNode(messageNode, sourceUrl);

  assert.deepEqual(fromSandbox(alert.attachmentUrls), ["https://cdn.discordapp.com/attachments/file.png"]);
});

test("extractAlertFromMessageNode keeps per-node fallback message id stable when visible content changes", async () => {
  const parser = await loadParser();
  const messageNode = createElement({
    children: [createElement({ className: "markup", text: "Entry alert" })]
  });

  const first = parser.extractAlertFromMessageNode(messageNode, sourceUrl);
  const second = parser.extractAlertFromMessageNode(messageNode, sourceUrl);
  appendChild(messageNode, createElement({ tagName: "button", text: "Open Chart" }));
  const third = parser.extractAlertFromMessageNode(messageNode, sourceUrl);

  assert.match(first.messageId, /^visible-/);
  assert.equal(second.messageId, first.messageId);
  assert.equal(third.messageId, first.messageId);
});
