import { readFile } from 'node:fs/promises';
import type { FastifyPluginCallback } from 'fastify';
import { expandTemplateVariables, formatDate } from '@tsumiwiki/shared';
import { resolveInLibrary } from '../lib/paths.js';
import { sendError } from '../plugins/auth.js';
import { authorOf } from './docs.js';

// #84 Phase 2: デイリーノート(『今日の日誌』)API。
// ライブラリ設定の dailyNotes.filenamePattern を今日の日付で展開してファイル名にし、
// dailyNotes.folder 配下に配置する。既に存在すればそのパスを返し、なければテンプレ
// (dailyNotes.template)を変数展開して新規作成する。

export const dailyNotesRoutes: FastifyPluginCallback = (app, _opts, done) => {
  app.post('/api/daily-notes/today', async (req, reply) => {
    if (!req.user) return sendError(reply, 401, 'UNAUTHORIZED', '認証が必要です');
    const settings = await app.librarySettingsService.get();
    const now = new Date();
    // ファイル名パターンは Obsidian と同じく素の日付フォーマット文字列として扱う
    // (例 'YYYY-MM-DD' → '2026-07-05')。{{...}} 変数構文はサポート外
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
        // ライブラリ外・保護パスへの逃走はresolveInLibraryが弾く
        const raw = await readFile(tmplAbs, 'utf8');
        body = expandTemplateVariables(raw, {
          date: now,
          title,
          user: req.user.displayName,
        });
      } catch {
        // テンプレが見つからない・読めない場合はテンプレ無し扱い
        body = defaultDailyNoteBody(now, title);
      }
    } else {
      body = defaultDailyNoteBody(now, title);
    }

    const created = await app.docService.createDocWithContent(relPath, body, authorOf(req));
    return { path: created.path, created: true };
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
