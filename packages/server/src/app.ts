import Fastify from 'fastify';
import type { HealthResponse } from '@tsumiwiki/shared';

export function buildApp() {
  const app = Fastify({ logger: true });

  app.get('/api/health', async (): Promise<HealthResponse> => {
    return {
      status: 'ok',
      name: 'tsumiwiki',
      version: '0.1.0',
      time: new Date().toISOString(),
    };
  });

  return app;
}
