import type { FastifyInstance } from 'fastify';
import { mcpAuthPlugin } from '../plugins/mcp-auth.js';
import { createMcpHttpHandler } from './http-handler.js';

// Remote MCPエンドポイント(issue #190)。MCP_ENABLED=trueのときのみapp.tsから呼ばれる。
// カプセル化境界(app.register)はapp.ts側で1つ作られるため、ここでは追加のwrapはしない
export async function registerMcpRoutes(app: FastifyInstance): Promise<void> {
  await app.register(mcpAuthPlugin);
  const handler = createMcpHttpHandler(app);
  app.all('/mcp', handler);
}
