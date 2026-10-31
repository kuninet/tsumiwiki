import type { FastifyInstance } from 'fastify';
import { mcpAuthPlugin } from '../plugins/mcp-auth.js';
import { mcpNetworkPlugin } from '../plugins/mcp-network.js';
import { createMcpHttpHandler } from './http-handler.js';

// Remote MCPエンドポイント(issue #190)。MCP_ENABLED=trueのときのみapp.tsから呼ばれる。
// カプセル化境界(app.register)はapp.ts側で1つ作られるため、ここでは追加のwrapはしない
export async function registerMcpRoutes(app: FastifyInstance): Promise<void> {
  if (app.config.mcpAuth === 'none') {
    // 認証なしモード(issue #290)。送信元をローカル・LAN・Tailscaleに限定する
    app.log.warn(
      'MCP は認証なしモードで起動しています(ローカル・LAN・Tailscale からのみ受け付け)',
    );
    if (app.config.mcpTokenIgnored) {
      app.log.warn('MCP_AUTH=none のため MCP_TOKEN は無視されます');
    }
    await app.register(mcpNetworkPlugin);
  } else {
    await app.register(mcpAuthPlugin);
  }
  const handler = createMcpHttpHandler(app);
  app.all('/mcp', handler);
}
