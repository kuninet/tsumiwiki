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

// #234: ClipboardItem対応環境ではtext/plain(Markdown)+text/html(HTML表)の両方を書き込む。
// エディタへのCmd+V貼り付けはtext/html経由で表に戻る
describe('copyTableToClipboard(ClipboardItem対応環境)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    // @ts-expect-error テスト用に定義したプロパティを剥がす
    delete navigator.clipboard;
  });

  // jsdomのBlobにはtext()が無いためFileReaderで読む(値はPromiseで渡される)
  async function blobText(blob: Blob | Promise<Blob>): Promise<string> {
    const resolved = await blob;
    return new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.readAsText(resolved);
    });
  }

  function stubClipboardItem() {
    class FakeClipboardItem {
      items: Record<string, Blob | Promise<Blob>>;
      constructor(items: Record<string, Blob | Promise<Blob>>) {
        this.items = items;
      }
    }
    vi.stubGlobal('ClipboardItem', FakeClipboardItem);
    return FakeClipboardItem;
  }

  it('execCommandが使える環境では同期のcopyイベント経路を最優先する(#238)', async () => {
    stubClipboardItem();
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { write, writeText: vi.fn() },
      configurable: true,
    });
    // jsdomにexecCommandは無いため、copyイベントを発火する実装を模擬する
    const setData = vi.fn();
    (document as unknown as { execCommand: () => boolean }).execCommand = () => {
      const ev = new Event('copy');
      (ev as unknown as { clipboardData: unknown }).clipboardData = {
        setData,
      };
      document.dispatchEvent(ev);
      return true;
    };

    const editor = createDocWithTable();
    placeCursorInsideTable(editor);
    try {
      await expect(copyTableToClipboard(editor)).resolves.toBe(true);
      // 同期経路で書き込まれ、async Clipboard APIは呼ばれない
      expect(write).not.toHaveBeenCalled();
      expect(setData).toHaveBeenCalledWith('text/plain', expect.stringContaining('| --- |'));
      expect(setData).toHaveBeenCalledWith('text/html', expect.stringContaining('<table'));
      // 一時textareaが残っていない
      expect(document.querySelector('textarea')).toBeNull();
    } finally {
      delete (document as unknown as { execCommand?: unknown }).execCommand;
      editor.destroy();
    }
  });

  it('execCommandがfalseを返したらasync Clipboard APIへフォールバックする', async () => {
    stubClipboardItem();
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { write, writeText: vi.fn() },
      configurable: true,
    });
    (document as unknown as { execCommand: () => boolean }).execCommand = () => false;

    const editor = createDocWithTable();
    placeCursorInsideTable(editor);
    try {
      await expect(copyTableToClipboard(editor)).resolves.toBe(true);
      expect(write).toHaveBeenCalledTimes(1);
    } finally {
      delete (document as unknown as { execCommand?: unknown }).execCommand;
      editor.destroy();
    }
  });

  it('text/plainのMarkdownとtext/htmlのHTML表の両方を書き込む', async () => {
    stubClipboardItem();
    const write = vi.fn().mockResolvedValue(undefined);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { write, writeText },
      configurable: true,
    });

    const editor = createDocWithTable();
    placeCursorInsideTable(editor);
    await expect(copyTableToClipboard(editor)).resolves.toBe(true);

    expect(write).toHaveBeenCalledTimes(1);
    expect(writeText).not.toHaveBeenCalled();
    const item = write.mock.calls[0][0][0] as { items: Record<string, Blob | Promise<Blob>> };
    const plain = await blobText(item.items['text/plain']);
    const html = await blobText(item.items['text/html']);
    expect(plain).toContain('| --- |');
    expect(html).toContain('<table');
    expect(html).toContain('<th');
    expect(html).toContain('あ');
    editor.destroy();
  });

  it('書き込んだtext/htmlをpasteHTMLで貼り付けると表ノードになりGFMを維持する', async () => {
    stubClipboardItem();
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { write, writeText: vi.fn() },
      configurable: true,
    });

    const editor = createDocWithTable();
    placeCursorInsideTable(editor);
    await copyTableToClipboard(editor);
    const item = write.mock.calls[0][0][0] as { items: Record<string, Blob | Promise<Blob>> };
    const html = await blobText(item.items['text/html']);

    // ProseMirrorの実ペースト経路(clipboardのtext/html)と同じHTMLパースを通す。
    // jsdomにはClipboardEventが無いためpasteHTMLが内部生成する分だけスタブする
    vi.stubGlobal(
      'ClipboardEvent',
      class extends Event {
        clipboardData: unknown;
        constructor(type: string, init?: { clipboardData?: unknown } & EventInit) {
          super(type, init);
          this.clipboardData = init?.clipboardData ?? null;
        }
      },
    );
    const target = new Editor({
      extensions: createEditorExtensions({ nodeViews: false }),
      content: '貼り付け先\n',
    });
    target.commands.setTextSelection(target.state.doc.content.size - 1);
    (target.view as unknown as { pasteHTML: (html: string) => boolean }).pasteHTML(html);

    let tableCount = 0;
    target.state.doc.descendants((n) => {
      if (n.type.name === 'table') tableCount++;
      return true;
    });
    expect(tableCount).toBe(1);
    const md = target.storage.markdown.getMarkdown() as string;
    expect(md).toContain('| --- |');
    expect(md).not.toContain('<table');
    target.destroy();
    editor.destroy();
  });

  it('ClipboardItemはあるがclipboard.writeが無い環境ではwriteTextを使う', async () => {
    stubClipboardItem();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    const editor = createDocWithTable();
    placeCursorInsideTable(editor);
    await expect(copyTableToClipboard(editor)).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledTimes(1);
    editor.destroy();
  });

  it('カットも両タイプを書き込み、表が消える', async () => {
    stubClipboardItem();
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { write, writeText: vi.fn() },
      configurable: true,
    });

    const editor = createDocWithTable();
    placeCursorInsideTable(editor);
    await expect(cutTableToClipboard(editor)).resolves.toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    const item = write.mock.calls[0][0][0] as { items: Record<string, Blob | Promise<Blob>> };
    expect(Object.keys(item.items).sort()).toEqual(['text/html', 'text/plain']);
    let hasTable = false;
    editor.state.doc.descendants((n) => {
      if (n.type.name === 'table') hasTable = true;
    });
    expect(hasTable).toBe(false);
    editor.destroy();
  });

  it('リッチなセル(太字+wikilink)でもHTML経路とMarkdown経路の結果が一致する', async () => {
    stubClipboardItem();
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { write, writeText: vi.fn() },
      configurable: true,
    });

    const editor = new Editor({
      extensions: createEditorExtensions({ nodeViews: false }),
      content: '| A |\n| --- |\n| **太字**と[[リンク先]] |\n',
    });
    placeCursorInsideTable(editor);
    await copyTableToClipboard(editor);
    const item = write.mock.calls[0][0][0] as { items: Record<string, Blob | Promise<Blob>> };
    const plain = await blobText(item.items['text/plain']);
    const html = await blobText(item.items['text/html']);

    vi.stubGlobal(
      'ClipboardEvent',
      class extends Event {
        clipboardData: unknown;
        constructor(type: string, init?: { clipboardData?: unknown } & EventInit) {
          super(type, init);
          this.clipboardData = init?.clipboardData ?? null;
        }
      },
    );
    const target = new Editor({
      extensions: createEditorExtensions({ nodeViews: false }),
      content: '',
    });
    (target.view as unknown as { pasteHTML: (html: string) => boolean }).pasteHTML(html);
    expect((target.storage.markdown.getMarkdown() as string).trim()).toBe(plain.trim());
    expect(plain).toContain('**太字**');
    expect(plain).toContain('[[リンク先]]');
    target.destroy();
    editor.destroy();
  });

  it('write(ClipboardItem)が拒否されたらwriteTextへフォールバックする', async () => {
    stubClipboardItem();
    const write = vi.fn().mockRejectedValue(new Error('not allowed'));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { write, writeText },
      configurable: true,
    });

    const editor = createDocWithTable();
    placeCursorInsideTable(editor);
    await expect(copyTableToClipboard(editor)).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toContain('| --- |');
    editor.destroy();
  });

  it('write・writeTextの両方が失敗したらfalse', async () => {
    stubClipboardItem();
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        write: vi.fn().mockRejectedValue(new Error('x')),
        writeText: vi.fn().mockRejectedValue(new Error('y')),
      },
      configurable: true,
    });

    const editor = createDocWithTable();
    placeCursorInsideTable(editor);
    await expect(copyTableToClipboard(editor)).resolves.toBe(false);
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

  it('カット後のundo 1回で表が復元される', async () => {
    const editor = createDocWithTable();
    placeCursorInsideTable(editor);
    await expect(cutTableToClipboard(editor)).resolves.toBe(true);

    editor.commands.undo();
    const topLevel: string[] = [];
    editor.state.doc.forEach((node) => topLevel.push(node.type.name));
    expect(topLevel).toEqual(['paragraph', 'table', 'paragraph']);
    expect(editor.storage.markdown.getMarkdown()).toContain('| --- |');
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

  it('moveTableDownの連続実行: 末尾に達したらfalseで止まる', () => {
    const editor = createDocWithTable();
    placeCursorInsideTable(editor);
    expect(moveTableDown(editor)).toBe(true);
    expect(moveTableDown(editor)).toBe(false);

    const topLevel: string[] = [];
    editor.state.doc.forEach((node) => topLevel.push(node.type.name));
    expect(topLevel).toEqual(['paragraph', 'paragraph', 'table']);
    editor.destroy();
  });

  it('移動後もカーソルは編集中のセルに留まる', () => {
    const editor = createDocWithTable();
    // 2行目bodyセル「う」にカーソルを置く
    let pos = -1;
    editor.state.doc.descendants((node, p) => {
      if (node.isText && node.text === 'う') pos = p;
      return true;
    });
    editor.commands.setTextSelection(pos);
    expect(moveTableUp(editor)).toBe(true);
    expect(editor.state.selection.$from.parent.textContent).toBe('う');
    editor.destroy();
  });

  it('blockquote内の表はblockquote内の兄弟とだけ入れ替わり、外へ飛び出さない', () => {
    const md = '> 引用段落\n>\n> | 列A | 列B |\n> | --- | --- |\n> | あ | い |\n';
    const editor = new Editor({
      extensions: createEditorExtensions({ nodeViews: false }),
      content: md,
    });
    placeCursorInsideTable(editor);
    expect(moveTableUp(editor)).toBe(true);

    // blockquote内で表が先頭になる
    let blockquoteChildren: string[] = [];
    editor.state.doc.forEach((node) => {
      if (node.type.name === 'blockquote') {
        blockquoteChildren = [];
        node.forEach((child) => blockquoteChildren.push(child.type.name));
      }
    });
    expect(blockquoteChildren).toEqual(['table', 'paragraph']);

    // blockquote先頭からはさらに上へは出ない
    expect(moveTableUp(editor)).toBe(false);
    expect(roundtripMarkdown(editor.storage.markdown.getMarkdown())).toContain('> | --- |');
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
