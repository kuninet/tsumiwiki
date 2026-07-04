import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { docQueryKey, saveDoc, TAGS_QUERY_KEY, TREE_QUERY_KEY } from '../api/docs';
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
  startEditing: (initialBody: string, initialTags: string[]) => Promise<void>;
  updateBody: (body: string) => void;
  updateTags: (tags: string[]) => void;
  save: () => Promise<void>;
  cancelEditing: () => Promise<void>;
  restoreDraft: () => string;
  discardDraftPrompt: () => Promise<void>;
}

function releaseLockBeacon(path: string): void {
  // sendBeaconはヘッダをカスタマイズできないため、CSRFヘッダが必須な本APIには使えない。
  // keepalive付きfetchでページ離脱後も送信を試行する(設計04章4.4)
  void fetch(`/api/locks?path=${encodeURIComponent(path)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
    keepalive: true,
    headers: { 'X-Requested-With': 'TsumiWiki' },
  });
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

  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [dirty, setDirty] = useState(false);
  const [lastDraftSavedAt, setLastDraftSavedAt] = useState<string | null>(null);
  const [draftPrompt, setDraftPrompt] = useState<DraftPrompt | null>(null);

  const contentRef = useRef<{ body: string; tags: string[] }>({ body: '', tags: [] });
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const modeRef = useRef(mode);
  modeRef.current = mode;

  useEffect(() => setStoreMode(mode), [mode, setStoreMode]);
  useEffect(() => setStoreDirty(dirty), [dirty, setStoreDirty]);
  useEffect(() => setStoreLastDraftSavedAt(lastDraftSavedAt), [lastDraftSavedAt, setStoreLastDraftSavedAt]);

  const stopEditingLocally = useCallback(() => {
    setMode('view');
    setDirty(false);
    setDraftPrompt(null);
    setLastDraftSavedAt(null);
    setStoreLockedPath(null);
  }, [setStoreLockedPath]);

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
  }, []);

  const updateTags = useCallback((tags: string[]) => {
    contentRef.current.tags = tags;
    setDirty(true);
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
    const path = optionsRef.current.path;
    const baseUpdatedAt = optionsRef.current.baseUpdatedAt;
    if (!path || !baseUpdatedAt) return;

    try {
      const { updatedAt } = await saveDoc({
        path,
        body: contentRef.current.body,
        tags: contentRef.current.tags,
        baseUpdatedAt,
      });
      await releaseLock(path).catch(() => {});
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
      // CONFLICT等その他のエラーは編集内容を保持したまま継続する
      showToast('error', err instanceof ApiRequestError ? err.message : '保存に失敗しました');
    }
  }, [invalidateAfterSave, showToast, stopEditingLocally]);

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
        releaseLockBeacon(path);
      }
    }
    window.addEventListener('beforeunload', handleBeforeUnload);
    window.addEventListener('pagehide', handlePageHide);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.removeEventListener('pagehide', handlePageHide);
    };
  }, [dirty]);

  // アンマウント時も編集中ならロック解放を試行する
  useEffect(() => {
    return () => {
      const path = optionsRef.current.path;
      if (modeRef.current === 'edit' && path) {
        releaseLockBeacon(path);
      }
    };
  }, []);

  return {
    mode,
    dirty,
    lastDraftSavedAt,
    draftPrompt,
    startEditing,
    updateBody,
    updateTags,
    save,
    cancelEditing,
    restoreDraft,
    discardDraftPrompt,
  };
}
