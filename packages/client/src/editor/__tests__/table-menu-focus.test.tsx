import { Editor } from '@tiptap/core';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ContextMenu } from '../../components/ContextMenu';
import { createEditorExtensions } from '../markdown';
import { getTableMenuItems } from '../table-menu';

// #234: 「表をコピー」選択後にエディタへフォーカスが戻ることの結線テスト。
// ContextMenuが onSelect() → onClose() の順で呼ぶことと、TipTapのfocusが
// requestAnimationFrame越しにview.focus()する挙動の両方に依存する繊細な経路のため固定する。

let editor: Editor;
let host: HTMLElement;

afterEach(() => {
  editor.destroy();
  host.remove();
  vi.unstubAllGlobals();
  // @ts-expect-error テスト用に定義したプロパティを剥がす
  delete navigator.clipboard;
});

it('「表をコピー」はクリックハンドラ内で同期的にwriteを呼び、メニュー閉鎖後にエディタへフォーカスが戻る', async () => {
  vi.stubGlobal(
    'ClipboardItem',
    class {
      items: unknown;
      constructor(items: unknown) {
        this.items = items;
      }
    },
  );
  const write = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    value: { write, writeText: vi.fn() },
    configurable: true,
  });

  host = document.createElement('div');
  document.body.appendChild(host);
  editor = new Editor({
    element: host,
    extensions: createEditorExtensions({ nodeViews: false }),
    content: '| A |\n| --- |\n| あ |\n',
  });
  editor.commands.setTextSelection(4);

  const { unmount } = render(
    <ContextMenu x={0} y={0} items={getTableMenuItems(editor)} onClose={vi.fn()} />,
  );
  fireEvent.click(screen.getByRole('menuitem', { name: '表をコピー' }));
  // ユーザージェスチャ内で同期的にクリップボードへ書き込む(Safariのジェスチャ紐づけ対策)
  expect(write).toHaveBeenCalledTimes(1);

  unmount(); // メニューが閉じてフォーカスは一旦bodyへ落ちる
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  expect(editor.isFocused).toBe(true);
});
