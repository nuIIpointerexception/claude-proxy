# claude-intercept

A Bun + TypeScript reverse proxy for Claude Code / Anthropic-compatible traffic.

It sits between Claude Code and the upstream API, forwards requests/responses, and captures structured telemetry plus optional local archives for debugging and analysis.

## What this project is

`claude-intercept` is an observability proxy:

1. Claude Code sends requests to this local proxy.
2. The proxy forwards those requests to the configured upstream API.
3. The proxy streams the upstream response back to Claude Code.
4. In parallel, it records request/response metadata, payloads, and SSE events.

Main runtime: `src/index.ts`.

## Features

- Forward-proxy for all methods and paths.
- Request correlation via per-request `x-request-id`.
- Header redaction for sensitive headers (for logged metadata).
- Request insight extraction for Anthropic-style payloads (model, stream flag, tool names/count, message count, prompt preview).
- SSE parsing + per-event logs + summary/rollup metrics.
- Optional local artifact archiving under `archives/`.
- Optional Axiom ingestion with batching and auto-create dataset support.

## Requirements

- [Bun](https://bun.sh)
- Claude Code configured to use this proxy as `ANTHROPIC_BASE_URL`

## Quick start

```bash
bun install
bun run start
```

Default listen address:
- `http://127.0.0.1:8787`

## Configure Claude Code

Point Claude Code to this proxy:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787"
  }
}
```

Then ensure this proxy knows the real upstream by either:
- setting `UPSTREAM_BASE_URL`, or
- running `bun run setup` (captures current upstream automatically when possible).

## Setup helper

```bash
bun run setup
```

`src/setup.ts` performs:
- Read `~/.claude/settings.json` (or `CLAUDE_SETTINGS_PATH`).
- Backup settings to `settings.json.backup.<timestamp>`.
- Set `env.ANTHROPIC_BASE_URL` to proxy base.
- Preserve previous upstream as `UPSTREAM_BASE_URL` when available.
- Create/update local `.env` defaults.

## Scripts

- `bun run dev` — watch mode
- `bun run start` — start proxy
- `bun run setup` — rewrite Claude settings + seed `.env`
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
- `BODY_LOG_MAX_BYTES` (default: `65536`)

### Axiom

- `AXIOM_TOKEN`
- `AXIOM_DATASET`
- `AXIOM_BATCH_SIZE` (default: `100`)
- `AXIOM_FLUSH_MS` (default: `1000`)
- `AXIOM_AUTO_CREATE_DATASET` (default: `1`)

## Event flow and outputs

The proxy builds structured events internally and queues them for Axiom when Axiom is configured.

Typical event actions include:
- `proxy_started`
- `request_received`
- `request_tool`
- `response_headers`
- `response_body`
- `sse_event`
- `sse_summary`
- `request_rollup`
- `proxy_request` (error path)

Note: this version primarily exports logs through Axiom queueing. Console output is minimal (startup / error messages).

## Archive files

When `ARCHIVE_ENABLED=1`, request-scoped artifacts are written under `archives/`:

- `<requestId>.request.meta.json`
- `<requestId>.request.body`
- `<requestId>.response.meta.json`
- `<requestId>.response.body` (non-SSE)
- `<requestId>.response.sse.ndjson` (SSE)
- `<requestId>.error.txt` (proxy errors)

## Security and privacy

This proxy can capture sensitive data (prompts, model output, tool payloads, headers/metadata). Treat outputs as sensitive.

Recommendations:
- Keep `.env` private.
- Keep `archives/` out of version control.
- Use only in environments where traffic inspection is authorized.

## Troubleshooting

### Error: `No upstream URL found`

Set `UPSTREAM_BASE_URL` or ensure Claude settings contain `env.ANTHROPIC_BASE_URL` for auto-resolution.

### Requests are not reaching proxy

Verify Claude is using:
- `ANTHROPIC_BASE_URL=http://127.0.0.1:8787`

### No data in Axiom

Verify:
- `AXIOM_TOKEN`
- `AXIOM_DATASET`

## Project structure

- `src/index.ts` — proxy runtime, telemetry, SSE parsing, archiving, Axiom batching
- `src/setup.ts` — one-time settings rewriter and `.env` seeder
- `archives/` — runtime capture artifacts
