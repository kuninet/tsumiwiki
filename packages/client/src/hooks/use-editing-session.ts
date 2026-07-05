import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DocResponse } from '@tsumiwiki/shared';
import { docQueryKey, fetchDoc, saveDoc, TAGS_QUERY_KEY, TREE_QUERY_KEY } from '../api/docs';
import { ApiRequestError } from '../api/client';
import { deleteDraft, getDraft, saveDraft } from '../api/drafts';
import { acquireLock, refreshLock, releaseLock } from '../api/locks';
import { useEditStore } from '../stores/edit';
import { useToastStore } from '../stores/toast';

// 編集モードのライフサイクル(設計04章4.4)を1つのフックに集約する状態機械。
// 閲覧⇔編集の切り替え・ロック取得/ハートビート/解放・下書きの自動保存/復元・
// 保存時の競合検知を担う。Tiptapエディタの状態そのものは持たず、呼び出し側
// (DocView)がonUpdate等でupdateBody/updateTagsを呼んで内容を渡す

const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;
const DEFAULT_AUTOSAVE_INTERVAL_MS = 30_000;

export interface DraftPrompt {
  content: string;
  updatedAt: string;
}

export interface UseEditingSessionOptions {
  path: string | undefined;
  baseUpdatedAt: string | undefined;
  onSaved?: (updatedAt: string) => void;
  onCancelled?: () => void;
  heartbeatIntervalMs?: number;
  autosaveIntervalMs?: number;
}

export interface UseEditingSessionResult {
  mode: 'view' | 'edit';
  dirty: boolean;
  lastDraftSavedAt: string | null;
  draftPrompt: DraftPrompt | null;
  conflict: boolean;
  startEditing: (initialBody: string, initialTags: string[]) => Promise<void>;
  updateBody: (body: string) => void;
  updateTags: (tags: string[]) => void;
  save: () => Promise<void>;
  cancelEditing: () => Promise<void>;
  restoreDraft: () => string;
  discardDraftPrompt: () => Promise<void>;
  resolveConflictOverwrite: () => Promise<void>;
  resolveConflictDiscard: () => Promise<void>;
}

