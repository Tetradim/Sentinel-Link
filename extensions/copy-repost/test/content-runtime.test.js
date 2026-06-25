import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

const contentPath = path.resolve("extensions/copy-repost/src/content.js");

async function loadContentRuntime(document) {
  const source = await readFile(contentPath, "utf8");
  const sandbox = {
    window: {
      __DISCORD_COPY_REPOST_TEST__: true,
      getComputedStyle: (node) => node.style ?? {},
      setTimeout(callback) {
        callback();
        return 0;
      }
    },
    document,
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

  return sandbox.window.DiscordCopyRepostContentTest;
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
  const runtime = await loadContentRuntime(document);

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
  const runtime = await loadContentRuntime(document);

  const confirmed = await runtime.waitForSendConfirmation(editor, "Full alert text", new Set(), { timeoutMs: 0 });

  assert.equal(confirmed, true);
});

test("waitForComposer returns the Discord message textbox", async () => {
  const { document, editor } = createDocument({ editorText: "" });
  const runtime = await loadContentRuntime(document);

  const found = await runtime.waitForComposer();

  assert.equal(found, editor);
});

test("send confirmation accepts new matching visible message", async () => {
  const oldMessage = createMessage("chat-messages-222-111", "Earlier alert");
  const { document, editor } = createDocument({
    editorText: "Full alert text",
    messages: [oldMessage]
  });
  const runtime = await loadContentRuntime(document);
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
