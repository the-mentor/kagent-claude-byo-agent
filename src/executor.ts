import { query, AbortError } from '@anthropic-ai/claude-agent-sdk';
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { AgentExecutor, RequestContext, ExecutionEventBus } from '@a2a-js/sdk/server';
import type { Task, TaskStatusUpdateEvent, TextPart, DataPart, Message } from '@a2a-js/sdk';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import { logger } from './logger';

const WORKSPACE = '/data/workspace';

try {
  fs.mkdirSync(WORKSPACE, { recursive: true });
} catch { /* /data not mounted or not writable — workspace dir created lazily if needed */ }

logger.info({ home: process.env.HOME, cwd: process.cwd() }, 'executor init');
try {
  const homeContents = fs.readdirSync(process.env.HOME ?? '/');
  logger.debug({ homeContents }, 'home dir contents');
} catch (err) {
  logger.debug({ err }, 'home dir unreadable');
}

const abortControllers = new Map<string, AbortController>();

const SESSIONS_FILE = '/data/.claude-sessions.json';

function getSession(contextId: string): string | undefined {
  try {
    const raw = fs.readFileSync(SESSIONS_FILE, 'utf-8');
    const map = JSON.parse(raw) as Record<string, string>;
    return map[contextId];
  } catch {
    return undefined;
  }
}

function saveSession(contextId: string, sessionId: string): void {
  try {
    let map: Record<string, string> = {};
    try {
      map = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8')) as Record<string, string>;
    } catch { /* file missing or corrupt — start fresh */ }
    map[contextId] = sessionId;
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(map), 'utf-8');
  } catch (err) {
    logger.warn({ contextId, err }, 'failed to persist session');
  }
}

// Durable fallback for canUseTool prompts: on a SandboxAgent, the gVisor container
// that blocked in canUseTool is destroyed and restored clean before the human's
// approve/deny click arrives as a new request — the in-memory pendingPermissions
// Promise resolve() from that container is gone. We persist just enough
// (toolName/toolInput) to recognize the decision and replay the tool call in a
// fresh resumed session instead of trying to resolve a callback that no longer exists.
const PENDING_PERMISSION_FILE = '/data/.pending-permission.json';

function getPendingPermission(contextId: string): { toolName: string; toolInput: Record<string, unknown> } | undefined {
  try {
    const map = JSON.parse(fs.readFileSync(PENDING_PERMISSION_FILE, 'utf-8')) as Record<string, { toolName: string; toolInput: Record<string, unknown> }>;
    return map[contextId];
  } catch {
    return undefined;
  }
}

function savePendingPermission(contextId: string, toolName: string, toolInput: Record<string, unknown>): void {
  try {
    let map: Record<string, { toolName: string; toolInput: Record<string, unknown> }> = {};
    try {
      map = JSON.parse(fs.readFileSync(PENDING_PERMISSION_FILE, 'utf-8'));
    } catch { /* file missing or corrupt — start fresh */ }
    map[contextId] = { toolName, toolInput };
    fs.writeFileSync(PENDING_PERMISSION_FILE, JSON.stringify(map), 'utf-8');
  } catch (err) {
    logger.warn({ contextId, err }, 'failed to persist pending permission');
  }
}

function clearPendingPermission(contextId: string): void {
  try {
    const map = JSON.parse(fs.readFileSync(PENDING_PERMISSION_FILE, 'utf-8')) as Record<string, unknown>;
    delete map[contextId];
    fs.writeFileSync(PENDING_PERMISSION_FILE, JSON.stringify(map), 'utf-8');
  } catch { /* nothing persisted to clear */ }
}

// Keyed by contextId — stores the resolve fn for a paused canUseTool prompt.
const pendingPermissions = new Map<string, {
  resolve: (r: PermissionResult) => void;
  toolUseID: string;
  toolName: string;
  toolInput: Record<string, unknown>;
}>();

