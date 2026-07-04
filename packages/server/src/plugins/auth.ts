import fastifyCookie from '@fastify/cookie';
import type { FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { User } from '@tsumiwiki/shared';
import { SessionService } from '../services/session-service.js';
import { UserService } from '../services/user-service.js';

// 認証・CSRF対策の共通処理(設計01章1.5 / 03章3.1)
// - /api配下は原則ログイン必須(NFR-SEC-01)
// - 変更系メソッドは X-Requested-With: TsumiWiki ヘッダ必須(CSRF対策)

export const SESSION_COOKIE = 'tsumiwiki_sid';
export const CSRF_HEADER_VALUE = 'TsumiWiki';

// /api/auth/me は「未認証でも200で{user:null}を返す」公開プローブ。
// 401イベントを本物のセッション失効に限定するための設計(#29レビュー対応)
const PUBLIC_PATHS = new Set(['/api/health', '/api/auth/login', '/api/auth/me']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

declare module 'fastify' {
  interface FastifyInstance {
    userService: UserService;
    sessionService: SessionService;
  }
  interface FastifyRequest {
    user: User | null;
    sessionId: string | null;
  }
}

export function sendError(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
): FastifyReply {
  return reply.code(status).send({ error: { code, message } });
}

// admin専用ルートの先頭で呼ぶ。falseを返したら処理を打ち切ること
export function requireAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.user?.role !== 'admin') {
    sendError(reply, 403, 'FORBIDDEN', '管理者権限が必要です');
    return false;
  }
  return true;
}

export const authPlugin = fp(async (app) => {
  await app.register(fastifyCookie);

  app.decorate('userService', new UserService(app.db));
  app.decorate('sessionService', new SessionService(app.db, app.config.sessionTtlMinutes));
  app.decorateRequest('user', null);
  app.decorateRequest('sessionId', null);

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    if (!path.startsWith('/api/')) return;

    // CSRF対策はカスタムヘッダ+SameSite=Laxの同一オリジン前提。
    // 将来CORSを導入する場合も X-Requested-With を許可ヘッダに含めないこと
    if (!SAFE_METHODS.has(req.method) && req.headers['x-requested-with'] !== CSRF_HEADER_VALUE) {
      return sendError(reply, 403, 'FORBIDDEN', 'X-Requested-Withヘッダが必要です');
    }
    if (PUBLIC_PATHS.has(path)) {
      // 公開パスでもセッションがあればreq.userを積む(meが自身を返せるように)
      const sid0 = req.cookies[SESSION_COOKIE];
      const session0 = sid0 ? app.sessionService.get(sid0) : null;
      if (session0) {
        const user0 = app.userService.byId(session0.userId);
        if (user0 && !user0.disabled) {
          req.user = user0;
          req.sessionId = session0.id;
        }
      }
      return;
    }

    const sid = req.cookies[SESSION_COOKIE];
    const session = sid ? app.sessionService.get(sid) : null;
    if (!session) {
      return sendError(reply, 401, 'UNAUTHORIZED', 'ログインが必要です');
    }
    const user = app.userService.byId(session.userId);
    if (!user || user.disabled) {
      app.sessionService.destroy(session.id);
      return sendError(reply, 401, 'UNAUTHORIZED', 'ログインが必要です');
    }
    // TTLを延長したときはCookieの有効期限も追随させる
    if (session.extended) {
      reply.setCookie(SESSION_COOKIE, session.id, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        maxAge: app.config.sessionTtlMinutes * 60,
      });
    }
    req.user = user;
    req.sessionId = session.id;
  });
});
