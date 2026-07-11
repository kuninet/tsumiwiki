import { EditorContent, useEditor } from '@tiptap/react';
import { CURSOR_MARKER, type DocResponse, type DocSummary, type User } from '@tsumiwiki/shared';
import { type MouseEvent as ReactMouseEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { uploadAttachment } from '../api/attachments';
import { isAllowedLinkUrl } from '../lib/allowed-link';
import { useTree } from '../api/docs';
import { useExpandTemplate } from '../api/templates';
import { createEditorExtensions } from '../editor/markdown';
import { parseMarkdownFragment } from '../editor/parse-fragment';
import '../editor/editor.css';
import { useEditingSession } from '../hooks/use-editing-session';
import { handleWikilinkClick } from '../lib/handle-wikilink-click';
import { removeInlineTag, renameInlineTag } from '../lib/inline-tag-rewrite';
import { saveBadge } from '../lib/save-badge';
import { useEditStore } from '../stores/edit';
import { useToastStore } from '../stores/toast';
import { useUIStore } from '../stores/ui';
import { ConfirmDialog } from './ConfirmDialog';
import { EditorToolbar } from './EditorToolbar';
import { HistoryPanel } from './HistoryPanel';
import { PromptDialog } from './PromptDialog';
import { TagChipEditor } from './TagChipEditor';
import { TemplatePickerDialog } from './TemplatePickerDialog';

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
  const [templateApplyOpen, setTemplateApplyOpen] = useState(false);
  // #51 Opus C1: タグの pending 状態を DocView 側に持ち、連続タグ操作でも
  // stale な doc.tags を参照しないようにする。閲覧モード遷移で doc.tags 側へ揃える
  const [pendingTags, setPendingTags] = useState<string[]>(doc.tags);

  const navigate = useNavigate();
  const showToast = useToastStore((s) => s.show);
  const expandTemplate = useExpandTemplate();
  const setLockedByOtherName = useEditStore((s) => s.setLockedByOtherName);
  const setSidebarTab = useUIStore((s) => s.setSidebarTab);
  const toggleTag = useUIStore((s) => s.toggleTag);
  const editorChromeVisible = useUIStore((s) => s.editorChromeVisible);
  const showEditorChrome = useUIStore((s) => s.showEditorChrome);
  const resetEditorChrome = useUIStore((s) => s.resetEditorChrome);
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

  // 文書オープン/切替時はツールバーを非表示にリセットする。
  // その後ユーザーがエディタで実操作したら showEditorChrome で表示ONになる(下の useEffect)。
  useEffect(() => {
    resetEditorChrome();
  }, [doc.path, resetEditorChrome]);

  // editor.commands.focus('start') は自動発火なので focus イベントを条件にすると即出てしまう。
  // 代わりに click / keydown / touchstart / paste を捕捉して、ユーザー起因の操作を検知する
  useEffect(() => {
    if (!editor || session.mode !== 'edit') return;
    const dom = editor.view.dom;
    const handler = () => showEditorChrome();
    dom.addEventListener('click', handler);
    dom.addEventListener('keydown', handler);
    dom.addEventListener('touchstart', handler);
    dom.addEventListener('paste', handler);
    return () => {
      dom.removeEventListener('click', handler);
      dom.removeEventListener('keydown', handler);
      dom.removeEventListener('touchstart', handler);
      dom.removeEventListener('paste', handler);
    };
  }, [editor, session.mode, showEditorChrome]);

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
        showEditorChrome();
        void current.save();
        return;
      }
      if (isMod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        showEditorChrome();
        setLinkDialogVisible(true);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showEditorChrome]);

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

  // #84 Phase C: 選択されたテンプレを展開して現在のエディタに流し込む。
  // - applyMode='insert': カーソル位置に挿入
  // - applyMode='append': 文末に追記
  // どちらも `{{cursor}}` があれば挿入後のカーソル位置をマーカーの場所へ戻す。
  //
  // 挿入は 1 chain / 1 transaction にまとめて 1 回の undo で完全に取り消せるようにする
  // (中#5/#6/#12 対応)。境目位置は「挿入開始 + pre.size」で計算する。
  //
  // 既知の制限(重大#2): テンプレ本文の *行内* に `{{cursor}}` があると、
  // 前半・後半それぞれが独立ブロックとしてパースされるため段落境界が生じる。
  // 行頭・行末に置けば期待通りに動く。テンプレ設計上の注意点。
  async function applyTemplateToEditor(
    templatePath: string,
    applyMode: 'insert' | 'append',
  ): Promise<void> {
    if (!editor) return;
    let expanded: string;
    try {
      const res = await expandTemplate.mutateAsync({
        templatePath,
        title: titleFromPath(doc.path),
      });
      expanded = res.markdown;
    } catch {
      // useExpandTemplate 内で toast は出しているので握りつぶす
      return;
    }

    // 中#4: await 中にキャンセル(mode=view)された可能性があるので再確認して抜ける
    if (sessionRef.current.mode !== 'edit' || !editor.isEditable) return;

    // 重大#1: `String.split(sep, 2)` は 2 個目以降のマーカー右側を捨ててしまう。
    // indexOf + slice で「最初のマーカーで分割し、残り本文は post 側に保持する」
    const cursorIdx = expanded.indexOf(CURSOR_MARKER);
    const preRaw = cursorIdx === -1 ? expanded : expanded.slice(0, cursorIdx);
    const postRaw =
      cursorIdx === -1 ? '' : expanded.slice(cursorIdx + CURSOR_MARKER.length);

    const pre = parseMarkdownFragment(preRaw);
    const post = parseMarkdownFragment(postRaw);
    if (pre.content.length === 0 && post.content.length === 0) return;

    // 挿入位置。append は文末、insert は現在のカーソル位置
    const insertAt =
      applyMode === 'append' ? editor.state.doc.content.size : editor.state.selection.from;
    // pre と post の境目のカーソル位置(cursor マーカーがなければ挿入末尾)
    const cursorAt = insertAt + pre.size;

    // 1 chain / 1 transaction にまとめる(中#5 / #12: undo 1 回で完全 revert)
    const combined = [...pre.content, ...post.content];
    editor
      .chain()
      .focus()
      .insertContentAt(insertAt, combined)
      .setTextSelection(cursorAt)
      .run();

    showToast('success', 'テンプレートを適用しました');
  }

  // wikilinkクリックでの遷移(FR-OBS-02)とfile://・UNCリンクの「パスをコピー」(FR-LINK-02)
  function handleContainerClick(e: ReactMouseEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement;

    // #96: wikilink は本文(view) / 履歴パネル(DiffView) 共通のヘルパで処理する。
    // wikilink の遷移は編集モード中でもクリック意図として扱う(view-mode gate より前で判定):
    // - 編集モード中は atom node なのでキャレット挙動はブロックされず、明示クリックのみ発火する
    // - 差分表示側は HistoryPanel > DiffView が別コンテナで、独自の onClick で同じヘルパを呼ぶ
    if (handleWikilinkClick(target, wikilinkDocsRef.current, navigate, showToast)) {
      return;
    }

    // 編集モード中の他リンクは編集操作(カーソル移動等)として扱い、遷移・コピーはしない
    if (sessionRef.current.mode !== 'view') return;

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
            className="h-[30px] rounded border border-line px-3 text-sm text-ink-soft hover:bg-hoverbg"
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

      {session.mode === 'edit' && editor && editorChromeVisible && (
        <EditorToolbar
          editor={editor}
          onOpenLinkDialog={() => setLinkDialogVisible(true)}
          onPickImage={(file) => void handleUploadImage(file)}
          onOpenTemplateApply={() => setTemplateApplyOpen(true)}
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

      {historyVisible && (
        <HistoryPanel
          path={doc.path}
          onClose={() => setHistoryVisible(false)}
          // #106: 編集中に復元されると dirty な内容で上書き保存される事故を防ぐ。
          // 復元前に編集セッションを片付け、閲覧モードへ戻してから restoreRevision を走らせる
          isDirty={session.mode === 'edit' && session.dirty}
          beforeRestore={session.mode === 'edit' ? session.cancelEditing : undefined}
        />
      )}

      {templateApplyOpen && (
        <TemplatePickerDialog
          mode="apply"
          onCancel={() => setTemplateApplyOpen(false)}
          onSubmit={(result) => {
            if (result.mode !== 'apply') return;
            setTemplateApplyOpen(false);
            void applyTemplateToEditor(result.templatePath, result.applyMode);
          }}
        />
      )}
    </div>
  );
}
