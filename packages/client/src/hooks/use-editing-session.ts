import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DocResponse, FrontmatterOp } from '@tsumiwiki/shared';
import { BACKLINKS_QUERY_KEY, docQueryKey, fetchDoc, saveDoc, TAGS_QUERY_KEY, TREE_QUERY_KEY } from '../api/docs';
import { ApiRequestError } from '../api/client';
import { deleteDraft, getDraft, saveDraft } from '../api/drafts';
import { ALL_HISTORY_QUERY_KEY } from '../api/history';
import { acquireLock, refreshLock, releaseLock } from '../api/locks';
import { useEditStore } from '../stores/edit';
import { useToastStore } from '../stores/toast';

// 編集モードのライフサイクル(設計04章4.4)を1つのフックに集約する状態機械。
// 閲覧⇔編集の切り替え・ロック取得/ハートビート/解放・下書きの自動保存/復元・
// 保存時の競合検知を担う。Tiptapエディタの状態そのものは持たず、呼び出し側
// (DocView)がonUpdate等でupdateBody/updateTagsを呼んで内容を渡す
//
// #300: ロックは編集モードに入った時点では取らず、最初に本文やタグを書き換えたとき
// (dirty になった瞬間)に取る。開いただけの文書には MCP などからも書き込める。
// ロックを取ったら、開いた時点(または最後の保存時点)の updatedAt と最新の updatedAt を
// 比べ、ずれていれば競合として知らせる。保存後しばらく入力が無ければロックを手放す

const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;
const DEFAULT_AUTOSAVE_INTERVAL_MS = 30_000;
const DEFAULT_IDLE_RELEASE_MS = 120_000;
// ロックの取得に通信失敗などで失敗したあと、入力をきっかけに取り直すのを控える時間。
// キー入力のたびに POST とトーストが出るのを防ぐ。保存のときはこの間でも取り直す
const LOCK_RETRY_COOLDOWN_MS = 10_000;

// 競合の種類。save=保存時にサーバーが CONFLICT を返した。
// acquire=ロックを取ったとき、開いたあとでほかから更新されていたと分かった
export type ConflictKind = 'save' | 'acquire';

// ロック確保の結果。ok=ロックを持っていて競合も無い / conflict=ロックは持ったが競合を検知した /
// locked=ほかの人が編集中で取れなかった(閲覧モードへ戻した) / failed=通信失敗など(次の変更や保存で再試行) /
// cancelled=取得中に編集を終えた・アンマウントした(取れたロックは手放した)
type EnsureLockResult = 'ok' | 'conflict' | 'locked' | 'failed' | 'cancelled';

// 添付リネームなど、サーバー側で自分の操作により文書が書き換わったときの扱い(#300)。
// advanced=ロックを持っているので基準の updatedAt を進めた / dirty=ロックが無いまま書き換え中なので
// 基準は進めない(次のロック取得で競合として知らせる) / reload=未変更なので最新を読み込み直せばよい
export type ServerRewriteResult = 'advanced' | 'dirty' | 'reload';

export interface DraftPrompt {
  content: string;
  updatedAt: string;
}

export interface UseEditingSessionOptions {
  path: string | undefined;
  // 文書キャッシュの updatedAt。編集を始めた時点の値だけを競合検知の基準に使う(#300)。
  // 編集中にキャッシュが再取得で進んでも、エディタの内容は差し替わらないので基準には使わない
  baseUpdatedAt: string | undefined;
  onSaved?: (updatedAt: string) => void;
  onCancelled?: () => void;
  heartbeatIntervalMs?: number;
  autosaveIntervalMs?: number;
  // 保存して dirty でなくなってから、入力が無いままロックを手放すまでの時間(#300)
  idleReleaseMs?: number;
  // タブ導入(Epic #133): 非アクティブタブは useEditStore(グローバル)への書き込みを抑止する。
  // ローカル state は常に更新するので、アクティブに戻ったタイミングで useEffect が
  // 現在値を store に流し込み、StatusBar 等が正しく追随する。省略時は true(既存挙動互換)
  active?: boolean;
}

