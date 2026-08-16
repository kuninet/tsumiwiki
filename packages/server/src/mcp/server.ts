import type { FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerReadTools } from './tools/read.js';
import { registerWriteTools } from './tools/write.js';
import { registerDailyTools } from './tools/daily.js';

// MCP経由の操作はコミットログでUI操作と判別できるよう固定のauthorを使う(issue #190)
export const MCP_AUTHOR = { name: 'MCP Agent', email: 'mcp@tsumiwiki.local' } as const;
// AUTOINCREMENTのuserIdは1以上のため、-1は既存ユーザーと絶対に衝突しない
export const MCP_SENTINEL_USER_ID = -1;

// リクエストごとに呼ばれる(ステートレス)
export function buildMcpServer(app: FastifyInstance): McpServer {
  const mcp = new McpServer(
    { name: 'tsumiwiki', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );
  registerReadTools(mcp, app);
  registerWriteTools(mcp, app);
  registerDailyTools(mcp, app);
  return mcp;
}
