import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

const contentPath = path.resolve("extensions/copy-repost/src/content.js");

test("listen-only sources are bridge eligible without becoming repost sources", async () => {
  const { runtime } = await loadContentRuntime(createDocument().document);
  const settings = { listenChannelUrls: ["https://discord.com/channels/111/333"], listenOnlyChannelUrls: ["https://discord.com/channels/111/222"] };
  assert.equal(runtime.isBridgeListenSource(settings, "https://discord.com/channels/111/222", "222"), true);
  assert.equal(runtime.isBridgeListenSource(settings, "https://discord.com/channels/111/333", "333"), true);
  assert.equal(runtime.isBridgeListenSource(settings, "https://discord.com/channels/111/444", "444"), false);
  assert.equal(runtime.isBridgeListenSource({ listenOnlyChannelUrls: settings.listenOnlyChannelUrls }, "https://discord.com/channels/111/444", "444"), false);
  assert.equal(runtime.sourceModeForBridge(settings, "https://discord.com/channels/111/222", "222"), "listen-only");
  assert.equal(runtime.sourceModeForBridge(settings, "https://discord.com/channels/111/333", "333"), "listen");
  assert.equal(runtime.sourceModeForBridge(settings, "https://discord.com/channels/111/444", "444"), "");
});

test("bridge preserves embed fields and footer and identifies the source message", async () => {
  const { runtime } = await loadContentRuntime(createDocument().document);
  const payload = runtime.chromeBridgePayload({ sourceUrl: "https://discord.com/channels/111/222", messageId: "999", sourceChannelId: "222", embeds: [{ title: "NVDA $230 Calls", fields: [{ name: "Exp", value: "Sep 03, 2026" }], footer: "Not Financial Advice" }] }, "listen-only");
  assert.equal(payload.embeds[0].footer_text, "Not Financial Advice");
  assert.equal(payload.embeds[0].fields[0].value, "Sep 03, 2026");
  assert.equal(payload.url, "https://discord.com/channels/111/222/999");
  assert.equal(payload.source, "sentinel-link");
  assert.equal(payload.source_mode, "listen-only");
});

test("bridge forwards stable message revision metadata", async () => {
  const { runtime } = await loadContentRuntime(createDocument().document);
  const payload = runtime.chromeBridgePayload({
    sourceUrl: "https://discord.com/channels/111/222",
    sourceChannelId: "222",
    messageId: "999",
    author: "MikeInvesting",
    authorRaw: "MikeInvesting(WILL NOT DM FIRST)",
    text: "IN AT $.26",
    revisionHash: "abc123",
    eventType: "updated"
  });

  assert.equal(payload.event_id, "999");
  assert.equal(payload.revision_hash, "abc123");
  assert.equal(payload.event_type, "updated");
  assert.equal(payload.author_raw, "MikeInvesting(WILL NOT DM FIRST)");
});

test("local OCR enriches image-only alerts with measured confidence", async () => {
  let bitmapClosed = false;
  const { runtime } = await loadContentRuntime(createDocument().document, {
    TextDetector: class {
      async detect() {
        return [{ rawValue: "BTO SPY 500C 9/12 @ .25", confidence: 0.92 }];
      }
    },
    createImageBitmap: async () => ({ close() { bitmapClosed = true; } }),
    fetch: async () => ({ ok: true, blob: async () => ({}) })
  });

  const enriched = await runtime.enrichPayloadWithLocalOcr(null, {
    text: "",
    embeds: [],
    attachmentUrls: ["https://cdn.discordapp.com/alert.png"]
  });

  assert.equal(enriched.ocrText, "BTO SPY 500C 9/12 @ .25");
  assert.equal(enriched.ocrConfidence, 0.92);
  assert.equal(bitmapClosed, true);
});

test("local OCR gives unmeasured text a high score only for a complete option entry", async () => {
  const detect = async () => [{ rawValue: "$SPY 500C ENTRY @ .25" }];
  const { runtime } = await loadContentRuntime(createDocument().document, {
    TextDetector: class { async detect() { return detect(); } },
    createImageBitmap: async () => ({ close() {} }),
    fetch: async () => ({ ok: true, blob: async () => ({}) })
  });

  const enriched = await runtime.enrichPayloadWithLocalOcr(null, {
    text: "", embeds: [], attachmentUrls: ["https://cdn.discordapp.com/alert.png"]
  });

  assert.equal(enriched.ocrConfidence, 0.85);
});

