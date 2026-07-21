import { query, AbortError } from '@anthropic-ai/claude-agent-sdk';
import type { AgentExecutor, RequestContext, ExecutionEventBus } from '@a2a-js/sdk/server';
import type {
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
  TextPart,
  Message,
} from '@a2a-js/sdk';
import { v4 as uuidv4 } from 'uuid';

const WORKSPACE = '/home/agent/workspace';

// One AbortController per running task — keyed by taskId.
const abortControllers = new Map<string, AbortController>();

function extractPrompt(message: Message): string {
  return message.parts
    .filter((p): p is TextPart => p.kind === 'text')
    .map((p) => p.text)
    .join('\n');
}

function makeStatusEvent(
  taskId: string,
  contextId: string,
  state: 'working' | 'completed' | 'failed' | 'canceled',
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

function makeArtifactEvent(
  taskId: string,
  contextId: string,
  text: string,
): TaskArtifactUpdateEvent {
  return {
    kind: 'artifact-update',
    taskId,
    contextId,
    artifact: {
      artifactId: uuidv4(),
      parts: [{ kind: 'text', text } as TextPart],
    },
  };
}

export const claudeExecutor: AgentExecutor = {
  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId, userMessage } = requestContext;
    const prompt = extractPrompt(userMessage);
    const abortController = new AbortController();
    abortControllers.set(taskId, abortController);

    try {
      for await (const msg of query({ prompt, options: { cwd: WORKSPACE, abortController } })) {
        if (msg.type === 'assistant') {
          for (const block of msg.message.content) {
            if (block.type === 'text') {
              eventBus.publish(makeArtifactEvent(taskId, contextId, block.text));
            } else if (block.type === 'tool_use') {
              eventBus.publish(
                makeStatusEvent(taskId, contextId, 'working', false, `Using tool: ${block.name}`),
              );
            }
          }
        } else if (msg.type === 'result') {
          if (msg.subtype === 'success' && !msg.is_error) {
            eventBus.publish(makeStatusEvent(taskId, contextId, 'completed', true));
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
      abortControllers.delete(taskId);
      eventBus.finished();
    }
  },

  async cancelTask(taskId: string, _eventBus: ExecutionEventBus): Promise<void> {
    abortControllers.get(taskId)?.abort();
  },
};
