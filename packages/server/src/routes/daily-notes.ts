import { readFile } from 'node:fs/promises';
import type { FastifyPluginCallback } from 'fastify';
import { expandTemplateVariables, formatDate } from '@tsumiwiki/shared';
import { resolveInLibrary } from '../lib/paths.js';
import { sendError } from '../plugins/auth.js';
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

export const dailyNotesRoutes: FastifyPluginCallback = (app, _opts, done) => {
  app.post('/api/daily-notes/today', async (req, reply) => {
    if (!req.user) return sendError(reply, 401, 'UNAUTHORIZED', '認証が必要です');
    return handling(reply, async () => {
      const settings = await app.librarySettingsService.get();
      const now = new Date();
      // ファイル名パターンは Obsidian と同じく素の日付フォーマット文字列として扱う
      // (例 'YYYY-MM-DD' → '2026-07-05')。{{...}} 変数構文は librarySettingsSchema で拒否済み
      const title = formatDate(now, settings.dailyNotes.filenamePattern);
      if (!title) {
        return sendError(
          reply,
          400,
          'INVALID_SETTINGS',
          'ファイル名パターンが不正です。ライブラリ設定を確認してください',
        );
      }
      const relPath = settings.dailyNotes.folder
        ? `${settings.dailyNotes.folder}/${title}.md`
        : `${title}.md`;

      // 既存文書があればそれを返す(created:false)
      try {
        const existing = await app.docService.getDoc(relPath);
        return { path: existing.path, created: false };
      } catch {
        // 存在しない → テンプレを読んで作成する
      }

      // テンプレ本文を読み(未設定 or 読み込み失敗はデフォルト frontmatter のみ)
      let body: string;
      if (settings.dailyNotes.template) {
        try {
          const tmplAbs = resolveInLibrary(app.config.libraryPath, settings.dailyNotes.template);
          // ライブラリ外・保護パスへの逃走は librarySettingsSchema の refine と
          // resolveInLibrary の両方で弾く
          const raw = await readFile(tmplAbs, 'utf8');
          body = expandTemplateVariables(
            raw,
            { date: now, title, user: req.user!.displayName },
            { stripCursor: true }, // Phase 3 でカーソル配置UIを実装するまでは空文字化する
          );
        } catch (e) {
          // テンプレが見つからない・読めない場合はテンプレ無し扱い(admin向けの警告ログは残す)
          req.log.warn(
            { err: e, template: settings.dailyNotes.template },
            'デイリーノート用テンプレートを読み込めませんでした。既定本文で作成します',
          );
          body = defaultDailyNoteBody(now, title);
        }
      } else {
        body = defaultDailyNoteBody(now, title);
      }

      // レース: 二人同時押しで敗者が DocConflictError を受けるので、既存パスとして返す
      try {
        const created = await app.docService.createDocWithContent(relPath, body, authorOf(req));
        return { path: created.path, created: true };
      } catch (e) {
        if (e instanceof DocConflictError) {
          const existing = await app.docService.getDoc(relPath);
          return { path: existing.path, created: false };
        }
        throw e;
      }
    });
  });

  done();
};

// テンプレ未設定・読取失敗時の既定本文(空白でもいいが、frontmatter に日付を残すと後で便利)
function defaultDailyNoteBody(now: Date, title: string): string {
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `---\ndate: ${yyyy}-${mm}-${dd}\n---\n\n# ${title}\n\n`;
}
