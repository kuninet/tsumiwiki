import { Extension } from '@tiptap/core';
import Link from '@tiptap/extension-link';
import { isAllowedLinkUrl } from '../../lib/allowed-link';

// Markdown リンク `[text](href "title")` の往復保全(issue #207)
//
// 既定の @tiptap/extension-link には 2 つの問題がある:
// 1. URI 検証(isAllowedUri)の正規表現でエスケープが失われ `.-:` が文字範囲(`/` を含む)
//    になっているため、`sub/file.png` のような `/` を含む相対パスが「不正なURI」として
//    弾かれ、パース時にリンクが丸ごと消える(テキストだけ残る)
// 2. `title` 属性を持たないため `[a](x "タイトル")` の title が落ちる
// さらに markdown-it の既定 validateLink は `file:` を拒否するため、
// 外部ファイルリンク(FR-LINK-02)が `\[a\](file:///...)` とリテラル化される。
//
// ここでは本アプリの許可スキーム(lib/allowed-link.ts: http/https/mailto/file と相対パス)に
// 揃えた検証に置き換え、title を属性として保持し、markdown-it 側でも file: を通す。

// ブラウザは URL のスキーム部に含まれる空白・制御文字を取り除いて解釈するため
// (`java\nscript:` → `javascript:`)、検証前に同じ正規化をしてすり抜けを防ぐ。
// markdown-it は実体参照(`&#9;` 等)を復号後にパーセントエンコードして渡してくるので、
// 念のためデコードしてから判定する(不正なエンコードは原文のまま判定する)
function normalizeForSchemeCheck(url: string): string {
  let decoded = url;
  try {
    decoded = decodeURIComponent(url);
  } catch {
    // 不正なパーセントエンコードは復号せず原文で判定する
  }
  return decoded.replace(/[\s\u0000-\u001f\u007f]/g, '');
}

export const LinkWithTitle = Link.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      title: { default: null },
    };
  },
}).configure({
  openOnClick: false,
  autolink: false,
  isAllowedUri: (url) => isAllowedLinkUrl(normalizeForSchemeCheck(url)),
});

interface MarkdownItWithValidateLink {
  validateLink: (url: string) => boolean;
}

// markdown-it の validateLink を差し替える(tiptap-markdown の parse.setup フックで呼ばれる)。
// 既定は vbscript/javascript/file/data を拒否(data は画像のみ許可)。file: だけを許可に変える
export const MarkdownLinkSchemes = Extension.create({
  name: 'markdownLinkSchemes',
  addStorage() {
    return {
      markdown: {
        parse: {
          setup(markdownit: MarkdownItWithValidateLink) {
            markdownit.validateLink = (url: string) => {
              const normalized = normalizeForSchemeCheck(url).toLowerCase();
              if (/^(vbscript|javascript):/.test(normalized)) return false;
              if (/^data:/.test(normalized)) {
                return /^data:image\/(gif|png|jpeg|webp);/.test(normalized);
              }
              return true;
            };
          },
        },
      },
    };
  },
});
