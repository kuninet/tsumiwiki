import type { FastifyInstance } from 'fastify';
import { createUserRequestSchema, updateUserRequestSchema } from '@tsumiwiki/shared';
import { requireAdmin, sendError } from '../plugins/auth.js';
import { DuplicateUsernameError } from '../services/user-service.js';

// ユーザー管理API(FR-AUTH-02。admin専用)
export function registerUserRoutes(app: FastifyInstance): void {
  app.get('/api/users', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    return { users: app.userService.list() };
  });

  app.post('/api/users', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const parsed = createUserRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? '入力が不正です');
    }
    try {
      const user = app.userService.create(parsed.data);
      return reply.code(201).send({ user });
    } catch (e) {
      if (e instanceof DuplicateUsernameError) {
        return sendError(reply, 409, 'CONFLICT', e.message);
      }
      throw e;
    }
  });

  app.patch('/api/users/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'ユーザーIDが不正です');
    }
    const parsed = updateUserRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', '入力が不正です');
    }
    const target = app.userService.byId(id);
    if (!target) {
      return sendError(reply, 404, 'NOT_FOUND', 'ユーザーが見つかりません');
    }

    const disabling = parsed.data.disabled === true;
    const demoting = parsed.data.role === 'user' && target.role === 'admin';
    // 自己ロックアウト防止: 自分自身の無効化・降格は拒否する
    if (id === req.user!.id && (disabling || demoting)) {
      return sendError(reply, 400, 'VALIDATION_ERROR', '自分自身を無効化・降格することはできません');
    }
    // 管理者不在防止: 最後の有効な管理者は無効化・降格できない
    if (
      target.role === 'admin' &&
      !target.disabled &&
      (disabling || demoting) &&
      app.userService.countActiveAdmins() <= 1
    ) {
      return sendError(reply, 400, 'VALIDATION_ERROR', '最後の管理者を無効化・降格することはできません');
    }

    const user = app.userService.update(id, parsed.data);
    // 無効化・降格・パスワードリセット時は対象ユーザーのセッションを失効させる
    if (disabling || demoting || parsed.data.password !== undefined) {
      app.sessionService.destroyByUser(id);
    }
    return { user };
  });
}
