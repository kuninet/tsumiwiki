// 差分表示用の軽量Markdownインライン装飾レンダラー(#64。本文に混ざった見た目にする)。
// 対応するのは strong / em / inline code / wikilink のみ。ブロック要素(見出し・
// リスト等)は行としての種別扱い(add/del/context)背景色で示すことに留める。
// 出力は sanitized HTML 文字列(< > & " ' を先にエスケープしてから許可パターンだけ復元)。
//
// なぜ dangerouslySetInnerHTML 前提の関数を用意するか:
// - 追加/削除ハイライトは行単位の背景色で表現するため、インライン装飾を
//   React 要素にツリー化するよりも文字列で組み上げた方が単純で回帰が起きにくい
// - 入力はサーバー生成の git diff (信頼源) だが、二重防御として先にエスケープする

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

// エスケープ済みHTMLに対して inline markdown 相当の装飾を適用する。
// 順序が重要:
// 1. inline code(``x``)を最初にプレースホルダに退避して装飾から守る
// 2. wikilink [[target]] / [[target|alias]](#96。data-type/data-targetを付与し
//    DocViewのクリックハンドラから本文と同様にナビゲーション可能にする。text は
//    既に行頭の escapeHtml で `"` `<` 等がエンティティ化済みなので、そのまま
//    属性値に使っても壊れない。本文側の wikilink.ts の escapeHtml(target) と同じ扱い。
//    alias 記法にも本文側と同じ挙動で対応する: data-target=target / 表示=alias)
// 3. bold **x**(2連続の * を em の 1連続より先に処理する)
// 4. italic *x*(bold処理後の残った * のみが対象になる)
// 5. code のプレースホルダを <code>x</code> に戻す
export function renderDiffInline(text: string): string {
  // SUB(U+001A)は制御文字で、通常のテキスト・エスケープ後HTML・markdownメタ文字
  // いずれとも衝突しないためプレースホルダの区切りに使う
  const OPEN = '';
  const CLOSE = '';
  const codes: string[] = [];
  let html = escapeHtml(text);
  html = html.replace(/`([^`]+)`/g, (_, inner: string) => {
    const idx = codes.length;
    codes.push(`<code>${inner}</code>`);
    return `${OPEN}${idx}${CLOSE}`;
  });
  html = html.replace(
    /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (_m, target: string, alias?: string) => {
      // target / alias は行頭の escapeHtml で処理済みなので、そのまま HTML に埋めてよい。
      // コールバック版を使うのは alias 未指定時のグループを undefined として受けたいのと、
      // 文字列版だと $1 と紛らわしい $ 展開が絡むのを避けたいため
      const label = alias ?? target;
      return `<span class="wikilink" data-type="wikilink" data-target="${target}">${label}</span>`;
    },
  );
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  html = html.replace(new RegExp(`${OPEN}(\\d+)${CLOSE}`, 'g'), (_, i) => codes[Number(i)] ?? '');
  return html;
}
