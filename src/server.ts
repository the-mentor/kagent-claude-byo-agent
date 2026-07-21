import express from 'express';
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  DefaultExecutionEventBusManager,
} from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { agentCard } from './agent-card';
import { claudeExecutor } from './executor';

const taskStore = new InMemoryTaskStore();
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
