import type { TaskStore } from '@a2a-js/sdk/server';
import type { Task, Message, Artifact } from '@a2a-js/sdk';
import * as fs from 'fs';
import { logger } from './logger';

// TypeScript twin of kagent's go/adk/pkg/taskstore/store.go (KAgentTaskStore)
// plus go/adk/pkg/auth/token.go (KAgentTokenService). The kagent UI renders
// chat history from the controller's tasks table, which is populated only by
// agents write-through persisting their A2A tasks to POST {KAGENT_URL}/api/tasks.
// Without this store, history exists only in the agent pod's memory and every
// session renders empty after the live SSE stream closes.

const KAGENT_TOKEN_PATH = '/var/run/secrets/tokens/kagent-token';
const TOKEN_REFRESH_MS = 60_000;

// Message/artifact metadata keys marking partial streaming chunks. Canonical is
// kagent_adk_partial; legacy keys recognized for parity with the Go implementation.
const PARTIAL_META_KEYS = ['kagent_partial', 'adk_partial', 'kagent_adk_partial'];

function isPartialMeta(meta: Record<string, unknown> | undefined): boolean {
  if (!meta) return false;
  return PARTIAL_META_KEYS.some((key) => meta[key] === true);
}

function cleanPartialHistory(history: Message[] | undefined): Message[] | undefined {
  if (!history) return history;
  return history.filter((m) => m && !isPartialMeta(m.metadata) && m.parts.length > 0);
}

function cleanPartialArtifacts(artifacts: Artifact[] | undefined): Artifact[] | undefined {
  if (!artifacts) return artifacts;
  return artifacts.filter((a) => a && !isPartialMeta(a.metadata) && a.parts.length > 0);
}

export class KAgentTaskStore implements TaskStore {
  private token = '';
  private tokenReadAt = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly agentName: string,
  ) {}

  private getToken(): string {
    const now = Date.now();
    if (now - this.tokenReadAt >= TOKEN_REFRESH_MS) {
      this.tokenReadAt = now;
      try {
        this.token = fs.readFileSync(KAGENT_TOKEN_PATH, 'utf-8').trim();
      } catch (err) {
        logger.warn({ err }, 'failed to read kagent token');
      }
    }
    return this.token;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Agent-Name': this.agentName,
    };
    const token = this.getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return headers;
  }

  async save(task: Task): Promise<void> {
    // Strip partial streaming messages/artifacts so persisted history contains
    // only final messages — mirrors cleanPartialEvents in the Go task store.
    const taskCopy: Task = {
      ...task,
      history: cleanPartialHistory(task.history),
      artifacts: cleanPartialArtifacts(task.artifacts),
    };

    try {
      const resp = await fetch(`${this.baseUrl}/api/tasks`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(taskCopy),
      });
      if (!resp.ok) {
        const body = await resp.text();
        logger.error({ taskId: task.id, status: resp.status, body }, 'failed to save task to kagent');
      } else {
        logger.debug({ taskId: task.id, state: task.status.state }, 'task saved to kagent');
      }
    } catch (err) {
      // Persistence failure must not kill the live stream — log and continue.
      logger.error({ taskId: task.id, err }, 'failed to save task to kagent');
    }
  }

  async load(taskId: string): Promise<Task | undefined> {
    try {
      const resp = await fetch(`${this.baseUrl}/api/tasks/${encodeURIComponent(taskId)}`, {
        method: 'GET',
        headers: this.headers(),
      });
      if (resp.status === 404) return undefined;
      if (!resp.ok) {
        const body = await resp.text();
        logger.error({ taskId, status: resp.status, body }, 'failed to load task from kagent');
        return undefined;
      }
      const wrapped = (await resp.json()) as { data?: Task };
      return wrapped.data ?? undefined;
    } catch (err) {
      logger.error({ taskId, err }, 'failed to load task from kagent');
      return undefined;
    }
  }
}
