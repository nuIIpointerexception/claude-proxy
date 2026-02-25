import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

type FileKind = "requestMeta" | "requestBody" | "responseMeta" | "responseBody" | "responseSse" | "errorText";

type Group = {
  dir: string;
  stem: string;
  files: Partial<Record<FileKind, string>>;
};

type JsonObject = Record<string, unknown>;

const cwd = process.cwd();
const archiveDir = process.env.ARCHIVE_DIR ?? join(cwd, "archives");

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(fullPath)));
      continue;
    }
    out.push(fullPath);
  }
  return out;
}

function classifyFile(name: string): { stem: string; kind: FileKind } | null {
  const patterns: Array<[string, FileKind]> = [
    [".request.meta.json", "requestMeta"],
    [".request.body", "requestBody"],
    [".response.meta.json", "responseMeta"],
    [".response.body", "responseBody"],
    [".response.sse.ndjson", "responseSse"],
    [".error.txt", "errorText"],
  ];

  for (const [suffix, kind] of patterns) {
    if (name.endsWith(suffix)) {
      return { stem: name.slice(0, -suffix.length), kind };
    }
  }
  return null;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as JsonObject).sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortJson(v)]));
  }
  return value;
}

function parseJson(raw: string, fallbackLabel: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return { parse_error: fallbackLabel, raw };
  }
}

function parseNdjson(raw: string): unknown[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => parseJson(line, `line_${index + 1}`));
}

function bodyFromBytes(bytes: Buffer, contentType: string | null): { encoding: "utf8"; text: string } | { encoding: "base64"; base64: string } {
  const normalized = (contentType ?? "").toLowerCase();
  const isText =
    normalized.startsWith("text/") ||
    normalized.includes("json") ||
    normalized.includes("xml") ||
    normalized.includes("x-www-form-urlencoded") ||
    normalized.includes("javascript");

  if (isText) {
    return { encoding: "utf8", text: bytes.toString("utf8") };
  }
  return { encoding: "base64", base64: bytes.toString("base64") };
}

async function main() {
  let allFiles: string[];
  try {
    allFiles = await walk(archiveDir);
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : undefined;
    if (code === "ENOENT") {
      console.log(`Archive directory not found: ${archiveDir}`);
      console.log("Nothing to prettify.");
      return;
    }
    throw error;
  }

  const groups = new Map<string, Group>();

  for (const file of allFiles) {
    const parsed = classifyFile(basename(file));
    if (!parsed) {
      continue;
    }

    const dir = dirname(file);
    const key = `${dir}::${parsed.stem}`;
    const existing = groups.get(key) ?? { dir, stem: parsed.stem, files: {} };
    existing.files[parsed.kind] = file;
    groups.set(key, existing);
  }

  let written = 0;
  for (const group of groups.values()) {
    const requestMetaRaw = group.files.requestMeta ? await readFile(group.files.requestMeta, "utf8") : null;
    const responseMetaRaw = group.files.responseMeta ? await readFile(group.files.responseMeta, "utf8") : null;
    const requestMeta = requestMetaRaw ? (parseJson(requestMetaRaw, "request.meta.json") as JsonObject) : null;
    const responseMeta = responseMetaRaw ? (parseJson(responseMetaRaw, "response.meta.json") as JsonObject) : null;

    const requestBody = group.files.requestBody
      ? bodyFromBytes(
          await readFile(group.files.requestBody),
          (requestMeta?.["http.request.body.content_type"] as string | undefined) ?? null,
        )
      : null;

    const responseBody = group.files.responseBody
      ? bodyFromBytes(
          await readFile(group.files.responseBody),
          (responseMeta?.["http.response.content_type"] as string | undefined) ?? null,
        )
      : null;

    const sseEvents = group.files.responseSse ? parseNdjson(await readFile(group.files.responseSse, "utf8")) : null;
    const error = group.files.errorText ? await readFile(group.files.errorText, "utf8") : null;

    const outPath = join(group.dir, `${group.stem}.json`);

    const pretty = sortJson({
      request: {
        meta: requestMeta,
        body: requestBody,
      },
      response: {
        meta: responseMeta,
        body: responseBody,
        sse_events: sseEvents,
      },
      error,
      source_files: sortJson(group.files),
    });

    await writeFile(outPath, `${JSON.stringify(pretty, null, 2)}\n`, "utf8");
    written += 1;
  }

  console.log(`Prettified ${written} archive request groups in place.`);
  console.log(`Archive dir: ${archiveDir}`);
}

await main();
