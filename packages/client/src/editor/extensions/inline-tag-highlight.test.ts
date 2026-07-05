import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { describe, expect, it } from 'vitest';
import { InlineTagHighlight, inlineTagPluginKey } from './inline-tag-highlight';

function editorWith(text: string): Editor {
  return new Editor({
    element: undefined,
    extensions: [StarterKit, InlineTagHighlight],
    content: text,
  });
}

function decorationsIn(editor: Editor): { from: number; to: number }[] {
  const set = inlineTagPluginKey.getState(editor.state);
  if (!set) return [];
  // DecorationSet.find は全 Decoration を返す
  return set.find().map((d) => ({ from: d.from, to: d.to }));
}

describe('InlineTagHighlight', () => {
  it('段落中の #タグ 1つを検出する', () => {
    const editor = editorWith('<p>ここは #日記 について</p>');
    const decs = decorationsIn(editor);
    expect(decs.length).toBe(1);
  });

  it('複数の #タグ を検出する(空白区切り)', () => {
    const editor = editorWith('<p>#日記 と #技術 と #AI連携</p>');
    const decs = decorationsIn(editor);
    expect(decs.length).toBe(3);
  });

  it('数字のみのタグ #123 は無視する', () => {
    const editor = editorWith('<p>#日記 #123</p>');
    const decs = decorationsIn(editor);
    expect(decs.length).toBe(1);
  });

  it('見出し先頭の # は装飾しない(パースが h1 になるため)', () => {
    // <h1>見出し</h1> になるので、そこにはタグ判定対象の #テキスト が存在しない
    const editor = editorWith('<h1>見出し</h1><p>#タグ</p>');
    const decs = decorationsIn(editor);
    expect(decs.length).toBe(1);
  });
});
