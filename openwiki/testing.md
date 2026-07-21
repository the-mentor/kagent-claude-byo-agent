---
type: Reference
title: Testing
description: The claude-byo-agent test suite — Jest with ts-jest, how the Claude Agent SDK's ESM-only module and the executor are mocked to run under Jest's CommonJS mode, what the executor and server tests cover, and how the Docker build runs tests as a gate.
resource: src/__tests__/executor.test.ts
tags: [testing, jest, ci]
---

# Testing

Tests use **Jest** with the **ts-jest** preset (`testEnvironment: node`, `testMatch: **/__tests__/**/*.test.ts`; config in `package.json`). Run them with:

```bash
npm test
```

The [Docker build](operations/deployment.md) runs `npm test` as part of the image build, so failing tests block the image.

## Why mocking is required

`@anthropic-ai/claude-agent-sdk` ships as ESM (`.mjs`) and cannot be imported directly under Jest's CommonJS mode. Both test files work around this:

- `executor.test.ts` mocks the **entire SDK module** (`query`, `AbortError`) and drives the executor with hand-written async generators.
- `server.test.ts` mocks the **executor module** so importing `../server` never pulls in the SDK.

## `src/__tests__/executor.test.ts`

Covers the [executor](architecture/overview.md) and the [HITL permissions workflow](workflows/hitl-permissions.md):

- assistant `text` block → `artifact-update`
- assistant `tool_use` block → `working` status (`Using tool: …`)
- `result` success → `completed`, `final: true`
- `result` error → `failed`, `final: true`, error text propagated
- `AbortError` → `canceled`, `final: true`
- `eventBus.finished()` called exactly once
- `cancelTask` aborts the running query
- HITL: `input-required` emitted (non-final) when `canUseTool` fires; `yes` resolves `allow`; `no` resolves `deny`

The HITL tests start `execute()` without awaiting, use `setImmediate` to let the generator reach `canUseTool`, then send the approval reply on the same `contextId`.

## `src/__tests__/server.test.ts`

Uses `supertest` against the Express app:

- `GET /.well-known/agent-card.json` → 200 with the agent name and `capabilities.streaming === true`
- `POST /` with an unknown JSON-RPC method → HTTP 200 with a JSON-RPC `error` (JSON-RPC errors are transported as HTTP 200)

## Watch out for

- When changing SDK message handling in `executor.ts`, keep the mock message shapes in `executor.test.ts` in sync — the tests assert on exact event kinds/states and `final` flags.
- The `Task`-event-first ordering (see [architecture](architecture/overview.md)) is load-bearing for `message/send`; changing publish order can silently drop updates and is not fully covered by unit tests.
