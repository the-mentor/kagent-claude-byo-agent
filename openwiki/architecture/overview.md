---
type: Architecture
title: Architecture Overview
description: Runtime architecture of claude-byo-agent — how the Express A2A server dispatches tasks to the ClaudeExecutor, which drives the Claude Agent SDK query() loop, plus A2A endpoints, event mapping, port/workspace choices, and the SandboxAgent-vs-Agent and A2A-not-ACP design decisions.
resource: src/server.ts
tags: [architecture, a2a, executor, kagent]
---

# Architecture Overview

The agent is a small, layered A2A service. A request path flows top to bottom:

```
kagent UI / A2A client
      │  A2A (JSON-RPC over HTTP + SSE)
      ▼
Express app (src/server.ts) — listens on :80
  ├── GET  /.well-known/agent-card.json   (agentCardHandler)
  └── POST /                              (jsonRpcHandler: message/send, message/stream)
      ▼
DefaultRequestHandler + InMemoryTaskStore + DefaultExecutionEventBusManager
      ▼
ClaudeExecutor (src/executor.ts)  — execute() / cancelTask()
      ▼
@anthropic-ai/claude-agent-sdk  query()  →  async generator
      Persistent workspace: /data/workspace
```

## Components

- **`src/index.ts`** — process entrypoint. Reads `PORT` (default `80`), calls `app.listen(PORT, '0.0.0.0')`, and installs SIGINT/SIGTERM handlers that close the server and force-exit after a 5s drain timeout.
- **`src/server.ts`** — constructs the Express app and wires `@a2a-js/sdk/server` pieces: `InMemoryTaskStore`, `DefaultExecutionEventBusManager`, and a `DefaultRequestHandler` bound to the static agent card and the `claudeExecutor`. JSON-RPC runs with `UserBuilder.noAuthentication`.
- **`src/agent-card.ts`** — static `AgentCard` (protocol `0.3.0`, `streaming: true`, one `coding` skill) served for discovery.
- **`src/executor.ts`** — the `AgentExecutor`. It translates the SDK's message stream into A2A events and hosts the permission workflow. This layer dispatches each task to the Claude Agent SDK and is described in detail in the [HITL permissions workflow](../workflows/hitl-permissions.md).

The Express layer is verified by the server test, and the executor by the executor tests, both covered in [testing](../testing.md). The whole image is shipped by [deployment/operations](../operations/deployment.md).

## A2A surface

Endpoints:

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/.well-known/agent-card.json` | Agent discovery metadata |
| `POST` | `/` | JSON-RPC 2.0 endpoint |

JSON-RPC methods: `message/send` (single response) and `message/stream` (SSE stream of events).

Event mapping produced by `execute()` (see `makeStatusEvent` / `makeArtifactEvent` / `makeTaskEvent` in `src/executor.ts`):

| SDK output | A2A event | `final` |
|------------|-----------|---------|
| assistant `text` block | `artifact-update` | false |
| assistant `tool_use` block | `status-update` `working` (`Using tool: …`) | false |
| tool needs approval | `status-update` `input-required` | false |
| `result` success | `status-update` `completed` | true |
| `result` error | `status-update` `failed` | true |
| `AbortError` | `status-update` `canceled` | true |

### Task-event ordering (why the Task event comes first)

`execute()` publishes a `Task` event (`makeTaskEvent`) **before** any status/artifact updates. This initializes `ResultManager.currentTask` in the store; without it, `message/send` drops every subsequent update as an "unknown task". This ordering was made explicit for the `message/send` path (see commit `21f22c1`). The HITL response branch also publishes a Task event before completing the turn.

## Key design decisions

- **`SandboxAgent`, not `Agent`.** `SandboxAgent` lets kagent provision and manage a container per Substrate actor, giving per-user workspace isolation and lifecycle for free. The workspace `/data/workspace` is fixed and persistent for the actor's lifetime — isolation is at the container level, so no per-task temp dirs are needed. Placing it under `/data` (the Substrate durable dir) ensures workspace files survive DATA-scope auto-suspend cycles.
- **`HOME=/data/home/agent` (set in entrypoint, not Dockerfile).** Claude Code's session store (`~/.claude/`) and config (`~/.claude.json`) must live under the Substrate durable dir so conversation history survives cold-boot resume. Substrate overrides the Dockerfile `ENV HOME` at actor launch time (actor runs as root → `HOME=/root`), so `docker-entrypoint.sh` explicitly re-sets `export HOME=/data/home/agent` before `exec node`, ensuring the node process and the `claude` subprocess both inherit it.
- **A2A, not ACP.** The base image `acp-sandbox-claude` ships an ACP shim; this project overrides the entrypoint (`docker-entrypoint.sh`) to bypass it and run its own A2A server, since A2A is kagent's native agent protocol. Details in [deployment](../operations/deployment.md).
- **Port 80.** The server listens on `:80` because kagent's `readyz` check probes port 80, not 8080 (commit `94909d3`; diagram updated in `de61b11`). `PORT` can still override it.
- **CommonJS module system.** `tsconfig.json` compiles to CommonJS with `moduleResolution: "node"`. `@a2a-js/sdk` ships real JS at its subpath exports (`/server`, `/server/express`), so `node` resolution works; `bundler`/ESM resolution does not apply.
- **Read-only tools by default.** `query()` is started with `allowedTools: ['Read','Glob','Grep','LS']`. `Write`, `Edit`, and `Bash` are intentionally omitted so the SDK asks for permission, routing them through the [HITL workflow](../workflows/hitl-permissions.md).

For the authoritative long-form rationale, see [`docs/design.md`](../../docs/design.md).
