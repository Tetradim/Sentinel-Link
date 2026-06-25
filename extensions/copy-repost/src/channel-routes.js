(function exposeChannelRoutes(global) {
  const defaultPrefix = "[copied-alert]";

  function normalizeDiscordChannelUrl(rawUrl) {
    let url;
    try {
      url = new URL(String(rawUrl || "").trim());
    } catch {
      throw new Error("Discord channel URL expected");
    }

    const match = url.pathname.match(/^\/channels\/(\d+)\/(\d+)(?:\/.*)?$/);
    if (url.protocol !== "https:" || url.hostname !== "discord.com" || !match) {
      throw new Error("Discord channel URL expected");
    }

    return {
      url: `${url.origin}/channels/${match[1]}/${match[2]}`,
      guildId: match[1],
      channelId: match[2]
    };
  }

  function addChannelUrl(urls, rawUrl) {
    const existingUrls = normalizeUrlList(urls);
    const channel = normalizeDiscordChannelUrl(rawUrl);
    if (existingUrls.includes(channel.url)) {
      throw new Error("duplicate Discord channel URL");
    }

    return {
      urls: [...existingUrls, channel.url],
      addedUrl: channel.url
    };
  }

  function revertLastChannelUrl(urls) {
    const existingUrls = normalizeUrlList(urls);
    if (existingUrls.length === 0) {
      return { urls: [], removedUrl: "" };
    }

    return {
      urls: existingUrls.slice(0, -1),
      removedUrl: existingUrls.at(-1)
    };
  }

  function clearChannelUrls() {
    return [];
  }

  function buildRuntimeConfig({ listenChannelUrls = [], postChannelUrls = [], prefix = defaultPrefix } = {}) {
    const destinationUrls = normalizeUrlList(postChannelUrls);
    const mappings = normalizeUrlList(listenChannelUrls).map((sourceUrl) => {
      const source = normalizeDiscordChannelUrl(sourceUrl);
      return {
        id: `popup-route-${source.channelId}`,
        enabled: true,
        sourceUrl: source.url,
        destinationUrls,
        prefix
      };
    });

    return {
      enabled: true,
      retry: {
        maxAttempts: 3,
        baseDelayMs: 2000
      },
      sendPacingMs: 1500,
      mappings
    };
  }

  function hasStoredRoutes(listenChannelUrls, postChannelUrls) {
    return normalizeUrlList(listenChannelUrls).length > 0 || normalizeUrlList(postChannelUrls).length > 0;
  }

  function normalizeUrlList(urls) {
    if (!Array.isArray(urls)) {
      return [];
    }

    const normalized = [];
    for (const rawUrl of urls) {
      if (typeof rawUrl !== "string" || !rawUrl.trim()) {
        continue;
      }
      const channel = normalizeDiscordChannelUrl(rawUrl);
      if (!normalized.includes(channel.url)) {
        normalized.push(channel.url);
      }
    }
    return normalized;
  }

  global.CopyRepostChannelRoutes = {
    addChannelUrl,
    buildRuntimeConfig,
    clearChannelUrls,
    hasStoredRoutes,
    normalizeDiscordChannelUrl,
    normalizeUrlList,
    revertLastChannelUrl
  };
})(globalThis);
