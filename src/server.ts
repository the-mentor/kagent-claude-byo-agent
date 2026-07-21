import express from 'express';
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  DefaultExecutionEventBusManager,
} from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { agentCard } from './agent-card';
import { claudeExecutor } from './executor';
import { KAgentTaskStore } from './kagent-task-store';
import { logger } from './logger';

// When running inside kagent, persist tasks to the controller so the UI can
// render chat history after the live stream closes. Fall back to in-memory
// for local docker runs.
const kagentUrl = process.env.KAGENT_URL;
const taskStore = kagentUrl
  ? new KAgentTaskStore(kagentUrl, process.env.KAGENT_NAME ?? '')
  : new InMemoryTaskStore();
logger.info({ kagentUrl: kagentUrl ?? null }, kagentUrl ? 'using kagent task store' : 'using in-memory task store');
const eventBusManager = new DefaultExecutionEventBusManager();
const requestHandler = new DefaultRequestHandler(
  agentCard,
  taskStore,
  claudeExecutor,
  eventBusManager,
);

export const app = express();
app.use(express.json());

app.use(
  '/.well-known/agent-card.json',
  agentCardHandler({ agentCardProvider: async () => agentCard }),
);

app.use(
  '/',
  jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }),
);
