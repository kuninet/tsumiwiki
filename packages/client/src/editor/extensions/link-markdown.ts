import { Extension } from '@tiptap/core';
import Link from '@tiptap/extension-link';
import { isAllowedLinkUrl } from '../../lib/allowed-link';
import { classifyLinkHref, linkHintEdit, linkHintView } from '../../lib/link-kind';

// Markdown リンク `[text](href "title")` の往復保全(issue #207)
// およびクリック可能なリンクの見た目とヒント属性の付与(issue #325)
//
// 既定の @tiptap/extension-link には 2 つの問題がある:
// 1. URI 検証(isAllowedUri)の正規表現でエスケープが失われ `.-:` が文字範囲(`/` を含む)
//    になっているため、`sub/file.png` のような `/` を含む相対パスが「不正なURI」として
//    弾かれ、パース時にリンクが丸ごと消える(テキストだけ残る)
// 2. `title` 属性を持たないため `[a](x "タイトル")` の title が落ちる
// さらに markdown-it の既定 validateLink は `file:` を拒否するため、
// 外部ファイルリンク(FR-LINK-02)が `\[a\](file:///...)` とリテラル化される。
//
// ここでは本アプリの許可スキーム(lib/allowed-link.ts: http/https/mailto/file・相対パス)に
// 揃えた検証に置き換え、title を属性として保持し、markdown-it 側も同じ判定にする。
// 許可外スキーム(tel: 等)は両層で一致して拒否→markdown-it がリテラル化するため原文は消えない。
// また #325 により、renderHTML で data-link-kind / data-link-hint などを付与し、
// target="_blank" は external のみ付与する。

export const LinkWithTitle = Link.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      title: {
        default: null,
        parseHTML(element) {
          return element.getAttribute('title');
        },
      },
    };
  },
  renderHTML({ mark, HTMLAttributes }) {
    const href = typeof HTMLAttributes.href === 'string' ? HTMLAttributes.href : '';
    const kind = classifyLinkHref(href);
    return (
      this.parent?.({
        mark,
        HTMLAttributes: {
          ...HTMLAttributes,
          // 外部リンクだけ新しいタブ。相対・mailto・file で新しいタブが開く既定動作を止める
          target: kind === 'external' ? '_blank' : null,
          'data-link-kind': kind,
          'data-link-hint': linkHintEdit(kind),
          'data-link-hint-view': linkHintView(kind),
        },
      }) ?? ['a', HTMLAttributes, 0]
    );
  },
}).configure({
  openOnClick: false,
  autolink: false,
  isAllowedUri: (url) => isAllowedLinkUrl(url),
  HTMLAttributes: { target: null, rel: 'noopener noreferrer nofollow', class: null },
});

interface MarkdownItWithValidateLink {
  validateLink: (url: string) => boolean;
}

// markdown-it の validateLink を差し替える(tiptap-markdown の parse.setup フックで呼ばれる)。
// Link 拡張の isAllowedUri と同じ許可集合にする。許可外はここでリテラル化されるため、
// 「markdown-it が通して Link 拡張が落とす」経路(=原文が消える)が生じない。
// 画像の src にも同じ判定が使われる(`![a](file:///...)` は <img> になる。FR-LINK-02 と同方針)
export const MarkdownLinkSchemes = Extension.create({
  name: 'markdownLinkSchemes',
  addStorage() {
    return {
      markdown: {
        parse: {
          setup(markdownit: MarkdownItWithValidateLink) {
            markdownit.validateLink = (url: string) => isAllowedLinkUrl(url);
          },
        },
      },
    };
  },
});
