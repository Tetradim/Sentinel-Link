import { createServer as createHttpServer } from "node:http";
import { timingSafeEqual } from "node:crypto";

const maxJsonBodyBytes = 1024 * 1024;
const allowedDiscordOrigins = new Set([
  "https://discord.com",
  "https://canary.discord.com",
  "https://ptb.discord.com"
]);

export function createServer({ config, store, authToken }) {
  const requiredAuthToken = normalizeAuthToken(authToken);
  return createHttpServer(async (request, response) => {
    try {
      await route({ request, response, config, store, authToken: requiredAuthToken });
    } catch (error) {
      const httpError = toHttpError(error);
      sendError(response, request, httpError);
    }
  });
}

async function route({ request, response, config, store, authToken }) {
  if (request.method === "OPTIONS") {
    return sendNoContent(response, request);
  }

  requireAuth(request, authToken);

  const url = new URL(request.url, "http://127.0.0.1");

  if (request.method === "GET" && url.pathname === "/health") {
    return sendJson(response, request, 200, { ok: true, enabled: config.enabled });
  }

  if (request.method === "GET" && url.pathname === "/config") {
    return sendJson(response, request, 200, sanitizeConfig(config));
  }

  if (request.method === "POST" && url.pathname === "/events") {
    const body = await readJson(request);
    const eventRequest = normalizeEventRequest(body, config);
    const result = await store.enqueueAlert(eventRequest.config, eventRequest.payload);
    return sendJson(response, request, 202, result);
  }

  if (request.method === "GET" && url.pathname === "/jobs/next") {
    const clientId = (url.searchParams.get("clientId") ?? "").trim();
    if (!clientId) {
      throw new HttpError(400, "missing_client_id", "clientId is required.");
    }
    const job = await store.claimNextJob(clientId);
    return sendJson(response, request, 200, job ?? { job: null });
  }

  const resultMatch = url.pathname.match(/^\/jobs\/([^/]+)\/result$/);
  if (request.method === "POST" && resultMatch) {
    const body = await readJson(request);
    const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
    if (!clientId) {
      throw new HttpError(400, "missing_client_id", "clientId is required.");
    }
    const result = await store.recordJobResult({
      jobId: decodeURIComponent(resultMatch[1]),
      status: body.status,
      reason: body.reason ?? "",
      degradation: Array.isArray(body.degradation) ? body.degradation : [],
      clientId,
      retry: config.retry
    });
    return sendJson(response, request, 200, result);
  }

  if (request.method === "GET" && url.pathname === "/status") {
    const snapshot = await store.snapshot();
    return sendJson(response, request, 200, summarize(snapshot));
  }

  throw new HttpError(404, "not_found", "Route not found.");
}

class HttpError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.statusCode = statusCode;
    this.errorCode = code;
  }
}

function normalizeAuthToken(authToken) {
  if (typeof authToken !== "string" || !authToken.trim()) {
    throw new Error("authToken is required");
  }
  return authToken.trim();
}

function requireAuth(request, authToken) {
  const requestToken = request.headers["x-helper-token"];
  if (typeof requestToken !== "string" || !tokensMatch(requestToken, authToken)) {
    throw new HttpError(401, "unauthorized", "A valid helper token is required.");
  }
}

function tokensMatch(requestToken, authToken) {
  const requestBuffer = Buffer.from(requestToken);
  const authBuffer = Buffer.from(authToken);
  return requestBuffer.length === authBuffer.length && timingSafeEqual(requestBuffer, authBuffer);
}

function sanitizeConfig(config) {
  return {
    enabled: config.enabled,
    retry: config.retry,
    sendPacingMs: config.sendPacingMs,
    mappings: config.mappings
  };
}

function normalizeEventRequest(body, baseConfig) {
  if (!body || typeof body !== "object" || Array.isArray(body) || !Object.hasOwn(body, "alert")) {
    return { config: baseConfig, payload: body };
  }

  return {
    config: {
      ...baseConfig,
      mappings: Object.hasOwn(body, "mappings") ? body.mappings : baseConfig.mappings
    },
    payload: body.alert
  };
}

function summarize(snapshot) {
  const counts = {
    queued: 0,
    in_progress: 0,
    retry_wait: 0,
    sent: 0,
    failed: 0,
    skipped_duplicate: snapshot.events.filter((event) => event.type === "skipped_duplicate").length
  };

  for (const job of snapshot.jobs) {
    if (Object.hasOwn(counts, job.status)) {
      counts[job.status] += 1;
    }
  }

  return {
    counts,
    recentEvents: snapshot.events.slice(-25)
  };
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxJsonBodyBytes) {
      throw new HttpError(413, "payload_too_large", "Request body must be 1 MB or smaller.");
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be valid JSON.");
  }
}

function toHttpError(error) {
  if (error instanceof HttpError) {
    return error;
  }

  if (typeof error?.message === "string") {
    if (error.message.startsWith("Job not found:")) {
      return new HttpError(404, "job_not_found", "Job was not found.");
    }
    if (error.message.includes("different client")) {
      return new HttpError(409, "lease_conflict", "Job is leased to a different client.");
    }
    if (error.message.includes("must be in progress") || error.message.includes("already terminal")) {
      return new HttpError(409, "invalid_transition", "Job result cannot be recorded in its current state.");
    }
    if (error.message.includes("Unsupported job result status")) {
      return new HttpError(409, "invalid_transition", "Job result status is not supported.");
    }
    if (error.message.includes("clientId is required")) {
      return new HttpError(400, "missing_client_id", "clientId is required.");
    }
    if (isValidationError(error.message)) {
      return new HttpError(400, "invalid_request", "Request payload is invalid.");
    }
  }

  return new HttpError(500, "internal_error", "An internal helper error occurred.");
}

function isValidationError(message) {
  return (
    message.startsWith("Config ") ||
    message.startsWith("Mapping ") ||
    message.startsWith("Discord channel URL expected:") ||
    message.startsWith("Alert payload ") ||
    message.includes(" must be ")
  );
}

function sendError(response, request, error) {
  sendJson(response, request, error.statusCode, {
    error: {
      code: error.errorCode,
      message: error.message
    }
  });
}

function sendNoContent(response, request) {
  response.writeHead(204, responseHeaders(request));
  response.end();
}

function sendJson(response, request, statusCode, body) {
  response.writeHead(statusCode, {
    ...responseHeaders(request),
    "content-type": "application/json"
  });

  response.end(JSON.stringify(body));
}

function responseHeaders(request) {
  const headers = {
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-helper-token"
  };
  const origin = request.headers.origin;
  if (typeof origin === "string" && isAllowedOrigin(origin)) {
    headers["access-control-allow-origin"] = origin;
    headers.vary = "Origin";
  }
  return headers;
}

function isAllowedOrigin(origin) {
  if (allowedDiscordOrigins.has(origin)) {
    return true;
  }
  return /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
}
