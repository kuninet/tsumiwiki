import { parseWikilinkTarget } from '@tsumiwiki/shared';
import { resolveNewDocInitialFolder, type UnresolvedLinkFolder } from '../stores/user-settings';

export interface NewDocFromLinkPlan {
  folder: string; // '' = ルート
  title: string; // createDoc に渡すタイトル(拡張子なし)
  path: string; // 予定パス(表示用)。folder ? `${folder}/${title}.md` : `${title}.md`
  invalidChars: string[]; // title に含まれる禁止文字(重複なし)。空なら作成可
}

// packages/server/src/services/doc-service.ts の FORBIDDEN_CHAR_MAP と同期。
// ※ '/' は targetDir に分割済みのため title 対象外。
const FORBIDDEN_CHAR_SET = new Set(['\\', ':', '*', '?', '"', '<', '>', '|']);
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;

/**
 * 未解決 wikilink から新規作成する文書のフォルダ・タイトル・パスを算出する。
 * 自文書内リンク([[#見出し]])や target が空の場合は null を返す。
 */
export function planNewDocFromWikilink(
  rawTarget: string,
  sourceDocPath: string,
  mode: UnresolvedLinkFolder,
): NewDocFromLinkPlan | null {
  let cleaned = rawTarget.trim();
  if (cleaned.startsWith('[[') && cleaned.endsWith(']]')) {
    cleaned = cleaned.slice(2, -2).trim();
  }

  const meta = parseWikilinkTarget(cleaned);
  if (meta.isInternal || meta.target === '') {
    return null;
  }

  // target に '/' が含まれる場合は最後の '/' で targetDir と title に分割する。
  // createDoc に '/' を含んだ title を渡すと全角置換されてリンクと不一致になるのを防ぐ。
  const lastSlashIdx = meta.target.lastIndexOf('/');
  const targetDir = lastSlashIdx !== -1 ? meta.target.slice(0, lastSlashIdx) : '';
  const title = lastSlashIdx !== -1 ? meta.target.slice(lastSlashIdx + 1) : meta.target;

  if (title === '') {
    return null;
  }

  const baseFolder =
    mode === 'same-folder'
      ? resolveNewDocInitialFolder(sourceDocPath, 'same-folder', '')
      : '';

  const folder = [baseFolder, targetDir].filter(Boolean).join('/');
  const path = folder ? `${folder}/${title}.md` : `${title}.md`;

  // title 内の禁止文字・制御文字を検出(重複排除)
  const invalidChars: string[] = [];
  const seen = new Set<string>();
  for (const char of title) {
    if (FORBIDDEN_CHAR_SET.has(char) || CONTROL_CHAR_RE.test(char)) {
      if (!seen.has(char)) {
        seen.add(char);
        invalidChars.push(char);
      }
    }
  }

  return {
    folder,
    title,
    path,
    invalidChars,
  };
}