// Keyed by contextId — the approval handler deposits its eventBus here so the
// original execute() can pick it up and route the post-approval response there.
// The approval handler AWAITS resolve() which the original execute() calls from its
// finally block — this keeps bus2's HTTP SSE stream open until the original execute()
// finishes publishing and calls bus2.finished(), then resolves so the handler can return.
const pendingResponseBuses = new Map<string, { bus: ExecutionEventBus; taskId: string; resolve: () => void }>();

function extractPrompt(message: Message): string {
  return message.parts
    .filter((p): p is TextPart => p.kind === 'text')
    .map((p) => p.text)
    .join('\n');
}

function parseDecision(message: Message): 'allow' | 'deny' {
  // Native kagent HITL: DataPart with decision_type
  for (const part of message.parts) {
    if (part.kind === 'data') {
      const data = (part as DataPart).data as Record<string, unknown>;
      if (data?.decision_type === 'approve') return 'allow';
      if (data?.decision_type === 'reject') return 'deny';
    }
  }
  // Fallback: plain text yes/no
  const text = message.parts
    .filter((p): p is TextPart => p.kind === 'text')
    .map((p) => p.text)
    .join('\n');
  return /^(yes|y|ok|sure|proceed|allow|approve|go\s+ahead)/i.test(text.trim()) ? 'allow' : 'deny';
}

function makeInputRequiredEvent(
  taskId: string,
  contextId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  toolUseID: string,
): TaskStatusUpdateEvent {
  const confirmationPart: DataPart = {
    kind: 'data',
    metadata: { adk_type: 'function_call', adk_is_long_running: true },
    data: {
      name: 'adk_request_confirmation',
      id: uuidv4(),
      args: {
        originalFunctionCall: {
          name: toolName,
          args: toolInput,
          id: toolUseID,
        },
      },
    },
  };
  const msg: Message = {
    kind: 'message',
    messageId: uuidv4(),
    role: 'agent',
    parts: [confirmationPart],
  };
  return {
    kind: 'status-update',
    taskId,
    contextId,
    // final:true ends the current SSE stream (matching the ADK reference executor).
    // input-required is a turn-ending interrupt, not a terminal task state — the
    // client resumes the task by sending the decision with the same taskId. Leaving
    // this false keeps the first stream's queue attached to the shared per-taskId
    // event bus, so post-approval events get delivered to BOTH streams and the UI
    // renders the response twice.
    final: true,
    status: { state: 'input-required', message: msg },
  };
}

function makeStatusEvent(
  taskId: string,
  contextId: string,
  state: 'working' | 'completed' | 'failed' | 'canceled' | 'input-required',
  final: boolean,
  messageText?: string,
  // Marks the message as a partial streaming chunk (kagent_adk_partial), so the
  // KAgentTaskStore strips it from persisted history — only the final completed
  // message survives, preventing duplicate bubbles when history is re-rendered.
  partial = false,
): TaskStatusUpdateEvent {
  const msg: Message | undefined = messageText
    ? {
        kind: 'message',
        messageId: uuidv4(),
        role: 'agent',
        parts: [{ kind: 'text', text: messageText } as TextPart],
        ...(partial ? { metadata: { kagent_adk_partial: true } } : {}),
      }
    : undefined;
  return {
    kind: 'status-update',
    taskId,
    contextId,
    final,
    status: { state, ...(msg ? { message: msg } : {}) },
  };
}


function makeTaskEvent(taskId: string, contextId: string): Task {
  return {
    kind: 'task',
    id: taskId,
    contextId,
    status: { state: 'working', timestamp: new Date().toISOString() },
  };
}