export interface UseEditingSessionResult {
  mode: 'view' | 'edit';
  dirty: boolean;
  lastDraftSavedAt: string | null;
  draftPrompt: DraftPrompt | null;
  // 競合が出ていなければ false。出ていればその種類(ダイアログの文言を出し分ける)
  conflict: false | ConflictKind;
  startEditing: (initialBody: string, initialTags: string[]) => Promise<void>;
  updateBody: (body: string) => void;
  updateTags: (tags: string[]) => void;
  // #282: プロパティ操作の更新
  updateFrontmatter: (ops: FrontmatterOp[], valid: boolean) => void;
  // dirty を変えずに保存対象の本文だけ差し替える。サーバー側で既にファイルが書き換わっている
  // 変更(添付リネームによる参照書き換え等)をエディタへ反映したときに使う
  syncBody: (body: string) => void;
  // 保存試行後、真に成功して dirty が落ちたかどうかを返す。
  // dirty=false のときの早期 return(何もしなくてよい)も true とみなす。
  // CloseConfirmDialog が「保存 → 閉じる」を進めてよいか判定するのに使う
  save: () => Promise<boolean>;
  cancelEditing: () => Promise<void>;
  restoreDraft: () => string;
  discardDraftPrompt: () => Promise<void>;
  resolveConflictOverwrite: () => Promise<void>;
  resolveConflictDiscard: () => Promise<void>;
  // 添付リネームでサーバー側の本文が書き換わったことを伝える。ロックを持っていれば基準を進める
  noteServerRewrite: (updatedAt: string) => ServerRewriteResult;
  // 未変更・ロックなしのときだけ、取り直した最新の文書を編集の起点にする。採用したら true
  reloadFromLatest: (latest: { body: string; tags: string[]; updatedAt: string }) => boolean;
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

// 離脱・アンマウント時の後始末: dirtyなら最終下書きを保存し、ロックを持っていれば解放する。
// 下書きはロックが無くても保存できる(#300。ほかの人のロック中はサーバーが拒否する)
function flushOnLeave(path: string, dirty: boolean, body: string, holdsLock: boolean): void {
  if (dirty) {
    saveDraftBeacon(path, body);
  }
  if (holdsLock) {
    releaseLockBeacon(path);
  }
}

export function useEditingSession(options: UseEditingSessionOptions): UseEditingSessionResult {
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const autosaveIntervalMs = options.autosaveIntervalMs ?? DEFAULT_AUTOSAVE_INTERVAL_MS;
  const idleReleaseMs = options.idleReleaseMs ?? DEFAULT_IDLE_RELEASE_MS;
  const active = options.active ?? true;

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
  const [conflict, setConflictLocal] = useState<false | ConflictKind>(false);
  // ロック状態と保存エラーは元々ストアへ直書きしていたが、非アクティブタブから書き込むと
  // アクティブタブ側の表示を破壊するのでローカル state を経由し、useEffect で active 時のみ同期する
  const [lockedPath, setLockedPathLocal] = useState<string | null>(null);
  const [saveError, setSaveErrorLocal] = useState(false);

  const contentRef = useRef<{
    body: string;
    tags: string[];
    frontmatterOps: FrontmatterOp[];
    frontmatterValid: boolean;
  }>({ body: '', tags: [], frontmatterOps: [], frontmatterValid: true });
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const savingRef = useRef(false);
  // useCallback([]) のコールバックやタイマーから同期的に参照するため、ロック・競合は ref にも持つ
  const lockedPathRef = useRef<string | null>(null);
  const conflictRef = useRef<false | ConflictKind>(false);
  // 取得中のロック確保。多重に呼ばれても取得は1回だけにするため Promise を使い回す
  const lockPromiseRef = useRef<Promise<EnsureLockResult> | null>(null);
  // 編集セッションの世代。編集の開始・終了・アンマウントで進め、取得中だったロック確保が
  // 古いセッションのものだと分かったら結果を捨てる(取れたロックは手放す)
  const sessionEpochRef = useRef(0);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idleReleaseMsRef = useRef(idleReleaseMs);
  idleReleaseMsRef.current = idleReleaseMs;
  // 競合検知の基準になる updatedAt(#300)。編集を始めた時点で固定し、進めるのは自分の書き込み
  // (保存・上書き保存・ロック保持中の添付リネーム)のときだけ。キャッシュの再取得では進めない
  const editBaseRef = useRef<string | undefined>(undefined);
  // このフックが送ったロック解放(アイドル解放・古いセッションの後始末)。次の取得はこれを待ってから送る
  const releasingRef = useRef<Promise<void> | null>(null);
  // 取得失敗の抑制: この時刻までは入力をきっかけに取り直さない。トーストは連続した失敗で1回だけ
  const lockRetryAfterRef = useRef(0);
  const lockFailureNotifiedRef = useRef(false);

  const setLockedPath = useCallback((path: string | null) => {
    lockedPathRef.current = path;
    setLockedPathLocal(path);
  }, []);

  const setConflict = useCallback((kind: false | ConflictKind) => {
    conflictRef.current = kind;
    setConflictLocal(kind);
  }, []);

  const clearIdleTimer = useCallback(() => {
    if (idleTimerRef.current !== null) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }, []);

  // 解放を送り、完了するまで releasingRef に持つ(直後の取得が解放より先に届かないようにする)
  const releaseTracked = useCallback((path: string): Promise<void> => {
    const promise = releaseLock(path)
      .then(() => undefined)
      .catch(() => {
        // 解放に失敗してもサーバー側のタイムアウトで失効する
      });
    releasingRef.current = promise;
    void promise.finally(() => {
      if (releasingRef.current === promise) releasingRef.current = null;
    });
    return promise;
  }, []);

  // active 時のみグローバルストアへ現在値を反映。active が false→true に変わったタイミングでも
  // 依存に active が入っているので再実行され、切替後のタブが正しく StatusBar に載る。
  useEffect(() => {
    if (active) setStoreMode(mode);
  }, [mode, active, setStoreMode]);
  useEffect(() => {
    if (active) setStoreDirty(dirty);
  }, [dirty, active, setStoreDirty]);
  useEffect(() => {
    if (active) setStoreLastDraftSavedAt(lastDraftSavedAt);
  }, [lastDraftSavedAt, active, setStoreLastDraftSavedAt]);
  useEffect(() => {
    if (active) setStoreLockedPath(lockedPath);
  }, [lockedPath, active, setStoreLockedPath]);
  useEffect(() => {
    if (active) setStoreSaveError(saveError);
  }, [saveError, active, setStoreSaveError]);

  const stopEditingLocally = useCallback(() => {
    sessionEpochRef.current += 1;
    lockPromiseRef.current = null;
    clearIdleTimer();
    // modeRef は次の描画まで古い値のままなので、離脱処理が二重に走らないよう先に更新する
    modeRef.current = 'view';
    setMode('view');
    setDirty(false);
    setDraftPrompt(null);
    setLastDraftSavedAt(null);
    setConflict(false);
    setLockedPath(null);
    setSaveErrorLocal(false);
    contentRef.current.frontmatterOps = [];
    contentRef.current.frontmatterValid = true;
  }, [clearIdleTimer, setConflict, setLockedPath]);

  // ロックを確保する(#300)。持っていれば何もしない。取得中ならその完了を待つ。
  // ロックを取ってから最新の updatedAt を比べるのは、比べたあとで MCP などに書き込まれる隙を作らないため
  const ensureLock = useCallback((): Promise<EnsureLockResult> => {
    if (lockedPathRef.current) {
      return Promise.resolve(conflictRef.current ? 'conflict' : 'ok');
    }
    if (lockPromiseRef.current) return lockPromiseRef.current;
    const path = optionsRef.current.path;
    if (!path) return Promise.resolve('failed');
    const epoch = sessionEpochRef.current;
    const isStale = () => epoch !== sessionEpochRef.current;

    // 古いセッションの後始末: このフックが新しいロックを持っておらず、取得も始めていないときだけ解放する。
    // サーバーの解放は同じユーザーのロックなら区別せず消すので、新しく取ったロックを消さないため
    const releaseIfUnused = async () => {
      // 取得中にアンマウントされたときは、lockPromiseRef が自分自身のまま残るので、それも「未使用」とみなす
      const pendingNow = lockPromiseRef.current;
      if (lockedPathRef.current === null && (pendingNow === null || pendingNow === promise)) {
        await releaseTracked(path);
      }
    };

    const promise = (async (): Promise<EnsureLockResult> => {
      // 直前に送った解放があれば、それが済んでから取得する
      if (releasingRef.current) await releasingRef.current;
      if (isStale()) return 'cancelled';
      try {
        await acquireLock(path);
      } catch (err) {
        if (isStale()) return 'cancelled';
        if (err instanceof ApiRequestError && err.code === 'DOC_LOCKED') {
          // ほかの人が編集中。入力しかけた分は下書きにもできないが、めったに起きないので許容する
          showToast('error', err.message);
          stopEditingLocally();
          // ロックの表示(○○さんが編集中)を最新にする
          void queryClient.invalidateQueries({ queryKey: docQueryKey(path) });
          return 'locked';
        }
        // 通信失敗など。編集は続けさせ、一定時間後の変更か保存のときに取り直す。
        // トーストは連続した失敗の間で1回だけ出す
        lockRetryAfterRef.current = Date.now() + LOCK_RETRY_COOLDOWN_MS;
        if (!lockFailureNotifiedRef.current) {
          lockFailureNotifiedRef.current = true;
          showToast(
            'error',
            err instanceof ApiRequestError ? err.message : '編集ロックを取得できませんでした',
          );
        }
        return 'failed';
      }
      lockRetryAfterRef.current = 0;
      lockFailureNotifiedRef.current = false;
      if (isStale()) {
        // 取得中に編集を終えた・アンマウントした。取れたロックは残さず手放す
        await releaseIfUnused();
        return 'cancelled';
      }

      let latestUpdatedAt: string | undefined;
      try {
        latestUpdatedAt = (await fetchDoc(path)).updatedAt;
      } catch {
        // 比べられなかったときもロックは持ったまま続ける。
        // 保存時にサーバーが baseUpdatedAt を比べるので、ほかの変更を黙って消すことはない
      }
      if (isStale()) {
        await releaseIfUnused();
        return 'cancelled';
      }
      setLockedPath(path);
      const baseUpdatedAt = editBaseRef.current;
      if (
        latestUpdatedAt !== undefined &&
        baseUpdatedAt !== undefined &&
        latestUpdatedAt !== baseUpdatedAt
      ) {
        // 開いたあとでほかから更新されていた。黙って読み込み直したり上書きしたりせず、競合として知らせる。
        // 競合ダイアログの2つのボタンはどちらもロックを持っている前提で動くので、ロックは持ったままにする
        setConflict('acquire');
        return 'conflict';
      }
      return 'ok';
    })();

    lockPromiseRef.current = promise;
    void promise.finally(() => {
      if (lockPromiseRef.current === promise) lockPromiseRef.current = null;
    });
    return promise;
  }, [queryClient, showToast, stopEditingLocally, setConflict, setLockedPath, releaseTracked]);

  // 書き換えたときの共通処理: dirty にし、ロック解放のタイマーを止め、ロックが無ければ取りにいく。
  // 直前に取得が失敗していたら、しばらくは入力のたびには取り直さない(保存のときは取り直す)
  const markDirtyAndEnsureLock = useCallback(() => {
    dirtyRef.current = true;
    setDirty(true);
    clearIdleTimer();
    if (!lockedPathRef.current && Date.now() >= lockRetryAfterRef.current) void ensureLock();
  }, [clearIdleTimer, ensureLock]);

  // 保存に成功して dirty でなくなったら、一定時間後にロックを手放すタイマーを起動する。
  // 満了時にまだ dirty でなく、競合も保存中でもなければ解放する(編集モードは続ける)
  const scheduleIdleRelease = useCallback(() => {
    clearIdleTimer();
    const epoch = sessionEpochRef.current;
    idleTimerRef.current = setTimeout(() => {
      idleTimerRef.current = null;
      if (epoch !== sessionEpochRef.current) return;
      if (dirtyRef.current || conflictRef.current || savingRef.current) return;
      const path = lockedPathRef.current;
      if (!path) return;
      setLockedPath(null);
      void releaseTracked(path);
    }, idleReleaseMsRef.current);
  }, [clearIdleTimer, setLockedPath, releaseTracked]);

  const startEditing = useCallback(
    async (initialBody: string, initialTags: string[]) => {
      const path = optionsRef.current.path;
      if (!path) return;
      // #300: ここではロックを取らない。最初に書き換えたときに ensureLock で取る
      sessionEpochRef.current += 1;
      // 前のセッションの取得がまだ終わっていなければ、その後始末(取れたロックの解放)を待つ
      // 競合検知の基準は、編集を始めた時点(initialBody を受け取った時点)の updatedAt に固定する
      const base = optionsRef.current.baseUpdatedAt;
      const pending = lockPromiseRef.current;
      lockPromiseRef.current = null;
      clearIdleTimer();
      if (pending) await pending;
      editBaseRef.current = base;
      lockRetryAfterRef.current = 0;
      lockFailureNotifiedRef.current = false;
      setSaveErrorLocal(false);
      contentRef.current = {
        body: initialBody,
        tags: initialTags,
        frontmatterOps: [],
        frontmatterValid: true,
      };
      setDirty(false);
      setDraftPrompt(null);
      setConflict(false);
      modeRef.current = 'edit';
      setMode('edit');
      // draft prompt などのローカル state だけ操作。ストア反映は useEffect が担う

      try {
        const { draft } = await getDraft(path);
        if (draft) {
          setDraftPrompt(draft);
        }
      } catch {
        // 下書き取得の失敗は編集開始自体をブロックしない
      }
    },
    [clearIdleTimer, setConflict],
  );

  const updateBody = useCallback(
    (body: string) => {
      contentRef.current.body = body;
      markDirtyAndEnsureLock();
      // 追加編集後に「自動保存済み」バッジが残らないよう毎編集でクリアする(次の自動保存で再点灯)
      setLastDraftSavedAt(null);
    },
    [markDirtyAndEnsureLock],
  );

  const syncBody = useCallback((body: string) => {
    contentRef.current.body = body;
  }, []);

  const updateTags = useCallback(
    (tags: string[]) => {
      contentRef.current.tags = tags;
      markDirtyAndEnsureLock();
      setLastDraftSavedAt(null);
    },
    [markDirtyAndEnsureLock],
  );

  const updateFrontmatter = useCallback(
    (ops: FrontmatterOp[], valid: boolean) => {
      contentRef.current.frontmatterOps = ops;
      contentRef.current.frontmatterValid = valid;
      markDirtyAndEnsureLock();
      setLastDraftSavedAt(null);
    },
    [markDirtyAndEnsureLock],
  );

  const restoreDraft = useCallback((): string => {
    const content = draftPrompt?.content ?? '';
    contentRef.current.body = content;
    markDirtyAndEnsureLock();
    setDraftPrompt(null);
    return content;
  }, [draftPrompt, markDirtyAndEnsureLock]);

  const discardDraftPrompt = useCallback(async () => {
    const path = optionsRef.current.path;
    setDraftPrompt(null);
    if (!path) return;
    await deleteDraft(path).catch(() => {
      // 既に無い等は無視する
    });
  }, []);

  const save = useCallback(async (): Promise<boolean> => {
    if (savingRef.current) return false; // 多重送信は失敗扱い(呼び出し側でリトライ判断)
    if (!dirtyRef.current) return true; // 変更なしは既に保存済みと同義。閉じ確認等でそのまま先へ進める

    // #282: プロパティに入力エラーがある場合は保存しない
    if (!contentRef.current.frontmatterValid) {
      showToast('error', 'プロパティに入力エラーがあります');
      return false;
    }

    const path = optionsRef.current.path;
    if (!path || !editBaseRef.current) return false;

    savingRef.current = true;
    setSaveErrorLocal(false); // 新しい保存試行時は前回のエラー表示をクリアする
    try {
      // #300: ロックを持っていなければ、先に取る(取得中ならその完了を待つ)。
      // 取れなかったとき、または競合が出ている(開いたあとの更新を検知した等)ときは保存しない
      const lockResult = await ensureLock();
      if (lockResult === 'failed') {
        setSaveErrorLocal(true);
        showToast('error', '編集ロックを取得できなかったため、保存できませんでした');
        return false;
      }
      if (lockResult !== 'ok') return false;
      // 編集を始めた時点(または最後に保存した時点)の updatedAt を送る。キャッシュの値は使わない
      const baseUpdatedAt = editBaseRef.current;
      if (!baseUpdatedAt) return false;
      const sentOps = contentRef.current.frontmatterOps;
      const { updatedAt, frontmatter } = await saveDoc({
        path,
        body: contentRef.current.body,
        tags: contentRef.current.tags,
        frontmatterOps: sentOps.length > 0 ? sentOps : undefined,
        baseUpdatedAt,
      });
      // React Query の refetch を待たず、送信した内容+returnされたupdatedAtでキャッシュを即更新する。
      // 待つと連続保存時に stale な baseUpdatedAt を送って409 CONFLICTになる。
      // body/tags もサーバに送った内容で置換することで、doc.tags を参照する側(タグチップ等)が
      // 保存後も正しい値を見られるようにする(#51: 編集モードを継続するので refetch は行わない)
      queryClient.setQueryData<DocResponse | undefined>(docQueryKey(path), (old) =>
        old
          ? {
              ...old,
              updatedAt,
              frontmatter: frontmatter ?? old.frontmatter,
              body: contentRef.current.body,
              tags: contentRef.current.tags,
            }
          : old,
      );
      // 保存後も編集モードは継続する(シームレスUX。#51)。
      editBaseRef.current = updatedAt;
      // #282: 送信中にプロパティが更新された場合は ops を残し、dirty=true のままアイドルタイマーを起動しない
      if (contentRef.current.frontmatterOps === sentOps) {
        contentRef.current.frontmatterOps = [];
        dirtyRef.current = false;
        setDirty(false);
        scheduleIdleRelease();
      } else {
        dirtyRef.current = true;
      }
      setLastDraftSavedAt(null);
      // tree/tags はタグ変化に追随させる
      queryClient.invalidateQueries({ queryKey: TREE_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: TAGS_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: ALL_HISTORY_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: BACKLINKS_QUERY_KEY });
      showToast('success', '保存しました');
      optionsRef.current.onSaved?.(updatedAt);
      return true;
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'LOCK_EXPIRED') {
        showToast('error', err.message);
        stopEditingLocally();
        return false;
      }
      if (err instanceof ApiRequestError && err.code === 'CONFLICT') {
        // 編集内容は保持したまま、競合解消ダイアログの表示に切り替える
        showToast('error', err.message);
        setConflict('save');
        return false;
      }
      setSaveErrorLocal(true);
      showToast('error', err instanceof ApiRequestError ? err.message : '保存に失敗しました');
      return false;
    } finally {
      savingRef.current = false;
    }
  }, [queryClient, showToast, stopEditingLocally, ensureLock, setConflict, scheduleIdleRelease]);

