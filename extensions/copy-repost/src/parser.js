(function () {
  const global = typeof window !== "undefined" ? window : globalThis;
  const emptyChannelIds = { guildId: "", channelId: "" };
  const nodeFallbackIds = typeof WeakMap === "function" ? new WeakMap() : null;
  let nextFallbackId = 1;

  function parseDiscordChannelIds(rawUrl) {
    let url;
    try {
      url = new URL(String(rawUrl));
    } catch {
      return { ...emptyChannelIds };
    }

    const match = url.pathname.match(/^\/channels\/(\d+)\/(\d+)(?:\/|$)/);
    if (url.protocol !== "https:" || url.hostname !== "discord.com" || !match) {
      return { ...emptyChannelIds };
    }

    return {
      guildId: match[1],
      channelId: match[2]
    };
  }

  function extractAlertFromMessageNode(messageNode, pageUrl) {
    const source = parseDiscordChannelIds(pageUrl);
    const sourceUrl =
      source.guildId && source.channelId
        ? `https://discord.com/channels/${source.guildId}/${source.channelId}`
        : pageUrl;
    const author =
      firstVisibleText(messageNode, ['[class*="username"]', '[class*="headerText"]']) ||
      previousMessageAuthor(messageNode);
    const timestampNode = firstNode(messageNode, ["time"]);
    const timestampText = timestampNode && isVisible(timestampNode) ? normalizedText(timestampNode) : "";
    const timestampIso = timestampIsoFromNode(timestampNode);
    const text = visibleTexts(messageNode, ['[class*="markup"]']).join("\n");
    const attachmentUrls = uniqueStrings(queryAll(messageNode, ["a[href]"]).map(getHref).filter(isDiscordAttachmentUrl));
    const embeds = extractEmbeds(messageNode);

    return {
      sourceUrl,
      sourceChannelId: source.channelId,
      messageId: extractMessageId(messageNode),
      author,
      timestampText,
      timestampIso,
      text,
      embeds,
      labels: [],
      attachmentUrls,
      capturedAt: new Date().toISOString()
    };
  }

  function extractEmbeds(messageNode) {
    const selected = uniqueNodes(
      queryAll(messageNode, ['[class*="embedWrapper"]', '[class*="embedFull"]', '[class*="embedGrid"]', '[class*="embed"]'])
    );
    const candidates = topLevelNodes(selected.filter(isEmbedContainer));
    const roots = candidates.length ? candidates : [messageNode];
    return roots.map(extractEmbed).filter(hasEmbedContent);
  }

  function extractEmbed(embedNode) {
    const fieldRoots = queryAll(embedNode, ['[class*="embedField"]']).filter(isEmbedFieldContainer);
    const fields = fieldRoots.length ? fieldRoots.map(extractField).filter(hasFieldContent) : extractUnwrappedFields(embedNode);
    return {
      title: firstVisibleText(embedNode, ['[class*="embedTitle"]']),
      description: firstVisibleText(embedNode, ['[class*="embedDescription"]']),
      fields,
      footer: firstVisibleText(embedNode, ['[class*="embedFooter"]'])
    };
  }

  function extractField(fieldNode) {
    const field = {
      name: firstVisibleText(fieldNode, ['[class*="embedFieldName"]']),
      value: firstVisibleText(fieldNode, ['[class*="embedFieldValue"]'])
    };
    if (hasFieldContent(field)) {
      return field;
    }
    return extractTextOnlyField(fieldNode);
  }

  function extractTextOnlyField(fieldNode) {
    const lines = rawText(fieldNode)
      .split(/\r?\n/)
      .map(normalizeWhitespace)
      .filter(Boolean);

    if (lines.length >= 2) {
      return {
        name: lines[0],
        value: lines.slice(1).join("\n")
      };
    }

    return {
      name: "",
      value: lines[0] || ""
    };
  }

  function extractUnwrappedFields(embedNode) {
    const names = visibleTexts(embedNode, ['[class*="embedFieldName"]']);
    const values = visibleTexts(embedNode, ['[class*="embedFieldValue"]']);
    const fields = [];
    const fieldCount = Math.min(names.length, values.length);
    for (let index = 0; index < fieldCount; index += 1) {
      const field = { name: names[index], value: values[index] };
      if (hasFieldContent(field)) {
        fields.push(field);
      }
    }
    return fields;
  }

  function isEmbedContainer(node) {
    const className = getClassName(node);
    if (
      /embed(?:title|description|field|footer)/i.test(className) ||
      /embedfield(?:name|value)/i.test(className)
    ) {
      return false;
    }
    return hasEmbedContent(extractEmbed(node));
  }

  function isEmbedFieldContainer(node) {
    const className = getClassName(node);
    return !/embedfield(?:name|value)/i.test(className);
  }

  function hasEmbedContent(embed) {
    return Boolean(embed.title || embed.description || embed.footer || embed.fields.length);
  }

  function hasFieldContent(field) {
    return Boolean(field.name || field.value);
  }

  function topLevelNodes(nodes) {
    const selected = new Set(nodes);
    return nodes.filter((node) => !hasSelectedAncestor(node, selected));
  }

  function hasSelectedAncestor(node, selected) {
    let parent = getParentNode(node);
    while (parent) {
      if (selected.has(parent)) {
        return true;
      }
      parent = getParentNode(parent);
    }
    return false;
  }

  function extractMessageId(messageNode) {
    const candidates = messageIdCandidates(messageNode);
    const numericId = firstFinalNumericId(candidates);
    if (numericId) {
      return numericId;
    }

    const stableId = firstStableDomMessageId(candidates);
    if (stableId) {
      return stableId;
    }

    const nearestContext = findNearestMessageContext(messageNode);
    if (nearestContext) {
      const contextCandidates = messageIdCandidates(nearestContext);
      return (
        firstFinalNumericId(contextCandidates) ||
        firstStableDomMessageId(contextCandidates) ||
        nodeFallbackMessageId(messageNode)
      );
    }

    return nodeFallbackMessageId(messageNode);
  }

  function firstFinalNumericId(candidates) {
    for (const candidate of candidates) {
      const match = String(candidate || "").match(/(\d+)(?!.*\d)/);
      if (match) {
        return match[1];
      }
    }
    return "";
  }

  function firstStableDomMessageId(candidates) {
    for (const candidate of candidates) {
      const normalized = normalizeDomAttributeValue(candidate);
      if (isStableDomAttributeValue(normalized)) {
        return `dom-${hashString(normalized)}`;
      }
    }
    return "";
  }

  function messageIdCandidates(node) {
    return [
      getAttribute(node, "data-list-item-id"),
      getAttribute(node, "aria-labelledby"),
      getNodeProperty(node, "id"),
      getAttribute(node, "id")
    ];
  }

  function findNearestMessageContext(node) {
    let parent = getParentNode(node);
    while (parent) {
      if (looksLikeMessageContext(parent)) {
        const candidates = messageIdCandidates(parent);
        if (firstFinalNumericId(candidates) || firstStableDomMessageId(candidates)) {
          return parent;
        }
      }
      parent = getParentNode(parent);
    }
    return null;
  }

  function looksLikeMessageContext(node) {
    const role = getAttribute(node, "role").toLowerCase();
    const className = getClassName(node).toLowerCase();
    const id = getNodeProperty(node, "id") || getAttribute(node, "id");
    return Boolean(
      String(id || "").startsWith("chat-messages-") ||
        getAttribute(node, "data-list-item-id") ||
        role === "listitem" ||
        className.includes("message") ||
        className.includes("group")
    );
  }

  function nodeFallbackMessageId(node) {
    if (node && typeof node === "object" && nodeFallbackIds) {
      const existing = nodeFallbackIds.get(node);
      if (existing) {
        return existing;
      }
      const id = `visible-${nextFallbackId}`;
      nextFallbackId += 1;
      nodeFallbackIds.set(node, id);
      return id;
    }

    const id = `visible-${nextFallbackId}`;
    nextFallbackId += 1;
    return id;
  }

  function normalizeDomAttributeValue(value) {
    return normalizeWhitespace(String(value || ""));
  }

  function isStableDomAttributeValue(value) {
    return Boolean(
      value &&
        value.length <= 200 &&
        !/^\d+$/.test(value) &&
        !/^https?:/i.test(value) &&
        /[A-Za-z_-]/.test(value) &&
        /^[A-Za-z0-9:_\-. ]+$/.test(value)
    );
  }

  function hashString(value) {
    let hash = 0;
    for (const character of value) {
      hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
    }
    return hash.toString(16);
  }

  function firstVisibleText(root, selectors) {
    for (const node of queryAll(root, selectors)) {
      if (!isVisible(node)) {
        continue;
      }
      const text = normalizedText(node);
      if (text) {
        return text;
      }
    }
    return "";
  }

  function previousMessageAuthor(messageNode) {
    let current = messageNode;
    let depth = 0;
    while (current && depth < 6) {
      let sibling = previousElementSibling(current);
      let checked = 0;
      while (sibling && checked < 12) {
        if (looksLikeMessageContext(sibling) || hasMessageContextDescendant(sibling)) {
          const author = lastVisibleText(sibling, ['[class*="username"]', '[class*="headerText"]']);
          if (author) {
            return author;
          }
          checked += 1;
        }
        sibling = previousElementSibling(sibling);
      }
      current = getParentNode(current);
      depth += 1;
    }
    return "";
  }

  function hasMessageContextDescendant(node) {
    return queryAll(node, ['[id^="chat-messages-"]', '[data-list-item-id]', '[role="listitem"]']).some(
      looksLikeMessageContext
    );
  }

  function lastVisibleText(root, selectors) {
    const texts = visibleTexts(root, selectors);
    return texts.length ? texts[texts.length - 1] : "";
  }

  function previousElementSibling(node) {
    if (node?.previousElementSibling) {
      return node.previousElementSibling;
    }
    const parent = getParentNode(node);
    const children = Array.from(parent?.children || []);
    const index = children.indexOf(node);
    return index > 0 ? children[index - 1] : null;
  }

  function firstNode(root, selectors) {
    for (const node of queryAll(root, selectors)) {
      return node;
    }
    return null;
  }

  function timestampIsoFromNode(node) {
    const rawTimestamp = getAttribute(node, "datetime") || getNodeProperty(node, "dateTime");
    if (!rawTimestamp) {
      return "";
    }

    const date = new Date(rawTimestamp);
    return Number.isFinite(date.getTime()) ? date.toISOString() : "";
  }

  function visibleTexts(root, selectors) {
    return queryAll(root, selectors)
      .filter(isVisible)
      .map(normalizedText)
      .filter(Boolean);
  }

  function queryAll(root, selectors) {
    if (!root || typeof root.querySelectorAll !== "function") {
      return [];
    }

    const matches = [];
    for (const selector of selectors) {
      try {
        for (const node of Array.from(root.querySelectorAll(selector))) {
          matches.push(node);
        }
      } catch {
        continue;
      }
    }
    return uniqueNodes(matches);
  }

  function uniqueNodes(nodes) {
    const seen = new Set();
    const unique = [];
    for (const node of nodes) {
      if (node && !seen.has(node)) {
        seen.add(node);
        unique.push(node);
      }
    }
    return unique;
  }

  function uniqueStrings(values) {
    const seen = new Set();
    const unique = [];
    for (const value of values) {
      const normalized = typeof value === "string" ? value.trim() : "";
      if (normalized && !seen.has(normalized)) {
        seen.add(normalized);
        unique.push(normalized);
      }
    }
    return unique;
  }

  function normalizedText(node) {
    return normalizeWhitespace(rawText(node));
  }

  function rawText(node) {
    if (typeof node?.innerText === "string") {
      return node.innerText;
    }
    if (typeof node?.textContent === "string") {
      return node.textContent;
    }
    return "";
  }

  function normalizeWhitespace(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function isVisible(node) {
    if (!node) {
      return false;
    }
    if (getNodeProperty(node, "hidden") === true || getAttribute(node, "aria-hidden") === "true") {
      return false;
    }

    const style = getStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }

    if (typeof node.getClientRects === "function") {
      try {
        return node.getClientRects().length > 0;
      } catch {
        return true;
      }
    }
    return true;
  }

  function getStyle(node) {
    if (typeof getComputedStyle === "function") {
      try {
        return getComputedStyle(node) || {};
      } catch {
        return {};
      }
    }
    return node?.style || {};
  }

  function getHref(node) {
    return (
      (typeof node?.href === "string" && node.href) ||
      getAttribute(node, "href") ||
      ""
    ).trim();
  }

  function isDiscordAttachmentUrl(rawUrl) {
    let url;
    try {
      url = new URL(rawUrl, "https://discord.com");
    } catch {
      return false;
    }
    const host = url.hostname.toLowerCase();
    if (host === "cdn.discordapp.com" || host === "media.discordapp.net") {
      return true;
    }
    return isDiscordOwnedHost(host) && url.pathname.includes("/attachments/");
  }

  function isDiscordOwnedHost(host) {
    return (
      host === "discord.com" ||
      host.endsWith(".discord.com") ||
      host === "discordapp.com" ||
      host.endsWith(".discordapp.com")
    );
  }

  function getClassName(node) {
    const className = getNodeProperty(node, "className") || getAttribute(node, "class") || "";
    return typeof className === "string" ? className : "";
  }

  function getAttribute(node, name) {
    if (!node || typeof node.getAttribute !== "function") {
      return "";
    }
    try {
      return node.getAttribute(name) || "";
    } catch {
      return "";
    }
  }

  function getNodeProperty(node, property) {
    try {
      return node ? node[property] : "";
    } catch {
      return "";
    }
  }

  function getParentNode(node) {
    return getNodeProperty(node, "parentElement") || getNodeProperty(node, "parentNode") || null;
  }

  global.DiscordCopyRepostParser = {
    parseDiscordChannelIds,
    extractAlertFromMessageNode
  };
})();
