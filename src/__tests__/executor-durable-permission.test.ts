import { claudeExecutor } from '../executor';
import { DefaultExecutionEventBus } from '@a2a-js/sdk/server';
import type { Message } from '@a2a-js/sdk';
import { v4 as uuidv4 } from 'uuid';

// Simulates the SandboxAgent checkpoint/restore boundary: the container that
// blocked in canUseTool is gone, so only a durable file (not the in-memory
// pendingPermissions Map) can tell a fresh execute() call that a decision is due.
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: jest.fn(),
  AbortError: class AbortError extends Error {
    name = 'AbortError';
    constructor() { super('Aborted'); }
  },
}));

jest.mock('fs', () => {
  const actual = jest.requireActual('fs') as typeof import('fs');
  const files: Record<string, string> = {};
  return {
    ...actual,
    readFileSync: jest.fn((path: string) => {
      if (!(path in files)) throw new Error('ENOENT');
      return files[path];
    }),
    writeFileSync: jest.fn((path: string, data: string) => { files[path] = data; }),
    mkdirSync: jest.fn(),
    readdirSync: jest.fn(() => []),
  };
});

const mockedSdk = jest.requireMock('@anthropic-ai/claude-agent-sdk') as { query: jest.Mock };
const mockedFs = jest.requireMock('fs') as { writeFileSync: jest.Mock };

const PENDING_PERMISSION_FILE = '/data/.pending-permission.json';

function seedPendingPermission(contextId: string, toolName: string, toolInput: Record<string, unknown>) {
  mockedFs.writeFileSync(PENDING_PERMISSION_FILE, JSON.stringify({ [contextId]: { toolName, toolInput } }));
}

function makeContext(text: string, contextId: string) {
  const userMessage: Message = {
    kind: 'message',
    messageId: uuidv4(),
    role: 'user',
    parts: [{ kind: 'text', text }],
  };
  return { taskId: uuidv4(), contextId, userMessage } as any;
}

function makeApprovalContext(contextId: string, decisionType: 'approve' | 'reject') {
  const userMessage: Message = {
    kind: 'message',
    messageId: uuidv4(),
    role: 'user',
    parts: [{ kind: 'data', data: { decision_type: decisionType } } as any],
  };
  return { taskId: uuidv4(), contextId, userMessage } as any;
}

function makeEventBus() {
  const published: any[] = [];
  const bus = new DefaultExecutionEventBus();
  bus.on('event', (e) => published.push(e));
  return { bus, published };
}

describe('durable pending-permission replay (SandboxAgent checkpoint/restore)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('auto-approves the retried tool call and skips a second input-required prompt', async () => {
    const contextId = uuidv4();
    seedPendingPermission(contextId, 'Bash', { command: 'curl -s https://api.ipify.org' });

    let capturedResult: any = null;
    mockedSdk.query.mockImplementation(({ options }: any) => {
      async function* run() {
        capturedResult = await options.canUseTool('Bash', { command: 'curl -s https://api.ipify.org' }, {
          signal: new AbortController().signal,
          toolUseID: 'tuid-retry-1',
        });
        yield { type: 'assistant', message: { content: [{ type: 'text', text: '5.6.7.8' }] } };
        yield { type: 'result', subtype: 'success', is_error: false, result: '' };
      }
      return run();
    });

    const { bus, published } = makeEventBus();
    await claudeExecutor.execute(makeApprovalContext(contextId, 'approve'), bus);

    expect(capturedResult?.behavior).toBe('allow');
    expect(mockedSdk.query).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringMatching(/proceed/i),
    }));

    const inputRequired = published.find((e) => e.kind === 'status-update' && e.status.state === 'input-required');
    expect(inputRequired).toBeUndefined();

    const completed = published.find((e) => e.kind === 'status-update' && e.status.state === 'completed');
    expect(completed).toBeDefined();
    expect(completed.status.message?.parts[0].text).toBe('5.6.7.8');
  });

  it('auto-denies the retried tool call when the persisted decision was reject', async () => {
    const contextId = uuidv4();
    seedPendingPermission(contextId, 'Bash', { command: 'rm -rf /' });

    let capturedResult: any = null;
    mockedSdk.query.mockImplementation(({ options }: any) => {
      async function* run() {
        capturedResult = await options.canUseTool('Bash', { command: 'rm -rf /' }, {
          signal: new AbortController().signal,
          toolUseID: 'tuid-retry-2',
        });
        yield { type: 'result', subtype: 'success', is_error: false, result: '' };
      }
      return run();
    });

    const { bus, published } = makeEventBus();
    await claudeExecutor.execute(makeApprovalContext(contextId, 'reject'), bus);

    expect(capturedResult?.behavior).toBe('deny');
    const inputRequired = published.find((e) => e.kind === 'status-update' && e.status.state === 'input-required');
    expect(inputRequired).toBeUndefined();
  });

  it('falls back to a fresh input-required prompt for a second, different tool call in the replay turn', async () => {
    const contextId = uuidv4();
    seedPendingPermission(contextId, 'Bash', { command: 'curl -s https://api.ipify.org' });

    mockedSdk.query.mockImplementation(({ options }: any) => {
      async function* run() {
        await options.canUseTool('Bash', { command: 'curl -s https://api.ipify.org' }, {
          signal: new AbortController().signal,
          toolUseID: 'tuid-retry-3a',
        });
        // A second, unrelated tool call in the same resumed turn should not be auto-decided.
        void options.canUseTool('Write', { file_path: '/tmp/x' }, {
          signal: new AbortController().signal,
          toolUseID: 'tuid-retry-3b',
        });
      }
      return run();
    });

    const { bus, published } = makeEventBus();
    await claudeExecutor.execute(makeApprovalContext(contextId, 'approve'), bus);
    await new Promise((r) => setImmediate(r));

    const inputRequired = published.find((e) => e.kind === 'status-update' && e.status.state === 'input-required');
    expect(inputRequired).toBeDefined();
    const dataPart = inputRequired.status.message?.parts?.find((p: any) => p.kind === 'data');
    expect(dataPart.data.args.originalFunctionCall.name).toBe('Write');
    // Each test uses a unique contextId, so the still-pending 'Write' permission
    // here has no effect on other tests — no cleanup needed.
  });

  it('leaves normal (non-approval, no persisted pending) tasks on the regular new-task path', async () => {
    const contextId = uuidv4();
    mockedSdk.query.mockReturnValue((async function* () {
      yield { type: 'result', subtype: 'success', is_error: false, result: '' };
    })());

    const { bus, published } = makeEventBus();
    await claudeExecutor.execute(makeContext('hello', contextId), bus);

    const completed = published.find((e) => e.kind === 'status-update' && e.status.state === 'completed');
    expect(completed).toBeDefined();
  });
});
