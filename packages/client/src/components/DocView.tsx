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
import { resolveWikilink } from '../lib/resolve-wikilink';
import { saveBadge } from '../lib/save-badge';
import { useEditStore } from '../stores/edit';
import { useToastStore } from '../stores/toast';
import { ConfirmDialog } from './ConfirmDialog';
import { EditorToolbar } from './EditorToolbar';
import { HistoryPanel } from './HistoryPanel';
import { PromptDialog } from './PromptDialog';

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

function parseTagsInput(input: string): string[] {
  return [...new Set(input.split(',').map((t) => t.trim()).filter(Boolean))];
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
  const [tagsInput, setTagsInput] = useState(doc.tags.join(', '));
  const [cancelConfirmVisible, setCancelConfirmVisible] = useState(false);
  const [linkDialogVisible, setLinkDialogVisible] = useState(false);
  const [historyVisible, setHistoryVisible] = useState(false);

  const navigate = useNavigate();
  const showToast = useToastStore((s) => s.show);
  const setLockedByOtherName = useEditStore((s) => s.setLockedByOtherName);
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
    // 第2引数 emitUpdate=false: setEditable の既定は true で、モード切替のたびに
    // onUpdate → updateBody → dirty=true が誤発火する(初回マウントすら未保存扱いになる)
    editor?.setEditable(session.mode === 'edit', false);
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

  function handleStartEdit() {
    setTagsInput(doc.tags.join(', '));
    void session.startEditing(doc.body, doc.tags);
  }

  function handleTagsInputChange(value: string) {
    setTagsInput(value);
    // 保存経路(ボタン/Ctrl+S)によらず常に最新のタグが送られるよう、入力の都度sessionへ反映する
    session.updateTags(parseTagsInput(value));
  }

  function handleSave() {
    void session.save();
  }

  function handleCancelClick() {
    if (session.dirty) {
      setCancelConfirmVisible(true);
    } else {
      void session.cancelEditing();
    }
  }

  function handleConfirmCancel() {
    setCancelConfirmVisible(false);
    void session.cancelEditing();
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
            {lockedByOther && (
              <span className="text-warning">{lockedByOther.displayName}さんが編集中</span>
            )}
          </p>
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
            <>
              <button
                type="button"
                onClick={handleCancelClick}
                className="h-[30px] rounded border border-line px-3 text-sm text-ink-soft hover:bg-hoverbg"
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={handleSave}
                className="h-8 rounded bg-success px-3 text-sm text-white hover:bg-success-hover"
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

      {session.mode === 'edit' && (
        <div className="border-b border-line px-4 py-2 sm:px-6 lg:px-8">
          <label className="block text-xs text-ink-faint">
            タグ(カンマ区切り)
            <input
              value={tagsInput}
              onChange={(e) => handleTagsInputChange(e.target.value)}
              className="mt-1 block w-full rounded border border-line bg-panel-2 px-2 py-1 text-sm text-ink"
            />
          </label>
        </div>
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

      {cancelConfirmVisible && (
        <ConfirmDialog
          title="編集のキャンセル"
          message="編集内容を破棄しますか?"
          confirmLabel="破棄"
          cancelLabel="編集を続ける"
          onConfirm={handleConfirmCancel}
          onCancel={() => setCancelConfirmVisible(false)}
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
