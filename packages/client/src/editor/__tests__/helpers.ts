import type { Editor } from '@tiptap/core';

// エディタのキー操作を実キー経路(handleKeyDown)で発火するテストヘルパー。
//
// 注意: editor.commands.keyboardShortcut() は captureTransaction が step のみを
// 再生するため、ハンドラ内の tr.setSelection が反映されない(カーソル位置の
// アサーションが実挙動と食い違う false green になる)。カーソル位置・選択範囲を
// 検証するテストでは必ずこちらを使うこと(issue #220 のレビューで判明)。
//
// 修飾キーは KeyboardEventInit で渡す。jsdom は Mac 判定にならないため
// Mod- 系は ctrlKey: true を使う。
export function pressKey(editor: Editor, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  editor.view.someProp('handleKeyDown', (f) => f(editor.view, event));
}
