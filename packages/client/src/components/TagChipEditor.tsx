import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { useTags } from '../api/tags';

// 文書ヘッダのタグチップ列。閲覧モードでは #77 Phase A と同じく TagPane フィルタ連動、
// 編集モードでは各チップから直接改名/削除できるインラインUIを提供する

interface TagChipEditorProps {
  tags: string[];
  editable: boolean;
  onNavigate: (tag: string) => void;
  onRename: (oldName: string, newName: string) => void;
  onRemove: (name: string) => void;
  onAdd: (name: string) => void;
}

// タグ名として使える文字集合。サーバ側 INLINE_TAG_RE と同じ /\p{L}\p{N}_/-/
const TAG_NAME_RE = /^[\p{L}\p{N}_/-]+$/u;

// サジェスト候補の上限。選択目的のUIなのでSearchBoxの8件より多めに取り、
// スクロールで探せる範囲に留める(タグが数百件あっても全件はDOM生成しない)
const MAX_TAG_SUGGESTIONS = 20;

// 入力を正規化: 先頭の # を落とし、trim、末尾のスラッシュ・ハイフンを除去、NFC 正規化
function normalizeTagName(input: string): string {
  const stripped = input.trim().replace(/^#+/, '');
  const trimmed = stripped.replace(/[/-]+$/, '');
  return trimmed.normalize('NFC');
}

export function TagChipEditor({
  tags,
  editable,
  onNavigate,
  onRename,
  onRemove,
  onAdd,
}: TagChipEditorProps) {
  const [renamingTag, setRenamingTag] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [adding, setAdding] = useState(false);
  const [addDraft, setAddDraft] = useState('');
  const [activeSuggestion, setActiveSuggestion] = useState(-1);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const addInputRef = useRef<HTMLInputElement | null>(null);

  // #118: 「+ タグを追加」の入力欄直下に出す既存タグサジェスト。TagPane/SearchBox と同じ useTags() を使う
  const { data: allTags } = useTags();
  const suggestionQuery = addDraft.toLowerCase();
  const suggestions = adding
    ? (allTags ?? [])
        .filter((t) => !tags.includes(t.tag))
        .filter((t) => suggestionQuery === '' || t.tag.toLowerCase().includes(suggestionQuery))
        .sort((a, b) => b.count - a.count)
        .slice(0, MAX_TAG_SUGGESTIONS)
    : [];

  useEffect(() => {
    if (renamingTag !== null) renameInputRef.current?.focus();
  }, [renamingTag]);

  useEffect(() => {
    if (adding) addInputRef.current?.focus();
  }, [adding]);

  // 入力値が変わったらサジェストのハイライト位置をリセット
  useEffect(() => {
    setActiveSuggestion(-1);
  }, [addDraft]);

  // モード離脱でインラインUIをリセット(編集中のドラフトも捨てる)
  useEffect(() => {
    if (!editable) {
      setRenamingTag(null);
      setRenameDraft('');
      setAdding(false);
      setAddDraft('');
      setActiveSuggestion(-1);
    }
  }, [editable]);

  function startRename(tag: string) {
    setAdding(false);
    setRenamingTag(tag);
    setRenameDraft(tag);
  }

  // rename/add の確定は setState 反映を待たずに現在の DOM 値を直接読む。
  // React 18 の event 内 setState はバッチされ、直後の onKeyDown 内の
  // `renameDraft` state は古い値のまま(fireEvent の連続呼び出しで顕在化)
  function commitRename(rawValue?: string) {
    if (renamingTag === null) return;
    const source = rawValue ?? renameDraft;
    const next = normalizeTagName(source);
    const isValid = next.length > 0 && TAG_NAME_RE.test(next);
    const changed = isValid && next !== renamingTag && !tags.includes(next);
    if (changed) onRename(renamingTag, next);
    setRenamingTag(null);
    setRenameDraft('');
  }

  function cancelRename() {
    setRenamingTag(null);
    setRenameDraft('');
  }

  function handleRenameKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitRename(e.currentTarget.value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelRename();
    }
  }

  function commitAdd(rawValue?: string) {
    const source = rawValue ?? addDraft;
    const next = normalizeTagName(source);
    const isValid = next.length > 0 && TAG_NAME_RE.test(next);
    if (isValid && !tags.includes(next)) onAdd(next);
    setAdding(false);
    setAddDraft('');
  }

  // サジェスト候補をクリック/Enterで選択したときの確定(正規化済みの既存タグ名なのでバリデーション不要)
  function selectSuggestion(name: string) {
    onAdd(name);
    setAdding(false);
    setAddDraft('');
  }

  function cancelAdd() {
    setAdding(false);
    setAddDraft('');
  }

  function handleAddKey(e: KeyboardEvent<HTMLInputElement>) {
    // IME変換中のEnter/矢印は候補操作に使わない(FR-EDIT-05。変換確定の誤操作防止。SearchBox と同じ作法)
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown') {
      if (suggestions.length === 0) return;
      e.preventDefault();
      setActiveSuggestion((i) => (i + 1) % suggestions.length);
    } else if (e.key === 'ArrowUp') {
      if (suggestions.length === 0) return;
      e.preventDefault();
      setActiveSuggestion((i) => (i - 1 + suggestions.length) % suggestions.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeSuggestion >= 0 && activeSuggestion < suggestions.length) {
        selectSuggestion(suggestions[activeSuggestion].tag);
      } else {
        commitAdd(e.currentTarget.value);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelAdd();
    }
  }

  const hasContent = tags.length > 0 || editable;
  if (!hasContent) return null;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {tags.map((tag) =>
        editable && renamingTag === tag ? (
          <span
            key={tag}
            className="inline-flex items-center rounded-full border border-accent-border bg-panel-2 pl-1"
          >
            <span className="text-xs text-accent">#</span>
            <input
              ref={renameInputRef}
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              // #51 Opus H3: 意図しない確定を避け、blur(タブ移動やダイアログ open 等)は cancel 扱い。
              // 確定は Enter のみ。バリデーション NG のサイレント破棄を防ぐ意味も兼ねる
              onBlur={cancelRename}
              onKeyDown={handleRenameKey}
              // タグ名の長さは最大30(見た目のバランス優先。強い上限は特にない)
              maxLength={30}
              className="w-[8ch] min-w-[6ch] border-0 bg-transparent px-1 py-0.5 text-xs text-ink outline-none focus:ring-0"
              aria-label={`タグ「${tag}」を改名`}
            />
          </span>
        ) : editable ? (
          <span
            key={tag}
            className="inline-flex items-center gap-0.5 rounded-full border border-accent-border bg-accent-soft pr-1 hover:bg-accent-softer"
          >
            <button
              type="button"
              onClick={() => startRename(tag)}
              className="px-2 py-0.5 text-xs text-accent"
              title="クリックで改名"
            >
              #{tag}
            </button>
            <button
              type="button"
              onClick={() => onRemove(tag)}
              className="rounded-full px-1.5 text-xs leading-none text-accent hover:bg-accent hover:text-white"
              title={`タグ #${tag} を削除`}
              aria-label={`タグ #${tag} を削除`}
            >
              ×
            </button>
          </span>
        ) : (
          <button
            key={tag}
            type="button"
            onClick={() => onNavigate(tag)}
            className="rounded-full border border-accent-border bg-accent-soft px-2.5 py-0.5 text-xs text-accent hover:bg-accent-softer"
            title={`タグ #${tag} の文書一覧を開く`}
          >
            #{tag}
          </button>
        ),
      )}
      {editable && (
        adding ? (
          <span className="relative inline-flex items-center rounded-full border border-accent-border bg-panel-2 pl-1">
            <span className="text-xs text-accent">#</span>
            <input
              ref={addInputRef}
              value={addDraft}
              onChange={(e) => setAddDraft(e.target.value)}
              // 追加も blur は cancel(意図しない誤タグ追加を防ぐ)。確定は Enter
              onBlur={cancelAdd}
              onKeyDown={handleAddKey}
              maxLength={30}
              placeholder="タグ名"
              className="w-[10ch] min-w-[8ch] border-0 bg-transparent px-1 py-0.5 text-xs text-ink outline-none focus:ring-0"
              aria-label="タグを追加"
            />
            {suggestions.length > 0 && (
              <div className="absolute left-0 top-full z-[40] mt-1 max-h-48 w-40 overflow-y-auto rounded-lg border border-line bg-panel shadow-lg">
                <ul>
                  {suggestions.map((t, i) => (
                    <li key={t.tag}>
                      <button
                        type="button"
                        // blur より先に発火させて cancelAdd による入力クローズを防ぐ(EditorToolbar と同じ手法)
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => selectSuggestion(t.tag)}
                        className={`block w-full truncate px-3 py-1.5 text-left text-xs ${
                          i === activeSuggestion ? 'bg-active text-accent' : 'text-ink-soft hover:bg-hoverbg'
                        }`}
                      >
                        #{t.tag}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="rounded-full border border-dashed border-line px-2.5 py-0.5 text-xs text-ink-faint hover:bg-hoverbg"
            title="タグを追加"
          >
            + タグを追加
          </button>
        )
      )}
    </div>
  );
}
