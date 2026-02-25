import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";

const STARTED_AT = Date.now();
const PROCESS_SESSION_ID = crypto.randomUUID();

async function loadDotEnv(): Promise<void> {
  try {
    const raw = await Bun.file(`${process.cwd()}/.env`).text();
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const eq = trimmed.indexOf("=");
      if (eq <= 0) {
        continue;
      }
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch {
    // no .env file
  }
}

await loadDotEnv();

const LISTEN_HOST = process.env.PROXY_HOST ?? "127.0.0.1";
const LISTEN_PORT = Number(process.env.PROXY_PORT ?? 8787);
const ARCHIVE_ENABLED = (process.env.ARCHIVE_ENABLED ?? "1") !== "0";
const ARCHIVE_DIR = process.env.ARCHIVE_DIR ?? `${process.cwd()}/archives`;
const AXIOM_TOKEN = process.env.AXIOM_TOKEN;
const AXIOM_DATASET = process.env.AXIOM_DATASET;
const AXIOM_BATCH_SIZE = Number(process.env.AXIOM_BATCH_SIZE ?? 100);
const AXIOM_FLUSH_MS = Number(process.env.AXIOM_FLUSH_MS ?? 1000);
const AXIOM_AUTO_CREATE_DATASET = (process.env.AXIOM_AUTO_CREATE_DATASET ?? "1") !== "0";
const BODY_LOG_MAX_BYTES = Number(process.env.BODY_LOG_MAX_BYTES ?? 65536);

type ClaudeSettings = {
  env?: {
    ANTHROPIC_BASE_URL?: string;
  };
};

type BodyPayload =
  | { encoding: "utf8"; text: string }
  | { encoding: "base64"; base64: string };

function isTextLike(contentType: string): boolean {
  return (
    contentType.startsWith("text/") ||
    contentType.includes("json") ||
    contentType.includes("xml") ||
    contentType.includes("x-www-form-urlencoded") ||
    contentType.includes("javascript")
  );
}

function decodeBody(bytes: Uint8Array | null, contentType: string): BodyPayload | null {
  if (!bytes || bytes.byteLength === 0) {
    return null;
  }

  const clipped = bytes.byteLength > BODY_LOG_MAX_BYTES ? bytes.slice(0, BODY_LOG_MAX_BYTES) : bytes;
  if (isTextLike(contentType)) {
    const text = new TextDecoder().decode(clipped);
    return {
      encoding: "utf8",
      text:
        bytes.byteLength > BODY_LOG_MAX_BYTES
          ? `${text}\n...[truncated ${bytes.byteLength - BODY_LOG_MAX_BYTES} bytes]`
          : text,
    };
  }

  const base64 = Buffer.from(clipped).toString("base64");
  return {
    encoding: "base64",
    base64: bytes.byteLength > BODY_LOG_MAX_BYTES ? `${base64}...[truncated]` : base64,
  };
}

function truncate(value: string, max = 280): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}…`;
}

function parsePayloadJson(payload: BodyPayload | null): Record<string, unknown> | null {
  if (!payload || payload.encoding !== "utf8") {
    return null;
  }
  try {
    return JSON.parse(payload.text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractRequestInsights(parsed: Record<string, unknown> | null): Record<string, unknown> {
  if (!parsed) {
    return {};
  }

  const out: Record<string, unknown> = {
    "anthropic.model": parsed.model,
    "anthropic.stream": parsed.stream,
    "anthropic.max_tokens": parsed.max_tokens,
    "anthropic.temperature": parsed.temperature,
  };

  if (parsed.metadata && typeof parsed.metadata === "object") {
    const metadata = parsed.metadata as Record<string, unknown>;
    out["anthropic.user_id"] = metadata.user_id;
  }

  if (Array.isArray(parsed.messages)) {
    out["anthropic.messages.count"] = parsed.messages.length;
    const firstUser = parsed.messages.find((m) => {
      if (!m || typeof m !== "object") return false;
      return (m as Record<string, unknown>).role === "user";
    }) as Record<string, unknown> | undefined;

    if (firstUser && Array.isArray(firstUser.content)) {
      const firstText = firstUser.content.find((c) => {
        if (!c || typeof c !== "object") return false;
        return (c as Record<string, unknown>).type === "text";
      }) as Record<string, unknown> | undefined;
      if (firstText && typeof firstText.text === "string") {
        out["prompt.preview"] = truncate(firstText.text.replace(/\s+/g, " "));
      }
    }
  }

  if (Array.isArray(parsed.system)) {
    out["anthropic.system.count"] = parsed.system.length;
  }

  if (Array.isArray(parsed.tools)) {
    out["anthropic.tools.count"] = parsed.tools.length;
    out["anthropic.tools.names"] = parsed.tools
      .map((t) => (t && typeof t === "object" ? (t as Record<string, unknown>).name : undefined))
      .filter((n): n is string => typeof n === "string");
  }

  return out;
}

const SENSITIVE_HEADERS = new Set(["authorization", "proxy-authorization", "x-api-key", "cookie", "set-cookie"]);

function redactHeaderValue(name: string, value: string): string {
  if (SENSITIVE_HEADERS.has(name.toLowerCase())) {
    return "[REDACTED]";
  }
  return value;
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of headers.entries()) {
    out[k] = redactHeaderValue(k, v);
  }
  return out;
}

function requestTarget(url: URL): string {
  return `${url.pathname}${url.search}`;
}

async function resolveUpstreamBase(): Promise<string | null> {
  const explicit = process.env.UPSTREAM_BASE_URL;
  if (explicit) {
    return explicit;
  }
  const settingsPath = process.env.CLAUDE_SETTINGS_PATH ?? `${homedir()}/.claude/settings.json`;
  try {
    const raw = await readFile(settingsPath, "utf8");
    const parsed = JSON.parse(raw) as ClaudeSettings;
    return parsed.env?.ANTHROPIC_BASE_URL ?? null;
  } catch {
    return null;
  }
}

async function archiveWrite(requestId: string, fileName: string, data: string | Uint8Array): Promise<void> {
  if (!ARCHIVE_ENABLED) {
    return;
  }
  const path = `${ARCHIVE_DIR}/${requestId}.${fileName}`;
  if (typeof data === "string") {
    await writeFile(path, data, "utf8");
    return;
  }
  await writeFile(path, data);
}

async function archiveAppend(requestId: string, fileName: string, line: string): Promise<void> {
  if (!ARCHIVE_ENABLED) {
    return;
  }
  const path = `${ARCHIVE_DIR}/${requestId}.${fileName}`;
  await appendFile(path, `${line}\n`, "utf8");
}

const axiomQueue: Record<string, unknown>[] = [];
let axiomFlushTimer: ReturnType<typeof setTimeout> | null = null;
let axiomFlushInFlight = false;
let axiomDatasetEnsured = false;

function nowIso(): string {
  return new Date().toISOString();
}

function latencyBucket(durationMs: number): string {
  if (durationMs <= 50) return "le_50ms";
  if (durationMs <= 100) return "le_100ms";
  if (durationMs <= 250) return "le_250ms";
  if (durationMs <= 500) return "le_500ms";
  if (durationMs <= 1000) return "le_1s";
  if (durationMs <= 3000) return "le_3s";
  if (durationMs <= 10000) return "le_10s";
  return "gt_10s";
}

async function ensureAxiomDataset(): Promise<boolean> {
  if (!AXIOM_TOKEN || !AXIOM_DATASET) {
    return false;
  }
  if (axiomDatasetEnsured) {
    return true;
  }
  if (!AXIOM_AUTO_CREATE_DATASET) {
    return false;
  }

  const createResponse = await fetch("https://api.axiom.co/v2/datasets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${AXIOM_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: AXIOM_DATASET, description: "Claude intercept logs" }),
  });

  if (!createResponse.ok && createResponse.status !== 409) {
    const err = await createResponse.text();
    throw new Error(`dataset create failed: ${createResponse.status} ${createResponse.statusText} ${err}`);
  }

  if (createResponse.status !== 409) {
    console.log(`Created Axiom dataset: ${AXIOM_DATASET}`);
  }

  axiomDatasetEnsured = true;
  return true;
}

async function flushAxiom(): Promise<void> {
  if (!AXIOM_TOKEN || !AXIOM_DATASET || axiomFlushInFlight || axiomQueue.length === 0) {
    return;
  }

  axiomFlushInFlight = true;
  const batch = axiomQueue.splice(0, AXIOM_BATCH_SIZE);
  const url = `https://api.axiom.co/v1/datasets/${encodeURIComponent(AXIOM_DATASET)}/ingest`;

  try {
    await ensureAxiomDataset();

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AXIOM_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(batch),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`axiom ingest failed: ${response.status} ${response.statusText} ${text}`);
      axiomQueue.unshift(...batch);
      if (response.status === 404) {
        axiomDatasetEnsured = false;
      }
    }
  } catch (error) {
    console.error(`axiom ingest failed: ${error instanceof Error ? error.message : String(error)}`);
    axiomQueue.unshift(...batch);
  } finally {
    axiomFlushInFlight = false;
  }

  if (axiomQueue.length > 0) {
    void flushAxiom();
  }
}