// sendBeaconはヘッダをカスタマイズできないため、CSRFヘッダが必須な本APIには使えない。
// keepalive付きfetchでページ離脱・SPA内遷移(アンマウント)後も送信を試行する(設計04章4.4)
function releaseLockBeacon(path: string): void {
  void fetch(`/api/locks?path=${encodeURIComponent(path)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
    keepalive: true,
    headers: { 'X-Requested-With': 'TsumiWiki' },
  });
}

function saveDraftBeacon(path: string, content: string): void {
  void fetch('/api/drafts', {
    method: 'PUT',
    credentials: 'same-origin',
    keepalive: true,
    headers: { 'X-Requested-With': 'TsumiWiki', 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, content }),
  });
}

// 離脱・アンマウント時の後始末: dirtyなら最終下書きを保存してからロックを解放する
function flushOnLeave(path: string, dirty: boolean, body: string): void {
  if (dirty) {
    saveDraftBeacon(path, body);
  }
  releaseLockBeacon(path);
}

export function useEditingSession(options: UseEditingSessionOptions): UseEditingSessionResult {
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const autosaveIntervalMs = options.autosaveIntervalMs ?? DEFAULT_AUTOSAVE_INTERVAL_MS;

  const queryClient = useQueryClient();
  const showToast = useToastStore((s) => s.show);
  const setStoreMode = useEditStore((s) => s.setMode);
  const setStoreDirty = useEditStore((s) => s.setDirty);
  const setStoreLockedPath = useEditStore((s) => s.setLockedPath);
  const setStoreLastDraftSavedAt = useEditStore((s) => s.setLastDraftSavedAt);
  const setStoreSaveError = useEditStore((s) => s.setSaveError);

  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [dirty, setDirty] = useState(false);
  const [lastDraftSavedAt, setLastDraftSavedAt] = useState<string | null>(null);
  const [draftPrompt, setDraftPrompt] = useState<DraftPrompt | null>(null);
  const [conflict, setConflict] = useState(false);

  const contentRef = useRef<{ body: string; tags: string[] }>({ body: '', tags: [] });
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const savingRef = useRef(false);

  useEffect(() => setStoreMode(mode), [mode, setStoreMode]);
  useEffect(() => setStoreDirty(dirty), [dirty, setStoreDirty]);
  useEffect(() => setStoreLastDraftSavedAt(lastDraftSavedAt), [lastDraftSavedAt, setStoreLastDraftSavedAt]);

  const stopEditingLocally = useCallback(() => {
    setMode('view');
    setDirty(false);
    setDraftPrompt(null);
    setLastDraftSavedAt(null);
    setConflict(false);
    setStoreLockedPath(null);
    setStoreSaveError(false);
  }, [setStoreLockedPath, setStoreSaveError]);

  const startEditing = useCallback(
    async (initialBody: string, initialTags: string[]) => {
      const path = optionsRef.current.path;
      if (!path) return;
      try {
        await acquireLock(path);
      } catch (err) {
        showToast('error', err instanceof ApiRequestError ? err.message : '編集を開始できませんでした');
        return;
      }
      contentRef.current = { body: initialBody, tags: initialTags };
      setDirty(false);
      setDraftPrompt(null);
      setConflict(false);
      setMode('edit');
      setStoreLockedPath(path);

      try {
        const { draft } = await getDraft(path);
        if (draft) {
          setDraftPrompt(draft);
        }
      } catch {
        // 下書き取得の失敗は編集開始自体をブロックしない
      }
    },
    [showToast, setStoreLockedPath],
  );

  const updateBody = useCallback((body: string) => {
    contentRef.current.body = body;
    setDirty(true);
    // 追加編集後に「自動保存済み」バッジが残らないよう毎編集でクリアする(次の自動保存で再点灯)
    setLastDraftSavedAt(null);
  }, []);

  const updateTags = useCallback((tags: string[]) => {
    contentRef.current.tags = tags;
    setDirty(true);
    setLastDraftSavedAt(null);
  }, []);

  const restoreDraft = useCallback((): string => {
    const content = draftPrompt?.content ?? '';
    contentRef.current.body = content;
    setDirty(true);
    setDraftPrompt(null);
    return content;
  }, [draftPrompt]);

  const discardDraftPrompt = useCallback(async () => {
    const path = optionsRef.current.path;
    setDraftPrompt(null);
    if (!path) return;
    await deleteDraft(path).catch(() => {
      // 既に無い等は無視する
    });
  }, []);

  const invalidateAfterSave = useCallback(
    (path: string) => {
      queryClient.invalidateQueries({ queryKey: docQueryKey(path) });
      queryClient.invalidateQueries({ queryKey: TREE_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: TAGS_QUERY_KEY });
    },
    [queryClient],
  );

  const save = useCallback(async () => {
    if (savingRef.current) return; // Ctrl+S連打等での多重送信を防ぐ
    const path = optionsRef.current.path;
    const baseUpdatedAt = optionsRef.current.baseUpdatedAt;
    if (!path || !baseUpdatedAt) return;

    savingRef.current = true;
    setStoreSaveError(false); // 新しい保存試行時は前回のエラー表示をクリアする
    try {
      const { updatedAt } = await saveDoc({
        path,
        body: contentRef.current.body,
        tags: contentRef.current.tags,
        baseUpdatedAt,
      });
      await releaseLock(path).catch(() => {});
      // React Query の refetch を待たず、returnされたupdatedAtをキャッシュに即反映する。
      // 待つと連続保存時に stale な baseUpdatedAt を送って409 CONFLICTになる
      queryClient.setQueryData<DocResponse | undefined>(docQueryKey(path), (old) =>
        old ? { ...old, updatedAt } : old,
      );
      invalidateAfterSave(path);
      stopEditingLocally();
      showToast('success', '保存しました');
      optionsRef.current.onSaved?.(updatedAt);
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'LOCK_EXPIRED') {
        showToast('error', err.message);
        stopEditingLocally();
        return;
      }
      if (err instanceof ApiRequestError && err.code === 'CONFLICT') {
        // 編集内容は保持したまま、競合解消ダイアログの表示に切り替える
        showToast('error', err.message);
        setConflict(true);
        return;
      }
      setStoreSaveError(true);
      showToast('error', err instanceof ApiRequestError ? err.message : '保存に失敗しました');
    } finally {
      savingRef.current = false;
    }
  }, [invalidateAfterSave, queryClient, showToast, stopEditingLocally, setStoreSaveError]);

  // 競合解消: 自分の編集内容を保持したまま、最新のupdatedAtを取得し直して再保存する
  const resolveConflictOverwrite = useCallback(async () => {
    const path = optionsRef.current.path;
    if (!path) return;
    try {
      const latest = await fetchDoc(path);
      const { updatedAt } = await saveDoc({
        path,
        body: contentRef.current.body,
        tags: contentRef.current.tags,
        baseUpdatedAt: latest.updatedAt,
      });
      await releaseLock(path).catch(() => {});
      queryClient.setQueryData<DocResponse | undefined>(docQueryKey(path), (old) =>
        old ? { ...old, updatedAt } : old,
      );
      invalidateAfterSave(path);
      stopEditingLocally();
      showToast('success', '保存しました');
      optionsRef.current.onSaved?.(updatedAt);
    } catch (err) {
      // 再度の競合等はダイアログを表示したまま再試行できるようにする
      showToast('error', err instanceof ApiRequestError ? err.message : '保存に失敗しました');
    }
  }, [invalidateAfterSave, queryClient, showToast, stopEditingLocally]);

  // 競合解消: 自分の編集を破棄し、最新の内容を読み込み直す
  const resolveConflictDiscard = useCallback(async () => {
    const path = optionsRef.current.path;
    setConflict(false);
    if (path) {
      await deleteDraft(path).catch(() => {});
      await releaseLock(path).catch(() => {});
      queryClient.invalidateQueries({ queryKey: docQueryKey(path) });
    }
    stopEditingLocally();
  }, [queryClient, stopEditingLocally]);

  const cancelEditing = useCallback(async () => {
    const path = optionsRef.current.path;
    if (path) {
      await deleteDraft(path).catch(() => {});
      await releaseLock(path).catch(() => {});
    }
    stopEditingLocally();
    optionsRef.current.onCancelled?.();
  }, [stopEditingLocally]);

  // ハートビート: 編集中のみ、ロック失効を検知したら閲覧モードへ戻す
  useEffect(() => {
    if (mode !== 'edit') return undefined;
    const timer = setInterval(() => {
      const path = optionsRef.current.path;
      if (!path) return;
      refreshLock(path).catch((err) => {
        if (err instanceof ApiRequestError && err.code === 'LOCK_EXPIRED') {
          showToast('error', err.message);
          stopEditingLocally();
        }
      });
    }, heartbeatIntervalMs);
    return () => clearInterval(timer);
  }, [mode, heartbeatIntervalMs, showToast, stopEditingLocally]);

  // 自動保存: 編集中かつdirtyな場合のみ下書きを保存する
  useEffect(() => {
    if (mode !== 'edit') return undefined;
    const timer = setInterval(() => {
      const path = optionsRef.current.path;
      if (!path || !contentRef.current) return;
      if (!dirty) return;
      saveDraft(path, contentRef.current.body)
        .then(() => setLastDraftSavedAt(new Date().toISOString()))
        .catch(() => {
          // 自動保存の失敗は次回タイマーでリトライするため静かに無視する
        });
    }, autosaveIntervalMs);
    return () => clearInterval(timer);
  }, [mode, dirty, autosaveIntervalMs]);

  // 離脱保護: 未保存の変更があるページ離脱前に警告し、pagehideでロック解放を試行する
  useEffect(() => {
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      if (modeRef.current === 'edit' && dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    }
    function handlePageHide() {
      const path = optionsRef.current.path;
      if (modeRef.current === 'edit' && path) {
        flushOnLeave(path, dirtyRef.current, contentRef.current.body);
      }
    }
    window.addEventListener('beforeunload', handleBeforeUnload);
    window.addEventListener('pagehide', handlePageHide);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.removeEventListener('pagehide', handlePageHide);
    };
  }, [dirty]);

  // アンマウント時(SPA内遷移含む)も編集中ならdirtyな内容を下書き保存してからロックを解放する
  useEffect(() => {
    return () => {
      const path = optionsRef.current.path;
      if (modeRef.current === 'edit' && path) {
        flushOnLeave(path, dirtyRef.current, contentRef.current.body);
      }
    };
  }, []);

  return {
    mode,
    dirty,
    lastDraftSavedAt,
    draftPrompt,
    conflict,
    startEditing,
    updateBody,
    updateTags,
    save,
    cancelEditing,
    restoreDraft,
    discardDraftPrompt,
    resolveConflictOverwrite,
    resolveConflictDiscard,
  };
}
