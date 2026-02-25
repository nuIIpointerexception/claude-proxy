# claude-intercept

A Bun + TypeScript reverse proxy for Claude Code traffic that forwards requests to the real upstream API while logging structured telemetry.

This project is useful when you want to inspect Claude request/response behavior, archive raw payloads, and optionally ship logs to Axiom for querying.

## What this project does

`claude-intercept` sits between Claude Code and the upstream Anthropic-compatible endpoint:

1. Claude Code sends requests to this proxy.
2. The proxy forwards requests to the real upstream.
3. The proxy streams responses back to Claude Code.
4. In parallel, it logs request/response metadata and bodies (including SSE streams).

Core implementation is in `src/index.ts`.

## Key features

- Auto-discovers upstream from `~/.claude/settings.json` (`env.ANTHROPIC_BASE_URL`) if `UPSTREAM_BASE_URL` is not set.
- Proxies all methods and paths to upstream.
- Adds per-request trace ID (`x-request-id`) and structured JSON logs.
- Captures request insights (model, stream flag, message/tool counts, prompt preview, etc.).
- Parses and logs Server-Sent Events (SSE), including event counts and token usage when available.
- Archives request/response artifacts locally under `archives/`.
- Optional Axiom export with batching, compact event mode, and sampling.

## Requirements

- [Bun](https://bun.sh)
- A Claude Code setup that can point `ANTHROPIC_BASE_URL` to this proxy

## Quick start

```bash
bun install
bun run start
```

Defaults:
- Listen host: `127.0.0.1`
- Listen port: `8787`
- Proxy URL: `http://127.0.0.1:8787`

## Configure Claude Code to use the proxy

Set your Claude settings so `ANTHROPIC_BASE_URL` points to this proxy:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787"
  }
}
```

Then ensure the proxy knows the real upstream, either:

- via `UPSTREAM_BASE_URL`, or
- by running setup (see below), which captures your previous upstream automatically.

## Setup helper (automatic configuration)

Run:

```bash
bun run setup
```

What setup does:
- Reads your Claude settings file (default `~/.claude/settings.json`).
- Backs it up to `settings.json.backup.<timestamp>`.
- Sets `ANTHROPIC_BASE_URL` to the proxy base.
- Preserves your previous upstream as `UPSTREAM_BASE_URL`.
- Creates/updates local `.env` defaults for this project.

## Scripts

- `bun run dev` – run proxy with watch mode
- `bun run start` – run proxy normally
- `bun run setup` – rewrite Claude settings and seed `.env`
- `bun run typecheck` – TypeScript typecheck (`tsc --noEmit`)

## Environment variables

### Proxy

- `PROXY_HOST` (default: `127.0.0.1`)
- `PROXY_PORT` (default: `8787`)
- `UPSTREAM_BASE_URL` (required unless auto-discovered)
- `CLAUDE_SETTINGS_PATH` (default: `~/.claude/settings.json`)

### Archiving

- `ARCHIVE_ENABLED` (default: `1`)
- `ARCHIVE_DIR` (default: `<project>/archives`)
- `BODY_LOG_MAX_BYTES` (default: `65536`)
- `SSE_LOG_MAX_CHARS` (default: `2000`)

### Axiom

- `AXIOM_TOKEN`
- `AXIOM_DATASET`
- `AXIOM_BATCH_SIZE` (default: `100`)
- `AXIOM_FLUSH_MS` (default: `1000`)
- `AXIOM_AUTO_CREATE_DATASET` (default: `1`)

## Logged event types

The proxy emits NDJSON-style structured logs to stdout.

Common `event.action` values:
- `proxy_started`
- `request_received`
- `request_tool`
- `response_headers`
- `response_body`
- `sse_event`
- `sse_summary`
- `request_rollup`
- `proxy_request` (error path)

## Local archive files

When archiving is enabled, per-request files are written under `archives/`:

- `<requestId>.request.meta.json`
- `<requestId>.request.body`
- `<requestId>.response.meta.json`
- `<requestId>.response.body` (non-SSE)
- `<requestId>.response.sse.ndjson` (SSE)
- `<requestId>.error.txt` (on proxy error)

## Security and privacy notes

This proxy is intentionally high-visibility and may log sensitive content:

- request/response bodies
- prompt text previews
- tool schemas
- streamed model output in SSE events

Recommendations:
- Treat logs and archives as sensitive data.
- Keep `.env` private.
- Add `archives/` to `.gitignore` before using this in repositories you commit.

## Troubleshooting

### `No upstream URL found`

Set `UPSTREAM_BASE_URL`, or ensure `~/.claude/settings.json` contains `env.ANTHROPIC_BASE_URL`.

### Claude requests do not hit proxy

Verify Claude is configured with:

- `ANTHROPIC_BASE_URL=http://127.0.0.1:8787`

### Axiom logs are missing

Verify both:

- `AXIOM_TOKEN`
- `AXIOM_DATASET`

## Project structure

- `src/index.ts` – proxy server, request/response handling, SSE parsing, logging, archiving, Axiom export
- `src/setup.ts` – one-time setup utility for Claude settings and local `.env`
- `archives/` – local request artifacts (runtime output)

## Notes

- This repository currently ignores `.env` and `node_modules` via `.gitignore`.
- Consider also ignoring `archives/` if you do not want captured traffic artifacts tracked by git.
