import type { FastifyPluginCallback } from 'fastify';
import { dailyNoteByDateRequestSchema } from '@tsumiwiki/shared';
import { sendError } from '../plugins/auth.js';
import {
  ensureDailyNote,
  InvalidDailyNoteSettingsError,
  renderDailyNoteBody,
  resolveDailyNotePath,
} from '../services/daily-note.js';
import { DocConflictError } from '../services/doc-service.js';
import { authorOf, handling } from './docs.js';

// #84 Phase 2: デイリーノート(『今日の日誌』)API。
// ライブラリ設定の dailyNotes.filenamePattern を今日の日付で展開してファイル名にし、
// dailyNotes.folder 配下に配置する。既に存在すればそのパスを返し、なければテンプレ
// (dailyNotes.template)を変数展開して新規作成する。
//
// タイムゾーン: 「今日」の判定は **サーバー実行環境のローカルTZ** を使う。
// TsumiWiki は社内サーバー1台に全ユーザーがぶら下がる想定(要件01章1.4)なので、
// サーバー/クライアントは同TZが原則。異TZ運用が必要になった場合はクライアントから
// 日付を渡す方式へ拡張する。
//
// #189: 過去/未来の任意日付で日誌を作る /by-date はこのTZ前提が崩れる
// (クライアントのローカルTZで解釈した日付をそのまま使いたい)ので、日付はクライアントから
// 'YYYY-MM-DD' 文字列で受け取り、`new Date(y, m-1, d)` でローカルTZの 0:00:00 として解釈する。

export const dailyNotesRoutes: FastifyPluginCallback = (app, _opts, done) => {
  app.post('/api/daily-notes/today', async (req, reply) => {
    if (!req.user) return sendError(reply, 401, 'UNAUTHORIZED', '認証が必要です');
    return handling(reply, async () => {
      try {
        return await ensureDailyNote(app, new Date(), req.user!.displayName, authorOf(req), req.log);
      } catch (e) {
        if (e instanceof InvalidDailyNoteSettingsError) {
          return sendError(
            reply,
            400,
            'INVALID_SETTINGS',
            'ファイル名パターンが不正です。ライブラリ設定を確認してください',
          );
        }
        throw e;
      }
    });
  });

  // #189: 指定した日付の日誌を新規作成する。既に存在する場合は開かず 409 を返す
  // (today との違い: today は既存があればそれを created:false で返すが、こちらは
  // 「その日はもう日誌がある」ことをクライアントに伝えて呼び出し側に判断させる)。
  app.post('/api/daily-notes/by-date', async (req, reply) => {
    if (!req.user) return sendError(reply, 401, 'UNAUTHORIZED', '認証が必要です');

    const parsed = dailyNoteByDateRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', '日付は YYYY-MM-DD 形式で指定してください');
    }
    const [y, m, d] = parsed.data.date.split('-').map(Number) as [number, number, number];
    const date = new Date(y, m - 1, d);
    // new Date は月日のオーバーフローを次の月/年へ繰り上げてしまう(例: 13月→翌年1月)ので、
    // 構成後の年月日が入力と一致するかで実在する暦日かを検証する
    if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) {
      return sendError(reply, 400, 'VALIDATION_ERROR', '存在しない日付です');
    }

    return handling(reply, async () => {
      const { settings } = await app.librarySettingsService.get();
      const resolved = resolveDailyNotePath(settings, date);
      if (!resolved) {
        return sendError(
          reply,
          400,
          'INVALID_SETTINGS',
          'ファイル名パターンが不正です。ライブラリ設定を確認してください',
        );
      }
      const { title, relPath } = resolved;

      // 既に存在すれば開かず 409(today と違い created:false では返さない)
      try {
        await app.docService.getDoc(relPath);
        return sendError(reply, 409, 'DAILY_NOTE_EXISTS', '指定した日付の日誌は既に存在します');
      } catch {
        // 存在しない → テンプレを読んで作成する
      }

      const body = await renderDailyNoteBody(app, settings, date, title, req.user!.displayName, req.log);

      try {
        const created = await app.docService.createDocWithContent(relPath, body, authorOf(req));
        return { path: created.path };
      } catch (e) {
        if (e instanceof DocConflictError) {
          return sendError(reply, 409, 'DAILY_NOTE_EXISTS', '指定した日付の日誌は既に存在します');
        }
        throw e;
      }
    });
  });

  done();
};
