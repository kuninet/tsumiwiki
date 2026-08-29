import { getHTMLFromFragment } from '@tiptap/core';
import Table from '@tiptap/extension-table';
import { Fragment, type Node as ProseMirrorNode } from '@tiptap/pm/model';

// issue #235: 表のMarkdownシリアライズを置き換える(tiptap-markdown既定の実装を踏襲しつつ、
// 以下の3点を修正する)。
//
// tiptap-markdown既定(node_modules/tiptap-markdown/dist/tiptap-markdown.es.js のTable$1)は
// セル内容を`state.renderInline(cellContent)`でそのまま書き出すだけで、セル内の`|`を
// エスケープしない。markdown-itのGFM表(rules_block/table.mjsのescapedSplit)はコードスパンや
// リンクなど文脈を一切考慮せず、バックスラッシュでエスケープされていない`|`を全てセル区切りとして
// 扱うため、以下が往復で壊れていた:
//   1. セル内の生テキストにある`|`(エスケープが失われセルが分割される)
//   2. セル内インラインコードにある`|`(同上。既定はコードスパンの中まで見ない)
//   3. テキストを含まないセル(`<br>`のみ・画像のみ・埋め込みのみ等)が
//      `cellContent.textContent.trim()`の判定でスキップされ、内容ごと消える
//
// 対応方針:
//   - 1・2はセルの描画結果(state.out)からセル分だけを切り出し、含まれる`|`を全て`\|`に
//     置換する(既定のstate.esc()は`|`を対象にしないため、renderInline後にまとめて処理する)。
//     markdown-it側のescapedSplitはエスケープされた`|`のバックスラッシュを取り除いた上で
//     セル内容の一部として残すため、コードスパンの中であっても`\|`と書けば再パース後は
//     ちゃんと`|`に戻る(実測で確認済み。GFM仕様上もコードスパンはバックスラッシュエスケープを
//     解釈しないが、markdown-it側の行分割はバックスラッシュの有無しか見ないため、この位置での
//     エスケープが結果的に正しい)。
//   - 3は「セルにテキストがあるか」ではなく「セルにインライン内容(ノード)があるか」
//     (`cellContent.content.size > 0`)で判定する。hardBreak・画像・埋め込み・wikilinkのような
//     テキストを持たないatomノードだけのセルも出力されるようになる。
//   - HTMLフォールバック(1行目が全てtableHeader・body側にtableHeaderがない・
//     colspan/rowspan=1・セルは単一ブロックという条件を満たさない表はHTML表として出力する)は
//     既定のisMarkdownSerializable判定とHTMLNodeのシリアライズをそのまま再現し、挙動を変えない。

interface MarkdownSerializerStateLike {
  out: string;
  inTable?: boolean;
  write(content: string): void;
  ensureNewLine(): void;
  closeBlock(node: ProseMirrorNode): void;
  renderInline(parent: ProseMirrorNode): void;
}

interface MarkdownSerializeContext {
  editor: {
    storage: { markdown: { options: { html?: boolean } } };
  };
}

// セルの描画結果に含まれる`|`を`\|`へエスケープする(既定のstate.esc()は対象外のため)
function escapeCellPipes(text: string): string {
  return text.replace(/\|/g, '\\|');
}

function hasSpan(cell: ProseMirrorNode): boolean {
  return cell.attrs.colspan > 1 || cell.attrs.rowspan > 1;
}

// tiptap-markdown既定のisMarkdownSerializableと同じ判定(HTMLフォールバックの条件)
function isMarkdownSerializableTable(node: ProseMirrorNode): boolean {
  const rows: ProseMirrorNode[] = [];
  node.forEach((row) => rows.push(row));
  const firstRow = rows[0];
  const bodyRows = rows.slice(1);

  const firstRowCells: ProseMirrorNode[] = [];
  firstRow?.forEach((cell) => firstRowCells.push(cell));
  if (
    firstRowCells.some(
      (cell) => cell.type.name !== 'tableHeader' || hasSpan(cell) || cell.childCount > 1,
    )
  ) {
    return false;
  }

  if (
    bodyRows.some((row) => {
      const cells: ProseMirrorNode[] = [];
      row.forEach((cell) => cells.push(cell));
      return cells.some(
        (cell) => cell.type.name === 'tableHeader' || hasSpan(cell) || cell.childCount > 1,
      );
    })
  ) {
    return false;
  }

  return true;
}

// tiptap-markdown既定のHTMLNode.serializeと同じ変換(formatBlock/elementFromString相当)
function formatTopLevelBlockHtml(html: string): string {
  const wrapped = `<body>${html}</body>`;
  const body = new window.DOMParser().parseFromString(wrapped, 'text/html').body;
  const element = body.firstElementChild;
  if (!element) return html;
  element.innerHTML = element.innerHTML.trim() ? `\n${element.innerHTML}\n` : `\n`;
  return element.outerHTML;
}

function serializeTableAsHtml(
  this: MarkdownSerializeContext,
  state: MarkdownSerializerStateLike,
  node: ProseMirrorNode,
  parent: ProseMirrorNode | Fragment,
): void {
  if (!this.editor.storage.markdown.options.html) {
    console.warn('Tiptap Markdown: "table" node is only available in html mode');
    state.write('[table]');
  } else {
    const schema = node.type.schema;
    const html = getHTMLFromFragment(Fragment.from(node), schema);
    const isTopLevel = parent instanceof Fragment || parent.type.name === schema.topNodeType.name;
    state.write(isTopLevel ? formatTopLevelBlockHtml(html) : html);
  }
  state.closeBlock(node);
}

export const TableMarkdown = Table.extend({
  addStorage() {
    return {
      markdown: {
        serialize(
          this: MarkdownSerializeContext,
          state: MarkdownSerializerStateLike,
          node: ProseMirrorNode,
          parent: ProseMirrorNode | Fragment,
        ) {
          if (!isMarkdownSerializableTable(node)) {
            serializeTableAsHtml.call(this, state, node, parent);
            return;
          }
          state.inTable = true;
          node.forEach((row, _rowOffset, rowIndex) => {
            state.write('| ');
            row.forEach((col, _colOffset, colIndex) => {
              if (colIndex) {
                state.write(' | ');
              }
              const cellContent = col.firstChild;
              // #235: テキストが無くてもインライン内容(hardBreak・画像・埋め込み等)があれば出力する
              if (cellContent && cellContent.content.size > 0) {
                const cellStart = state.out.length;
                state.renderInline(cellContent);
                // out の書き換えは renderInline 完了時点(inlines のオフセット記録が
                // すべて解決・pop 済み)だから安全。tiptap-markdown 更新時は要再確認。
                // パイプを含まないセルではスライス連結(O(出力長))を省略する
                if (state.out.indexOf('|', cellStart) >= 0) {
                  state.out =
                    state.out.slice(0, cellStart) + escapeCellPipes(state.out.slice(cellStart));
                }
              }
            });
            state.write(' |');
            state.ensureNewLine();
            if (!rowIndex) {
              const delimiterRow = Array.from({ length: row.childCount })
                .map(() => '---')
                .join(' | ');
              state.write(`| ${delimiterRow} |`);
              state.ensureNewLine();
            }
          });
          state.closeBlock(node);
          state.inTable = false;
        },
        parse: {
          // handled by markdown-it (パースはmarkdown-it側の既定のGFM表ルールに任せる)
        },
      },
    };
  },
});