  // 競合解消: 自分の編集内容を保持したまま、最新のupdatedAtを取得し直して再保存する
  const resolveConflictOverwrite = useCallback(async () => {
    const path = optionsRef.current.path;
    if (!path) return;
    if (!contentRef.current.frontmatterValid) {
      showToast('error', 'プロパティに入力エラーがあります');
      return;
    }
    try {
      const latest = await fetchDoc(path);
      const sentOps = contentRef.current.frontmatterOps;
      const { updatedAt, frontmatter } = await saveDoc({
        path,
        body: contentRef.current.body,
        tags: contentRef.current.tags,
        frontmatterOps: sentOps.length > 0 ? sentOps : undefined,
        baseUpdatedAt: latest.updatedAt,
      });
      queryClient.setQueryData<DocResponse | undefined>(docQueryKey(path), (old) =>
        old
          ? {
              ...old,
              updatedAt,
              frontmatter: frontmatter ?? old.frontmatter,
              body: contentRef.current.body,
              tags: contentRef.current.tags,
            }
          : old,
      );
      // 保存後も編集モードを継続(#51)。ロックはしばらく入力が無ければ手放す(#300)
      editBaseRef.current = updatedAt;
      contentRef.current.frontmatterOps = [];
      dirtyRef.current = false;
      setDirty(false);
      setLastDraftSavedAt(null);
      setConflict(false);
      scheduleIdleRelease();
      queryClient.invalidateQueries({ queryKey: TREE_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: TAGS_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: ALL_HISTORY_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: BACKLINKS_QUERY_KEY });
      showToast('success', '保存しました');
      optionsRef.current.onSaved?.(updatedAt);
    } catch (err) {
      // 再度の競合等はダイアログを表示したまま再試行できるようにする
      showToast('error', err instanceof ApiRequestError ? err.message : '保存に失敗しました');
    }
  }, [queryClient, showToast, setConflict, scheduleIdleRelease]);

