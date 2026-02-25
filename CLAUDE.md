# CLAUDE.md

## Project summary

`claude-intercept` is a Bun + TypeScript reverse proxy for Claude Code / Anthropic-compatible APIs.

- Main runtime: `src/index.ts`
- Setup helper: `src/setup.ts`
- Purpose: forward traffic while capturing telemetry, SSE events, and optional local archives.

## Core behavior

1. Accept request locally (`PROXY_HOST` / `PROXY_PORT`).
2. Forward request to upstream (`UPSTREAM_BASE_URL` or value resolved from Claude settings).
3. Stream upstream response back to client.
4. Capture metadata/body and archive artifacts under `archives/`.
5. Optionally batch logs to Axiom (`AXIOM_*` env vars).

## Important files

- `src/index.ts` — proxy server, request/response logging, SSE parsing, archiving, Axiom queue/flush
- `src/setup.ts` — rewrites Claude settings to point to proxy and seeds `.env`
- `README.md` — usage and configuration
- `.gitignore` — includes `.env`, `archives/`, and `src/index.js`

## Local development

```bash
bun install
bun run dev
```

Other scripts:

```bash
bun run start
bun run setup
bun run typecheck
```

## Environment variables

- Proxy: `PROXY_HOST`, `PROXY_PORT`, `UPSTREAM_BASE_URL`, `CLAUDE_SETTINGS_PATH`
- Archiving: `ARCHIVE_ENABLED`, `ARCHIVE_DIR`
- Axiom: `AXIOM_TOKEN`, `AXIOM_DATASET`, `AXIOM_BATCH_SIZE`, `AXIOM_FLUSH_MS`, `AXIOM_AUTO_CREATE_DATASET`

## Safety / privacy

This project may capture sensitive prompts, model outputs, and tool payloads.

- Treat `archives/` as sensitive data.
- Do not commit secret-bearing files.
- Use only in authorized environments where traffic interception is permitted.

## Editing guidance

- Keep behavior changes minimal and explicit.
- Prefer updating `src/index.ts` over touching ignored/stale artifacts.
- Preserve request streaming behavior (`ReadableStream.tee()` split for client + inspection).
