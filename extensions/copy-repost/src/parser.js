(function () {
  const global = typeof window !== "undefined" ? window : globalThis;
  const emptyChannelIds = { guildId: "", channelId: "" };

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
    const text = firstVisibleText(messageNode, ['[class*="markup"]']);
    const labels = uniqueStrings(visibleTexts(messageNode, ["button", '[role="button"]', '[class*="button"]']));
    const attachmentUrls = uniqueStrings(queryAll(messageNode, ["a[href]"]).map(getHref).filter(isDiscordAttachmentUrl));
    const embeds = extractEmbeds(messageNode);

    return {
      sourceUrl,
      sourceChannelId: source.channelId,
      messageId: extractMessageId(messageNode, {
        sourceUrl,
        author: firstVisibleText(messageNode, ['[class*="username"]', '[class*="headerText"]']),
        timestampText: firstVisibleText(messageNode, ["time"]),
        text,
        embeds,
        labels,
        attachmentUrls
      }),
      author: firstVisibleText(messageNode, ['[class*="username"]', '[class*="headerText"]']),
      timestampText: firstVisibleText(messageNode, ["time"]),
      text,
      embeds,
      labels,
      attachmentUrls,
      capturedAt: new Date().toISOString()
    };
  }

  function extractEmbeds(messageNode) {
    const candidates = uniqueNodes(
      queryAll(messageNode, ['[class*="embedWrapper"]', '[class*="embedFull"]', '[class*="embedGrid"]', '[class*="embed"]'])
    ).filter(isEmbedContainer);
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
    return {
      name: firstVisibleText(fieldNode, ['[class*="embedFieldName"]']),
      value: firstVisibleText(fieldNode, ['[class*="embedFieldValue"]'])
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

  function extractMessageId(messageNode, fallbackParts) {
    const candidates = [
      getNodeProperty(messageNode, "id"),
      getAttribute(messageNode, "id"),
      getAttribute(messageNode, "data-list-item-id"),
      getAttribute(messageNode, "aria-labelledby")
    ];

    for (const candidate of candidates) {
      const match = String(candidate || "").match(/(\d+)(?!.*\d)/);
      if (match) {
        return match[1];
      }
    }

    return createFallbackMessageId(fallbackParts);
  }

  function createFallbackMessageId(parts) {
    const basis = JSON.stringify(parts);
    let hash = 0;
    for (const character of basis) {
      hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
    }
    return `visible-${hash.toString(16)}`;
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
    const rawText =
      typeof node?.innerText === "string"
        ? node.innerText
        : typeof node?.textContent === "string"
          ? node.textContent
          : "";
    return rawText.replace(/\s+/g, " ").trim();
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
    return host === "cdn.discordapp.com" || host === "media.discordapp.net" || url.pathname.includes("/attachments/");
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

  global.DiscordCopyRepostParser = {
    parseDiscordChannelIds,
    extractAlertFromMessageNode
  };
})();
