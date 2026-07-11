import type { FastifyPluginCallback } from 'fastify';
import { librarySettingsSchema } from '@tsumiwiki/shared';
import { sendError } from '../plugins/auth.js';
import { authorOf } from './docs.js';

// #84 Phase 1: ライブラリ設定 API。全ユーザーが読める・admin のみ更新可能。
// 実装は LibrarySettingsService に委譲。

export const librarySettingsRoutes: FastifyPluginCallback = (app, _opts, done) => {
  app.get('/api/library/settings', async (req, reply) => {
    if (!req.user) return sendError(reply, 401, 'UNAUTHORIZED', '認証が必要です');
    const { settings, corrupted } = await app.librarySettingsService.get();
    return { settings, corrupted };
  });

  app.put('/api/library/settings', async (req, reply) => {
    if (!req.user) return sendError(reply, 401, 'UNAUTHORIZED', '認証が必要です');
    if (req.user.role !== 'admin') {
      return sendError(reply, 403, 'FORBIDDEN', 'ライブラリ設定の変更は管理者のみが行えます');
    }
    const parsed = librarySettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(
        reply,
        400,
        'VALIDATION_ERROR',
        parsed.error.issues[0]?.message ?? '入力内容を確認してください',
      );
    }
    const updated = await app.librarySettingsService.update(parsed.data, authorOf(req));
    return { settings: updated };
  });

  done();
};