async function loadContentRuntime(document, runtimeGlobals = {}) {
  const source = await readFile(contentPath, "utf8");
  const { window: runtimeWindow = {}, ...otherRuntimeGlobals } = runtimeGlobals;
  const selection = {
    selectedNode: null,
    removeAllRanges() {
      this.selectedNode = null;
    },
    addRange(range) {
      this.selectedNode = range.selectedNode;
    }
  };
  if (typeof document.createRange !== "function") {
    document.createRange = () => ({
      selectedNode: null,
      selectNodeContents(node) {
        this.selectedNode = node;
      },
      collapse() {}
    });
  }
  const sandbox = {
    window: {
      __DISCORD_COPY_REPOST_TEST__: true,
      getComputedStyle: (node) => node.style ?? {},
      getSelection: () => selection,
      setTimeout(callback) {
        callback();
        return 0;
      },
      ...runtimeWindow
    },
    document,
    location: {
      href: "https://discord.com/channels/1508501048610914406/1519744142471725136"
    },
    URL,
    Date,
    console,
    getComputedStyle: (node) => node.style ?? {},
    Node: { ELEMENT_NODE: 1 },
    MutationObserver: class {
      observe() {}
    },
    ...otherRuntimeGlobals
  };
  sandbox.globalThis = sandbox;

  vm.runInNewContext(await readFile(path.resolve("extensions/copy-repost/src/trading-bridge-config.js"), "utf8"), sandbox);
  vm.runInNewContext(source, sandbox, { filename: contentPath });

  return {
    runtime: sandbox.window.DiscordCopyRepostContentTest,
    selection
  };
}

function createDocument({ editorText = "", messages = [] } = {}) {
  const editor = createElement({
    attrs: { role: "textbox", contenteditable: "true" },
    text: editorText
  });
  const body = createElement({ children: messages });

  const document = {
    body,
    readyState: "complete",
    querySelector(selector) {
      if (
        selector === '[role="textbox"][contenteditable="true"]' ||
        selector === '[data-slate-editor="true"][contenteditable="true"]' ||
        selector === '[aria-label*="Message"][contenteditable="true"]'
      ) {
        return editor;
      }
      return body.querySelector(selector);
    },
    querySelectorAll(selector) {
      return body.querySelectorAll(selector);
    },
    addMessage(message) {
      body.children.push(message);
      message.parentElement = body;
    }
  };

  return { document, editor };
}

function createMessage(id, text) {
  return createElement({ id, text });
}

function createElement({ id = "", text = "", attrs = {}, children = [] } = {}) {
  const node = {
    nodeType: 1,
    id,
    attrs: { ...attrs },
    children,
    style: { display: "block", visibility: "visible" },
    get textContent() {
      return text || children.map((child) => child.textContent).join("");
    },
    get innerText() {
      return this.textContent;
    },
    getAttribute(name) {
      if (name === "id") return this.id || null;
      return this.attrs[name] ?? null;
    },
    matches(selector) {
      return matchesSelector(this, selector);
    },
    focus() {
      this.focused = true;
    },
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] ?? null;
    },
    querySelectorAll(selector) {
      return findMatchingDescendants(this, selector);
    }
  };
  for (const child of children) {
    child.parentElement = node;
  }
  return node;
}

function findMatchingDescendants(root, selector) {
  const matches = [];
  const visit = (node) => {
    for (const child of node.children ?? []) {
      if (matchesSelector(child, selector)) {
        matches.push(child);
      }
      visit(child);
    }
  };
  visit(root);
  return matches;
}

function matchesSelector(node, selector) {
  if (selector === '[id^="chat-messages-"]') {
    return String(node.id || "").startsWith("chat-messages-");
  }
  return false;
}

test("send confirmation rejects non-empty changed composer text", async () => {
  const { document, editor } = createDocument({ editorText: "Partial alert text" });
  const { runtime } = await loadContentRuntime(document);

  const confirmed = await runtime.waitForSendConfirmation(
    editor,
    "Full alert text with complete payload",
    new Set(),
    { timeoutMs: 0 }
  );

  assert.equal(confirmed, false);
});

test("content runtime exposes a version for background reinjection checks", async () => {
  const { document } = createDocument();
  const { runtime } = await loadContentRuntime(document);

  assert.equal(runtime.contentScriptVersion, "0.1.16");
});

test("content runtime reinitializes after an extension restart leaves a stale page marker", async () => {
  const { document } = createDocument();
  const { runtime } = await loadContentRuntime(document, {
    window: { __discordCopyRepostContentVersion: "0.1.13" }
  });

  assert.ok(runtime);
  assert.equal(runtime.contentScriptVersion, "0.1.16");
});

test("content runtime keys the same visible source message independently of Discord id churn", async () => {
  const { document } = createDocument();
  const { runtime } = await loadContentRuntime(document);
  const first = runtime.payloadKey({
    sourceChannelId: "1518453268169101402",
    messageId: "temporary-local-id",
    author: "Tetradim",
    timestampText: "[ 8:14 AM ]",
    text: "Dedicated",
    embeds: [],
    attachmentUrls: []
  });
  const second = runtime.payloadKey({
    sourceChannelId: "1518453268169101402",
    messageId: "confirmed-server-id",
    author: "Tetradim",
    timestampText: "[ 8:14 AM ]",
    text: "Dedicated",
    embeds: [],
    attachmentUrls: []
  });

  assert.equal(first, second);
});

