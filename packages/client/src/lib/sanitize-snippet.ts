// 検索snippetの防御的サニタイズ(#34レビュー対応)。
// サーバー側は「本文をHTMLエスケープ済み+<mark>のみHTML」という契約だが、
// 将来のサーバー変更で契約が崩れてもXSSにならないよう、描画直前に
// <mark>/</mark>以外のHTMLをすべてエスケープして二重化する
const MARK_TOKEN_RE = /(<\/?mark>)/;

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function sanitizeSnippet(snippet: string): string {
  return snippet
    .split(MARK_TOKEN_RE)
    .map((part) => (MARK_TOKEN_RE.test(part) ? part : escapeHtml(part)))
    .join('');
}
