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
│  /data/workspace                    │
└─────────────────────────────────────┘
```

---

## Repository Structure

```
claude-byo-agent/
├── src/
│   ├── index.ts              — entrypoint, starts Express on PORT (default 8080)
│   ├── server.ts             — Express app, mounts A2A handlers, selects task store
│   ├── agent-card.ts         — static AgentCard metadata
│   ├── executor.ts           — AgentExecutor impl: query() + HITL permission handler
│   ├── kagent-task-store.ts  — TaskStore that persists tasks to the kagent controller
│   └── __tests__/
│       ├── executor.test.ts
│       ├── kagent-task-store.test.ts
│       └── server.test.ts
├── kagent-manifests/
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

`SandboxAgent` is used here because it provides per-user workspace isolation and lifecycle management without any extra work. The workspace at `/data/workspace` is persistent for the lifetime of the actor.

### A2A, not ACP

The base image (`acp-sandbox-claude`) ships an ACP shim. This project **overrides the `ENTRYPOINT`** to bypass the ACP shim entirely and runs its own A2A server instead. ACP and A2A are incompatible protocols; A2A is kagent's native protocol for agent communication.

### Workspace

The workspace is a fixed path `/data/workspace`, not a per-task temp directory. Since each `SandboxAgent` actor is its own container, isolation is provided at the container level. Claude Code reads and writes files there across tasks, giving it a persistent context for iterative development work. Placing the workspace under `/data` (the Substrate durable dir) ensures files survive DATA-scope auto-suspend cycles.

### Session persistence

Claude Code's session store (`~/.claude/`) and config (`~/.claude.json`) must live under the Substrate durable dir (`/data`) to survive cold-boot resume.

The Dockerfile sets `ENV HOME=/data/home/agent`, but Substrate overrides `HOME` at actor launch time based on the container user's passwd entry (the actor runs as root, so Substrate sets `HOME=/root`). To work around this, `docker-entrypoint.sh` explicitly re-sets `HOME=/data/home/agent` and runs `mkdir -p "$HOME"` before `exec node` — ensuring the node process and all subprocesses (including the `claude` subprocess spawned by `query()`) inherit the correct HOME.

Session IDs are also persisted to `/data/.claude-sessions.json` so that the executor can resume the correct Claude Code session across turns. Together, these two mechanisms give the same conversation continuity as a long-running regular agent.

### Task persistence (kagent chat history)

The kagent UI renders chat history from the controller's **tasks** table, which is populated only when the agent write-through persists its A2A tasks to `POST {KAGENT_URL}/api/tasks`. With the SDK's default `InMemoryTaskStore`, tasks live only in the agent pod's memory — every session renders empty once the live SSE stream closes.

`src/kagent-task-store.ts` implements the `@a2a-js/sdk/server` `TaskStore` interface as a TypeScript twin of kagent's Go `KAgentTaskStore` (`go/adk/pkg/taskstore/store.go`):

- `save(task)` → `POST {KAGENT_URL}/api/tasks` — the SDK's `ResultManager` calls this after every published event, upserting the task (keyed by task ID, associated to the session via `contextId`).
- `load(taskId)` → `GET {KAGENT_URL}/api/tasks/{id}` — used by the framework to resume existing tasks (e.g. the HITL approval turn).
- Auth mirrors kagent's Go `KAgentTokenService`: `Authorization: Bearer` with the projected service-account token from `/var/run/secrets/tokens/kagent-token` (re-read every 60s) plus an `X-Agent-Name` header (`KAGENT_NAME`).
- Before saving, messages/artifacts whose metadata carries a partial flag (`kagent_adk_partial`, or legacy `adk_partial`/`kagent_partial`) are stripped from history, so persisted history contains only final messages.
- Persistence failures are logged and swallowed — they must not kill the live stream.

`server.ts` selects the store at startup: `KAgentTaskStore` when `KAGENT_URL` is set (kagent deployments inject it), `InMemoryTaskStore` otherwise (local `docker run`).

To cooperate with partial-stripping, the executor stamps streaming `working` messages (text chunks and `Using tool: …` notices) with `kagent_adk_partial: true`. The `completed` event carries the full accumulated response text — it is the single non-partial agent message that survives in persisted history. The kagent UI shows partial working messages in its transient streaming box and renders the final message as the one persistent chat bubble.

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
| `task` | — | Initializes the task (only for new tasks, never on resume) |
| `status-update` `working` | false | Streaming text chunk or tool notice; message metadata carries `kagent_adk_partial: true` so it is excluded from persisted history |
| `status-update` `input-required` | true | Claude needs human approval for a tool; ends the current stream — the client resumes the task with the same `taskId` |
| `status-update` `completed` | true | Task finished; message carries the full response text (the single persisted agent message) |
| `status-update` `failed` | true | Task finished with an error |
| `status-update` `canceled` | true | Task was aborted |