  // 競合解消: 自分の編集を破棄し、最新の内容を読み込み直す
  const resolveConflictDiscard = useCallback(async () => {
    const path = optionsRef.current.path;
    const holdsLock = lockedPathRef.current !== null;
    setConflict(false);
    if (path) {
      await deleteDraft(path).catch(() => {});
      if (holdsLock) await releaseLock(path).catch(() => {});
      queryClient.invalidateQueries({ queryKey: docQueryKey(path) });
    }
    stopEditingLocally();
  }, [queryClient, stopEditingLocally, setConflict]);

  const cancelEditing = useCallback(async () => {
    const path = optionsRef.current.path;
    const holdsLock = lockedPathRef.current !== null;
    const pending = lockPromiseRef.current;
    // 世代を進めるので、取得中のロック確保は完了時に取れたロックを手放す
    stopEditingLocally();
    // その後始末が済むまで待つ。待たずに返すと、呼び出し側(履歴の復元など)がこのあと取ったロックを
    // 古い取得の後始末が消してしまう(サーバーの解放は同じユーザーのロックを区別しない)
    if (pending) await pending;
    if (path) {
      await deleteDraft(path).catch(() => {});
      if (holdsLock) await releaseLock(path).catch(() => {});
    }
    optionsRef.current.onCancelled?.();
  }, [stopEditingLocally]);

