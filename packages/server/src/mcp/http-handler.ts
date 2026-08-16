import type { FastifyInstance, FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildMcpServer } from './server.js';

// ステートレスHTTP実装(issue #190。単一ユーザー・自宅サーバー・ツール実行のみ想定)。
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
      await transport.handleRequest(req.raw, reply.raw, req.body);
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
