import { KAgentTaskStore } from '../kagent-task-store';
import type { Task } from '@a2a-js/sdk';
import * as fs from 'fs';

jest.mock('fs');
const mockedFs = fs as jest.Mocked<typeof fs>;

const BASE_URL = 'http://kagent-controller:8083';
const AGENT_NAME = 'test-agent';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    kind: 'task',
    id: 'task-1',
    contextId: 'ctx-1',
    status: { state: 'completed' },
    ...overrides,
  } as Task;
}

describe('KAgentTaskStore', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedFs.readFileSync.mockReturnValue('sa-token\n' as any);
    fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 201, text: async () => '' });
    global.fetch = fetchMock as any;
  });

  it('save POSTs the task with auth headers', async () => {
    const store = new KAgentTaskStore(BASE_URL, AGENT_NAME);
    await store.save(makeTask());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/api/tasks`);
    expect(init.method).toBe('POST');
    expect(init.headers['Authorization']).toBe('Bearer sa-token');
    expect(init.headers['X-Agent-Name']).toBe(AGENT_NAME);
    const body = JSON.parse(init.body);
    expect(body.id).toBe('task-1');
  });

  it('save strips partial messages from history but keeps final ones', async () => {
    const store = new KAgentTaskStore(BASE_URL, AGENT_NAME);
    const task = makeTask({
      history: [
        {
          kind: 'message', messageId: 'u1', role: 'user',
          parts: [{ kind: 'text', text: 'hi' }],
        },
        {
          kind: 'message', messageId: 'p1', role: 'agent',
          parts: [{ kind: 'text', text: 'streaming chunk' }],
          metadata: { kagent_adk_partial: true },
        },
        {
          kind: 'message', messageId: 'f1', role: 'agent',
          parts: [{ kind: 'text', text: 'final answer' }],
        },
      ] as any,
    });
    await store.save(task);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const ids = body.history.map((m: any) => m.messageId);
    expect(ids).toEqual(['u1', 'f1']);
    // Caller's task must not be mutated.
    expect(task.history).toHaveLength(3);
  });

  it('save strips legacy partial keys too', async () => {
    const store = new KAgentTaskStore(BASE_URL, AGENT_NAME);
    await store.save(makeTask({
      history: [
        { kind: 'message', messageId: 'p1', role: 'agent', parts: [{ kind: 'text', text: 'x' }], metadata: { adk_partial: true } },
        { kind: 'message', messageId: 'p2', role: 'agent', parts: [{ kind: 'text', text: 'y' }], metadata: { kagent_partial: true } },
      ] as any,
    }));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.history).toHaveLength(0);
  });

  it('save does not throw when the controller is unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const store = new KAgentTaskStore(BASE_URL, AGENT_NAME);
    await expect(store.save(makeTask())).resolves.toBeUndefined();
  });

  it('load returns the unwrapped task', async () => {
    const task = makeTask();
    fetchMock.mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ data: task }),
    });
    const store = new KAgentTaskStore(BASE_URL, AGENT_NAME);
    const loaded = await store.load('task-1');

    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE_URL}/api/tasks/task-1`);
    expect(loaded?.id).toBe('task-1');
  });

  it('load returns undefined on 404', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, text: async () => 'not found' });
    const store = new KAgentTaskStore(BASE_URL, AGENT_NAME);
    await expect(store.load('missing')).resolves.toBeUndefined();
  });

  it('load returns undefined when the controller is unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const store = new KAgentTaskStore(BASE_URL, AGENT_NAME);
    await expect(store.load('task-1')).resolves.toBeUndefined();
  });
});