  const noteServerRewrite = useCallback(
    (updatedAt: string): ServerRewriteResult => {
      if (modeRef.current === 'edit' && lockedPathRef.current !== null) {
        // ロックを持っているので、ほかからの書き込みは入っていない。自分の書き込みとして基準を進める
        editBaseRef.current = updatedAt;
        return 'advanced';
      }
      if (modeRef.current === 'edit' && dirtyRef.current) return 'dirty';
      return 'reload';
    },
    [],
  );

  const reloadFromLatest = useCallback(
    (latest: { body: string; tags: string[]; updatedAt: string }): boolean => {
      if (modeRef.current !== 'edit') return false;
      if (dirtyRef.current || lockedPathRef.current !== null || lockPromiseRef.current !== null) {
        return false;
      }
      contentRef.current = {
        body: latest.body,
        tags: latest.tags,
        frontmatterOps: [],
        frontmatterValid: true,
      };
      editBaseRef.current = latest.updatedAt;
      return true;
    },
    [],
  );

  // ハートビート: ロックを持っている間だけ。ロック失効を検知したら閲覧モードへ戻す
  useEffect(() => {
    if (mode !== 'edit' || !lockedPath) return undefined;
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
  }, [mode, lockedPath, heartbeatIntervalMs, showToast, stopEditingLocally]);

