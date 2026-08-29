import { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEditorExtensions, roundtripMarkdown } from '../markdown';
import {
  copyTableToClipboard,
  cutTableToClipboard,
  findParentTable,
  moveTableDown,
  moveTableUp,
  serializeTableToMarkdown,
} from '../table-block-ops';

// 段落+2列表+段落の文書。カーソル位置を選べるようポジションも返す。
function createDocWithTable() {
  const md = '前の段落\n\n| 列A | 列B |\n| --- | --- |\n| あ | い |\n| う | え |\n\n後の段落\n';
  const editor = new Editor({
    extensions: createEditorExtensions({ nodeViews: false }),
    content: md,
  });
  return editor;
}

// 表セル内にカーソルを置く(文書中の table ノードを直接探し、その内部へ移動する)。
function placeCursorInsideTable(editor: Editor) {
  let tablePos = -1;
  editor.state.doc.descendants((node, pos) => {
    if (tablePos === -1 && node.type.name === 'table') tablePos = pos;
  });
  expect(tablePos).not.toBe(-1);
  const $pos = editor.state.doc.resolve(tablePos + 3); // table -> tableRow -> tableCell/Header の中のテキスト付近
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near($pos)));
}

// 表外(先頭段落)にカーソルを置く。
function placeCursorOutsideTable(editor: Editor) {
  editor.commands.setTextSelection(1);
}

describe('findParentTable / serializeTableToMarkdown', () => {
  it('表内カーソルなら表ノードとその位置を返す', () => {
    const editor = createDocWithTable();
    placeCursorInsideTable(editor);
    const found = findParentTable(editor);
    expect(found).not.toBeNull();
    expect(found!.node.type.name).toBe('table');
    editor.destroy();
  });

  it('表外カーソルなら null', () => {
    const editor = createDocWithTable();
    placeCursorOutsideTable(editor);
    expect(findParentTable(editor)).toBeNull();
    editor.destroy();
  });

  it('表のみのGFM Markdownを返し、前後の段落テキストを含まない', () => {
    const editor = createDocWithTable();
    placeCursorInsideTable(editor);
    const md = serializeTableToMarkdown(editor);
    expect(md).not.toBeNull();
    expect(md).toContain('| --- |');
    expect(md).toContain('あ');
    expect(md).toContain('い');
    expect(md).not.toContain('前の段落');
    expect(md).not.toContain('後の段落');
    editor.destroy();
  });

  it('表外カーソルでは null を返す', () => {
    const editor = createDocWithTable();
    placeCursorOutsideTable(editor);
    expect(serializeTableToMarkdown(editor)).toBeNull();
    editor.destroy();
  });
});

describe('copyTableToClipboard', () => {
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined);
    // jsdomにclipboardは無いため、テスト用に定義する
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
  });

  afterEach(() => {
    // @ts-expect-error テスト用に定義したプロパティを剥がす
    delete navigator.clipboard;
  });

  it('表のMarkdownをクリップボードへ書き込み、trueを返す', async () => {
    const editor = createDocWithTable();
    placeCursorInsideTable(editor);
    const result = await copyTableToClipboard(editor);
    expect(result).toBe(true);
    expect(writeText).toHaveBeenCalledTimes(1);
    const written = writeText.mock.calls[0][0] as string;
    expect(written).toContain('| --- |');
    expect(written).toContain('あ');
    editor.destroy();
  });

  it('表外カーソルではクリップボードに触れずfalseを返す', async () => {
    const editor = createDocWithTable();
    placeCursorOutsideTable(editor);
    const result = await copyTableToClipboard(editor);
    expect(result).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
    editor.destroy();
  });

  it('クリップボードが失敗した場合はfalseを返す(例外を漏らさない)', async () => {
    writeText.mockRejectedValueOnce(new Error('permission denied'));
    const editor = createDocWithTable();
    placeCursorInsideTable(editor);
    await expect(copyTableToClipboard(editor)).resolves.toBe(false);
    editor.destroy();
  });
});

describe('cutTableToClipboard', () => {
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
  });

  afterEach(() => {
    // @ts-expect-error テスト用に定義したプロパティを剥がす
    delete navigator.clipboard;
  });

  it('コピー内容に加え、文書から表が消える', async () => {
    const editor = createDocWithTable();
    placeCursorInsideTable(editor);
    const result = await cutTableToClipboard(editor);
    expect(result).toBe(true);
    expect(writeText).toHaveBeenCalledTimes(1);
    const written = writeText.mock.calls[0][0] as string;
    expect(written).toContain('あ');

    let hasTable = false;
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'table') hasTable = true;
    });
    expect(hasTable).toBe(false);
    expect(editor.storage.markdown.getMarkdown()).toContain('前の段落');
    expect(editor.storage.markdown.getMarkdown()).toContain('後の段落');
    editor.destroy();
  });

  it('クリップボードが失敗した場合は表を削除せずfalseを返す', async () => {
    writeText.mockRejectedValueOnce(new Error('permission denied'));
    const editor = createDocWithTable();
    placeCursorInsideTable(editor);
    const result = await cutTableToClipboard(editor);
    expect(result).toBe(false);

    let hasTable = false;
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'table') hasTable = true;
    });
    expect(hasTable).toBe(true);
    editor.destroy();
  });

  it('await中に文書が変わったら削除せずfalseを返す(位置ズレによる本文破損の防止)', async () => {
    // クリップボード書き込みのawait中(権限プロンプト等)に文書が変わると、事前に取った
    // 位置が別範囲を指して本文を破損しうる。削除前に表を取り直し、対象を見失ったら
    // 何も消さないことを保証する(insertContentAtはカーソルを挿入先へ移すため表外になる)
    const editor = createDocWithTable();
    placeCursorInsideTable(editor);
    let resolveWrite!: () => void;
    writeText.mockReturnValueOnce(new Promise<void>((resolve) => (resolveWrite = resolve)));
    const cutPromise = cutTableToClipboard(editor);
    editor.commands.insertContentAt(0, '割り込み段落\n\n');
    resolveWrite();
    await expect(cutPromise).resolves.toBe(false);

    const md = editor.storage.markdown.getMarkdown() as string;
    expect(md).toContain('割り込み段落');
    expect(md).toContain('前の段落');
    expect(md).toContain('後の段落');
    expect(md).toContain('| --- |'); // 表は残る(何も削除されない)
    editor.destroy();
  });

  it('表外カーソルではfalseを返す', async () => {
    const editor = createDocWithTable();
    placeCursorOutsideTable(editor);
    const result = await cutTableToClipboard(editor);
    expect(result).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
    editor.destroy();
  });
});