// Replays a canUseTool decision that arrived after the original blocked container
// was destroyed (SandboxAgent checkpoint/restore). Resumes the Claude session and
// nudges it to retry the pending action; the retry's first matching tool call is
// auto-decided per `autoDecision` instead of prompting the human again. Any further
// tool call in this turn falls back to normal HITL (persist + emit input-required).
async function runResumedApprovalTurn(
  taskId: string,
  contextId: string,
  eventBus: ExecutionEventBus,
  prompt: string,
  autoDecision: { decision: 'allow' | 'deny'; toolName: string },
): Promise<void> {
  const abortController = new AbortController();
  abortControllers.set(taskId, abortController);
  const existingSession = getSession(contextId);
  let responseText = '';
  let autoDecisionUsed = false;

  const canUseTool: CanUseTool = (toolName, input, opts) => {
    const toolInput = (input ?? {}) as Record<string, unknown>;
    if (!autoDecisionUsed && toolName === autoDecision.toolName) {
      autoDecisionUsed = true;
      if (autoDecision.decision === 'allow') {
        return Promise.resolve({
          behavior: 'allow',
          toolUseID: opts.toolUseID,
          updatedInput: toolInput,
        } as PermissionResult);
      }
      return Promise.resolve({
        behavior: 'deny',
        message: 'User denied the tool use.',
        toolUseID: opts.toolUseID,
      } as PermissionResult);
    }
    savePendingPermission(contextId, toolName, toolInput);
    eventBus.publish(makeInputRequiredEvent(taskId, contextId, toolName, toolInput, opts.toolUseID));
    return new Promise<PermissionResult>((resolve) => {
      pendingPermissions.set(contextId, { resolve, toolUseID: opts.toolUseID, toolName, toolInput });
      abortController.signal.addEventListener(
        'abort',
        () => {
          pendingPermissions.delete(contextId);
          clearPendingPermission(contextId);
          resolve({ behavior: 'deny', message: 'Task aborted', toolUseID: opts.toolUseID });
        },
        { once: true },
      );
    });
  };

  try {
    for await (const msg of query({
      prompt,
      options: {
        cwd: WORKSPACE,
        abortController,
        canUseTool,
        allowedTools: ['Read', 'Glob', 'Grep', 'LS'],
        ...(existingSession ? { resume: existingSession } : {}),
      },
    })) {
      logger.debug({ type: msg.type, subtype: 'subtype' in msg ? msg.subtype : undefined }, 'sdk msg (resumed approval)');
      if (msg.type === 'system' && msg.subtype === 'init') {
        saveSession(contextId, msg.session_id);
      } else if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type === 'text') {
            responseText += block.text;
            eventBus.publish(makeStatusEvent(taskId, contextId, 'working', false, block.text, true));
          } else if (block.type === 'tool_use') {
            eventBus.publish(makeStatusEvent(taskId, contextId, 'working', false, `Using tool: ${block.name}`, true));
          }
        }
      } else if (msg.type === 'result') {
        if (msg.subtype === 'success' && !msg.is_error) {
          eventBus.publish(makeStatusEvent(taskId, contextId, 'completed', true, responseText || undefined));
        } else {
          const errText = 'errors' in msg ? (msg.errors as string[]).join('; ') : msg.subtype;
          eventBus.publish(makeStatusEvent(taskId, contextId, 'failed', true, errText));
        }
      }
    }
  } catch (err: unknown) {
    if (err instanceof AbortError) {
      eventBus.publish(makeStatusEvent(taskId, contextId, 'canceled', true));
    } else {
      eventBus.publish(makeStatusEvent(taskId, contextId, 'failed', true, String(err)));
    }
  } finally {
    pendingPermissions.delete(contextId);
    abortControllers.delete(taskId);
    eventBus.finished();
  }
}

