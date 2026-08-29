import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createEditorExtensions, roundtripMarkdown } from '../markdown';

// #229: 表のセル内改行(hardBreak)は<br>としてシリアライズされる。
// これが再パースで「<br>」というテキストに化けず、改行として往復することを保証する

let editor: Editor;

afterEach(() => {
  editor.destroy();
});

function newEditor(content: string): Editor {
  editor = new Editor({ extensions: createEditorExtensions({ nodeViews: false }), content });
  return editor;
}

function countHardBreaks(e: Editor): number {
  let n = 0;
  e.state.doc.descendants((node) => {
    if (node.type.name === 'hardBreak') n++;
    return true;
  });
  return n;
}

describe('表のセル内改行(#229)', () => {
  it('セル内の<br>はhardBreakノードとしてパースされる(テキストに化けない)', () => {
    newEditor('| A |\n| --- |\n| 1行目<br>2行目 |\n');
    expect(countHardBreaks(editor)).toBe(1);
    expect(editor.getText()).not.toContain('<br>');
  });

  it('<br/>・<BR>のバリアントも改行として扱う', () => {
    newEditor('| A |\n| --- |\n| 1<br/>2<BR>3<br />4 |\n');
    expect(countHardBreaks(editor)).toBe(3);
  });

  it('セル内hardBreakの往復が冪等(<br>のまま保存される)', () => {
    const md = '| A |\n| --- |\n| 1行目<br>2行目 |\n';
    const pass1 = roundtripMarkdown(md);
    expect(pass1).toContain('<br>');
    expect(pass1).not.toContain('&lt;br&gt;');
    expect(roundtripMarkdown(pass1)).toBe(pass1);
  });

  it('エディタでセルに改行を入力→保存→再表示でも改行が維持される', () => {
    newEditor('| A |\n| --- |\n| 1 |\n');
    let pos = -1;
    editor.state.doc.descendants((n, p) => {
      if (n.isText && n.text === '1') pos = p;
      return true;
    });
    editor.commands.setTextSelection(pos + 1);
    editor.commands.setHardBreak();
    editor.commands.insertContent('2行目');
    const saved = editor.storage.markdown.getMarkdown() as string;
    expect(saved).toContain('| 1<br>2行目 |');

    const reopened = newEditor(saved);
    expect(countHardBreaks(reopened)).toBe(1);
    expect(reopened.storage.markdown.getMarkdown()).toBe(saved);
  });

  it('段落内の<br>も改行になり、hardBreakのMarkdown記法(バックスラッシュ改行)で安定する', () => {
    const pass1 = roundtripMarkdown('前<br>後\n');
    expect(pass1).toBe('前\\\n後');
    expect(roundtripMarkdown(pass1)).toBe(pass1);
  });

  it('<br>以外のインラインHTMLは従来どおりテキストとして保全される(回帰)', () => {
    newEditor('本文に<span>タグ</span>がある\n');
    expect(editor.getText()).toContain('<span>タグ</span>');
    expect(countHardBreaks(editor)).toBe(0);
  });
});
