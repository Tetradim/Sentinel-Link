import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

const contentPath = path.resolve("extensions/copy-repost/src/content.js");

async function loadContentRuntime(document) {
  const source = await readFile(contentPath, "utf8");
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
      }
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
    }
  };
  sandbox.globalThis = sandbox;

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

function createJob(overrides = {}) {
  return {
    destinationUrl: "https://discord.com/channels/1508501048610914406/1519744142471725136",
    messageText:
      "[copied-alert]\nSource: https://discord.com/channels/1508501048610914406/1518453268169101402\nFrom: [ 12:09 PM ]\n\nBTO AMD 200C 6/26/2026 @ 0.10 CODX-PHYS-20260624-114724 position_size_block",
    ...overrides
  };
}
