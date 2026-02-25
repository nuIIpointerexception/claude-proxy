# claude-intercept

## quick use

1. `bun install`
2. `bun run start`
3. point claude code to `http://127.0.0.1:8787` with `ANTHROPIC_BASE_URL`

A Bun + TypeScript reverse proxy for Claude Code / Anthropic-compatible traffic.

## safe usage (read first)

This tool can capture sensitive data (prompts, model output, tool schemas, headers/metadata).
Use it only in environments where traffic interception is authorized.

- Treat `archives/` as sensitive.
- Keep `.env` private.
- Do not share captured artifacts unless you have permission.

## What this project does

`claude-intercept` sits between Claude Code and the upstream API:

1. Claude Code sends requests to this local proxy.
2. The proxy forwards requests upstream.
3. The proxy streams upstream responses back to Claude Code.
4. In parallel, it records request/response metadata, payloads, and SSE events.

Main runtime: `src/index.ts`.

## Features

- Forward proxy for all methods and paths.
- Per-request correlation ID via `x-request-id`.
- Sensitive header redaction in logged metadata.
- Anthropic payload insight extraction (`model`, `stream`, tools, message counts, prompt preview).
- SSE parsing with per-event capture and summary/rollup metrics.
- Optional local archive artifacts under `archives/`.
- Optional Axiom ingestion with batching and dataset auto-create support.

## Requirements

- [Bun](https://bun.sh)
- Claude Code configured to use this proxy as `ANTHROPIC_BASE_URL`

## Quick start

```bash
bun install
bun run start
```

Default listen address: `http://127.0.0.1:8787`

## Configure Claude Code

Set Claude Code to point at the proxy:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787"
  }
}
```

Then provide the real upstream to this proxy by either:
- setting `UPSTREAM_BASE_URL`, or
- running `bun run setup` (captures prior upstream when possible).

## Setup helper

```bash
bun run setup
```

`src/setup.ts` will:
- read `~/.claude/settings.json` (or `CLAUDE_SETTINGS_PATH`),
- write `settings.json.backup.<timestamp>`,
- set `env.ANTHROPIC_BASE_URL` to the proxy base,
- preserve previous upstream as `UPSTREAM_BASE_URL` when available,
- create/update local `.env` defaults.

## Scripts

- `bun run dev` — watch mode
- `bun run start` — run proxy
- `bun run setup` — rewrite Claude settings + seed `.env`
- `bun run prettify:archives` — overwrite archive groups in place as `*.json`
- `bun run typecheck` — TypeScript check

## Environment variables

### Proxy
- `PROXY_HOST` (default: `127.0.0.1`)
- `PROXY_PORT` (default: `8787`)
- `UPSTREAM_BASE_URL` (optional if auto-resolved)
- `CLAUDE_SETTINGS_PATH` (default: `~/.claude/settings.json`)

### Archiving and payload capture
- `ARCHIVE_ENABLED` (default: `1`)
- `ARCHIVE_DIR` (default: `<project>/archives`)

### Axiom
- `AXIOM_TOKEN`
- `AXIOM_DATASET`
- `AXIOM_BATCH_SIZE` (default: `100`)
- `AXIOM_FLUSH_MS` (default: `1000`)
- `AXIOM_AUTO_CREATE_DATASET` (default: `1`)

## Events and outputs

The proxy builds structured events and queues them to Axiom when Axiom is configured.

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

Note: console output is intentionally minimal (startup/errors). Event payloads are primarily for Axiom/exported sinks.

## Archive files

When `ARCHIVE_ENABLED=1`, files are written under request-type folders:

- `archives/messages/<method>/v1-messages/<timestamp>-<requestId>.request.meta.json`
- `archives/messages/<method>/v1-messages/<timestamp>-<requestId>.request.body`
- `archives/messages/<method>/v1-messages/<timestamp>-<requestId>.response.meta.json`
- `archives/messages/<method>/v1-messages/<timestamp>-<requestId>.response.body` (non-SSE)
- `archives/messages-stream/<method>/v1-messages/<timestamp>-<requestId>.response.sse.ndjson` (SSE)
- `archives/<category>/<method>/<path>/<timestamp>-<requestId>.error.txt` (proxy errors)

## Archive prettifier

Run:

```bash
bun run prettify:archives
```

This overwrites each archive request group in place with `<stem>.json`, combining and formatting:

- request meta + decoded body
- response meta + decoded body
- parsed SSE NDJSON events
- proxy error text (if present)

Optional env var:
- `ARCHIVE_DIR` (directory to rewrite; default `./archives`)

Works on Linux and Windows (Bun runtime, no shell-specific commands).

## Troubleshooting

### `No upstream URL found`
Set `UPSTREAM_BASE_URL` or ensure Claude settings include `env.ANTHROPIC_BASE_URL` for auto-resolution.

### Requests are not reaching proxy
Verify Claude is using `ANTHROPIC_BASE_URL=http://127.0.0.1:8787`.

### No data in Axiom
Verify both `AXIOM_TOKEN` and `AXIOM_DATASET`.

## Project structure

- `src/index.ts` — proxy runtime, telemetry, SSE parsing, archiving, Axiom batching
- `src/setup.ts` — settings rewriter and `.env` seeder
- `archives/` — runtime capture artifacts
