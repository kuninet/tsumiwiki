import { Extension, type Editor } from '@tiptap/core';
import type { ResolvedPos } from '@tiptap/pm/model';
import { PluginKey, TextSelection, type Transaction } from '@tiptap/pm/state';
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from '@tiptap/suggestion';
import type { DocSummary } from '@tsumiwiki/shared';
import { isMac } from '../../lib/platform';

// [[入力によるwikilink候補補完(FR-LINK-01・設計05章5.5)
// 既存のWikilinkノードのシリアライズには一切触れない(表示・入力補助のみ)

export interface WikilinkSuggestionOptions {
  getDocs: () => DocSummary[];
}

// Esc で明示的に閉じた範囲を覚えておくための情報。「位置」だけでなく「その時点のテキスト」も
// 保持する。allowSpaces: true のため [[ 以降の空白を含む文字列がまるごとクエリになり、
// 位置だけの比較では「Esc → 消して打ち直し」を区別できない(打ち直した文字列が変わっても
// range.from は変わらないことがある)ため、位置+テキストの組で判定する(#195)
interface Dismissed {
  from: number;
  text: string;
}

// ショートカット・Suggestionプラグインの双方から状態を共有するための領域。
// addStorage() で保持する。createEditorExtensions() は呼び出しのたびに WikilinkSuggestion.configure()
// を新規実行してエディタインスタンスを作るため、storage もインスタンスごとに独立する
// (タブ/分割ペインが増えてもモジュールスコープ変数のような相互干渉は起きない、という前提に依存する)
interface WikilinkSuggestionStorage {
  dismissed: Dismissed | null;
  // ショートカットの「いったんdismiss→即再開」処理が完了するまでの再入防止フラグ。
  // Suggestionのview().updateはasync(items()をawaitする)ため、onStart/onExitはdispatch直後
  // ではなくマイクロタスク後に走る。同一tickでショートカットが連打されると、まだonStartが
  // 走っていないタイミングで次の「dismiss→再開」が割り込み、popupの多重生成やscrollリスナーの
  // リークにつながるため、queueMicrotaskで解除するまでの間は何もしない
  reopening: boolean;
}

// Suggestionプラグインの状態をショートカット側からも参照するための専用キー
const WIKILINK_SUGGESTION_KEY = new PluginKey('wikilinkSuggestion');