`input-required` must be `final: true`: the SDK keys execution event buses by `taskId` and only detaches a stream's queue on a final event. Since the approval turn resumes the **same** `taskId`, a non-final `input-required` leaves the first stream attached to the shared bus — every post-approval event would then be delivered to both streams and the UI would render the response twice.

---

## Human-in-the-Loop (HITL)

Instead of bypassing permission checks, the executor uses the SDK's `canUseTool` callback to pause execution and ask the human before each tool use.

### Flow

```
1. User sends task via message/stream (contextId: "ctx-1", taskId: "task-A")
   → execute() starts, query() runs with canUseTool callback

2. Claude decides to use a tool (e.g. Bash: rm -rf /important)
   → SDK calls canUseTool("Bash", {cmd: "..."}, opts)
   → canUseTool emits:
       status-update { state: "input-required", final: true,
                       message: adk_request_confirmation DataPart }
   → the first SSE stream ends (final event); the task stays resumable
     (input-required is not a terminal task state)
   → canUseTool parks — returns a Promise that has not resolved yet
   → query() is suspended

3. kagent UI shows the approval card to the user

4. User decides; the UI sends a new message/stream with the SAME taskId "task-A"
   (a DataPart { decision_type: "approve" | "reject" }, or plain text)
   → the request handler loads task-A from the task store, appends the
     decision message to its history, and saves it
   → execute() is called again; executor detects the pending permission
     for contextId "ctx-1" and resolves the parked Promise (allow/deny)
   → the approval execute() publishes NO events of its own — it deposits its
     eventBus in pendingResponseBuses and awaits until the original execute()
     finishes (publishing a bare Task event here would overwrite the task's
     persisted history)

5. Original query() resumes with the allow/deny result
   → the original execute() picks up the approval turn's eventBus from
     pendingResponseBuses and publishes all subsequent events there
     (the first stream is closed; its bus has no listeners anymore)
   → if allowed: Claude executes the tool and continues
   → if denied: Claude receives a denial message and may respond or stop
   → eventually query() completes
     → status-update { state: "completed", final: true, message: <response> }
     → the original execute()'s finally block calls finished() on the approval
       bus and resolves the approval execute()'s await
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

A second map hands the approval turn's event bus to the original `execute()`:

```typescript
// Keyed by contextId — the approval handler deposits its eventBus here so the
// original execute() can route the post-approval response to the waiting client
// stream. The approval handler awaits resolve(), which the original execute()
// calls from its finally block after finishing the bus.
const pendingResponseBuses = new Map<string, {
  bus: ExecutionEventBus;
  taskId: string;
  resolve: () => void;
}>();
```

Cleanup: the `finally` block in `execute()` always removes the pending entries (including an orphaned response bus if `query()` threw before consuming it), preventing stale state if `query()` errors or is aborted before the human responds.

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
RUN mkdir -p /data && chown agent:agent /data

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

- `executor.test.ts` — streaming/partial working events, tool status, success/failure/abort/cancel, HITL allow/deny flows (text and native DataPart decisions), and post-approval bus routing
- `kagent-task-store.test.ts` — task save/load against the controller API: auth headers, partial-message stripping, 404 handling, and resilience to an unreachable controller
- `server.test.ts` — agent card endpoint, unknown JSON-RPC method error

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

1. Checks `pendingPermissions` for the `contextId` — if found, this is a HITL decision: resolve the parked permission, deposit this turn's eventBus in `pendingResponseBuses`, and await until the original `execute()` finishes
2. Publishes a Task event (only when the message does not resume an existing task), extracts the prompt from the user message
3. Defines `canUseTool` callback that emits `input-required` (`final: true`) and parks on a `Promise`
4. Runs `query({ prompt, options: { cwd, abortController, canUseTool, allowedTools, resume } })`
5. Translates SDK messages to A2A events:
   - `assistant` text / tool_use → `working` status with `kagent_adk_partial: true` message metadata
   - `result` success → `completed` status carrying the full accumulated response text
   - `result` error → `failed` status
   - After HITL approval, switches the active event bus to the approval turn's bus
6. Catches `AbortError` → `canceled` status; other errors → `failed` status

**`cancelTask(taskId, eventBus)`**

Aborts the `AbortController` registered for the task, which signals the `query()` generator to stop and also resolves any pending `canUseTool` with deny.

### `src/kagent-task-store.ts`

`KAgentTaskStore` — write-through `TaskStore` backed by the kagent controller REST API. See [Task persistence](#task-persistence-kagent-chat-history) for the full behavior. Used automatically when `KAGENT_URL` is set; otherwise `server.ts` falls back to `InMemoryTaskStore`.

### `src/index.ts`

Reads `PORT` from the environment (default `8080`) and starts the Express server on `0.0.0.0`.
