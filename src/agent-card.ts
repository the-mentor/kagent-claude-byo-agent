import type { AgentCard } from '@a2a-js/sdk';

export const agentCard: AgentCard = {
  protocolVersion: '0.3.0',
  name: 'claude-coding-agent',
  description: 'Claude Code agent powered by @anthropic-ai/claude-agent-sdk. Runs coding tasks in a persistent workspace.',
  url: 'http://localhost:8080',
  version: '1.0.0',
  capabilities: {
    streaming: true,
  },
  defaultInputModes: ['text'],
  defaultOutputModes: ['text'],
  skills: [
    {
      id: 'coding',
      name: 'Coding',
      description: 'Software development tasks: write, read, execute, and modify code in the persistent workspace.',
      tags: ['coding', 'files', 'shell'],
    },
  ],
};