export const claudeExecutor: AgentExecutor = {
  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId, userMessage } = requestContext;

    // If this contextId has a pending permission prompt, the incoming message
    // is the human's allow/deny answer rather than a new task.
    const pending = pendingPermissions.get(contextId);
    if (pending) {
      pendingPermissions.delete(contextId);
      clearPendingPermission(contextId);
      if (parseDecision(userMessage) === 'allow') {
        pending.resolve({
          behavior: 'allow',
          toolUseID: pending.toolUseID,
          // updatedInput is required by the subprocess's Zod schema when behavior is 'allow'.
          // Pass the original tool input unchanged — we're approving as-is.
          updatedInput: pending.toolInput,
          // Add a session-level rule so the subprocess auto-approves this tool type
          // for the rest of the conversation (ask-once-per-tool-type semantics).
          updatedPermissions: [{
            type: 'addRules',
            rules: [{ toolName: `${pending.toolName}(*)` }],
            behavior: 'allow',
            destination: 'session',
          }],
        });
      } else {
        pending.resolve({
          behavior: 'deny',
          message: 'User denied the tool use.',
          toolUseID: pending.toolUseID,
        });
      }
      // Hand this stream's eventBus to the original execute() and AWAIT a signal.
      // Keeping this execute() alive holds bus2's HTTP SSE stream open so the
      // original execute() can still publish to it. The original execute() calls
      // bus2.finished() then resolve() from its finally block; we return after that.
      //
      // No Task event here: the client resumes with the original taskId, so the
      // request handler already loaded the persisted task, appended the approval
      // message to its history, and saved it. Publishing a bare Task would
      // overwrite that history in the store.
      await new Promise<void>((resolve) => {
        pendingResponseBuses.set(contextId, { bus: eventBus, taskId, resolve });
      });
      return;
    }

    // No live in-memory Promise for this contextId. On a SandboxAgent the container
    // that blocked in canUseTool was destroyed and restored clean before this
    // approve/deny click arrived as a brand new request — check the durable record
    // written just before that happened. There's no original execute() to hand this
    // eventBus to, so replay the tool call ourselves in a fresh resumed session and
    // prime canUseTool to auto-decide the retry instead of prompting again.
    const persistedPending = getPendingPermission(contextId);
    if (persistedPending) {
      clearPendingPermission(contextId);
      const decision = parseDecision(userMessage);
      if (!requestContext.task) {
        eventBus.publish(makeTaskEvent(taskId, contextId));
      }
      await runResumedApprovalTurn(
        taskId,
        contextId,
        eventBus,
        decision === 'allow' ? 'Yes, please proceed with that.' : 'No, please do not do that.',
        { decision, toolName: persistedPending.toolName },
      );
      return;
    }

    // Publish a Task event first so ResultManager.currentTask is initialized before
    // any status-update or artifact-update events arrive. Without this, message/send
    // drops all updates ("unknown task") because the task is never in the store.
    // Skip when the message resumes an existing task — the store already holds it
    // (with history), and a bare Task event would overwrite that history.
    if (!requestContext.task) {
      eventBus.publish(makeTaskEvent(taskId, contextId));
    }

    logger.debug({ taskId, contextId }, 'task start');
    const prompt = extractPrompt(userMessage);
    const abortController = new AbortController();
    abortControllers.set(taskId, abortController);
    const existingSession = getSession(contextId);
    logger.debug({ contextId, existingSession: existingSession ?? null }, 'session lookup');
    let responseText = '';
    // After HITL approval the approval handler deposits its eventBus in pendingResponseBuses.
    // We switch to it so the post-approval response reaches the waiting client stream.
    let activeEventBus = eventBus;
    let activeTaskId = taskId;
    // Saved resolve() from the approval handler's pending promise — called in finally
    // to unblock the approval execute() after activeEventBus.finished() closes bus2.
    let approvalResolve: (() => void) | undefined;

    // canUseTool pauses query() and emits input-required so the human can decide.
    const canUseTool: CanUseTool = (toolName, input, opts) => {
      const toolInput = (input ?? {}) as Record<string, unknown>;
      savePendingPermission(contextId, toolName, toolInput);
      eventBus.publish(
        makeInputRequiredEvent(taskId, contextId, toolName, toolInput, opts.toolUseID),
      );
      return new Promise<PermissionResult>((resolve) => {
        pendingPermissions.set(contextId, {
          resolve,
          toolUseID: opts.toolUseID,
          toolName,
          toolInput,
        });
        // Use our own abortController (not opts.signal which the SDK may pre-abort).
        abortController.signal.addEventListener(
          'abort',
          () => {
            pendingPermissions.delete(contextId);
            clearPendingPermission(contextId);
            resolve({ behavior: 'deny', message: 'Task aborted', toolUseID: opts.toolUseID });
          },
          { once: true },
        );
      });
    };

    try {
      for await (const msg of query({
        prompt,
        options: {
          cwd: WORKSPACE,
          abortController,
          canUseTool,
          allowedTools: [
            'Read', 'Glob', 'Grep', 'LS',
            // Write, Edit, Bash intentionally omitted — subprocess sends can_use_tool
            // for these, triggering canUseTool HITL callback.
          ],
          ...(existingSession ? { resume: existingSession } : {}),
        },
      })) {
        logger.debug({ type: msg.type, subtype: 'subtype' in msg ? msg.subtype : undefined }, 'sdk msg');
        // After approval, switch to the response bus deposited by the approval handler.
        const pendingResponse = pendingResponseBuses.get(contextId);
        if (pendingResponse) {
          pendingResponseBuses.delete(contextId);
          activeEventBus = pendingResponse.bus;
          activeTaskId = pendingResponse.taskId;
          approvalResolve = pendingResponse.resolve;
          logger.debug({ contextId, activeTaskId }, 'switched to approval response bus');
        }
        if (msg.type === 'system' && msg.subtype === 'init') {
          logger.debug({ contextId, sessionId: msg.session_id }, 'session init');
          saveSession(contextId, msg.session_id);
        } else if (msg.type === 'assistant') {
          for (const block of msg.message.content) {
            if (block.type === 'text') {
              responseText += block.text;
              activeEventBus.publish(
                makeStatusEvent(activeTaskId, contextId, 'working', false, block.text, true),
              );
            } else if (block.type === 'tool_use') {
              activeEventBus.publish(
                makeStatusEvent(activeTaskId, contextId, 'working', false, `Using tool: ${block.name}`, true),
              );
            }
          }
        } else if (msg.type === 'result') {
          if (msg.subtype === 'success' && !msg.is_error) {
            activeEventBus.publish(
              makeStatusEvent(activeTaskId, contextId, 'completed', true, responseText || undefined),
            );
          } else {
            const errText = 'errors' in msg ? (msg.errors as string[]).join('; ') : msg.subtype;
            activeEventBus.publish(makeStatusEvent(activeTaskId, contextId, 'failed', true, errText));
          }
        }
      }
    } catch (err: unknown) {
      if (err instanceof AbortError) {
        activeEventBus.publish(makeStatusEvent(activeTaskId, contextId, 'canceled', true));
      } else {
        activeEventBus.publish(makeStatusEvent(activeTaskId, contextId, 'failed', true, String(err)));
      }
    } finally {
      pendingPermissions.delete(contextId);
      const orphanedPending = pendingResponseBuses.get(contextId);
      pendingResponseBuses.delete(contextId);
      abortControllers.delete(taskId);
      activeEventBus.finished();
      if (orphanedPending) {
        // Approval bus was deposited but never consumed by the loop (e.g. query()
        // threw before the next iteration). Close it then unblock the approval execute().
        orphanedPending.bus.finished();
        orphanedPending.resolve();
      } else {
        // Normal HITL path: bus was consumed and switched; unblock the approval execute()
        // now that activeEventBus (bus2) has been finished() above.
        approvalResolve?.();
      }
    }
  },

  async cancelTask(taskId: string, _eventBus: ExecutionEventBus): Promise<void> {
    abortControllers.get(taskId)?.abort();
  },
};
