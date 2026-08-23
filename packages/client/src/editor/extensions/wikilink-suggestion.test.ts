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

// jsdomではnavigator.platformがMacではないため、tiptapのModはCtrlに解決される。
// keyは小文字'k'にすること(大文字'K'だとprosemirror-keymapがkeyCode経由の解決になりjsdomで不安定)
function pressShortcut(editor: Editor) {
  editor.view.dom.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'k',
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
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

  it('#195: ポップアップ内スクロールでは popup が閉じない、外側スクロールでは閉じずに位置を追従する', async () => {
    const editor = new Editor({
      extensions: createEditorExtensions({ nodeViews: false, getWikilinkDocs: () => DOCS }),
      content: '',
    });
    editor.commands.insertContent('[[');
    await flushMicrotasks();
    const popup = document.querySelector('.wikilink-suggestion-popup') as HTMLElement;
    expect(popup).toBeTruthy();

    // popup 内部の scroll イベントは無視される(popup 存続)
    const item = popup.querySelector('.wikilink-suggestion-item')!;
    item.dispatchEvent(new Event('scroll', { bubbles: true }));
    expect(document.querySelector('.wikilink-suggestion-popup')).toBeTruthy();

    // ドキュメント本体の scroll では閉じない(位置を追従するだけ)。
    // 実機で「popup 表示直後の scroll イベントで消えてしまい、以降 Esc もショートカットも
    // 効かなくなる」不具合があったための修正(#195)
    document.body.dispatchEvent(new Event('scroll', { bubbles: true }));
    expect(document.querySelector('.wikilink-suggestion-popup')).toBeTruthy();

    editor.destroy();
  });

  it('#151: ヘッダに現在の絞り込み query が表示される', async () => {
    const editor = new Editor({
      extensions: createEditorExtensions({ nodeViews: false, getWikilinkDocs: () => DOCS }),
      content: '',
    });
    editor.commands.insertContent('[[ペ');
    await flushMicrotasks();
    const header = document.querySelector('.wikilink-suggestion-header');
    expect(header?.textContent).toContain('絞り込み: ペ');
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

  it('#195: 直前が文字でも [[ で発火する', async () => {
    const editor = new Editor({
      extensions: createEditorExtensions({ nodeViews: false, getWikilinkDocs: () => DOCS }),
      content: '',
    });

    editor.commands.insertContent('詳細は[[ペ');
    await flushMicrotasks();

    const popup = document.querySelector('.wikilink-suggestion-popup');
    expect(popup).toBeTruthy();
    expect(popup?.textContent).toContain('ページ');

    editor.destroy();
  });

  it('#195: Esc 後に入力を続けるとテキストが変わるので再表示される', async () => {
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

    // dismiss は「位置+その時点のテキスト」で判定するため、文字を追加してテキストが変わると
    // 再表示される(VS Codeと同じ挙動。#195)
    editor.commands.insertContent('ー');
    await flushMicrotasks();
    expect(document.querySelector('.wikilink-suggestion-popup')).toBeTruthy();

    editor.destroy();
  });

  it('#195: Esc 後に別の位置で [[ を打つと開く', async () => {
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

    // 段落を分けて別の位置で [[ を打つ→dismiss情報のfromと一致しないため開く
    editor.commands.enter();
    editor.commands.insertContent('[[別');
    await flushMicrotasks();
    expect(document.querySelector('.wikilink-suggestion-popup')).toBeTruthy();

    editor.destroy();
  });

  it('#195: Esc で閉じた後にショートカットで再表示され、絞り込み語が維持される', async () => {
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

    pressShortcut(editor);
    await flushMicrotasks();

    const popup = document.querySelector('.wikilink-suggestion-popup');
    expect(popup).toBeTruthy();
    const header = popup?.querySelector('.wikilink-suggestion-header');
    expect(header?.textContent).toContain('絞り込み: ペ');

    editor.destroy();
  });

  it('#195: 全角 ［［ で入力した場合はショートカットで半角に正規化して開く', async () => {
    const editor = new Editor({
      extensions: createEditorExtensions({ nodeViews: false, getWikilinkDocs: () => DOCS }),
      content: '',
    });

    editor.commands.insertContent('［［ペ');
    await flushMicrotasks();
    expect(document.querySelector('.wikilink-suggestion-popup')).toBeNull();

    pressShortcut(editor);
    await flushMicrotasks();

    const popup = document.querySelector('.wikilink-suggestion-popup');
    expect(popup).toBeTruthy();
    const header = popup?.querySelector('.wikilink-suggestion-header');
    expect(header?.textContent).toContain('絞り込み: ペ');
    const text = editor.getText();
    expect(text).toContain('[[ペ');
    expect(text).not.toContain('［［');

    editor.destroy();
  });

  it('#195: 開きかけの [[ が無ければ [[ を挿入して空クエリで開く', async () => {
    const editor = new Editor({
      extensions: createEditorExtensions({ nodeViews: false, getWikilinkDocs: () => DOCS }),
      content: '',
    });

    editor.commands.insertContent('abc');
    await flushMicrotasks();

    pressShortcut(editor);
    await flushMicrotasks();

    expect(editor.getText().endsWith('abc[[')).toBe(true);
    const popup = document.querySelector('.wikilink-suggestion-popup');
    const header = popup?.querySelector('.wikilink-suggestion-header');
    expect(header?.textContent).toContain('文字入力で絞り込み');

    editor.destroy();
  });

  it('#195: 範囲選択中は選択テキストを絞り込み語にし、確定で選択テキストごと置換される', async () => {
    const editor = new Editor({
      extensions: createEditorExtensions({ nodeViews: false, getWikilinkDocs: () => DOCS }),
      content: '',
    });

    editor.commands.insertContent('ページ');
    await flushMicrotasks();
    editor.commands.setTextSelection({ from: 1, to: 4 });

    pressShortcut(editor);
    await flushMicrotasks();

    const popup = document.querySelector('.wikilink-suggestion-popup');
    expect(popup).toBeTruthy();
    const header = popup?.querySelector('.wikilink-suggestion-header');
    expect(header?.textContent).toContain('絞り込み: ページ');

    const item = popup!.querySelector('.wikilink-suggestion-item') as HTMLButtonElement;
    item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    const markdown = (editor.storage.markdown.getMarkdown() as string).trim();
    expect(markdown).toBe('[[フォルダ/ページ]]');

    editor.destroy();
  });

  it('#195: コードブロック内では発火しない', async () => {
    const editor = new Editor({
      extensions: createEditorExtensions({ nodeViews: false, getWikilinkDocs: () => DOCS }),
      content: '',
    });

    editor.commands.setCodeBlock();
    editor.commands.insertContent('[[ペ');
    await flushMicrotasks();
    expect(document.querySelector('.wikilink-suggestion-popup')).toBeNull();

    const textBefore = editor.getText();
    pressShortcut(editor);
    await flushMicrotasks();
    expect(document.querySelector('.wikilink-suggestion-popup')).toBeNull();
    expect(editor.getText()).toBe(textBefore);

    editor.destroy();
  });

  it('#195: インラインコード内では発火しない', async () => {
    const editor = new Editor({
      extensions: createEditorExtensions({ nodeViews: false, getWikilinkDocs: () => DOCS }),
      content: '',
    });

    editor.commands.setMark('code');
    editor.commands.insertContent('[[ペ');
    await flushMicrotasks();
    expect(document.querySelector('.wikilink-suggestion-popup')).toBeNull();

    editor.destroy();
  });

  it('#195: popup が外的要因で消えてもショートカットで復活する', async () => {
    const editor = new Editor({
      extensions: createEditorExtensions({ nodeViews: false, getWikilinkDocs: () => DOCS }),
      content: '',
    });

    editor.commands.insertContent('[[ペ');
    await flushMicrotasks();
    expect(document.querySelector('.wikilink-suggestion-popup')).toBeTruthy();

    // プラグイン状態(active)はそのままに、popup の DOM だけを外的要因で消す
    // (実機の scroll イベント等を想定)
    document.querySelector('.wikilink-suggestion-popup')!.remove();
    expect(document.querySelector('.wikilink-suggestion-popup')).toBeNull();

    pressShortcut(editor);
    await flushMicrotasks();

    const popup = document.querySelector('.wikilink-suggestion-popup');
    expect(popup).toBeTruthy();
    const header = popup?.querySelector('.wikilink-suggestion-header');
    expect(header?.textContent).toContain('絞り込み: ペ');

    editor.destroy();
  });

  it('#195: popup が無い状態でも Esc で dismiss される', async () => {
    const editor = new Editor({
      extensions: createEditorExtensions({ nodeViews: false, getWikilinkDocs: () => DOCS }),
      content: '',
    });

    editor.commands.insertContent('[[ペ');
    await flushMicrotasks();
    expect(document.querySelector('.wikilink-suggestion-popup')).toBeTruthy();

    // popup の DOM だけを外的要因で消す(プラグイン状態は active のまま)
    document.querySelector('.wikilink-suggestion-popup')!.remove();
    expect(document.querySelector('.wikilink-suggestion-popup')).toBeNull();

    // popupEl が無い状態でも Escape が dismiss を成立させることを確認する
    editor.view.dom.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );

    // 選択位置を変えずに空トランザクションをdispatchしてもdismissされたままなら再表示されない
    editor.view.dispatch(editor.state.tr);
    await flushMicrotasks();
    expect(document.querySelector('.wikilink-suggestion-popup')).toBeNull();

    editor.destroy();
  });

  it('#195: [[ペ で popup 表示中に一部を選択してショートカットを押しても [[ が二重挿入されない', async () => {
    const editor = new Editor({
      extensions: createEditorExtensions({ nodeViews: false, getWikilinkDocs: () => DOCS }),
      content: '',
    });

    editor.commands.insertContent('[[ページ');
    await flushMicrotasks();
    expect(document.querySelector('.wikilink-suggestion-popup')).toBeTruthy();

    // 「ペ」だけを選択(ダブルクリック等を想定)。選択が発生するとSuggestionプラグインは
    // 一旦非activeになる
    editor.commands.setTextSelection({ from: 3, to: 4 });

    pressShortcut(editor);
    await flushMicrotasks();

    // 選択の前に開きかけの [[ があるので、二重挿入されず [[ページ のまま維持される
    // (選択は潰さずカーソルを選択末尾へ移すだけなので、絞り込み語は [[ から新カーソル位置までの「ペ」)
    expect(editor.getText()).toBe('[[ページ');
    const popup = document.querySelector('.wikilink-suggestion-popup');
    expect(popup).toBeTruthy();
    const header = popup?.querySelector('.wikilink-suggestion-header');
    expect(header?.textContent).toContain('絞り込み: ペ');

    editor.destroy();
  });

  it('#195: ショートカットを同一 tick で連打しても popup は 1 個', async () => {
    const editor = new Editor({
      extensions: createEditorExtensions({ nodeViews: false, getWikilinkDocs: () => DOCS }),
      content: '',
    });

    editor.commands.insertContent('[[ペ');
    await flushMicrotasks();
    expect(document.querySelector('.wikilink-suggestion-popup')).toBeTruthy();

    // await を挟まず同一 tick で連打する
    pressShortcut(editor);
    pressShortcut(editor);
    pressShortcut(editor);
    await flushMicrotasks();

    expect(document.querySelectorAll('.wikilink-suggestion-popup').length).toBe(1);

    editor.view.dom.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    await flushMicrotasks();
    expect(document.querySelectorAll('.wikilink-suggestion-popup').length).toBe(0);

    editor.destroy();
  });
});
