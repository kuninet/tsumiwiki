import { EditorContent, useEditor } from '@tiptap/react';
import type { DocResponse, DocSummary, User } from '@tsumiwiki/shared';
import { type MouseEvent as ReactMouseEvent, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { uploadAttachment } from '../api/attachments';
import { useTree } from '../api/docs';
import { createEditorExtensions } from '../editor/markdown';
import '../editor/editor.css';
import { useEditingSession } from '../hooks/use-editing-session';
import { docUrl } from '../lib/doc-path';
import { resolveWikilink } from '../lib/resolve-wikilink';
import { useToastStore } from '../stores/toast';
import { ConfirmDialog } from './ConfirmDialog';
import { EditorToolbar } from './EditorToolbar';
import { PromptDialog } from './PromptDialog';

// 文書閲覧・編集画面(SC-02のMainPane。設計04章4.2/4.4・05章5.3〜5.5)
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

function parseTagsInput(input: string): string[] {
  return [...new Set(input.split(',').map((t) => t.trim()).filter(Boolean))];
}

const IMAGE_MIME_PREFIX = 'image/';

export function DocView({ doc, currentUser }: DocViewProps) {
  const [tagsInput, setTagsInput] = useState(doc.tags.join(', '));
  const [cancelConfirmVisible, setCancelConfirmVisible] = useState(false);
  const [linkDialogVisible, setLinkDialogVisible] = useState(false);

  const navigate = useNavigate();
  const showToast = useToastStore((s) => s.show);
  const { data: tree } = useTree();

  const wikilinkDocsRef = useRef<DocSummary[]>([]);
  useEffect(() => {
    wikilinkDocsRef.current = tree?.docs ?? [];
  }, [tree]);

  const session = useEditingSession({
    path: doc.path,
    baseUpdatedAt: doc.updatedAt,
  });

  const editor = useEditor({
    extensions: createEditorExtensions({ getWikilinkDocs: () => wikilinkDocsRef.current }),
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
        files.forEach((file) => void handleUploadImage(file));
        return true;
      },
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []).filter((f) =>
          f.type.startsWith(IMAGE_MIME_PREFIX),
        );
        if (files.length === 0) return false;
        event.preventDefault();
        files.forEach((file) => void handleUploadImage(file));
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
    editor?.setEditable(session.mode === 'edit');
  }, [editor, session.mode]);

  // 閲覧中に限り、外部要因(他者更新・定期refetch等)でdocが変わったら本文を追随させる。
  // 編集中は絶対に上書きしない(編集内容が消えるため)
  useEffect(() => {
    if (session.mode === 'view' && editor && !editor.isDestroyed) {
      editor.commands.setContent(doc.body);
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

  async function handleUploadImage(file: File) {
    showToast('success', '画像をアップロード中...');
    try {
      const result = await uploadAttachment(doc.path, file);
      editor?.chain().focus().insertContent({ type: 'obsidianEmbed', attrs: { target: result.fileName } }).run();
      showToast('success', '画像をアップロードしました');
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : '画像のアップロードに失敗しました');
    }
  }

  // wikilinkクリックでの遷移(FR-OBS-02)とfile://・UNCリンクの「パスをコピー」(FR-LINK-02)
  function handleContainerClick(e: ReactMouseEvent<HTMLDivElement>) {
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
      }
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start justify-between border-b border-gray-200 px-6 py-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">{titleFromPath(doc.path)}</h1>
          <p className="mt-1 text-sm text-gray-500">
            更新日時: {doc.updatedAt}
            {lockedByOther && (
              <span className="ml-2 text-amber-600">{lockedByOther.displayName}さんが編集中</span>
            )}
          </p>
        </div>
        <div className="flex flex-shrink-0 gap-2">
          {session.mode === 'view' ? (
            <button
              type="button"
              onClick={handleStartEdit}
              disabled={!!lockedByOther}
              className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              編集
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={handleCancelClick}
                className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={handleSave}
                className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700"
              >
                保存
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
        <div className="border-b border-gray-200 px-6 py-2">
          <label className="block text-xs text-gray-500">
            タグ(カンマ区切り)
            <input
              value={tagsInput}
              onChange={(e) => handleTagsInputChange(e.target.value)}
              className="mt-1 block w-full rounded border border-gray-300 px-2 py-1 text-sm text-gray-800"
            />
          </label>
        </div>
      )}

      <div className="flex-1 overflow-auto px-6 py-4" onClick={handleContainerClick}>
        <EditorContent editor={editor} />
      </div>

      {session.draftPrompt && (
        <ConfirmDialog
          title="未保存の下書き"
          message="未保存の下書きがあります。復元しますか?"
          confirmLabel="復元"
          cancelLabel="破棄"
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
    </div>
  );
}
