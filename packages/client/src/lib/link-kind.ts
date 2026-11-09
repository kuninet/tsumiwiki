// 本文中のリンク分類・パス解決・ヒント文言の純関数(issue #325)
import { normalizeRelSegments, toFilesUrl } from './resolve-embed-src';
import { isMac } from './platform';

export type LinkKind = 'external' | 'mailto' | 'file' | 'anchor' | 'relative';

// href をデコードする(不正なエンコードは原文のまま)。allowed-link.ts の normalizeForSchemeCheck と同じ try/catch 作法
export function safeDecodeHref(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

// 分類はデコード後の文字列で行う(markdown-it が UNC の \ を %5C にするため)
export function classifyLinkHref(href: string): LinkKind {
  const d = safeDecodeHref(href).trim();
  if (/^https?:/i.test(d)) return 'external';
  if (/^mailto:/i.test(d)) return 'mailto';
  if (/^file:/i.test(d) || d.startsWith('\\\\')) return 'file';
  if (d.startsWith('#')) return 'anchor';
  return 'relative';
}

function folderOfPath(path?: string): string {
  if (!path) return '';
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

export type RelativeLinkTarget =
  | { type: 'doc'; path: string } // navigate(docUrl(path)) する
  | { type: 'file'; url: string } // window.open(url, '_blank', 'noopener,noreferrer') する
  | null; // 解決不能(空パス等)

// 相対リンクを現在の文書パスを基準に解決する
export function resolveRelativeLink(href: string, docPath: string): RelativeLinkTarget {
  // href を ? / # の手前で切る
  const cleanHref = href.split(/[?#]/)[0] ?? '';
  const rel = safeDecodeHref(cleanHref).trim();
  if (!rel) return null;

  // 先頭が / ならライブラリルート基準、それ以外は文書フォルダ基準
  const folder = folderOfPath(docPath);
  const joined = rel.startsWith('/') ? rel.slice(1) : folder ? `${folder}/${rel}` : rel;

  const normalized = normalizeRelSegments(joined);
  if (!normalized) return null;

  // 最終セグメントの拡張子判定
  const lastSeg = normalized.split('/').pop() ?? normalized;
  const lastDot = lastSeg.lastIndexOf('.');
  const ext = lastDot >= 0 ? lastSeg.slice(lastDot).toLowerCase() : '';

  if (ext === '' || ext === '.md') {
    return { type: 'doc', path: normalized };
  }
  return { type: 'file', url: toFilesUrl(normalized) };
}

// 編集モード用(修飾キー付き)。anchor は null(ヒントを出さない)
export function linkHintEdit(kind: LinkKind): string | null {
  const mod = isMac() ? 'Cmd' : 'Ctrl';
  switch (kind) {
    case 'external':
    case 'relative':
      return `${mod}+クリックで開く`;
    case 'file':
      return `${mod}+クリックでパスをコピー`;
    case 'mailto':
      return `${mod}+クリックでメールを作成`;
    case 'anchor':
      return null;
  }
}

// 閲覧モード用。file のみ 'クリックでパスをコピー'、他は null
export function linkHintView(kind: LinkKind): string | null {
  return kind === 'file' ? 'クリックでパスをコピー' : null;
}

// 修飾キー(Ctrl または Cmd)が押されているかの判定
export function isLinkOpenModifier(e: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return e.ctrlKey || e.metaKey;
}
