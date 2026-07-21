import { query, AbortError } from '@anthropic-ai/claude-agent-sdk';
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { AgentExecutor, RequestContext, ExecutionEventBus } from '@a2a-js/sdk/server';
import type { Task, TaskStatusUpdateEvent, TextPart, DataPart, Message } from '@a2a-js/sdk';
import { v4 as uuidv4 } from 'uuid';

const WORKSPACE = '/home/agent/workspace';

const abortControllers = new Map<string, AbortController>();

// Keyed by contextId — stores the resolve fn for a paused canUseTool prompt.
const pendingPermissions = new Map<string, {
  resolve: (r: PermissionResult) => void;
  toolUseID: string;
  toolName: string;
  toolInput: Record<string, unknown>;
}>();

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
    final: false,
    status: { state: 'input-required', message: msg },
  };
}

function makeStatusEvent(
  taskId: string,
  contextId: string,
  state: 'working' | 'completed' | 'failed' | 'canceled' | 'input-required',
  final: boolean,
  messageText?: string,
): TaskStatusUpdateEvent {
  const msg: Message | undefined = messageText
    ? {
        kind: 'message',
        messageId: uuidv4(),
        role: 'agent',
        parts: [{ kind: 'text', text: messageText } as TextPart],
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

export const claudeExecutor: AgentExecutor = {
  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId, userMessage } = requestContext;

    // If this contextId has a pending permission prompt, the incoming message
    // is the human's allow/deny answer rather than a new task.
    const pending = pendingPermissions.get(contextId);
    if (pending) {
      pendingPermissions.delete(contextId);
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
      // Acknowledge the human turn; the original query() task continues on its own.
      eventBus.publish(makeTaskEvent(taskId, contextId));
      eventBus.publish(makeStatusEvent(taskId, contextId, 'completed', true));
      eventBus.finished();
      return;
    }

    // Publish a Task event first so ResultManager.currentTask is initialized before
    // any status-update or artifact-update events arrive. Without this, message/send
    // drops all updates ("unknown task") because the task is never in the store.
    eventBus.publish(makeTaskEvent(taskId, contextId));

    const prompt = extractPrompt(userMessage);
    const abortController = new AbortController();
    abortControllers.set(taskId, abortController);
    let responseText = '';

    // canUseTool pauses query() and emits input-required so the human can decide.
    const canUseTool: CanUseTool = (toolName, input, opts) => {
      const toolInput = (input ?? {}) as Record<string, unknown>;
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
        },
      })) {
        if (msg.type === 'assistant') {
          for (const block of msg.message.content) {
            if (block.type === 'text') {
              responseText += block.text;
              eventBus.publish(
                makeStatusEvent(taskId, contextId, 'working', false, block.text),
              );
            } else if (block.type === 'tool_use') {
              eventBus.publish(
                makeStatusEvent(taskId, contextId, 'working', false, `Using tool: ${block.name}`),
              );
            }
          }
        } else if (msg.type === 'result') {
          if (msg.subtype === 'success' && !msg.is_error) {
            eventBus.publish(
              makeStatusEvent(taskId, contextId, 'completed', true, responseText || undefined),
            );
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
  },

  async cancelTask(taskId: string, _eventBus: ExecutionEventBus): Promise<void> {
    abortControllers.get(taskId)?.abort();
  },
};