test("send confirmation accepts empty composer text", async () => {
  const { document, editor } = createDocument({ editorText: "" });
  const { runtime } = await loadContentRuntime(document);

  const confirmed = await runtime.waitForSendConfirmation(editor, "Full alert text", new Set(), { timeoutMs: 0 });

  assert.equal(confirmed, true);
});

test("waitForComposer returns the Discord message textbox", async () => {
  const { document, editor } = createDocument({ editorText: "" });
  const { runtime } = await loadContentRuntime(document);

  const found = await runtime.waitForComposer();

  assert.equal(found, editor);
});

test("send confirmation accepts new matching visible message", async () => {
  const oldMessage = createMessage("chat-messages-222-111", "Earlier alert");
  const { document, editor } = createDocument({
    editorText: "Full alert text",
    messages: [oldMessage]
  });
  const { runtime } = await loadContentRuntime(document);
  const beforeMessageKeys = runtime.captureVisibleMessageKeys();

  document.addMessage(createMessage("chat-messages-222-222", "Full alert text with complete payload"));

  const confirmed = await runtime.waitForSendConfirmation(
    editor,
    "Full alert text with complete payload",
    beforeMessageKeys,
    { timeoutMs: 0 }
  );

  assert.equal(confirmed, true);
});

test("prepareComposerForTrustedInput focuses and selects an empty composer", async () => {
  const { document, editor } = createDocument({ editorText: "" });
  const { runtime, selection } = await loadContentRuntime(document);

  const result = await runtime.prepareComposerForTrustedInput(createJob());

  assert.equal(result.ok, true);
  assert.equal(result.beforeMessageKeys.length, 0);
  assert.equal(editor.focused, true);
  assert.equal(selection.selectedNode, editor);
});

test("prepareComposerForTrustedInput rejects a non-repost user draft", async () => {
  const { document } = createDocument({ editorText: "user typed draft" });
  const { runtime } = await loadContentRuntime(document);

  const result = await runtime.prepareComposerForTrustedInput(createJob());

  assert.equal(result.ok, false);
  assert.equal(result.reason, "Discord composer is not empty");
});

test("prepareComposerForTrustedInput allows replacing a stale repost draft", async () => {
  const { document } = createDocument({
    editorText:
      "[copied-alert]\nSource: https://discord.com/channels/1508501048610914406/1518453268169101402\n\nOld alert"
  });
  const { runtime } = await loadContentRuntime(document);

  const result = await runtime.prepareComposerForTrustedInput(createJob());

  assert.equal(result.ok, true);
  assert.equal(result.replacingDraft, true);
});

test("verifyComposerDraft accepts matching trusted input text", async () => {
  const job = createJob();
  const { document } = createDocument({ editorText: job.messageText });
  const { runtime } = await loadContentRuntime(document);

  const result = runtime.verifyComposerDraft(job.messageText);

  assert.equal(result.ok, true);
});

test("waitForComposerDraft waits for Discord to reflect trusted input", async () => {
  const job = createJob();
  let readCount = 0;
  const { document } = createDocument({
    editorText: {
      toString() {
        readCount += 1;
        return readCount < 2 ? "" : job.messageText;
      }
    }
  });
  const { runtime } = await loadContentRuntime(document);

  const result = await runtime.waitForComposerDraft(job.messageText, { timeoutMs: 1000 });

  assert.equal(result.ok, true);
});

test("messageNodesForAddedNode includes nearest message ancestor for grouped Discord replies", async () => {
  const groupedChild = createElement({ className: "markup", text: "Second grouped alert" });
  const groupedMessage = createMessage("chat-messages-222-333", "First grouped alert");
  groupedMessage.children.push(groupedChild);
  groupedChild.parentElement = groupedMessage;
  const { document } = createDocument({ messages: [groupedMessage] });
  const { runtime } = await loadContentRuntime(document);

  const nodes = runtime.messageNodesForAddedNode(groupedChild);

  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].id, groupedMessage.id);
});

test("messageNodesForAddedNode includes nearest message ancestor for added text nodes", async () => {
  const groupedTextNode = {
    nodeType: 3,
    textContent: "Definitely solid."
  };
  const groupedMessage = createMessage("chat-messages-222-444", "");
  groupedTextNode.parentElement = groupedMessage;
  groupedTextNode.parentNode = groupedMessage;
  const { document } = createDocument({ messages: [groupedMessage] });
  const { runtime } = await loadContentRuntime(document);

  const nodes = runtime.messageNodesForAddedNode(groupedTextNode);

  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].id, groupedMessage.id);
});

function createJob(overrides = {}) {
  return {
    destinationUrl: "https://discord.com/channels/1508501048610914406/1519744142471725136",
    messageText:
      "[copied-alert]\nSource: https://discord.com/channels/1508501048610914406/1518453268169101402\nFrom: [ 12:09 PM ]\n\nBTO AMD 200C 6/26/2026 @ 0.10 CODX-PHYS-20260624-114724 position_size_block",
    ...overrides
  };
}
