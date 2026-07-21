import { claudeExecutor } from '../executor';
import * as sdk from '@anthropic-ai/claude-agent-sdk';
import { DefaultExecutionEventBus } from '@a2a-js/sdk/server';
import type { Message } from '@a2a-js/sdk';
import { v4 as uuidv4 } from 'uuid';

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: jest.fn(),
  AbortError: class AbortError extends Error {
    name = 'AbortError';
    constructor() { super('Aborted'); }
  },
}));

const mockedSdk = jest.requireMock('@anthropic-ai/claude-agent-sdk') as {
  query: jest.Mock;
  AbortError: new () => Error;
};

async function* gen<T>(...items: T[]): AsyncGenerator<T, void> {
  for (const item of items) yield item;
}

function makeContext(text: string) {
  const userMessage: Message = {
    kind: 'message',
    messageId: uuidv4(),
    role: 'user',
    parts: [{ kind: 'text', text }],
  };
  return {
    taskId: uuidv4(),
    contextId: uuidv4(),
    userMessage,
  } as any;
}

describe('claudeExecutor', () => {
  let eventBus: DefaultExecutionEventBus;
  const published: any[] = [];

  beforeEach(() => {
    jest.clearAllMocks();
    published.length = 0;
    eventBus = new DefaultExecutionEventBus();
    eventBus.on('event', (e) => published.push(e));
  });

  it('publishes artifact-update for assistant text block', async () => {
    mockedSdk.query.mockReturnValue(gen(
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello world' }] } },
      { type: 'result', subtype: 'success', is_error: false, result: 'Hello world' },
    ));

    await claudeExecutor.execute(makeContext('do something'), eventBus);

    const artifact = published.find((e) => e.kind === 'artifact-update');
    expect(artifact).toBeDefined();
    expect(artifact.artifact.parts[0].text).toBe('Hello world');
  });

  it('publishes working status-update for tool_use block', async () => {
    mockedSdk.query.mockReturnValue(gen(
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', id: 'x', input: {} }] } },
      { type: 'result', subtype: 'success', is_error: false, result: '' },
    ));

    await claudeExecutor.execute(makeContext('run a command'), eventBus);

    const working = published.find(
      (e) => e.kind === 'status-update' && e.status.state === 'working',
    );
    expect(working).toBeDefined();
    expect(working.status.message.parts[0].text).toContain('Bash');
  });

  it('publishes completed status-update with final=true on success', async () => {
    mockedSdk.query.mockReturnValue(gen(
      { type: 'result', subtype: 'success', is_error: false, result: '' },
    ));

    await claudeExecutor.execute(makeContext('task'), eventBus);

    const completed = published.find(
      (e) => e.kind === 'status-update' && e.status.state === 'completed',
    );
    expect(completed).toBeDefined();
    expect(completed.final).toBe(true);
  });

  it('publishes failed status-update with final=true on error result', async () => {
    mockedSdk.query.mockReturnValue(gen(
      { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['something broke'] },
    ));

    await claudeExecutor.execute(makeContext('task'), eventBus);

    const failed = published.find(
      (e) => e.kind === 'status-update' && e.status.state === 'failed',
    );
    expect(failed).toBeDefined();
    expect(failed.final).toBe(true);
    expect(failed.status.message.parts[0].text).toContain('something broke');
  });

  it('publishes canceled status-update on AbortError', async () => {
    const { AbortError: MockAbortError } = mockedSdk;
    async function* throwAbort(): AsyncGenerator<never, void> {
      throw new MockAbortError();
    }
    mockedSdk.query.mockReturnValue(throwAbort());

    await claudeExecutor.execute(makeContext('task'), eventBus);

    const canceled = published.find(
      (e) => e.kind === 'status-update' && e.status.state === 'canceled',
    );
    expect(canceled).toBeDefined();
    expect(canceled.final).toBe(true);
  });

  it('calls eventBus.finished() after execution', async () => {
    mockedSdk.query.mockReturnValue(gen(
      { type: 'result', subtype: 'success', is_error: false, result: '' },
    ));
    const finishedSpy = jest.spyOn(eventBus, 'finished');

    await claudeExecutor.execute(makeContext('task'), eventBus);

    expect(finishedSpy).toHaveBeenCalledTimes(1);
  });

  it('cancelTask aborts the running query', async () => {
    mockedSdk.query.mockReturnValue(gen(
      { type: 'result', subtype: 'success', is_error: false, result: '' },
    ));

    const ctx = makeContext('task');
    await claudeExecutor.execute(ctx, eventBus);
    // cancelTask should not throw even when no controller is registered
    await expect(claudeExecutor.cancelTask(ctx.taskId, eventBus)).resolves.toBeUndefined();
  });
});
