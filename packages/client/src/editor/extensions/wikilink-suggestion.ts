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

  // スクロールで位置がずれるため、検知したらポップアップを閉じる
  const closeOnScroll = () => {
    popupEl?.remove();
    popupEl = null;
  };
  let selectedIndex = 0;
  let currentItems: DocSummary[] = [];
  let currentCommand: ((doc: DocSummary) => void) | null = null;

  function renderList() {
    if (!popupEl) return;
    popupEl.innerHTML = '';
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
          return matched.slice(0, 20);
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
