(function exposeSourceRouting(global) {
  function buildSourceConfig({ helperConfig = {}, runtimeMappings = [], listenOnlyChannelUrls = [] } = {}) {
    const validRuntimeMappings = Array.isArray(runtimeMappings)
      ? runtimeMappings.filter((mapping) => mapping && mapping.enabled !== false)
      : [];
    return {
      listenOnlyChannelUrls,
      helperSources: extractEnabledSources(helperConfig),
      popupSources: extractEnabledSources({
        enabled: true,
        mappings: validRuntimeMappings
      }),
      runtimeMappings: validRuntimeMappings
    };
  }

  function selectSubmissionForPayload(payload, sourceConfig = {}) {
    if (isListenOnlyPayload(payload, sourceConfig.listenOnlyChannelUrls)) {
      return {
        allowed: true,
        mode: "listen-only",
        body: { alert: payload, captureOnly: true, mappings: [] }
      };
    }
    if (matchesSources(payload, sourceConfig.popupSources) && sourceConfig.runtimeMappings?.length) {
      return {
        allowed: true,
        mode: "popup",
        body: {
          alert: payload,
          mappings: sourceConfig.runtimeMappings
        }
      };
    }

    if (matchesSources(payload, sourceConfig.helperSources)) {
      return {
        allowed: true,
        mode: "helper",
        body: payload
      };
    }

    return {
      allowed: false,
      mode: "ignored",
      body: null
    };
  }

  function isListenOnlyPayload(payload, urls = []) {
    const sources = extractEnabledSources({
      mappings: (Array.isArray(urls) ? urls : []).map(sourceUrl => ({ sourceUrl }))
    });
    return matchesSources({
      sourceChannelId: payload?.sourceChannelId || payload?.channel_id,
      sourceUrl: payload?.sourceUrl || payload?.channel_url || payload?.url
    }, sources);
  }

  function extractEnabledSources(config) {
    const sourceChannelIds = new Set();
    const sourceUrls = new Set();
    if (config?.enabled === false || !Array.isArray(config?.mappings)) {
      return { sourceChannelIds, sourceUrls };
    }

    for (const mapping of config.mappings) {
      if (!mapping || mapping.enabled === false) {
        continue;
      }

      const sourceChannelId = normalizeSourceChannelId(mapping.sourceChannelId) || channelIdFromUrl(mapping.sourceUrl);
      if (sourceChannelId) {
        sourceChannelIds.add(sourceChannelId);
      }

      const sourceUrl = discordChannelPrefix(mapping.sourceUrl);
      if (sourceUrl) {
        sourceUrls.add(sourceUrl);
      }
    }

    return { sourceChannelIds, sourceUrls };
  }

  function matchesSources(payload, sources = {}) {
    const sourceChannelId = normalizeSourceChannelId(payload?.sourceChannelId);
    if (sourceChannelId && sources.sourceChannelIds?.has(sourceChannelId)) {
      return true;
    }

    const sourceUrl = discordChannelPrefix(payload?.sourceUrl);
    return Boolean(sourceUrl && sources.sourceUrls?.has(sourceUrl));
  }

  function channelIdFromUrl(rawUrl) {
    try {
      const url = new URL(rawUrl);
      const match = url.pathname.match(/^\/channels\/(\d+)\/(\d+)/);
      return url.protocol === "https:" && url.hostname === "discord.com" && match ? match[2] : "";
    } catch {
      return "";
    }
  }

  function discordChannelPrefix(rawUrl) {
    try {
      const url = new URL(rawUrl);
      const match = url.pathname.match(/^\/channels\/(\d+)\/(\d+)/);
      return url.protocol === "https:" && url.hostname === "discord.com" && match
        ? `${url.origin}/channels/${match[1]}/${match[2]}`
        : "";
    } catch {
      return "";
    }
  }

  function normalizeSourceChannelId(sourceChannelId) {
    return typeof sourceChannelId === "string" ? sourceChannelId.trim() : "";
  }

  global.CopyRepostSourceRouting = {
    buildSourceConfig,
    isListenOnlyPayload,
    selectSubmissionForPayload
  };
})(globalThis);
