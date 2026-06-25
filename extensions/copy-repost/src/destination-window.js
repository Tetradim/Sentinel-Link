(function installCopyRepostDestinationWindow() {
  const keys = {
    dedicatedPostWindowEnabled: "dedicatedPostWindowEnabled",
    dedicatedPostWindowMinimized: "dedicatedPostWindowMinimized",
    closePostWindowsOnShutdown: "closePostWindowsOnShutdown",
    managedDestinationWindowId: "managedDestinationWindowId",
    managedDestinationTabIds: "managedDestinationTabIds"
  };

  function choosePostWindowUrl({ postChannelUrls = [], fallbackUrl = "" } = {}) {
    const urls = normalizeUrlList(postChannelUrls);
    const selected = urls.at(-1) || normalizeDiscordChannelUrl(fallbackUrl)?.url || "";
    if (!selected) {
      throw new Error("No post channel URL is configured");
    }
    return selected;
  }

  function normalizeDedicatedWindowState(input = {}) {
    return {
      dedicatedPostWindowEnabled: input.dedicatedPostWindowEnabled === true,
      dedicatedPostWindowMinimized: input.dedicatedPostWindowMinimized !== false,
      closePostWindowsOnShutdown: input.closePostWindowsOnShutdown !== false,
      managedDestinationWindowId: normalizePositiveInteger(input.managedDestinationWindowId),
      managedDestinationTabIds: normalizeTabIds(input.managedDestinationTabIds)
    };
  }

  function normalizeUrlList(values) {
    if (!Array.isArray(values)) {
      return [];
    }
    const urls = [];
    for (const value of values) {
      const normalized = normalizeDiscordChannelUrl(value);
      if (normalized && !urls.includes(normalized.url)) {
        urls.push(normalized.url);
      }
    }
    return urls;
  }

  function normalizeDiscordChannelUrl(rawUrl) {
    try {
      const url = new URL(String(rawUrl || "").trim());
      const match = url.pathname.match(/^\/channels\/(\d+)\/(\d+)/);
      if (url.protocol !== "https:" || url.hostname !== "discord.com" || !match) {
        return null;
      }
      return {
        guildId: match[1],
        channelId: match[2],
        url: `${url.origin}/channels/${match[1]}/${match[2]}`
      };
    } catch {
      return null;
    }
  }

  function normalizeTabIds(values) {
    if (!Array.isArray(values)) {
      return [];
    }
    return values.map(normalizePositiveInteger).filter((value) => value !== null);
  }

  function normalizePositiveInteger(value) {
    const number = Number.parseInt(value, 10);
    return Number.isInteger(number) && number > 0 ? number : null;
  }

  globalThis.CopyRepostDestinationWindow = {
    keys,
    choosePostWindowUrl,
    normalizeDedicatedWindowState,
    normalizeDiscordChannelUrl,
    normalizeUrlList
  };
})();
