import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";

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

type ClaudeSettings = {
  env?: Record<string, string>;
};

function normalizeBase(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

await loadDotEnv();

const proxyBase = normalizeBase(process.env.PROXY_BASE_URL ?? "http://127.0.0.1:8787");
const settingsPath = process.env.CLAUDE_SETTINGS_PATH ?? `${homedir()}/.claude/settings.json`;

const raw = await readFile(settingsPath, "utf8");
const settings = JSON.parse(raw) as ClaudeSettings;
if (!settings.env) {
  settings.env = {};
}

const currentBase = settings.env.ANTHROPIC_BASE_URL;
const upstreamCandidate = currentBase && normalizeBase(currentBase) !== proxyBase ? currentBase : process.env.UPSTREAM_BASE_URL;
if (upstreamCandidate) {
  settings.env.UPSTREAM_BASE_URL = upstreamCandidate;
}

settings.env.ANTHROPIC_BASE_URL = proxyBase;

await writeFile(`${settingsPath}.backup.${Date.now()}`, raw, "utf8");
await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

const envPath = `${process.cwd()}/.env`;
const envRaw = await Bun.file(envPath).text().catch(() => "");
const envMap = new Map<string, string>();
for (const line of envRaw.split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    continue;
  }
  const eq = trimmed.indexOf("=");
  if (eq <= 0) {
    continue;
  }
  envMap.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
}

if (upstreamCandidate && !envMap.has("UPSTREAM_BASE_URL")) {
  envMap.set("UPSTREAM_BASE_URL", normalizeBase(upstreamCandidate));
}
if (!envMap.has("AXIOM_DATASET")) {
  envMap.set("AXIOM_DATASET", "claude-intercept");
}
if (!envMap.has("AXIOM_BATCH_SIZE")) {
  envMap.set("AXIOM_BATCH_SIZE", "100");
}
if (!envMap.has("AXIOM_FLUSH_MS")) {
  envMap.set("AXIOM_FLUSH_MS", "1000");
}
if (!envMap.has("AXIOM_AUTO_CREATE_DATASET")) {
  envMap.set("AXIOM_AUTO_CREATE_DATASET", "1");
}
const ordered = [...envMap.entries()].map(([k, v]) => `${k}=${v}`).join("\n");
await writeFile(envPath, `${ordered}\n`, "utf8");

console.log(`Updated ${settingsPath}`);
console.log(`Proxy base set to: ${proxyBase}`);
if (upstreamCandidate) {
  console.log(`Upstream captured as: ${normalizeBase(upstreamCandidate)}`);
}
console.log(`Updated ${envPath}`);
