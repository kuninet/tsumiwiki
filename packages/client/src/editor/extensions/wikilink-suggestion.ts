import { Extension } from '@tiptap/core';
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from '@tiptap/suggestion';
import type { DocSummary } from '@tsumiwiki/shared';

// [[入力によるwikilink候補補完(FR-LINK-01・設計05章5.5)
// 既存のWikilinkノードのシリアライズには一切触れない(表示・入力補助のみ)

export interface WikilinkSuggestionOptions {
  getDocs: () => DocSummary[];
}

function titleFromDocPath(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.md$/i, '');
}

function targetFromDocPath(path: string): string {
  return path.replace(/\.md$/i, '');
}

// ポップアップ(自作・絶対配置div)。tippy等の新規依存は追加しない
function createRenderer() {
  let popupEl: HTMLDivElement | null = null;

  // #151: ポップアップ内のスクロールで自身が閉じないよう、event.target が popup 内かで
  // 判定する。popup 外(ドキュメント本体、記事のスクロール等)なら位置ずれ防止で閉じる
  const closeOnScroll = (e: Event) => {
    if (!popupEl) return;
    const t = e.target as Node | null;
    if (t && popupEl.contains(t)) return; // popup 内スクロールは無視
    popupEl.remove();
    popupEl = null;
  };
  let selectedIndex = 0;
  let currentItems: DocSummary[] = [];
  let currentCommand: ((doc: DocSummary) => void) | null = null;
  let currentQuery = '';

  function scrollSelectedIntoView() {
    if (!popupEl) return;
    const el = popupEl.querySelector<HTMLElement>('.wikilink-suggestion-item.is-selected');
    // jsdom などで scrollIntoView が無い環境を想定してガード。
    // block: 'nearest' で見えていれば動かさず、隠れている場合だけ最小移動でスクロール
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' });
    }
  }

  function renderList() {
    if (!popupEl) return;
    popupEl.innerHTML = '';
    // ヘッダ: discoverability のため、現在の絞り込み query とキー操作ヒントを常に出す
    const header = document.createElement('div');
    header.className = 'wikilink-suggestion-header';
    header.textContent = currentQuery
      ? `絞り込み: ${currentQuery}(↑↓ で選択 / Enter で確定 / Esc で閉じる)`
      : '文字入力で絞り込み(↑↓ で選択 / Enter で確定 / Esc で閉じる)';
    popupEl.appendChild(header);
    if (currentItems.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'wikilink-suggestion-empty';
      empty.textContent = '一致する文書がありません';
      popupEl.appendChild(empty);
      return;
    }
    currentItems.forEach((item, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `wikilink-suggestion-item${index === selectedIndex ? ' is-selected' : ''}`;
      button.textContent = titleFromDocPath(item.path);
      // clickだとエディタのフォーカス喪失でsuggestionが先に閉じてしまうためmousedownで捕捉する
      button.addEventListener('mousedown', (e) => {
        e.preventDefault();
        currentCommand?.(item);
      });
      popupEl!.appendChild(button);
    });
    scrollSelectedIntoView();
  }

  function position(rect: DOMRect | null) {
    if (!popupEl || !rect) return;
    popupEl.style.left = `${rect.left + window.scrollX}px`;
    popupEl.style.top = `${rect.bottom + window.scrollY + 4}px`;
  }

  function sync(props: SuggestionProps<DocSummary, DocSummary>) {
    selectedIndex = 0;
    currentItems = props.items;
    currentCommand = (item) => props.command(item);
    currentQuery = props.query ?? '';
    renderList();
    position(props.clientRect?.() ?? null);
  }

  return {
    onStart(props: SuggestionProps<DocSummary, DocSummary>) {
      window.addEventListener('scroll', closeOnScroll, { capture: true });
      popupEl = document.createElement('div');
      popupEl.className = 'wikilink-suggestion-popup';
      popupEl.setAttribute('role', 'listbox');
      document.body.appendChild(popupEl);
      sync(props);
    },
    onUpdate(props: SuggestionProps<DocSummary, DocSummary>) {
      sync(props);
    },
    onKeyDown(props: SuggestionKeyDownProps): boolean {
      // IME変換中のEnter/矢印は候補操作に横取りしない(FR-EDIT-05)
      if (props.event.isComposing) return false;
      if (!popupEl) return false;
      const count = currentItems.length;
      if (props.event.key === 'Escape') {
        popupEl.remove();
        popupEl = null;
        return true;
      }
      if (props.event.key === 'ArrowDown') {
        if (count > 0) selectedIndex = (selectedIndex + 1) % count;
        renderList();
        return true;
      }
      if (props.event.key === 'ArrowUp') {
        if (count > 0) selectedIndex = (selectedIndex - 1 + count) % count;
        renderList();
        return true;
      }
      // PageDown/PageUp で 5 件ずつジャンプ(#151: 長いリストで便利)
      if (props.event.key === 'PageDown') {
        if (count > 0) selectedIndex = Math.min(count - 1, selectedIndex + 5);
        renderList();
        return true;
      }
      if (props.event.key === 'PageUp') {
        if (count > 0) selectedIndex = Math.max(0, selectedIndex - 5);
        renderList();
        return true;
      }
      if (props.event.key === 'Home') {
        if (count > 0) selectedIndex = 0;
        renderList();
        return true;
      }
      if (props.event.key === 'End') {
        if (count > 0) selectedIndex = count - 1;
        renderList();
        return true;
      }
      if (props.event.key === 'Enter') {
        const item = currentItems[selectedIndex];
        if (item) currentCommand?.(item);
        return true;
      }
      return false;
    },
    onExit() {
      window.removeEventListener('scroll', closeOnScroll, { capture: true });
      popupEl?.remove();
      popupEl = null;
    },
  };
}

export const WikilinkSuggestion = Extension.create<WikilinkSuggestionOptions>({
  name: 'wikilinkSuggestion',

  addOptions() {
    return {
      getDocs: () => [],
    };
  },

  addProseMirrorPlugins() {
    const { getDocs } = this.options;

    return [
      Suggestion<DocSummary, DocSummary>({
        editor: this.editor,
        char: '[[',
        allowSpaces: true,
        items: ({ query }) => {
          const q = query.trim().toLowerCase();
          const docs = getDocs();
          const matched = q
            ? docs.filter(
                (d) =>
                  titleFromDocPath(d.path).toLowerCase().includes(q) || d.path.toLowerCase().includes(q),
              )
            : docs;
          // #151: 上限を 20 → 200 に緩めた(以前は 20 件を超えると出ないので絞り込みが必須になっていた)。
          // 200 でも popup 側の max-height + overflow-y でスクロール可能
          return matched.slice(0, 200);
        },
        command: ({ editor, range, props }) => {
          editor
            .chain()
            .focus()
            .deleteRange(range)
            .insertContent({
              type: 'wikilink',
              attrs: { target: targetFromDocPath(props.path), alias: null },
            })
            .run();
        },
        render: createRenderer,
      }),
    ];
  },
});
