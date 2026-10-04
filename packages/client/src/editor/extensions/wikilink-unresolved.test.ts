import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import type { DocSummary } from '@tsumiwiki/shared';
import { describe, expect, it } from 'vitest';
import { Wikilink } from './wikilink';
import {
  WIKILINK_DOCS_CHANGED_META,
  WikilinkUnresolved,
  wikilinkUnresolvedPluginKey,
} from './wikilink-unresolved';

function createEditor(content: string, getDocs: () => DocSummary[]): Editor {
  return new Editor({
    element: undefined,
    extensions: [
      StarterKit,
      Wikilink,
      WikilinkUnresolved.configure({ getDocs }),
    ],
    content,
  });
}

function getUnresolvedDecorations(editor: Editor) {
  const set = wikilinkUnresolvedPluginKey.getState(editor.state);
  if (!set) return [];
  return set.find().map((d) => ({
    from: d.from,
    to: d.to,
    spec: d.spec,
    attrs: (d as unknown as { type: { attrs: Record<string, string> } }).type?.attrs,
  }));
}

function doc(path: string, title: string): DocSummary {
  return { path, title, folder: '', updatedAt: '2026-01-01' };
}

describe('WikilinkUnresolved', () => {
  it('存在しないリンク先にis-unresolvedデコレーションを付与する', () => {
    const docs = [doc('existing.md', 'existing')];
    const html = '<p><span data-type="wikilink" data-target="missing">missing</span></p>';
    const editor = createEditor(html, () => docs);

    const decs = getUnresolvedDecorations(editor);
    expect(decs).toHaveLength(1);
    expect(decs[0].attrs?.class).toContain('is-unresolved');
    expect(decs[0].attrs?.title).toBe('リンク先が存在しません');
    editor.destroy();
  });

  it('存在するリンク先にはデコレーションを付与しない', () => {
    const docs = [doc('existing.md', 'existing')];
    const html = '<p><span data-type="wikilink" data-target="existing">existing</span></p>';
    const editor = createEditor(html, () => docs);

    const decs = getUnresolvedDecorations(editor);
    expect(decs).toHaveLength(0);
    editor.destroy();
  });

  it('見出し付きリンク([[existing#sec]])は対象文書が存在すれば解決される', () => {
    const docs = [doc('existing.md', 'existing')];
    const html = '<p><span data-type="wikilink" data-target="existing#sec">existing</span></p>';
    const editor = createEditor(html, () => docs);

    const decs = getUnresolvedDecorations(editor);
    expect(decs).toHaveLength(0);
    editor.destroy();
  });

  it('自文書内見出しリンク([[#見出し]])は未解決にしない', () => {
    const docs: DocSummary[] = [];
    const html = '<p><span data-type="wikilink" data-target="#見出し">#見出し</span></p>';
    const editor = createEditor(html, () => docs);

    const decs = getUnresolvedDecorations(editor);
    expect(decs).toHaveLength(0);
    editor.destroy();
  });

  it('WIKILINK_DOCS_CHANGED_METAのdispatchで文書追加時に未解決が解除される', () => {
    let docs: DocSummary[] = [];
    const html = '<p><span data-type="wikilink" data-target="new-doc">new-doc</span></p>';
    const editor = createEditor(html, () => docs);

    expect(getUnresolvedDecorations(editor)).toHaveLength(1);

    // 新規文書が追加された
    docs = [doc('new-doc.md', 'new-doc')];
    const tr = editor.state.tr.setMeta(WIKILINK_DOCS_CHANGED_META, true);
    editor.view.dispatch(tr);

    expect(getUnresolvedDecorations(editor)).toHaveLength(0);
    editor.destroy();
  });

  it('docChanged(文字入力)時にもdocs参照が同一であればキャッシュを活用して状態が維持される', () => {
    const docs = [doc('existing.md', 'existing')];
    const html = '<p><span data-type="wikilink" data-target="missing">missing</span></p>';
    const editor = createEditor(html, () => docs);

    expect(getUnresolvedDecorations(editor)).toHaveLength(1);

    // テキスト挿入(docChanged: true)
    editor.commands.insertContent('追加テキスト');

    const decs = getUnresolvedDecorations(editor);
    expect(decs).toHaveLength(1);
    expect(decs[0].attrs?.class).toContain('is-unresolved');
    editor.destroy();
  });
});
