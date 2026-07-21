# kagent claude-byo-agent Design

A standalone BYO (Bring Your Own) agent for kagent that runs Claude Code as an A2A service inside a `SandboxAgent` CRD. It does not modify the kagent repository.

---

## Overview

kagent's `SandboxAgent` CRD allows external agent containers to plug into the kagent ecosystem. Each container must speak A2A — an HTTP/JSON-RPC protocol with SSE streaming. This project wraps the `@anthropic-ai/claude-agent-sdk` in a thin A2A server so Claude Code can be deployed and managed as a kagent agent.

```
User / kagent UI
      │
      │  A2A (JSON-RPC over HTTP/SSE)
      ▼
┌─────────────────────────────────────┐
│  Express server  :80.               │
│  ├── GET  /.well-known/agent-card   │
│  └── POST /  (JSON-RPC)             │
│       ├── message/send              │
│       └── message/stream  ◄── SSE   │
├─────────────────────────────────────┤
│  ClaudeExecutor (AgentExecutor)     │
│  ├── execute()  — runs query()      │
│  └── cancelTask()                   │
├─────────────────────────────────────┤
│  @anthropic-ai/claude-agent-sdk     │
│  query()  →  async generator        │
│  Persistent workspace:              │
│  /home/agent/workspace              │
└─────────────────────────────────────┘
```

---

## Repository Structure

```
claude-byo-agent/
├── src/
│   ├── index.ts          — entrypoint, starts Express on PORT (default 8080)
│   ├── server.ts         — Express app, mounts A2A handlers
│   ├── agent-card.ts     — static AgentCard metadata
│   ├── executor.ts       — AgentExecutor impl: query() + HITL permission handler
│   └── __tests__/
│       ├── executor.test.ts
│       └── server.test.ts
├── k8s/
│   ├── agent.yaml        — SandboxAgent CRD manifest
│   └── secret.yaml       — Secret template for ANTHROPIC_API_KEY
├── Dockerfile
├── package.json
├── tsconfig.json
└── test-local.sh         — Docker smoke test script
```

---

## Key Design Decisions

### SandboxAgent, not Agent

kagent has two agent kinds:

- `Agent` — a plain BYO agent with a fixed URL, no lifecycle management
- `SandboxAgent` — kagent provisions and manages the container (Substrate actor model); each actor gets its own isolated container instance

`SandboxAgent` is used here because it provides per-user workspace isolation and lifecycle management without any extra work. The workspace at `/home/agent/workspace` is persistent for the lifetime of the actor.

### A2A, not ACP

The base image (`acp-sandbox-claude`) ships an ACP shim. This project **overrides the `ENTRYPOINT`** to bypass the ACP shim entirely and runs its own A2A server instead. ACP and A2A are incompatible protocols; A2A is kagent's native protocol for agent communication.

### Workspace

The workspace is a fixed path `/home/agent/workspace`, not a per-task temp directory. Since each `SandboxAgent` actor is its own container, isolation is provided at the container level. Claude Code reads and writes files there across tasks, giving it a persistent context for iterative development work.

### Module system

The project compiles to CommonJS (`"module": "CommonJS"`) with `"moduleResolution": "node"`. `@a2a-js/sdk` ships actual JS files at its subpath exports (`/server`, `/server/express`), so `node` resolution works. `bundler` resolution requires ESM mode and does not apply here.

---

## A2A Protocol

The server implements the A2A protocol via `@a2a-js/sdk@0.3.13`.

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/.well-known/agent-card.json` | Agent discovery metadata |
| `POST` | `/` | JSON-RPC 2.0 endpoint |

### JSON-RPC methods

| Method | Description |
|--------|-------------|
| `message/send` | Send a message, receive a single response |
| `message/stream` | Send a message, receive SSE stream of events |

### Event types

Events emitted during a task:

| Event | `final` | Description |
|-------|---------|-------------|
| `artifact-update` | false | Claude produced text output |
| `status-update` `working` | false | Claude is using a tool |
| `status-update` `input-required` | false | Claude needs human approval for a tool |
| `status-update` `completed` | true | Task finished successfully |
| `status-update` `failed` | true | Task finished with an error |
| `status-update` `canceled` | true | Task was aborted |

---

## Human-in-the-Loop (HITL)

Instead of bypassing permission checks, the executor uses the SDK's `canUseTool` callback to pause execution and ask the human before each tool use.

### Flow

```
1. User sends task via message/stream (contextId: "ctx-1")
   → execute() starts, query() runs with canUseTool callback

2. Claude decides to use a tool (e.g. Bash: rm -rf /important)
   → SDK calls canUseTool("Bash", {cmd: "..."}, opts)
   → canUseTool emits:
       status-update { state: "input-required", final: false,
                       message: "Claude wants to run Bash: rm -rf ...\nReply yes to allow or no to deny." }
   → canUseTool parks — returns a Promise that has not resolved yet
   → query() is suspended

3. kagent UI shows the pending request to the user

4. User replies with a new message/stream (same contextId: "ctx-1")
   → execute() is called again
   → executor detects pending permission for contextId "ctx-1"
   → parses user reply: "yes" → allow, anything else → deny
   → resolves the parked Promise
   → publishes status-update { state: "completed", final: true } for this turn
   → returns

5. Original query() resumes with the allow/deny result
   → if allowed: Claude executes the tool and continues
   → if denied: Claude receives a denial message and may respond or stop
   → eventually query() completes → status-update { state: "completed", final: true }