describe('moveTableUp / moveTableDown', () => {
  it('moveTableUp: 段落A・表・段落B が 表・段落A・段落B になる', () => {
    const editor = createDocWithTable();
    placeCursorInsideTable(editor);
    const result = moveTableUp(editor);
    expect(result).toBe(true);

    const topLevel: string[] = [];
    editor.state.doc.forEach((node) => topLevel.push(node.type.name));
    expect(topLevel).toEqual(['table', 'paragraph', 'paragraph']);

    // 移動後もカーソルが表内にある
    const found = findParentTable(editor);
    expect(found).not.toBeNull();

    const md = roundtripMarkdown(editor.storage.markdown.getMarkdown());
    expect(roundtripMarkdown(md)).toBe(md); // 冪等性

    editor.commands.undo();
    const afterUndo: string[] = [];
    editor.state.doc.forEach((node) => afterUndo.push(node.type.name));
    expect(afterUndo).toEqual(['paragraph', 'table', 'paragraph']);
    editor.destroy();
  });

  it('moveTableDown: 段落A・表・段落B が 段落A・段落B・表 になる', () => {
    const editor = createDocWithTable();
    placeCursorInsideTable(editor);
    const result = moveTableDown(editor);
    expect(result).toBe(true);

    const topLevel: string[] = [];
    editor.state.doc.forEach((node) => topLevel.push(node.type.name));
    expect(topLevel).toEqual(['paragraph', 'paragraph', 'table']);

    const found = findParentTable(editor);
    expect(found).not.toBeNull();

    const md = roundtripMarkdown(editor.storage.markdown.getMarkdown());
    expect(roundtripMarkdown(md)).toBe(md);

    editor.commands.undo();
    const afterUndo: string[] = [];
    editor.state.doc.forEach((node) => afterUndo.push(node.type.name));
    expect(afterUndo).toEqual(['paragraph', 'table', 'paragraph']);
    editor.destroy();
  });

  it('文書先頭の表ではmoveTableUpはfalseで無変化', () => {
    const md = '| 列A | 列B |\n| --- | --- |\n| あ | い |\n\n後の段落\n';
    const editor = new Editor({
      extensions: createEditorExtensions({ nodeViews: false }),
      content: md,
    });
    placeCursorInsideTable(editor);
    const before = editor.state.doc.toJSON();
    const result = moveTableUp(editor);
    expect(result).toBe(false);
    expect(editor.state.doc.toJSON()).toEqual(before);
    editor.destroy();
  });

  it('文書末尾の表ではmoveTableDownはfalseで無変化', () => {
    const md = '前の段落\n\n| 列A | 列B |\n| --- | --- |\n| あ | い |\n';
    const editor = new Editor({
      extensions: createEditorExtensions({ nodeViews: false }),
      content: md,
    });
    placeCursorInsideTable(editor);
    const before = editor.state.doc.toJSON();
    const result = moveTableDown(editor);
    expect(result).toBe(false);
    expect(editor.state.doc.toJSON()).toEqual(before);
    editor.destroy();
  });

  it('表外カーソルではmoveTableUp/Downともにfalse', () => {
    const editor = createDocWithTable();
    placeCursorOutsideTable(editor);
    expect(moveTableUp(editor)).toBe(false);
    expect(moveTableDown(editor)).toBe(false);
    editor.destroy();
  });
});

describe('ペースト経路相当での挿入(insertContentAt)', () => {
  it('シリアライズした表Markdownを insertContentAt で挿入すると表ノードになる', () => {
    const editor = createDocWithTable();
    placeCursorInsideTable(editor);
    const tableMarkdown = serializeTableToMarkdown(editor);
    expect(tableMarkdown).not.toBeNull();

    // tiptap-markdown が上書きする insertContentAt は文字列をMarkdownとしてパースする
    // (paste時の clipboardTextParser と同じ MarkdownParser#parse を経由する)
    const target = new Editor({
      extensions: createEditorExtensions({ nodeViews: false }),
      content: '<p></p>',
    });
    target.commands.insertContentAt(1, tableMarkdown as string);

    let inserted: ReturnType<typeof target.state.doc.nodeAt> = null;
    let found = false;
    target.state.doc.descendants((node) => {
      if (node.type.name === 'table') {
        found = true;
        inserted = node;
      }
    });
    expect(found).toBe(true);
    expect(target.storage.markdown.getMarkdown()).toContain('あ');
    expect(target.storage.markdown.getMarkdown()).toContain('い');
    void inserted;

    target.destroy();
    editor.destroy();
  });
});
