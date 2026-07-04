import type { FastifyInstance } from 'fastify';
import { changePasswordRequestSchema, loginRequestSchema } from '@tsumiwiki/shared';
import { SESSION_COOKIE, sendError } from '../plugins/auth.js';

// ログイン試行のレート制限(ユーザー名+IP単位。プロセス内メモリで管理)
const RATE_WINDOW_MS = 15 * 60_000;
const RATE_MAX_FAILURES = 10;

interface FailureRecord {
  count: number;
  firstAt: number;
}

export function registerAuthRoutes(app: FastifyInstance): void {
  const loginFailures = new Map<string, FailureRecord>();

  function isRateLimited(key: string): boolean {
    const rec = loginFailures.get(key);
    if (!rec) return false;
    if (Date.now() - rec.firstAt > RATE_WINDOW_MS) {
      loginFailures.delete(key);
      return false;
    }
    return rec.count >= RATE_MAX_FAILURES;
  }

  function recordFailure(key: string): void {
    const rec = loginFailures.get(key);
    if (!rec || Date.now() - rec.firstAt > RATE_WINDOW_MS) {
      loginFailures.set(key, { count: 1, firstAt: Date.now() });
    } else {
      rec.count++;
    }
  }

  app.post('/api/auth/login', async (req, reply) => {
    const parsed = loginRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'ユーザーIDとパスワードを入力してください');
    }
    const rateKey = `${parsed.data.username}@${req.ip}`;
    if (isRateLimited(rateKey)) {
      return sendError(
        reply,
        429,
        'TOO_MANY_REQUESTS',
        'ログイン試行が多すぎます。しばらく待ってから再試行してください',
      );
    }
    const user = app.userService.verifyLogin(parsed.data.username, parsed.data.password);
    if (!user) {
      recordFailure(rateKey);
      return sendError(reply, 401, 'UNAUTHORIZED', 'ユーザーIDまたはパスワードが違います');
    }
    loginFailures.delete(rateKey);
    app.sessionService.cleanup();
    const session = app.sessionService.create(user.id);
    reply.setCookie(SESSION_COOKIE, session.id, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: app.config.sessionTtlMinutes * 60,
      // 初期リリースは初期のHTTP運用のためsecureは付けない(NFR-SEC-05)。HTTPS化時に有効化
    });
    return { user };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    if (req.sessionId) {
      app.sessionService.destroy(req.sessionId);
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    return { user: req.user };
  });

  app.put('/api/me/password', async (req, reply) => {
    const parsed = changePasswordRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', '新しいパスワードを入力してください');
    }
    const ok = app.userService.changePassword(
      req.user!.id,
      parsed.data.currentPassword,
      parsed.data.newPassword,
    );
    if (!ok) {
      return sendError(reply, 400, 'VALIDATION_ERROR', '現在のパスワードが違います');
    }
    // パスワード変更時は本人の他セッションを失効させる(現行セッションは維持)
    app.sessionService.destroyByUser(req.user!.id, req.sessionId ?? undefined);
    return { ok: true };
  });
}