```

### Ask-once-per-tool semantics

When the user approves a tool, the allow response includes `updatedPermissions` adding a session-level rule for that tool type:

```typescript
updatedPermissions: [{
  type: 'addRules',
  rules: [{ toolName: `${pending.toolName}(*)` }],
  behavior: 'allow',
  destination: 'session',
}]
```

The subprocess applies this rule, so subsequent calls to the same tool type (e.g. a second `Bash`) do not trigger `canUseTool` again. The user is asked at most once per tool type per conversation context.

### The `updatedInput` requirement

The subprocess validates the allow response with a Zod schema that requires `updatedInput: Record<string, unknown>` when `behavior === 'allow'`. The SDK TypeScript type marks it optional, but the subprocess treats it as required. Always include the original tool input unchanged:

```typescript
{ behavior: 'allow', toolUseID: ..., updatedInput: originalInput, updatedPermissions: [...] }
```

### Allow/deny parsing

The user's reply is matched case-insensitively against:

- **Allow:** `yes`, `y`, `ok`, `sure`, `proceed`, `allow`, `approve`, `go ahead`
- **Deny:** anything else

### State management

```typescript
// Keyed by contextId — stores the resolve fn for a paused canUseTool prompt.
const pendingPermissions = new Map<string, {
  resolve: (r: PermissionResult) => void;
  toolUseID: string;
  toolName: string;
  toolInput: Record<string, unknown>;
}>();
```

The `execute()` method checks this map first on every call. If the `contextId` has an entry, the incoming message is treated as a human permission answer rather than a new task.

Cleanup: the `finally` block in `execute()` always removes the pending entry, preventing stale state if `query()` errors or is aborted before the human responds.

---

## Deployment

### Docker

```dockerfile
FROM ghcr.io/kagent-dev/kagent/acp-sandbox-claude:0.10.0-beta7

USER root
WORKDIR /app

COPY package.json ./
COPY tsconfig.json ./
COPY src/ src/

RUN npm install && npm run build && npm test && npm prune --production
RUN mkdir -p /home/agent/workspace && chown agent:agent /home/agent/workspace

USER agent
EXPOSE 8080
ENTRYPOINT ["node", "dist/index.js"]
```

The build runs `npm test` inside Docker — tests must pass for the image to build.

### Kubernetes

Deploy as a `SandboxAgent` CRD in the `kagent` namespace:

```yaml
apiVersion: kagent.dev/v1alpha2
kind: SandboxAgent
metadata:
  name: claude-coding-agent
  namespace: kagent
spec:
  description: "Claude Code agent — persistent workspace per Substrate actor"
  type: BYO
  byo:
    deployment:
      image: <registry>/claude-byo-agent:latest
      cmd: ["node", "dist/index.js"]   # required — Substrate does not fall back to ENTRYPOINT
      env:
        - name: ANTHROPIC_API_KEY
          valueFrom:
            secretKeyRef:
              name: anthropic-credentials
              key: ANTHROPIC_API_KEY
```

Create the secret first:

```bash
kubectl create secret generic anthropic-credentials \
  --from-literal=ANTHROPIC_API_KEY=sk-ant-... \
  -n kagent
```

### Local Docker test

This starts the container, hits the agent card endpoint, then sends a streaming task.

To run the container manually:

```bash
docker run --rm -p 8080:8080 \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  --name claude-byo-test \
  claude-byo-agent:dev
```

---

## Dependencies

| Package | Version | Role |
|---------|---------|------|
| `@a2a-js/sdk` | 0.3.13 | A2A server framework (Express adapter) |
| `@anthropic-ai/claude-agent-sdk` | 0.3.205 | Claude Code agent runtime (`query()`) |
| `express` | ^4.21.2 | HTTP server |
| `uuid` | ^11.0.5 | Generates message/artifact IDs |

### SDK notes

`@anthropic-ai/claude-agent-sdk` ships as ESM (`.mjs`). Jest runs in CJS mode and cannot import it directly. The executor tests mock the entire SDK module to avoid this. The server tests mock the executor for the same reason.

---

## Testing

```bash
# Run inside Docker (executed as part of build)
npm run build && npm test

# Or locally if you have node_modules
npm test
```

Tests cover:

- `executor.test.ts` — 10 tests: artifact events, tool status, success/failure/abort/cancel, HITL allow/deny flows
- `server.test.ts` — 2 tests: agent card endpoint, unknown JSON-RPC method error

---

## Source Files

### `src/agent-card.ts`

Static `AgentCard` returned at `/.well-known/agent-card.json`. Declares the agent's name, capabilities (`streaming: true`), and a single `coding` skill.

### `src/server.ts`

Constructs the Express app with two routes:

- `agentCardHandler` mounted with `app.use` (not `app.get`) — required because `agentCardHandler` returns an Express Router that handles `GET /` internally; mounting with `app.get` prevents path stripping and the internal handler never matches
- `jsonRpcHandler` handles `message/send` and `message/stream`

### `src/executor.ts`

Implements `AgentExecutor` with two methods:

**`execute(requestContext, eventBus)`**

1. Checks `pendingPermissions` for the `contextId` — if found, this is a HITL response; resolve it and return
2. Extracts the prompt from the user message
3. Defines `canUseTool` callback that emits `input-required` and parks on a `Promise`
4. Runs `query({ prompt, options: { cwd, abortController, canUseTool } })`
5. Translates SDK messages to A2A events:
   - `assistant` → `artifact-update` (text) or `working` status (tool_use)
   - `result` → `completed` or `failed` status
6. Catches `AbortError` → `canceled` status; other errors → `failed` status

**`cancelTask(taskId, eventBus)`**

Aborts the `AbortController` registered for the task, which signals the `query()` generator to stop and also resolves any pending `canUseTool` with deny.

### `src/index.ts`

Reads `PORT` from the environment (default `8080`) and starts the Express server on `0.0.0.0`.