  // 自動保存: 編集中かつdirtyな場合のみ下書きを保存する。ロックの有無は問わない(#300)
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

  // 離脱保護: 未保存の変更があるページ離脱前に警告し、pagehideで下書き保存とロック解放を試行する
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
        flushOnLeave(
          path,
          dirtyRef.current,
          contentRef.current.body,
          lockedPathRef.current !== null || lockPromiseRef.current !== null,
        );
      }
    }
    window.addEventListener('beforeunload', handleBeforeUnload);
    window.addEventListener('pagehide', handlePageHide);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.removeEventListener('pagehide', handlePageHide);
    };
  }, [dirty]);

  // アンマウント時(SPA内遷移含む)も編集中ならdirtyな内容を下書き保存し、ロックを持っていれば解放する
  useEffect(() => {
    return () => {
      const path = optionsRef.current.path;
      const holdsLock = lockedPathRef.current !== null || lockPromiseRef.current !== null;
      // 取得中のロック確保は世代を進めて無効にする(完了時に取れたロックを手放す)
      sessionEpochRef.current += 1;
      if (idleTimerRef.current !== null) clearTimeout(idleTimerRef.current);
      if (modeRef.current === 'edit' && path) {
        flushOnLeave(path, dirtyRef.current, contentRef.current.body, holdsLock);
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
    updateFrontmatter,
    syncBody,
    save,
    cancelEditing,
    restoreDraft,
    discardDraftPrompt,
    resolveConflictOverwrite,
    resolveConflictDiscard,
    noteServerRewrite,
    reloadFromLatest,
  };
}
