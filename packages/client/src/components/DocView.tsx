import { EditorContent, useEditor } from '@tiptap/react';
import type { DocResponse, DocSummary, User } from '@tsumiwiki/shared';
import { type MouseEvent as ReactMouseEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { uploadAttachment } from '../api/attachments';
import { isAllowedLinkUrl } from '../lib/allowed-link';
import { useTree } from '../api/docs';
import { createEditorExtensions } from '../editor/markdown';
import '../editor/editor.css';
import { useEditingSession } from '../hooks/use-editing-session';
import { docUrl } from '../lib/doc-path';
import { removeInlineTag, renameInlineTag } from '../lib/inline-tag-rewrite';
import { resolveWikilink } from '../lib/resolve-wikilink';
import { saveBadge } from '../lib/save-badge';
import { useEditStore } from '../stores/edit';
import { useToastStore } from '../stores/toast';
import { useUIStore } from '../stores/ui';
import { ConfirmDialog } from './ConfirmDialog';
import { EditorToolbar } from './EditorToolbar';
import { HistoryPanel } from './HistoryPanel';
import { PromptDialog } from './PromptDialog';
import { TagChipEditor } from './TagChipEditor';

// 文書閲覧・編集画面(SC-02のMainPane。設計04章4.2/4.4・05章5.3〜5.5・デザインhandoff components.md)
// 閲覧・編集は同じTiptapインスタンスのeditable切り替えで実現し、表示を完全一致させる

interface DocViewProps {
  doc: DocResponse;
  currentUser: User;
}

function titleFromPath(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.md$/i, '');
}

