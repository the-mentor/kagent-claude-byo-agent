---
type: Reference
title: claude-byo-agent Quickstart
description: Entrypoint for the claude-byo-agent wiki. Explains what this Claude Code BYO A2A agent for kagent SandboxAgent does, how to build/run/test it, and links to architecture, HITL workflow, deployment, and testing pages.
resource: package.json
tags: [quickstart, overview, kagent, a2a, claude]
---

# claude-byo-agent

`claude-byo-agent` is a standalone **BYO (Bring Your Own) agent** for [kagent](https://github.com/kagent-dev/kagent). It wraps the `@anthropic-ai/claude-agent-sdk` in a thin **A2A** (Agent-to-Agent) HTTP/JSON-RPC server so that Claude Code can be deployed and managed as a kagent `SandboxAgent` CRD. It does not modify the kagent repository — it ships as its own container image.

- **What it is:** an A2A server (`express` + `@a2a-js/sdk`) whose executor runs Claude Code via `query()` in a persistent workspace at `/data/workspace`.
- **Where it runs:** as a `SandboxAgent` in the `kagent` namespace; kagent (Substrate actor model) provisions one isolated container per actor.
- **How it talks:** A2A JSON-RPC over HTTP with SSE streaming, listening on **port 80**.

The single canonical design document is [`docs/design.md`](../docs/design.md). This wiki summarizes the current running state and links back to source; where the design doc lags behind recent commits (e.g. port and entrypoint changes), the wiki reflects current code.

## How it fits together

The [architecture overview](architecture/overview.md) describes the request path: the Express A2A server dispatches every task to the `ClaudeExecutor`, which drives the Claude Agent SDK. Tool use is gated by a [human-in-the-loop permission workflow](workflows/hitl-permissions.md). The image is shipped and run via the [deployment/operations guide](operations/deployment.md), and behavior is protected by the [test suite](testing.md), which the Docker build runs as a gate.

## Build, test, run

```bash
npm install
npm run build     # tsc -> dist/
npm test          # jest (ts-jest)
npm start         # node dist/index.js, listens on :80 (override with PORT)
```

Running requires `ANTHROPIC_API_KEY` in the environment. See [operations/deployment.md](operations/deployment.md) for Docker and Kubernetes.

## Repository map

| Path | Purpose |
|------|---------|
| `src/index.ts` | Process entrypoint; reads `PORT` (default `80`), starts Express, handles SIGINT/SIGTERM shutdown |
| `src/server.ts` | Builds the Express app and mounts A2A handlers (agent card + JSON-RPC) |
| `src/agent-card.ts` | Static `AgentCard` served at `/.well-known/agent-card.json` |
| `src/executor.ts` | `AgentExecutor` implementation: runs `query()`, maps SDK output to A2A events, and implements HITL |
| `src/__tests__/` | Jest tests for the executor and server |
| `Dockerfile` | Builds on kagent's `acp-sandbox-claude` base; installs, builds, tests, prunes |
| `docker-entrypoint.sh` | `exec node /app/dist/index.js` (overrides the base image's ACP shim) |
| `kagent-manifests/agent.yaml` | `SandboxAgent` CRD manifest |
| `kagent-manifests/secret.yaml` | Template Secret for `ANTHROPIC_API_KEY` |
| `docs/design.md` | Authoritative long-form design doc |
| `superpowers/` | Planning artifacts (plan + design spec) from the initial build; not runtime code |

## Sections

- [Architecture overview](architecture/overview.md) — runtime shape, A2A endpoints/events, key design decisions.
- [HITL permissions workflow](workflows/hitl-permissions.md) — the `canUseTool` ask-once-per-tool approval flow.
- [Deployment & operations](operations/deployment.md) — Docker, Kubernetes SandboxAgent, secrets, port/readiness.
- [Testing](testing.md) — test suite, SDK mocking, and the build-time test gate.

## Backlog

- `superpowers/` plans and specs (`superpowers/plans/`, `superpowers/specs/`) — deferred. Reason: planning/spec artifacts describing how the agent was built, not part of the running system; document only if they become an ongoing workflow.
