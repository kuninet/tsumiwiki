import HardBreak from '@tiptap/extension-hard-break';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

// issue #229: hardBreakのMarkdownシリアライズを置き換える(StarterKit側は無効化)。
//
// tiptap-markdown既定のシリアライザは、表内のhardBreakをHTMLNode経由で書き出すため
// マーク(太字・リンク等)ごとHTML化してしまい、外側の `**` と内側の `<strong>` が
// 二重になって開く→保存のたびにHTMLが増殖する。また見出し内は `\`+改行で書くため
// ATX見出しが再パースで分裂し、セル末尾のhardBreakは出力されず消えていた。
//
// ここでは「複数行を表現できないコンテキスト(表セル内・見出し内)ではマークを
// 含まない素の<br>を書く(末尾でも落とさない)」「それ以外は既定と同じ
// バックスラッシュ+改行(段落末尾の連続hardBreakは書かない)」とする。
// パース側は raw-block.ts が<br>をエスケープせず通過させることで対になる。

interface SerializerStateLike {
  inTable?: boolean;
  write(content: string): void;
}

export const HardBreakMarkdown = HardBreak.extend({
  addStorage() {
    return {
      markdown: {
        serialize(
          state: SerializerStateLike,
          node: ProseMirrorNode,
          parent: ProseMirrorNode,
          index: number,
        ) {
          if (state.inTable || parent.type.name === 'heading') {
            state.write('<br>');
            return;
          }
          for (let i = index + 1; i < parent.childCount; i++) {
            if (parent.child(i).type !== node.type) {
              state.write('\\\n');
              return;
            }
          }
        },
        parse: {
          // markdown-it側(hardbreakトークンとraw-blockの<br>通過)で処理される
        },
      },
    };
  },
});
