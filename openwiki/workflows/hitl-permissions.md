---
type: Playbook
title: HITL Permissions Workflow
description: How claude-byo-agent gates tool use with human-in-the-loop approval using the Claude Agent SDK canUseTool callback, including the contextId-keyed pendingPermissions map, ask-once-per-tool semantics, the updatedInput requirement, allow/deny parsing, and abort handling.
resource: src/executor.ts
tags: [workflow, hitl, permissions, executor, security]
---

# HITL Permissions Workflow

Rather than auto-approving tool use, the [`ClaudeExecutor`](../architecture/overview.md) pauses `query()` and asks the human before Claude runs a sensitive tool. Only read-only tools (`Read`, `Glob`, `Grep`, `LS`) are pre-allowed; `Write`, `Edit`, and `Bash` trigger the approval flow. This behavior was introduced in commit `3fce3e1` and is exercised by the [test suite](../testing.md).

## Flow

1. Client sends a task via `message/stream` with a `contextId`. `execute()` publishes a `Task` event, then runs `query()` with a `canUseTool` callback.
2. Claude decides to use a gated tool. The SDK invokes `canUseTool(toolName, input, opts)`.
3. `canUseTool` publishes `status-update { state: 'input-required', final: false }` with a "Reply **yes** to allow or **no** to deny" prompt, then **parks** — it returns a `Promise` that has not resolved and stores the resolver in `pendingPermissions` keyed by `contextId`. `query()` is suspended.
4. The user replies with a new message on the **same `contextId`**. `execute()` is re-entered, sees a pending entry for that `contextId`, and treats the message as the approval answer (not a new task).
5. The executor resolves the parked promise with `allow` or `deny`, publishes a `Task` event and a `completed` status for that turn, and returns.
6. The original `query()` resumes: on allow, Claude runs the tool and continues; on deny, it receives a denial message. Eventually the query completes and emits a final `completed`/`failed` status.

## State: `pendingPermissions`

```typescript
const pendingPermissions = new Map<string, {
  resolve: (r: PermissionResult) => void;
  toolUseID: string;
  toolName: string;
  toolInput: Record<string, unknown>;
}>();
```

Keyed by `contextId`. `execute()` checks this map first on every call. The `finally` block always deletes the entry, so a failed or aborted `query()` cannot leave stale pending state.

## Allow / deny parsing

`parseDecision()` matches the reply case-insensitively at the start of the string:

- **Allow:** `yes`, `y`, `ok`, `sure`, `proceed`, `allow`, `approve`, `go ahead`
- **Deny:** anything else

## Ask-once-per-tool semantics

An `allow` response includes `updatedPermissions` that adds a **session-level** rule for the tool type:

```typescript
updatedPermissions: [{
  type: 'addRules',
  rules: [{ toolName: `${pending.toolName}(*)` }],
  behavior: 'allow',
  destination: 'session',
}]
```

After approving, e.g., `Bash` once, subsequent `Bash` calls in the same conversation do not re-prompt. The user is asked at most once per tool type per context.

## The `updatedInput` requirement

When `behavior === 'allow'`, the SDK subprocess validates the response against a Zod schema that **requires** `updatedInput`, even though the TypeScript type marks it optional. The executor always passes the original tool input unchanged (`updatedInput: pending.toolInput`).

## Abort / cancel

`cancelTask(taskId)` aborts the task's `AbortController`. The `canUseTool` promise also listens for that abort signal and resolves as `deny` ("Task aborted"), so a cancel while awaiting human input cleanly unblocks the suspended `query()`. `AbortError` from `query()` maps to a `canceled` status.