// 開きかけの[[ ( or ［［)を検知して発火させるための正規表現。
// tiptapのfindSuggestionMatchと合わせ、直前のテキストノード末尾からの一致のみを見る。
// findOpener は textBetween のリーフ区切りに \0 を使うため、wikilink 等のインラインノードを
// またいで誤一致しないよう \0 も除外する(またぐと findSuggestionMatch 側は検知できず、
// popup が開かないまま全角の半角化だけが走ってしまう)
const OPENER_RE = /(?:\[\[|［［)[^[\]［］\0]*$/;

// コードブロック/インラインコード内では発火させない(#195)。
// codeBlock 等のノードも Code マークも spec.code: true を持つため、ノード名やマーク名に
// 依存せずこの spec で判定する
function isInsideCode(pos: ResolvedPos): boolean {
  if (pos.parent.type.spec.code) return true;
  return pos.marks().some((m) => m.type.spec.code);
}

// カーソル(段落内オフセット基準)の直前にある、開きかけの [[/［［ を検出する。
// 選択がある場合にも「選択の直前」を調べられるよう、$pos.parent.textBetween を親ノード先頭から
// 走査する(nodeBefore だけだと選択の先頭側テキストノードしか見えないため)
function findOpener(
  $pos: ResolvedPos,
): { from: number; normalize: (tr: Transaction) => void } | null {
  const beforeText = $pos.parent.textBetween(0, $pos.parentOffset, undefined, '\0');
  const match = OPENER_RE.exec(beforeText);
  if (!match) return null;
  // parent.textBetween は $pos.parent 先頭からのオフセットなので、文書全体の位置に変換する
  const from = $pos.pos - (beforeText.length - match.index);
  const isFullWidth = match[0].startsWith('［［');
  return {
    from,
    normalize: (tr) => {
      // 全角で入力されていた場合は半角に正規化してから開く
      if (isFullWidth) tr.insertText('[[', from, from + 2);
    },
  };
}

// Mod-Shift-K: サジェストを明示的に開く(#195)。
// - 既にプラグインが active(popup が外的要因で消えていても decoration/state は生きている)なら、
//   いったん dismiss して同じ範囲で開き直す(popup を必ず再生成させるため)
// - active でなければ、カーソル直前の開きかけ [[/［［ を検出して開くか、[[ を挿入する
function openWikilinkSuggestion(editor: Editor, storage: WikilinkSuggestionStorage): boolean {
  if (!editor.isEditable || editor.view.composing) return false;
  // 同一tick内での連打を無視する(重大2)。Suggestionのview().updateはasyncなため、
  // 直前の「dismiss→再開」のonStartがまだ走っていない状態で次を実行すると popup が多重生成される
  if (storage.reopening) return true;

  const { $from, $to, from, to, empty } = editor.state.selection;
  if (isInsideCode($from)) return false;

  const suggestionState = WIKILINK_SUGGESTION_KEY.getState(editor.state) as
    { active: boolean; range: { from: number; to: number } } | undefined;

  if (suggestionState?.active) {
    // 一旦 dismiss して allow() を false にし(onExit → popup 消滅)、
    // 直後に dismiss を解除して同じトランザクション列で再度 allow() を true に戻す(onStart → popup 再生成)。
    // dispatch 自体は同期だが、onStart/onExit の実行(view().update)はitems()のawait後まで
    // 遅延するため、それが完了するまでは reopening で再入をガードする
    const range = suggestionState.range;
    storage.reopening = true;
    storage.dismissed = {
      from: range.from,
      text: editor.state.doc.textBetween(range.from, range.to),
    };
    editor.view.dispatch(editor.state.tr);
    storage.dismissed = null;
    editor.view.dispatch(editor.state.tr);
    queueMicrotask(() => {
      storage.reopening = false;
    });
    return true;
  }

  if (empty) {
    const opener = findOpener($from);
    if (opener) {
      storage.dismissed = null;
      const tr = editor.state.tr;
      opener.normalize(tr);
      // apply() を再評価させるための(全角正規化以外は実質空の)トランザクション
      editor.view.dispatch(tr);
      return true;
    }
  }

  if (!empty) {
    // 選択範囲の直前に閉じていない [[/［［ があれば、選択を挿入テキストで潰さずカーソルを
    // 選択末尾へ移すだけにする(選択中に開きかけを検出しないと [[ が二重挿入されてしまう。重大1)
    const openerBeforeSelection = findOpener($from);
    if (openerBeforeSelection) {
      storage.dismissed = null;
      const tr = editor.state.tr;
      openerBeforeSelection.normalize(tr);
      tr.setSelection(TextSelection.create(tr.doc, to));
      editor.view.dispatch(tr);
      return true;
    }
    if (!$from.sameParent($to)) return false;
    const text = editor.state.doc.textBetween(from, to, '');
    storage.dismissed = null;
    editor.view.dispatch(editor.state.tr.insertText('[[' + text, from, to));
    return true;
  }

  storage.dismissed = null;
  editor.view.dispatch(editor.state.tr.insertText('[[', from));
  return true;
}

function titleFromDocPath(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.md$/i, '');
}

function targetFromDocPath(path: string): string {
  return path.replace(/\.md$/i, '');
}

// ポップアップ(自作・絶対配置div)。tippy等の新規依存は追加しない
function createRenderer(storage: WikilinkSuggestionStorage, editor: Editor) {
  let popupEl: HTMLDivElement | null = null;
  let currentClientRect: (() => DOMRect | null) | null = null;

  // #151/#195: ポップアップ内のスクロールでは何もしない。popup 外(ドキュメント本体、
  // 記事のスクロール等)のスクロールでは popup を閉じず、位置を追従させる。
  // (実機では popup 表示直後に window の scroll イベントが飛ぶことがあり、閉じてしまうと
  //  プラグイン状態は active のままで Esc もショートカットも効かなくなる不具合があった)
  const followScroll = (e: Event) => {
    if (!popupEl) return;
    const t = e.target as Node | null;
    if (t && popupEl.contains(t)) return; // popup 内スクロールは無視
    position(currentClientRect?.() ?? null);
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
    // ヘッダ: discoverability のため、現在の絞り込み query とキー操作ヒント・再表示ショートカットを常に出す
    const modLabel = isMac() ? '⌘' : 'Ctrl';
    const header = document.createElement('div');
    header.className = 'wikilink-suggestion-header';
    header.textContent = currentQuery
      ? `絞り込み: ${currentQuery}(↑↓ 選択 / Enter 確定 / Esc 閉じる / ${modLabel}+Shift+K 再表示)`
      : `文字入力で絞り込み(↑↓ 選択 / Enter 確定 / Esc 閉じる / ${modLabel}+Shift+K 再表示)`;
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
    if (!popupEl) return;
    // clientRect が null(decorationNode が見つからない等)のときは古い位置のまま
    // 表示され続けてしまうため、いったん隠す(#195)
    if (!rect) {
      popupEl.style.visibility = 'hidden';
      return;
    }
    popupEl.style.visibility = 'visible';
    popupEl.style.left = `${rect.left + window.scrollX}px`;
    popupEl.style.top = `${rect.bottom + window.scrollY + 4}px`;
  }

  function sync(props: SuggestionProps<DocSummary, DocSummary>) {
    selectedIndex = 0;
    currentItems = props.items;
    currentCommand = (item) => props.command(item);
    currentQuery = props.query ?? '';
    currentClientRect = props.clientRect ?? null;
    renderList();
    position(currentClientRect?.() ?? null);
  }

  return {
    onStart(props: SuggestionProps<DocSummary, DocSummary>) {
      // 同一tick内の連打等でonStartが重複して呼ばれても popup / リスナーが多重化しないよう、
      // 既存のものを片付けてから作り直す(重大2)
      popupEl?.remove();
      window.removeEventListener('scroll', followScroll, { capture: true });
      window.addEventListener('scroll', followScroll, { capture: true });
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
      // Escape は popup が(外的要因で)既に消えていても dismiss を成立させる。
      // popup が無いことを理由に早期returnすると、プラグイン状態が active のまま残り
      // Esc もショートカットも効かなくなってしまうため、popupEl の有無チェックより先に処理する
      if (props.event.key === 'Escape') {
        storage.dismissed = {
          from: props.range.from,
          text: editor.state.doc.textBetween(props.range.from, props.range.to),
        };
        popupEl?.remove();
        popupEl = null;
        // apply() を再評価させるための空トランザクション
        editor.view.dispatch(editor.state.tr);
        return true;
      }
      if (!popupEl) return false;
      const count = currentItems.length;
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
      window.removeEventListener('scroll', followScroll, { capture: true });
      popupEl?.remove();
      popupEl = null;
    },
  };
}

export const WikilinkSuggestion = Extension.create<
  WikilinkSuggestionOptions,
  WikilinkSuggestionStorage
>({
  name: 'wikilinkSuggestion',

  addOptions() {
    return {
      getDocs: () => [],
    };
  },

  addStorage() {
    return {
      dismissed: null,
      reopening: false,
    };
  },

  addKeyboardShortcuts() {
    const handler = () => openWikilinkSuggestion(this.editor, this.storage);
    return {
      // Esc で閉じた後の再表示、および[[を打たずに明示的に開くためのショートカット(#195)。
      // macOS実機では Shift 併用時に event.key が大文字 'K' になることがあり、
      // 小文字だけの登録だと keyCode 経由のフォールバック解決頼みになるため両方登録する
      'Mod-Shift-k': handler,
      'Mod-Shift-K': handler,
    };
  },

  addProseMirrorPlugins() {
    const { getDocs } = this.options;
    const storage = this.storage;

    return [
      Suggestion<DocSummary, DocSummary>({
        pluginKey: WIKILINK_SUGGESTION_KEY,
        editor: this.editor,
        char: '[[',
        allowSpaces: true,
        // #195: [[の直前文字が行頭/半角スペースでなくても発火させる
        // (既定の allowedPrefixes: [' '] だと「詳細は[[」のような日本語文中で発火しない)
        allowedPrefixes: null,
        allow: ({ state, range }) => {
          const $pos = state.doc.resolve(range.from);
          // コードブロック/インラインコード内では発火させない(#195)
          if (isInsideCode($pos)) return false;
          if (
            storage.dismissed &&
            storage.dismissed.from === range.from &&
            state.doc.textBetween(range.from, range.to) === storage.dismissed.text
          ) {
            return false;
          }
          return true;
        },
        items: ({ query }) => {
          const q = query.trim().toLowerCase();
          const docs = getDocs();
          const matched = q
            ? docs.filter(
                (d) =>
                  titleFromDocPath(d.path).toLowerCase().includes(q) ||
                  d.path.toLowerCase().includes(q),
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
        render: () => createRenderer(storage, this.editor),
      }),
    ];
  },
});
