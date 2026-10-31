import { readFile } from 'node:fs/promises';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { expandTemplateVariables, formatDate, type LibrarySettings } from '@tsumiwiki/shared';
import { resolveInLibrary } from '../lib/paths.js';
import { DocConflictError } from './doc-service.js';
import type { GitAuthor } from './git-service.js';

// デイリーノートの作成処理(#84 / #190 / #288)。
// REST(routes/daily-notes.ts)と MCP(mcp/tools/daily.ts)の両方から使う共通実装。

// ファイル名パターンが空文字に展開される(=ライブラリ設定が不正)場合に投げる
export class InvalidDailyNoteSettingsError extends Error {
  constructor() {
    super('ファイル名パターンが不正です。ライブラリ設定を確認してください');
    this.name = 'InvalidDailyNoteSettingsError';
  }
}

// 'YYYY-MM-DD' 文字列をローカルTZの 0:00:00 の Date に変換する(#189 / #292)。
// 形式不正・実在しない暦日(2026-02-30 や 13月など)は null を返す。
// REST(/by-date)と MCP(create_daily_note の date)で判定を共有する
export function parseLocalDate(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const date = new Date(y, mo - 1, d);
  // new Date は月日のオーバーフローを次の月/年へ繰り上げてしまうので、
  // 構成後の年月日が入力と一致するかで実在する暦日かを検証する
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return date;
}

// ファイル名パターンを指定日付で展開し、title/relPath を組み立てる。
// パターンが空文字に展開される(=不正な設定)場合は null を返す
export function resolveDailyNotePath(
  settings: LibrarySettings,
  date: Date,
): { title: string; relPath: string } | null {
  // ファイル名パターンは Obsidian と同じく素の日付フォーマット文字列として扱う
  // (例 'YYYY-MM-DD' → '2026-07-05')。{{...}} 変数構文は librarySettingsSchema で拒否済み
  const title = formatDate(date, settings.dailyNotes.filenamePattern);
  if (!title) return null;
  const relPath = settings.dailyNotes.folder
    ? `${settings.dailyNotes.folder}/${title}.md`
    : `${title}.md`;
  return { title, relPath };
}

// テンプレ設定があれば読み込んで変数展開し、無ければ既定本文を返す
export async function renderDailyNoteBody(
  app: FastifyInstance,
  settings: LibrarySettings,
  date: Date,
  title: string,
  user: string,
  log: FastifyBaseLogger,
): Promise<string> {
  if (!settings.dailyNotes.template) {
    return defaultDailyNoteBody(date, title);
  }
  try {
    const tmplAbs = resolveInLibrary(app.config.libraryPath, settings.dailyNotes.template);
    // ライブラリ外・保護パスへの逃走は librarySettingsSchema の refine と
    // resolveInLibrary の両方で弾く
    const raw = await readFile(tmplAbs, 'utf8');
    return expandTemplateVariables(
      raw,
      { date, title, user },
      { stripCursor: true }, // Phase 3 でカーソル配置UIを実装するまでは空文字化する
    );
  } catch (e) {
    // テンプレが見つからない・読めない場合はテンプレ無し扱い(admin向けの警告ログは残す)
    log.warn(
      { err: e, template: settings.dailyNotes.template },
      'デイリーノート用テンプレートを読み込めませんでした。既定本文で作成します',
    );
    return defaultDailyNoteBody(date, title);
  }
}

// テンプレ未設定・読取失敗時の既定本文(空白でもいいが、frontmatter に日付を残すと後で便利)
export function defaultDailyNoteBody(date: Date, title: string): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `---\ndate: ${yyyy}-${mm}-${dd}\n---\n\n# ${title}\n\n`;
}

// 指定日のデイリーノートを保証する。既存ならそのパスを created:false で返し、
// なければテンプレ展開して新規作成する。ファイル名パターン不正時は
// InvalidDailyNoteSettingsError を投げる
export async function ensureDailyNote(
  app: FastifyInstance,
  date: Date,
  user: string,
  author: GitAuthor,
  log: FastifyBaseLogger,
): Promise<{ path: string; created: boolean }> {
  const { settings } = await app.librarySettingsService.get();
  const resolved = resolveDailyNotePath(settings, date);
  if (!resolved) throw new InvalidDailyNoteSettingsError();
  const { title, relPath } = resolved;

  // 既存文書があればそれを返す(created:false)
  try {
    const existing = await app.docService.getDoc(relPath);
    return { path: existing.path, created: false };
  } catch {
    // 存在しない → テンプレを読んで作成する
  }

  const body = await renderDailyNoteBody(app, settings, date, title, user, log);

  // レース: 二人同時押しで敗者が DocConflictError を受けるので、既存パスとして返す
  try {
    const created = await app.docService.createDocWithContent(relPath, body, author);
    return { path: created.path, created: true };
  } catch (e) {
    if (e instanceof DocConflictError) {
      const existing = await app.docService.getDoc(relPath);
      return { path: existing.path, created: false };
    }
    throw e;
  }
}
