# kagent-claude-byo-agent

A standalone **BYO (Bring Your Own) agent** for [kagent](https://github.com/kagent-dev/kagent). It wraps the `@anthropic-ai/claude-agent-sdk` in a thin **A2A** (Agent-to-Agent) HTTP/JSON-RPC server so that Claude Code can be deployed and managed as a kagent `SandboxAgent` CRD.

- **What it is:** an A2A server (`express` + `@a2a-js/sdk`) whose executor runs Claude Code via `query()` in a persistent workspace at `/data/workspace`
- **Where it runs:** as a `SandboxAgent` in the `kagent` namespace; kagent provisions one isolated container per actor
- **How it talks:** A2A JSON-RPC over HTTP with SSE streaming on **port 80**

## Requirements

- Node.js 22+
- `ANTHROPIC_API_KEY` environment variable

## Build, test, run

```bash
npm install
npm run build     # tsc -> dist/
npm test          # jest (ts-jest); also runs as part of Docker build
npm start         # node dist/index.js, listens on :80 (override with PORT)
```

## Docker

```bash
docker build -t kagent-claude-byo-agent .
docker run -e ANTHROPIC_API_KEY=<key> -p 8080:80 kagent-claude-byo-agent
```

## Kubernetes

Apply the manifests in `kagent-manifests/` after filling in your API key in `kagent-manifests/secret.yaml`:

```bash
kubectl apply -f kagent-manifests/secret.yaml
kubectl apply -f kagent-manifests/agent.yaml
```

## Repository map

| Path | Purpose |
|------|---------|
| `src/index.ts` | Process entrypoint; reads `PORT` (default `80`), starts Express |
| `src/server.ts` | Express app with A2A handlers (agent card + JSON-RPC) |
| `src/agent-card.ts` | Static `AgentCard` served at `/.well-known/agent-card.json` |
| `src/executor.ts` | `AgentExecutor`: runs `query()`, maps SDK output to A2A events, implements HITL |
| `Dockerfile` | Builds on kagent's `acp-sandbox-claude` base; installs, builds, tests, prunes |
| `docker-entrypoint.sh` | `exec node /app/dist/index.js` |
| `kagent-manifests/` | `SandboxAgent` CRD manifest and API key Secret template |
| `docs/design.md` | Authoritative design document |

## Documentation

Extended documentation lives in [`openwiki/`](openwiki/quickstart.md), covering architecture, the HITL permissions workflow, deployment, and testing.
