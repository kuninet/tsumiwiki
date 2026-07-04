import { Editor } from '@tiptap/core';
import type { DocSummary } from '@tsumiwiki/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createEditorExtensions } from '../markdown';

const DOCS: DocSummary[] = [
  { path: 'フォルダ/ページ.md', title: 'ページ', folder: 'フォルダ', updatedAt: 't' },
  { path: '別文書.md', title: '別文書', folder: '', updatedAt: 't' },
];

// Suggestionプラグインのview().updateはitems()をawaitする非同期関数のため、
// insertContent後はマイクロタスクが解決するまで1tick待つ必要がある
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('WikilinkSuggestion', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('[[入力で候補ポップアップが表示され、候補をクリックするとwikilinkノードが挿入される', async () => {
    const editor = new Editor({
      extensions: createEditorExtensions({ nodeViews: false, getWikilinkDocs: () => DOCS }),
      content: '',
    });

    editor.commands.insertContent('[[ペ');
    await flushMicrotasks();

    const popup = document.querySelector('.wikilink-suggestion-popup');
    expect(popup).toBeTruthy();
    expect(popup?.textContent).toContain('ページ');

    const item = popup!.querySelector('.wikilink-suggestion-item') as HTMLButtonElement;
    item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    const markdown = (editor.storage.markdown.getMarkdown() as string).trim();
    expect(markdown).toBe('[[フォルダ/ページ]]');

    editor.destroy();
  });

  it('一致する文書がない場合は空である旨を表示する', async () => {
    const editor = new Editor({
      extensions: createEditorExtensions({ nodeViews: false, getWikilinkDocs: () => DOCS }),
      content: '',
    });

    editor.commands.insertContent('[[存在しない文書名');
    await flushMicrotasks();

    const popup = document.querySelector('.wikilink-suggestion-popup');
    expect(popup?.textContent).toContain('一致する文書がありません');

    editor.destroy();
  });

  it('Escapeでポップアップが閉じる', async () => {
    const editor = new Editor({
      extensions: createEditorExtensions({ nodeViews: false, getWikilinkDocs: () => DOCS }),
      content: '',
    });

    editor.commands.insertContent('[[ペ');
    await flushMicrotasks();
    expect(document.querySelector('.wikilink-suggestion-popup')).toBeTruthy();

    editor.view.dom.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );

    expect(document.querySelector('.wikilink-suggestion-popup')).toBeNull();

    editor.destroy();
  });
});
