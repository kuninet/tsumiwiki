import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

// MCP用Bearer認証。preHandlerで/mcpへの全リクエストを検証する(issue #190)
export const mcpAuthPlugin = fp(async (app) => {
  const token = app.config.mcpToken;
  if (!token) {
    // config.tsのfail-secureで既にブロック済みだが二重防御
    throw new Error('MCP_TOKEN 未設定です');
  }
  const expected = Buffer.from(token, 'utf8');

  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    // '/mcpfoo'等の非関係パスに誤爆しないよう、完全一致またはセグメント区切りのみ対象にする
    const urlPath = req.url.split('?')[0];
    if (urlPath !== '/mcp' && !urlPath.startsWith('/mcp/')) return;
    const header = req.headers.authorization ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) {
      reply
        .header('WWW-Authenticate', 'Bearer realm="tsumiwiki-mcp"')
        .code(401)
        .send({ error: { code: 'UNAUTHORIZED', message: 'Bearer トークンが必要です' } });
      return;
    }
    const provided = Buffer.from(match[1], 'utf8');
    // 長さが違うとtimingSafeEqualがthrowするため、長さ不一致を先に弾く
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      reply
        .header('WWW-Authenticate', 'Bearer realm="tsumiwiki-mcp", error="invalid_token"')
        .code(401)
        .send({ error: { code: 'UNAUTHORIZED', message: 'トークンが不正です' } });
      return;
    }
  });
});
