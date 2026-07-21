import request from 'supertest';
import { app } from '../server';
import { agentCard } from '../agent-card';

describe('A2A server', () => {
  it('GET /.well-known/agent-card.json returns 200 with agent name', async () => {
    const res = await request(app).get('/.well-known/agent-card.json');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe(agentCard.name);
    expect(res.body.capabilities.streaming).toBe(true);
  });

  it('POST / with unknown method returns JSON-RPC error', async () => {
    const res = await request(app)
      .post('/')
      .set('Content-Type', 'application/json')
      .send({ jsonrpc: '2.0', id: 1, method: 'nonexistent/method', params: {} });
    expect(res.status).toBe(200); // JSON-RPC errors return HTTP 200
    expect(res.body.error).toBeDefined();
  });
});
