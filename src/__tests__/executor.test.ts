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

function makeContext(text: string, contextId = uuidv4()) {
  const userMessage: Message = {
    kind: 'message',
    messageId: uuidv4(),
    role: 'user',
    parts: [{ kind: 'text', text }],
  };
  return {
    taskId: uuidv4(),
    contextId,
    userMessage,
  } as any;
}

function makeEventBus() {
  const published: any[] = [];
  const bus = new DefaultExecutionEventBus();
  bus.on('event', (e) => published.push(e));
  return { bus, published };
}

describe('claudeExecutor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('publishes artifact-update for assistant text block', async () => {
    const { bus, published } = makeEventBus();
    mockedSdk.query.mockReturnValue(gen(
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello world' }] } },
      { type: 'result', subtype: 'success', is_error: false, result: 'Hello world' },
    ));

    await claudeExecutor.execute(makeContext('do something'), bus);

    const artifact = published.find((e) => e.kind === 'artifact-update');
    expect(artifact).toBeDefined();
    expect(artifact.artifact.parts[0].text).toBe('Hello world');
  });

  it('publishes working status-update for tool_use block', async () => {
    const { bus, published } = makeEventBus();
    mockedSdk.query.mockReturnValue(gen(
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', id: 'x', input: {} }] } },
      { type: 'result', subtype: 'success', is_error: false, result: '' },
    ));

    await claudeExecutor.execute(makeContext('run a command'), bus);

    const working = published.find(
      (e) => e.kind === 'status-update' && e.status.state === 'working',
    );
    expect(working).toBeDefined();
    expect(working.status.message.parts[0].text).toContain('Bash');
  });

  it('publishes completed status-update with final=true on success', async () => {
    const { bus, published } = makeEventBus();
    mockedSdk.query.mockReturnValue(gen(
      { type: 'result', subtype: 'success', is_error: false, result: '' },
    ));

    await claudeExecutor.execute(makeContext('task'), bus);

    const completed = published.find(
      (e) => e.kind === 'status-update' && e.status.state === 'completed',
    );
    expect(completed).toBeDefined();
    expect(completed.final).toBe(true);
  });

  it('publishes failed status-update with final=true on error result', async () => {
    const { bus, published } = makeEventBus();
    mockedSdk.query.mockReturnValue(gen(
      { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['something broke'] },
    ));

    await claudeExecutor.execute(makeContext('task'), bus);

    const failed = published.find(
      (e) => e.kind === 'status-update' && e.status.state === 'failed',
    );
    expect(failed).toBeDefined();
    expect(failed.final).toBe(true);
    expect(failed.status.message.parts[0].text).toContain('something broke');
  });

  it('publishes canceled status-update on AbortError', async () => {
    const { bus, published } = makeEventBus();
    const { AbortError: MockAbortError } = mockedSdk;
    async function* throwAbort(): AsyncGenerator<never, void> {
      throw new MockAbortError();
    }
    mockedSdk.query.mockReturnValue(throwAbort());

    await claudeExecutor.execute(makeContext('task'), bus);

    const canceled = published.find(
      (e) => e.kind === 'status-update' && e.status.state === 'canceled',
    );
    expect(canceled).toBeDefined();
    expect(canceled.final).toBe(true);
  });

  it('calls eventBus.finished() after execution', async () => {
    const { bus } = makeEventBus();
    mockedSdk.query.mockReturnValue(gen(
      { type: 'result', subtype: 'success', is_error: false, result: '' },
    ));
    const finishedSpy = jest.spyOn(bus, 'finished');

    await claudeExecutor.execute(makeContext('task'), bus);

    expect(finishedSpy).toHaveBeenCalledTimes(1);
  });

  it('cancelTask aborts the running query', async () => {
    const { bus } = makeEventBus();
    mockedSdk.query.mockReturnValue(gen(
      { type: 'result', subtype: 'success', is_error: false, result: '' },
    ));

    const ctx = makeContext('task');
    await claudeExecutor.execute(ctx, bus);
    await expect(claudeExecutor.cancelTask(ctx.taskId, bus)).resolves.toBeUndefined();
  });

  describe('HITL — canUseTool', () => {
    it('emits input-required (non-final) when canUseTool is called', async () => {
      const { bus, published } = makeEventBus();
      const contextId = uuidv4();

      // Make query() call canUseTool then resolve
      mockedSdk.query.mockImplementation(({ options }: any) => {
        async function* run() {
          if (options?.canUseTool) {
            // Call it but don't await — we want to capture the pending state
            void options.canUseTool('Bash', { cmd: 'rm -rf /' }, {
              signal: new AbortController().signal,
              toolUseID: 'tuid-1',
            });
          }
          // Yield nothing further (simulate query blocked on permission)
        }
        return run();
      });

      // Start execute without awaiting — it will block on canUseTool
      const execPromise = claudeExecutor.execute(makeContext('task', contextId), bus);

      // Give the generator time to reach canUseTool and publish input-required
      await new Promise((r) => setImmediate(r));

      const inputRequired = published.find(
        (e) => e.kind === 'status-update' && e.status.state === 'input-required',
      );
      expect(inputRequired).toBeDefined();
      expect(inputRequired.final).toBe(false);

      // Resolve by sending "no" so execute() can finish
      const { bus: bus2 } = makeEventBus();
      await claudeExecutor.execute(makeContext('no', contextId), bus2);
      await execPromise;
    });

    it('resolves allow when user replies yes', async () => {
      const { bus } = makeEventBus();
      const { bus: bus2, published: published2 } = makeEventBus();
      const contextId = uuidv4();
      let capturedResult: any = null;

      mockedSdk.query.mockImplementation(({ options }: any) => {
        async function* run() {
          if (options?.canUseTool) {
            capturedResult = await options.canUseTool('Bash', {}, {
              signal: new AbortController().signal,
              toolUseID: 'tuid-2',
            });
          }
          yield { type: 'result', subtype: 'success', is_error: false, result: '' };
        }
        return run();
      });

      const execPromise = claudeExecutor.execute(makeContext('task', contextId), bus);
      await new Promise((r) => setImmediate(r));

      await claudeExecutor.execute(makeContext('yes', contextId), bus2);
      await execPromise;

      expect(capturedResult?.behavior).toBe('allow');
      const completed2 = published2.find(
        (e) => e.kind === 'status-update' && e.status.state === 'completed',
      );
      expect(completed2?.final).toBe(true);
    });

    it('resolves deny when user replies no', async () => {
      const { bus } = makeEventBus();
      const { bus: bus2 } = makeEventBus();
      const contextId = uuidv4();
      let capturedResult: any = null;

      mockedSdk.query.mockImplementation(({ options }: any) => {
        async function* run() {
          if (options?.canUseTool) {
            capturedResult = await options.canUseTool('Bash', {}, {
              signal: new AbortController().signal,
              toolUseID: 'tuid-3',
            });
          }
          yield { type: 'result', subtype: 'success', is_error: false, result: '' };
        }
        return run();
      });

      const execPromise = claudeExecutor.execute(makeContext('delete production.db', contextId), bus);
      await new Promise((r) => setImmediate(r));

      await claudeExecutor.execute(makeContext('no', contextId), bus2);
      await execPromise;

      expect(capturedResult?.behavior).toBe('deny');
    });
  });
});
