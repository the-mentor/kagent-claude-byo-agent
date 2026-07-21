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

  it('publishes working status-update for assistant text block', async () => {
    const { bus, published } = makeEventBus();
    mockedSdk.query.mockReturnValue(gen(
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello world' }] } },
      { type: 'result', subtype: 'success', is_error: false, result: 'Hello world' },
    ));

    await claudeExecutor.execute(makeContext('do something'), bus);

    const streaming = published.find(
      (e) => e.kind === 'status-update' && e.status.state === 'working' && e.status.message,
    );
    expect(streaming).toBeDefined();
    expect(streaming.status.message.parts[0].text).toBe('Hello world');
    // Streaming chunks are flagged partial so the kagent task store strips them
    // from persisted history.
    expect(streaming.status.message.metadata?.kagent_adk_partial).toBe(true);

    const completed = published.find(
      (e) => e.kind === 'status-update' && e.status.state === 'completed',
    );
    expect(completed).toBeDefined();
    expect(completed.status.message?.parts[0].text).toBe('Hello world');
    // The completed message is the single non-partial copy that persists.
    expect(completed.status.message?.metadata?.kagent_adk_partial).toBeUndefined();
  });

  it('accumulates multiple text blocks as working events', async () => {
    const { bus, published } = makeEventBus();
    mockedSdk.query.mockReturnValue(gen(
      { type: 'assistant', message: { content: [
        { type: 'text', text: 'Hello ' },
        { type: 'text', text: 'world' },
      ] } },
      { type: 'result', subtype: 'success', is_error: false, result: '' },
    ));

    await claudeExecutor.execute(makeContext('do something'), bus);

    const workingEvents = published.filter(
      (e) => e.kind === 'status-update' && e.status.state === 'working' && e.status.message,
    );
    expect(workingEvents).toHaveLength(2);
    expect(workingEvents[0].status.message.parts[0].text).toBe('Hello ');
    expect(workingEvents[1].status.message.parts[0].text).toBe('world');

    const completed = published.find(
      (e) => e.kind === 'status-update' && e.status.state === 'completed',
    );
    expect(completed).toBeDefined();
    expect(completed.status.message?.parts[0].text).toBe('Hello world');
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
    it('emits input-required (final) when canUseTool is called', async () => {
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
      // input-required ends the stream (final) — the client resumes the task
      // by sending the decision with the same taskId on a new stream.
      expect(inputRequired.final).toBe(true);
      // Native kagent HITL: message has adk_request_confirmation DataPart
      const parts = inputRequired.status.message?.parts ?? [];
      const dataPart = parts.find((p: any) => p.kind === 'data');
      expect(dataPart).toBeDefined();
      expect((dataPart as any).data.name).toBe('adk_request_confirmation');
      expect((dataPart as any).data.args.originalFunctionCall.name).toBe('Bash');
      expect((dataPart as any).metadata.adk_type).toBe('function_call');
      expect((dataPart as any).metadata.adk_is_long_running).toBe(true);

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

    it('resolves allow on native DataPart decision_type approve', async () => {
      const { bus } = makeEventBus();
      const { bus: bus2, published: published2 } = makeEventBus();
      const contextId = uuidv4();
      let capturedResult: any = null;

      mockedSdk.query.mockImplementation(({ options }: any) => {
        async function* run() {
          if (options?.canUseTool) {
            capturedResult = await options.canUseTool('Write', { file_path: '/tmp/x' }, {
              signal: new AbortController().signal,
              toolUseID: 'tuid-native-approve',
            });
          }
          yield { type: 'result', subtype: 'success', is_error: false, result: '' };
        }
        return run();
      });

      const execPromise = claudeExecutor.execute(makeContext('task', contextId), bus);
      await new Promise((r) => setImmediate(r));

      // Send native DataPart decision
      const approveMessage: Message = {
        kind: 'message',
        messageId: uuidv4(),
        role: 'user',
        parts: [{ kind: 'data', data: { decision_type: 'approve' } } as any],
      };
      await claudeExecutor.execute({ ...makeContext('', contextId), userMessage: approveMessage } as any, bus2);
      await execPromise;

      expect(capturedResult?.behavior).toBe('allow');
      const completed2 = published2.find(
        (e) => e.kind === 'status-update' && e.status.state === 'completed',
      );
      expect(completed2?.final).toBe(true);
    });

    it('resolves deny on native DataPart decision_type reject', async () => {
      const { bus } = makeEventBus();
      const { bus: bus2 } = makeEventBus();
      const contextId = uuidv4();
      let capturedResult: any = null;

      mockedSdk.query.mockImplementation(({ options }: any) => {
        async function* run() {
          if (options?.canUseTool) {
            capturedResult = await options.canUseTool('Bash', {}, {
              signal: new AbortController().signal,
              toolUseID: 'tuid-native-reject',
            });
          }
          yield { type: 'result', subtype: 'success', is_error: false, result: '' };
        }
        return run();
      });

      const execPromise = claudeExecutor.execute(makeContext('task', contextId), bus);
      await new Promise((r) => setImmediate(r));

      const rejectMessage: Message = {
        kind: 'message',
        messageId: uuidv4(),
        role: 'user',
        parts: [{ kind: 'data', data: { decision_type: 'reject' } } as any],
      };
      await claudeExecutor.execute({ ...makeContext('', contextId), userMessage: rejectMessage } as any, bus2);
      await execPromise;

      expect(capturedResult?.behavior).toBe('deny');
    });

    it('routes post-approval response to the approval bus, not the original bus', async () => {
      const { bus: bus1, published: published1 } = makeEventBus();
      const { bus: bus2, published: published2 } = makeEventBus();
      const contextId = uuidv4();

      // query() blocks on canUseTool, then after approval yields assistant text + result
      mockedSdk.query.mockImplementation(({ options }: any) => {
        async function* run() {
          if (options?.canUseTool) {
            await options.canUseTool('Bash', { command: 'curl -s https://api.ipify.org' }, {
              signal: new AbortController().signal,
              toolUseID: 'tuid-hitl',
            });
          }
          yield { type: 'assistant', message: { content: [{ type: 'text', text: '1.2.3.4' }] } };
          yield { type: 'result', subtype: 'success', is_error: false, result: '' };
        }
        return run();
      });

      // First execute: blocks at canUseTool, emits input-required on bus1
      const execPromise = claudeExecutor.execute(makeContext('what is my ip?', contextId), bus1);
      await new Promise((r) => setImmediate(r));

      // Approval arrives on bus2 — deposits bus2 for the original execute() to pick up
      await claudeExecutor.execute(makeContext('yes', contextId), bus2);
      await execPromise;

      // Post-approval text must NOT appear on bus1
      const textOnBus1 = published1.filter(
        (e) => e.kind === 'status-update' && e.status?.message?.parts?.[0]?.text === '1.2.3.4',
      );
      expect(textOnBus1).toHaveLength(0);

      // Post-approval text appears exactly once on bus2 as a working event
      const workingOnBus2 = published2.filter(
        (e) => e.kind === 'status-update' && e.status.state === 'working' && e.status.message,
      );
      expect(workingOnBus2).toHaveLength(1);
      expect(workingOnBus2[0].status.message.parts[0].text).toBe('1.2.3.4');

      const completedOnBus2 = published2.find(
        (e) => e.kind === 'status-update' && e.status.state === 'completed',
      );
      expect(completedOnBus2).toBeDefined();
      expect(completedOnBus2.final).toBe(true);
      expect(completedOnBus2.status.message?.parts[0].text).toBe('1.2.3.4');
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