function folderOfPath(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

// パンくず用: フォルダ階層のセグメント一覧(ファイル名は含まない)
function breadcrumbFromPath(path: string): string[] {
  const folder = folderOfPath(path);
  return folder ? folder.split('/') : [];
}

// 更新日時をJSTの「日付」と「時刻」に分けて返す。
// 想定入力: ISO 8601(サーバーはUTCで送出)。パース失敗時は原文をdateへ、timeは空
function formatUpdatedAt(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return { date: iso, time: '' };
  const tz = 'Asia/Tokyo';
  const date = new Intl.DateTimeFormat('ja-JP', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
  const time = new Intl.DateTimeFormat('ja-JP', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(d);
  return { date, time };
}

const IMAGE_MIME_PREFIX = 'image/';

export function DocView({ doc, currentUser }: DocViewProps) {
  const [linkDialogVisible, setLinkDialogVisible] = useState(false);
  const [historyVisible, setHistoryVisible] = useState(false);
  const [discardConfirmVisible, setDiscardConfirmVisible] = useState(false);
  // #51 Opus C1: タグの pending 状態を DocView 側に持ち、連続タグ操作でも
  // stale な doc.tags を参照しないようにする。閲覧モード遷移で doc.tags 側へ揃える
  const [pendingTags, setPendingTags] = useState<string[]>(doc.tags);

  const navigate = useNavigate();
  const showToast = useToastStore((s) => s.show);
  const setLockedByOtherName = useEditStore((s) => s.setLockedByOtherName);
  const setSidebarTab = useUIStore((s) => s.setSidebarTab);
  const toggleTag = useUIStore((s) => s.toggleTag);
  const { data: tree } = useTree();

  const wikilinkDocsRef = useRef<DocSummary[]>([]);
  useEffect(() => {
    wikilinkDocsRef.current = tree?.docs ?? [];
  }, [tree]);

  const session = useEditingSession({
    path: doc.path,
    baseUpdatedAt: doc.updatedAt,
  });

  // 拡張群はマウント時に1度だけ構築する(毎レンダーのsetOptions再設定を回避)
  const extensions = useMemo(
    () => createEditorExtensions({ getWikilinkDocs: () => wikilinkDocsRef.current }),
    // wikilinkDocsRefはref経由のため再構築不要
    [],
  );
  const editor = useEditor({
    extensions,
    content: doc.body,
    editable: false,
    onUpdate: ({ editor: e }) => {
      session.updateBody(e.storage.markdown.getMarkdown() as string);
    },
    editorProps: {
      handleDrop: (_view, event) => {
        const files = Array.from(event.dataTransfer?.files ?? []).filter((f) =>
          f.type.startsWith(IMAGE_MIME_PREFIX),
        );
        if (files.length === 0) return false;
        event.preventDefault();
        void handleUploadImages(files);
        return true;
      },
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []).filter((f) =>
          f.type.startsWith(IMAGE_MIME_PREFIX),
        );
        if (files.length === 0) return false;
        event.preventDefault();
        void handleUploadImages(files);
        return true;
      },
    },
  });

  // NodeView(embed-view/image-view)が相対パス解決に使う現在文書のフォルダを共有する
  useEffect(() => {
    if (!editor) return;
    editor.storage.tsumiwikiDoc = { folder: folderOfPath(doc.path) };
  }, [editor, doc.path]);

  useEffect(() => {
    if (!editor) return;
    // 第2引数 emitUpdate=false: setEditable の既定は true で、モード切替のたびに
    // onUpdate → updateBody → dirty=true が誤発火する(初回マウントすら未保存扱いになる)
    editor.setEditable(session.mode === 'edit', false);
    // 編集モードに入ったら本文先頭にカーソルを出す(#51: 開いた瞬間から入力可能に)
    if (session.mode === 'edit') {
      editor.commands.focus('start');
    }
  }, [editor, session.mode]);

  // 閲覧中に限り、外部要因(他者更新・定期refetch等)でdocが変わったら本文を追随させる。
  // 編集中は絶対に上書きしない(編集内容が消えるため)。
  // 第2引数 emitUpdate=false: setContent の反映で onUpdate → updateBody → dirty=true と
  // なってしまうのを防ぐ(保存直後にdocが更新されて未保存扱いになる不具合の対処)
  useEffect(() => {
    if (session.mode === 'view' && editor && !editor.isDestroyed) {
      editor.commands.setContent(doc.body, false);
    }
  }, [editor, doc.body, session.mode]);

  // sessionは毎レンダリングで新しいオブジェクトになるため、refに固定して
  // keydownリスナーの登録/解除がレンダリングのたびに走らないようにする
  const sessionRef = useRef(session);
  sessionRef.current = session;

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const current = sessionRef.current;
      if (current.mode !== 'edit' || e.isComposing) return;
      const isMod = e.ctrlKey || e.metaKey;
      if (isMod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void current.save();
        return;
      }
      if (isMod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setLinkDialogVisible(true);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const lockedByOther = doc.lock && doc.lock.userId !== currentUser.id ? doc.lock : null;

  // StatusBar(AppShell)に他者ロック状況を伝える
  useEffect(() => {
    setLockedByOtherName(lockedByOther?.displayName ?? null);
    return () => setLockedByOtherName(null);
  }, [lockedByOther?.displayName, setLockedByOtherName]);

  // #51: 文書を開いた瞬間に編集モードに入る。他者ロック中は閲覧モードにフォールバック。
  // 1つの doc.path に対しては1度だけ試行する(startEditing 失敗時のトースト連発を避ける)
  const autoEditAttemptedRef = useRef<string | null>(null);
  const docBodyRef = useRef(doc.body);
  const docTagsRef = useRef(doc.tags);
  docBodyRef.current = doc.body;
  docTagsRef.current = doc.tags;
  useEffect(() => {
    if (!editor) return;
    if (lockedByOther) return;
    if (autoEditAttemptedRef.current === doc.path) return;
    autoEditAttemptedRef.current = doc.path;
    void sessionRef.current.startEditing(docBodyRef.current, docTagsRef.current);
  }, [editor, lockedByOther, doc.path]);

  // #51 Opus C1: 閲覧モードへ落ちたときは doc.tags(サーバ側の真値)へリセット。
  // 編集中は pendingTags を独立に持ち、Rename/Remove/Add の連続操作でも stale 化しない
  useEffect(() => {
    if (session.mode === 'view') setPendingTags(doc.tags);
  }, [session.mode, doc.tags]);

  function handleStartEdit() {
    // 手動で編集モードへ入り直すエントリ(閲覧モード落ち後のリトライ用)
    autoEditAttemptedRef.current = doc.path;
    setPendingTags(doc.tags);
    void session.startEditing(doc.body, doc.tags);
  }

  function handleSave() {
    void session.save();
  }

  function handleDiscardClick() {
    // #51 Opus H2: 編集破棄動線。dirty のときのみ確認ダイアログ、そうでなければ即キャンセル
    if (session.dirty) setDiscardConfirmVisible(true);
    else void session.cancelEditing();
  }

  function handleConfirmDiscard() {
    setDiscardConfirmVisible(false);
    void session.cancelEditing();
  }

  function handleTagNavigate(tag: string) {
    setSidebarTab('tag');
    toggleTag(tag);
  }

  function handleTagRename(oldName: string, newName: string) {
    // frontmatter(session.updateTags)+本文中インライン#tag の両方を書き換える。
    // editor.commands.setContent で emitUpdate=true にすることで onUpdate → session.updateBody が発火し、
    // dirty=true と contentRef の更新が自動的に行われる
    // 注意: setContent は undo history をリセットする既知の副作用がある(Tiptap)。タグ操作の頻度は低いため許容
    if (!editor || editor.isDestroyed) return;
    // 重複除去(名前衝突は TagChipEditor 側でも弾いているが二重防御)
    const nextTags = [...new Set(pendingTags.map((t) => (t === oldName ? newName : t)))];
    const currentBody = editor.storage.markdown.getMarkdown() as string;
    const nextBody = renameInlineTag(currentBody, oldName, newName);
    if (nextBody !== currentBody) {
      editor.commands.setContent(nextBody, true);
    }
    setPendingTags(nextTags);
    session.updateTags(nextTags);
  }

  function handleTagRemove(name: string) {
    if (!editor || editor.isDestroyed) return;
    const nextTags = pendingTags.filter((t) => t !== name);
    const currentBody = editor.storage.markdown.getMarkdown() as string;
    const nextBody = removeInlineTag(currentBody, name);
    if (nextBody !== currentBody) {
      editor.commands.setContent(nextBody, true);
    }
    setPendingTags(nextTags);
    session.updateTags(nextTags);
  }

  function handleTagAdd(name: string) {
    if (pendingTags.includes(name)) return;
    const nextTags = [...pendingTags, name];
    setPendingTags(nextTags);
    session.updateTags(nextTags);
  }

  function handleRestoreDraft() {
    const content = session.restoreDraft();
    editor?.commands.setContent(content);
  }

  function handleConfirmLink(url: string) {
    setLinkDialogVisible(false);
    if (!editor) return;
    if (!isAllowedLinkUrl(url)) {
      showToast('error', 'このURL形式は使用できません(http/https/mailto/fileのみ)');
      return;
    }
    if (editor.state.selection.empty) {
      editor
        .chain()
        .focus()
        .insertContent([{ type: 'text', marks: [{ type: 'link', attrs: { href: url } }], text: url }])
        .run();
    } else {
      editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
    }
  }

  // 複数ファイルは逐次アップロードし、成功をまとめて1トーストで通知する
  async function handleUploadImages(files: File[]) {
    let inserted = 0;
    for (const file of files) {
      try {
        const result = await uploadAttachment(doc.path, file);
        editor
          ?.chain()
          .focus()
          .insertContent({ type: 'obsidianEmbed', attrs: { target: result.fileName } })
          .run();
        inserted++;
      } catch (err) {
        showToast('error', err instanceof Error ? err.message : '画像のアップロードに失敗しました');
      }
    }
    if (inserted > 0) {
      showToast('success', inserted === 1 ? '画像を挿入しました' : `${inserted}件の画像を挿入しました`);
    }
  }

  async function handleUploadImage(file: File) {
    await handleUploadImages([file]);
  }

  // wikilinkクリックでの遷移(FR-OBS-02)とfile://・UNCリンクの「パスをコピー」(FR-LINK-02)
  function handleContainerClick(e: ReactMouseEvent<HTMLDivElement>) {
    // 編集モード中のクリックはカーソル移動として扱い、遷移・コピーはしない
    if (sessionRef.current.mode !== 'view') return;
    const target = e.target as HTMLElement;

    const wikilinkEl = target.closest('span[data-type="wikilink"]');
    if (wikilinkEl) {
      const wikilinkTarget = wikilinkEl.getAttribute('data-target') ?? '';
      const resolved = resolveWikilink(wikilinkTarget, wikilinkDocsRef.current);
      if (resolved) {
        navigate(docUrl(resolved));
      } else {
        showToast('error', 'リンク先が見つかりません');
      }
      return;
    }

    const anchorEl = target.closest('a');
    if (anchorEl) {
      const href = anchorEl.getAttribute('href') ?? '';
      if (href.startsWith('file:') || href.startsWith('\\\\')) {
        e.preventDefault();
        navigator.clipboard
          .writeText(href)
          .then(() => showToast('success', 'パスをコピーしました'))
          .catch(() => showToast('error', 'コピーに失敗しました'));
        return;
      }
      if (/^https?:/i.test(href)) {
        // 外部リンクは新規タブで開く(openOnClick:false のため自前処理)
        e.preventDefault();
        window.open(href, '_blank', 'noopener,noreferrer');
      }
    }
  }

  const breadcrumb = breadcrumbFromPath(doc.path);
  const badge = saveBadge(session.dirty, session.lastDraftSavedAt);

  return (
    <div className="flex h-full flex-col bg-canvas">
      <div className="flex items-start justify-between px-4 pb-4 pt-5 sm:px-6 lg:px-8">
        <div className="min-w-0">
          {breadcrumb.length > 0 && (
            <nav className="truncate text-xs text-ink-faint">
              {breadcrumb.map((segment, i) => (
                <span key={i}>
                  {i > 0 && <span className="mx-1">›</span>}
                  {segment}
                </span>
              ))}
            </nav>
          )}
          <h1 className="mt-1 truncate text-h1 text-ink">{titleFromPath(doc.path)}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-ink-faint">
            <span>更新</span>
            <span>{formatUpdatedAt(doc.updatedAt).date}</span>
            <span className="font-mono">{formatUpdatedAt(doc.updatedAt).time}</span>
            <span className={`font-medium ${badge.className}`}>{badge.label}</span>
            {/* #51: 即編集モードが基本のため、閲覧モードのときは明示バッジを出す。
                 他者ロック中(lockedByOther)か、なんらかの理由でロック取得できていない場合に該当 */}
            {session.mode === 'view' && (
              <span className="rounded bg-panel-2 px-1.5 py-0.5 text-ink-faint">閲覧モード</span>
            )}
            {lockedByOther && (
              <span className="text-warning">{lockedByOther.displayName}さんが編集中</span>
            )}
          </p>
          {/* #77 Phase A / #51: フロントマター+本文中の #タグ を合算したチップ列。
              閲覧モードでは TagPane フィルタ連動、編集モードでは各チップから改名/削除できる */}
          <TagChipEditor
            tags={session.mode === 'edit' ? pendingTags : doc.tags}
            editable={session.mode === 'edit'}
            onNavigate={handleTagNavigate}
            onRename={handleTagRename}
            onRemove={handleTagRemove}
            onAdd={handleTagAdd}
          />
        </div>
        <div className="flex flex-shrink-0 gap-2">
          <button
            type="button"
            onClick={() => setHistoryVisible(true)}
            disabled={session.mode === 'edit'}
            title={session.mode === 'edit' ? '編集中は使用できません' : undefined}
            className="h-[30px] rounded border border-line px-3 text-sm text-ink-soft hover:bg-hoverbg disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span aria-hidden="true">⟲</span> 履歴
          </button>
          {session.mode === 'view' ? (
            // 閲覧モード: ロック取得のリトライエントリ(他者編集終了後や取得失敗後の再試行)
            <button
              type="button"
              onClick={handleStartEdit}
              disabled={!!lockedByOther}
              title={lockedByOther ? `${lockedByOther.displayName}さんが編集中です` : undefined}
              className="h-8 rounded bg-accent px-3 text-sm text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span aria-hidden="true">✎</span> 編集
            </button>
          ) : (
            // 編集モード: dirty のときのみ「破棄」を表示、保存は変更ありの間だけ活性化(#51)
            <>
              {session.dirty && (
                <button
                  type="button"
                  onClick={handleDiscardClick}
                  className="h-[30px] rounded border border-line px-3 text-sm text-ink-soft hover:bg-hoverbg"
                  title="編集内容を破棄"
                >
                  破棄
                </button>
              )}
              <button
                type="button"
                onClick={handleSave}
                disabled={!session.dirty}
                title={!session.dirty ? '変更がありません' : undefined}
                className="h-8 rounded bg-success px-3 text-sm text-white hover:bg-success-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span aria-hidden="true">✓</span> 保存
              </button>
            </>
          )}
        </div>
      </div>

      {session.mode === 'edit' && editor && (
        <EditorToolbar
          editor={editor}
          onOpenLinkDialog={() => setLinkDialogVisible(true)}
          onPickImage={(file) => void handleUploadImage(file)}
        />
      )}

      <div className="flex-1 overflow-auto" onClick={handleContainerClick}>
        {/* コンテンツ幅は最大760pxで、狭くなるにつれ padding→本文ブロック順に自動追従する。
            記事幅がビューポート幅を超えないよう `max-w-full` を保険で入れる */}
        <div className="mx-auto max-w-[min(760px,100%)] px-4 py-4 sm:px-6 lg:px-8">
          <EditorContent editor={editor} />
        </div>
      </div>

      {session.draftPrompt && (
        <ConfirmDialog
          title="未保存の下書き"
          message="未保存の下書きがあります。復元しますか?"
          confirmLabel="復元"
          cancelLabel="破棄"
          variant="primary"
          onConfirm={handleRestoreDraft}
          onCancel={() => void session.discardDraftPrompt()}
        />
      )}

      {discardConfirmVisible && (
        <ConfirmDialog
          title="編集内容の破棄"
          message="編集内容を破棄しますか?"
          confirmLabel="破棄"
          cancelLabel="編集を続ける"
          onConfirm={handleConfirmDiscard}
          onCancel={() => setDiscardConfirmVisible(false)}
        />
      )}

      {session.conflict && (
        <ConfirmDialog
          title="保存の競合"
          message="保存先が取得後に変更されています。"
          confirmLabel="自分の内容で上書き保存"
          cancelLabel="破棄して最新を読み込む"
          onConfirm={() => void session.resolveConflictOverwrite()}
          onCancel={() => void session.resolveConflictDiscard()}
        />
      )}

      {linkDialogVisible && (
        <PromptDialog
          title="リンク"
          label="URL"
          defaultValue={(editor?.getAttributes('link').href as string | undefined) ?? ''}
          confirmLabel="設定"
          onConfirm={handleConfirmLink}
          onCancel={() => setLinkDialogVisible(false)}
        />
      )}

      {historyVisible && <HistoryPanel path={doc.path} onClose={() => setHistoryVisible(false)} />}
    </div>
  );
}