function queueAxiom(event: Record<string, unknown>): void {
  if (!AXIOM_TOKEN || !AXIOM_DATASET) {
    return;
  }

  axiomQueue.push(event);
  if (axiomQueue.length >= AXIOM_BATCH_SIZE) {
    void flushAxiom();
    return;
  }

  if (axiomFlushTimer) {
    return;
  }

  axiomFlushTimer = setTimeout(() => {
    axiomFlushTimer = null;
    void flushAxiom();
  }, AXIOM_FLUSH_MS);
}

function log(event: Record<string, unknown>) {
  const payload = {
    "@timestamp": nowIso(),
    "service.name": "claude-intercept",
    "service.version": "0.3.0",
    "event.dataset": "claude.proxy",
    "session.id": PROCESS_SESSION_ID,
    ...event,
  };
  queueAxiom(payload);
}

function toUpstreamUrl(localRequestUrl: string, upstreamOrigin: URL): URL {
  const incoming = new URL(localRequestUrl);
  return new URL(`${incoming.pathname}${incoming.search}`, upstreamOrigin);
}

async function captureResponseBody(inspectStream: ReadableStream<Uint8Array>, requestId: string, contentType: string) {
  const responseBytes = new Uint8Array(await new Response(inspectStream).arrayBuffer());
  const payload = decodeBody(responseBytes, contentType);
  await archiveWrite(requestId, "response.body", responseBytes);
  log({
    "log.level": "info",
    "trace.id": requestId,
    "event.action": "response_body",
    "http.response.body.bytes": responseBytes.byteLength,
    "http.response.body.content_type": contentType,
    "http.response.body": payload,
  });
}

