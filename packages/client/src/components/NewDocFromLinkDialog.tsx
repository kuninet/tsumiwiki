import { type FormEvent, type KeyboardEvent, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { parseWikilinkTarget } from '@tsumiwiki/shared';
import { useCreateDoc } from '../api/docs';
import { docUrl } from '../lib/doc-path';
import { planNewDocFromWikilink } from '../lib/wikilink-new-doc';
import { useTabsStore } from '../stores/tabs';
import { useToastStore } from '../stores/toast';
import { type UnresolvedLinkFolder, useUserSettingsStore } from '../stores/user-settings';

// #268: 未解決リンクをクリックしたときの新規文書作成ダイアログ
export interface NewDocFromLinkDialogProps {
  wikilinkTarget: string;
  sourceDocPath: string;
  onCancel: () => void;
  onCreated: (path: string) => void;
}

export function NewDocFromLinkDialog({
  wikilinkTarget,
  sourceDocPath,
  onCancel,
  onCreated,
}: NewDocFromLinkDialogProps) {
  const navigate = useNavigate();
  const showToast = useToastStore((s) => s.show);
  const initialFolderMode = useUserSettingsStore((s) => s.unresolvedLinkFolder);
  const setUnresolvedLinkFolder = useUserSettingsStore((s) => s.setUnresolvedLinkFolder);
  const [folderMode, setFolderMode] = useState<UnresolvedLinkFolder>(initialFolderMode);

  const createDoc = useCreateDoc();

  const targetMeta = useMemo(() => parseWikilinkTarget(wikilinkTarget), [wikilinkTarget]);
  const displayTarget = targetMeta.target || wikilinkTarget;

  const plan = useMemo(
    () => planNewDocFromWikilink(wikilinkTarget, sourceDocPath, folderMode),
    [wikilinkTarget, sourceDocPath, folderMode],
  );

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!plan || createDoc.isPending) return;

    // 1. 選んだラジオの値を保存(キャンセル時は保存しない)
    setUnresolvedLinkFolder(folderMode);

    // 2. createDoc mutation 実行
    createDoc.mutate(
      { folder: plan.folder, title: plan.title },
      {
        onSuccess: (data) => {
          // 3. 成功時: pinned タブで開いて遷移
          useTabsStore.getState().openDoc(data.path, { pinned: true });
          navigate(docUrl(data.path));

          // 4. 連番付与等で予定パスと異なる場合の警告
          if (data.path !== plan.path) {
            showToast('warning', 'リンク名と異なる名前で作成されました');
          }

          onCreated(data.path);
        },
        // 5. 失敗時は useCreateDoc の onError がトーストを出し、ダイアログは開いたまま
      },
    );
  }

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      if (!createDoc.isPending) {
        onCancel();
      }
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-doc-from-link-title"
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget && !createDoc.isPending) onCancel();
      }}
      onKeyDown={handleKeyDown}
    >
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md rounded-lg border border-line bg-panel p-6 shadow-lg"
      >
        <h2 id="new-doc-from-link-title" className="text-base font-bold text-ink">
          リンク先の文書を作成
        </h2>
        <p className="mt-1 text-sm text-ink-soft">
          「{displayTarget}」はまだありません。
        </p>

        <div className="mt-4">
          <span className="block text-sm font-medium text-ink-soft">作成先</span>
          <div className="mt-2 space-y-2">
            <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
              <input
                type="radio"
                name="unresolved-link-folder-dialog"
                value="same-folder"
                checked={folderMode === 'same-folder'}
                onChange={() => setFolderMode('same-folder')}
                className="text-accent focus:ring-accent"
              />
              リンク元と同じフォルダ
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
              <input
                type="radio"
                name="unresolved-link-folder-dialog"
                value="root"
                checked={folderMode === 'root'}
                onChange={() => setFolderMode('root')}
                className="text-accent focus:ring-accent"
              />
              ルート
            </label>
          </div>
        </div>

        <div className="mt-4 rounded border border-line bg-panel-2 p-3">
          <div className="text-xs text-ink-faint">作成されるファイル:</div>
          <div className="mt-0.5 break-all font-mono text-sm text-ink">
            {plan?.path ?? ''}
          </div>
        </div>

        {plan && plan.invalidChars.length > 0 && (
          <div className="mt-3 rounded border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
            {plan.invalidChars.map((c) => `「${c}」`).join(' ')}などファイル名に使えない文字は全角に置き換えて作成されます。リンクは未解決のまま残るので、作成後にリンクを書き換えてください。
          </div>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={createDoc.isPending}
            className="rounded border border-line px-3 py-1.5 text-sm text-ink-soft hover:bg-hoverbg disabled:opacity-50"
          >
            キャンセル
          </button>
          <button
            type="submit"
            autoFocus
            disabled={!plan || createDoc.isPending}
            className="rounded bg-accent px-3 py-1.5 text-sm text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {createDoc.isPending ? '作成中...' : '作成して開く'}
          </button>
        </div>
      </form>
    </div>
  );
}
