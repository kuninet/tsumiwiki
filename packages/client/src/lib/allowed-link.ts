// リンクとして許可するURLスキーム(FR-LINK-02)。
// javascript:等の実行系スキームはエディタのコマンド挿入経路でも拒否する。
// エディタの Link 拡張(editor/extensions/link-markdown.ts)と markdown-it の validateLink も
// この関数を使い、許可集合を 1 か所に揃える(層ごとに食い違うと「片方が通して片方が落とす」
// 隙間がそのままリンク消失になるため)。data: は画像用途でも許可しない(許可しても Image 拡張の
// 既定 allowBase64=false で落ちて原文が消えるため、リテラル化して原文を残す方を選ぶ)
const ALLOWED_SCHEMES = ['http', 'https', 'mailto', 'file'];

// ブラウザは URL のスキーム部に含まれる空白・制御文字を取り除いて解釈するため
// (`java\nscript:` → `javascript:`)、判定前に同じ正規化をしてすり抜けを防ぐ。
// markdown-it は実体参照(`&#9;` 等)を復号後にパーセントエンコードして渡してくるので、
// 念のためデコードしてから判定する(不正なエンコードは原文のまま判定する)。
// 注意: 先頭セグメントに `%3A` を含む相対パス(`foo%3Abar.png`)はデコード後にスキーム扱いとなり
// ブラウザより厳しい側に倒れて拒否される(実用上まず現れない形のため許容)
export function normalizeForSchemeCheck(url: string): string {
  let decoded = url;
  try {
    decoded = decodeURIComponent(url);
  } catch {
    // 不正なパーセントエンコードは復号せず原文で判定する
  }
  return decoded.replace(/[\s\u0000-\u001f\u007f]/g, '');
}

export function isAllowedLinkUrl(url: string): boolean {
  const normalized = normalizeForSchemeCheck(url);
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(normalized);
  if (!schemeMatch) return true; // 相対URL・スキームなしは許可
  return ALLOWED_SCHEMES.includes(schemeMatch[1].toLowerCase());
}