async function captureSSE(
  inspectStream: ReadableStream<Uint8Array>,
  requestId: string,
  upstreamUrl: string,
  rollupBase: Record<string, unknown>,
) {
  const reader = inspectStream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sequence = 0;
  let sseBytes = 0;
  const eventTypeCount = new Map<string, number>();
  let usageInputTokens = 0;
  let usageOutputTokens = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      sseBytes += value.byteLength;
    }
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      if (!frame.trim()) {
        continue;
      }
      sequence += 1;
      let eventName = "message";
      let eventId: string | undefined;
      const dataLines: string[] = [];
      for (const line of frame.split(/\r?\n/)) {
        if (line.startsWith(":")) {
          continue;
        }
        if (line.startsWith("event:")) {
          eventName = line.slice(6).trim() || "message";
        } else if (line.startsWith("id:")) {
          eventId = line.slice(3).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }
      }

      eventTypeCount.set(eventName, (eventTypeCount.get(eventName) ?? 0) + 1);
      const data = dataLines.join("\n");

      if (eventName === "message_delta") {
        try {
          const parsed = JSON.parse(data) as Record<string, unknown>;
          if (parsed.usage && typeof parsed.usage === "object") {
            const usage = parsed.usage as Record<string, unknown>;
            usageInputTokens = Number(usage.input_tokens ?? usageInputTokens) || usageInputTokens;
            usageOutputTokens = Number(usage.output_tokens ?? usageOutputTokens) || usageOutputTokens;
          }
        } catch {
          // ignore parse errors
        }
      }

      const sseEvent = {
        "trace.id": requestId,
        "event.action": "sse_event",
        "event.sequence": sequence,
        "url.full": upstreamUrl,
        "sse.event": eventName,
        "sse.id": eventId,
        "sse.data": data,
        "sse.frame": frame,
        "sse.data.bytes": Buffer.byteLength(data, "utf8"),
      };
      log({ "log.level": "info", ...sseEvent });
      await archiveAppend(requestId, "response.sse.ndjson", JSON.stringify(sseEvent));
    }
  }

  const sseTypeCounts = Object.fromEntries(eventTypeCount.entries());
  log({
    "log.level": "info",
    "trace.id": requestId,
    "event.action": "sse_summary",
    "sse.event_count": sequence,
    "sse.stream.bytes": sseBytes,
    "usage.input_tokens": usageInputTokens,
    "usage.output_tokens": usageOutputTokens,
    "sse.type_counts": sseTypeCounts,
  });

  log({
    "log.level": "info",
    "event.action": "request_rollup",
    ...rollupBase,
    "sse.event_count": sequence,
    "sse.stream.bytes": sseBytes,
    "usage.input_tokens": usageInputTokens,
    "usage.output_tokens": usageOutputTokens,
    "sse.type_counts": sseTypeCounts,
  });
}

