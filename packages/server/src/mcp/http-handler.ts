import type { FastifyInstance, FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildMcpServer } from './server.js';

// SDK 1.30 は prompts/get の params.arguments が無いと、引数がすべて optional でも
// Required で拒否する。MCP 仕様では arguments は省略可なので、無ければ {} を補う。
// batch(配列)にも対応し、オブジェクトでない body・params の無いメッセージは触らない
export function fillPromptGetArguments(body: unknown): unknown {
  const fill = (msg: unknown): unknown => {
    if (typeof msg !== 'object' || msg === null) return msg;
    const m = msg as { method?: unknown; params?: unknown };
    if (m.method !== 'prompts/get') return msg;
    if (typeof m.params !== 'object' || m.params === null || Array.isArray(m.params)) return msg;
    const params = m.params as { arguments?: unknown };
    if (params.arguments !== undefined) return msg;
    return { ...m, params: { ...params, arguments: {} } };
  };
  return Array.isArray(body) ? body.map(fill) : fill(body);
}

// ステートレスHTTP実装(issue #190。単一ユーザー・自宅サーバー・ツールとプロンプトのみ想定)。
// リクエストごとに新規McpServer + Transportを作ってconnectし、レスポンス完了でcloseする
export function createMcpHttpHandler(app: FastifyInstance): RouteHandlerMethod {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const mcp = buildMcpServer(app);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    reply.hijack();

    // 二重closeを避けるガード(ソケットクローズとfinallyの両方から呼ばれうる)
    let closed = false;
    const closeAll = () => {
      if (closed) return;
      closed = true;
      void transport.close();
      void mcp.close();
    };
    reply.raw.on('close', closeAll);

    try {
      await mcp.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, fillPromptGetArguments(req.body));
    } catch (err) {
      // hijack後はFastifyのエラーハンドラが応答を書けないため、ここで書かないと
      // クライアントがソケットタイムアウトまでハングする
      app.log.error({ err }, 'MCP リクエスト処理に失敗しました');
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'Content-Type': 'application/json' });
        reply.raw.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32603, message: '内部エラーが発生しました' },
          }),
        );
      } else {
        // ヘッダ送出後はソケットを閉じるしかない
        req.raw.socket.destroy();
      }
    } finally {
      closeAll();
    }
  };
}