const upstreamBase = await resolveUpstreamBase();
if (!upstreamBase) {
  throw new Error("No upstream URL found. Set UPSTREAM_BASE_URL or configure ANTHROPIC_BASE_URL in ~/.claude/settings.json");
}

const upstreamOrigin = new URL(upstreamBase);
await mkdir(ARCHIVE_DIR, { recursive: true });

Bun.serve({
  hostname: LISTEN_HOST,
  port: LISTEN_PORT,
  async fetch(request) {
    const requestId = crypto.randomUUID();
    const started = performance.now();
    const upstreamUrl = toUpstreamUrl(request.url, upstreamOrigin);
    const requestContentType = request.headers.get("content-type") ?? "application/octet-stream";
    const requestBytes = request.body ? new Uint8Array(await request.arrayBuffer()) : null;
    const requestPayload = decodeBody(requestBytes, requestContentType);

    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("host", upstreamUrl.host);
    requestHeaders.set("x-request-id", requestId);
    requestHeaders.set("accept-encoding", "identity");

    const requestJson = parsePayloadJson(requestPayload);
    const requestInsights = extractRequestInsights(requestJson);
    const requestMeta = {
      "trace.id": requestId,
      "event.action": "request_received",
      "event.kind": "event",
      "http.request.method": request.method,
      "url.full": upstreamUrl.toString(),
      "url.path": upstreamUrl.pathname,
      "http.request.headers": headersToObject(request.headers),
      "http.request.body.bytes": requestBytes?.byteLength ?? 0,
      "http.request.body.content_type": requestContentType,
      "http.request.body": requestPayload,
      ...requestInsights,
    };

    log({ "log.level": "info", ...requestMeta });
    await archiveWrite(requestId, "request.body", requestBytes ?? new Uint8Array());
    await archiveWrite(requestId, "request.meta.json", JSON.stringify(requestMeta, null, 2));

    if (requestJson && Array.isArray(requestJson.tools)) {
      for (const [index, rawTool] of requestJson.tools.entries()) {
        if (!rawTool || typeof rawTool !== "object") {
          continue;
        }
        const tool = rawTool as Record<string, unknown>;
        log({
          "log.level": "info",
          "trace.id": requestId,
          "event.action": "request_tool",
          "tool.index": index,
          "tool.name": typeof tool.name === "string" ? tool.name : null,
          "tool.description": typeof tool.description === "string" ? truncate(tool.description, 500) : null,
          "tool.input_schema": tool.input_schema,
          "url.path": upstreamUrl.pathname,
          "anthropic.model": requestInsights["anthropic.model"],
          "anthropic.user_id": requestInsights["anthropic.user_id"],
        });
      }
    }

    try {
      const upstreamResponse = await fetch(upstreamUrl, {
        method: request.method,
        headers: requestHeaders,
        body: requestBytes,
        redirect: "manual",
      });

      const durationMs = performance.now() - started;
      const responseContentType = upstreamResponse.headers.get("content-type") ?? "application/octet-stream";
      const responseHeaders = headersToObject(upstreamResponse.headers);

      const requestBytesCount = requestBytes?.byteLength ?? 0;
      const responseBytesCount = Number(upstreamResponse.headers.get("content-length") ?? 0);
      const responseMeta = {
        "trace.id": requestId,
        "event.action": "response_headers",
        "event.kind": "event",
        "event.outcome": upstreamResponse.ok ? "success" : "failure",
        "event.duration": Math.round(durationMs * 1_000_000),
        "latency.ms": Math.round(durationMs),
        "latency.bucket": latencyBucket(durationMs),
        "http.response.status_code": upstreamResponse.status,
        "http.response.headers": responseHeaders,
        "http.response.content_type": responseContentType,
        "http.request.body.bytes": requestBytesCount,
        "http.response.body.bytes": responseBytesCount,
        "network.bytes": requestBytesCount + responseBytesCount,
      };

      const rollupBase = {
        "trace.id": requestId,
        "event.outcome": upstreamResponse.ok ? "success" : "failure",
        "latency.ms": Math.round(durationMs),
        "latency.bucket": latencyBucket(durationMs),
        "http.request.method": request.method,
        "url.full": upstreamUrl.toString(),
        "url.path": upstreamUrl.pathname,
        "http.response.status_code": upstreamResponse.status,
        "http.request.body.bytes": requestBytesCount,
        "http.response.body.bytes": responseBytesCount,
        "network.bytes": requestBytesCount + responseBytesCount,
        ...requestInsights,
      };

      log({ "log.level": "info", ...responseMeta });
      await archiveWrite(requestId, "response.meta.json", JSON.stringify(responseMeta, null, 2));

      const body = upstreamResponse.body;
      if (!body) {
        return new Response(null, {
          status: upstreamResponse.status,
          statusText: upstreamResponse.statusText,
          headers: upstreamResponse.headers,
        });
      }

      const [clientStream, inspectStream] = body.tee();
      if (responseContentType.includes("text/event-stream")) {
        void captureSSE(inspectStream, requestId, upstreamUrl.toString(), rollupBase);
      } else {
        void captureResponseBody(inspectStream, requestId, responseContentType);
        log({
          "log.level": "info",
          "event.action": "request_rollup",
          ...rollupBase,
        });
      }

      return new Response(clientStream, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers: upstreamResponse.headers,
      });
    } catch (error) {
      const durationMs = performance.now() - started;
      const errorText = error instanceof Error ? error.message : String(error);
      log({
        "log.level": "error",
        "trace.id": requestId,
        "event.action": "proxy_request",
        "event.kind": "event",
        "event.outcome": "failure",
        "event.duration": Math.round(durationMs * 1_000_000),
        "latency.ms": Math.round(durationMs),
        "latency.bucket": latencyBucket(durationMs),
        "http.request.method": request.method,
        "url.full": upstreamUrl.toString(),
        error: errorText,
      });
      log({
        "log.level": "error",
        "trace.id": requestId,
        "event.action": "request_rollup",
        "event.outcome": "failure",
        "latency.ms": Math.round(durationMs),
        "latency.bucket": latencyBucket(durationMs),
        "http.request.method": request.method,
        "url.full": upstreamUrl.toString(),
        error: errorText,
      });
      await archiveWrite(requestId, "error.txt", errorText);
      return new Response("Bad gateway", { status: 502 });
    }
  },
});

log({
  "log.level": "info",
  "event.action": "proxy_started",
  "process.uptime_ms": Date.now() - STARTED_AT,
  listen: `http://${LISTEN_HOST}:${LISTEN_PORT}`,
  upstream: upstreamOrigin.toString(),
  "archive.enabled": ARCHIVE_ENABLED,
  "archive.dir": ARCHIVE_DIR,
  "axiom.enabled": Boolean(AXIOM_TOKEN && AXIOM_DATASET),
});

console.log(`claude-intercept listening on http://${LISTEN_HOST}:${LISTEN_PORT}`);
