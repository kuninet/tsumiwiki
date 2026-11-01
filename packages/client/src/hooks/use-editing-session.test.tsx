import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEditStore } from '../stores/edit';
import { useToastStore } from '../stores/toast';
import { useEditingSession } from './use-editing-session';

interface Call {
  method: string;
  path: string;
  body: unknown;
}

interface ErrorOverride {
  status: number;
  error: { code: string; message: string };
}

function isErrorOverride(value: unknown): value is ErrorOverride {
  return typeof value === 'object' && value !== null && 'status' in value && 'error' in value;
}

// 応答を呼び出しごとに変えたり、応答を遅らせたりしたいときは関数を渡す(戻り値が応答になる)
type OverrideFn = () => unknown;

function stubFetch(overrides: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const [path] = url.split('?');
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });

    const key = `${method} ${path}`;
    const raw = overrides[key];
    const override = typeof raw === 'function' ? await (raw as OverrideFn)() : raw;
    if (isErrorOverride(override)) {
      return {
        ok: false,
        status: override.status,
        json: () => Promise.resolve({ error: override.error }),
      };
    }
    if (key in overrides) {
      return { ok: true, status: 200, json: () => Promise.resolve(override) };
    }
    return { ok: true, status: 200, json: () => Promise.resolve({ ok: true }) };
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

const BASE = '2026-07-01T00:00:00+09:00';

// ロック取得後の比較で使う GET /api/docs の応答
function docResponse(updatedAt: string) {
  return { path: 'a.md', frontmatter: {}, tags: [], body: '本文', updatedAt, lock: null };
}

function countCalls(calls: Call[], method: string, path: string): number {
  return calls.filter((c) => c.method === method && c.path === path).length;
}

// 投げっぱなしのロック確保(fetch → json → 比較)を最後まで進める
async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe('useEditingSession', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    // 前のテストのフックが後から store へ書き込まないよう、fetch の差し替えを戻す前にアンマウントする
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    useEditStore.setState({ mode: 'view', dirty: false, lockedPath: null, lastDraftSavedAt: null });
    useToastStore.setState({ toast: null });
  });

  it('編集開始ではロックを取らずに編集モードへ遷移し、下書きを確認する(#300)', async () => {
    const calls = stubFetch({ 'GET /api/drafts': { draft: null } });

    const { result } = renderHook(() => useEditingSession({ path: 'a.md', baseUpdatedAt: BASE }), {
      wrapper,
    });

    await act(async () => {
      await result.current.startEditing('本文', ['tag1']);
    });

    expect(result.current.mode).toBe('edit');
    expect(countCalls(calls, 'POST', '/api/locks')).toBe(0);
    expect(countCalls(calls, 'GET', '/api/drafts')).toBe(1);
    expect(useEditStore.getState().lockedPath).toBeNull();
  });

  it('最初の updateBody でロックを1回だけ取る。連続で呼んでも取得は1回だけ', async () => {
    const calls = stubFetch({
      'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
      'GET /api/drafts': { draft: null },
      'GET /api/docs': docResponse(BASE),
    });

    const { result } = renderHook(() => useEditingSession({ path: 'a.md', baseUpdatedAt: BASE }), {
      wrapper,
    });
    await act(async () => {
      await result.current.startEditing('本文', []);
    });

    act(() => {
      result.current.updateBody('1');
      result.current.updateBody('12');
      result.current.updateBody('123');
    });
    await flush();
    act(() => result.current.updateBody('1234'));
    await flush();

    expect(countCalls(calls, 'POST', '/api/locks')).toBe(1);
    // 取得したあと、開いた時点からの更新が無いかを最新の updatedAt で確かめる
    expect(countCalls(calls, 'GET', '/api/docs')).toBe(1);
    expect(result.current.conflict).toBe(false);
    expect(useEditStore.getState().lockedPath).toBe('a.md');
  });

  it('updateTags でもロックを取る。syncBody では取らない', async () => {
    const calls = stubFetch({
      'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
      'GET /api/drafts': { draft: null },
      'GET /api/docs': docResponse(BASE),
    });

    const { result } = renderHook(() => useEditingSession({ path: 'a.md', baseUpdatedAt: BASE }), {
      wrapper,
    });
    await act(async () => {
      await result.current.startEditing('本文', []);
    });

    act(() => result.current.syncBody('差し替えた本文'));
    await flush();
    expect(countCalls(calls, 'POST', '/api/locks')).toBe(0);

    act(() => result.current.updateTags(['新タグ']));
    await flush();
    expect(countCalls(calls, 'POST', '/api/locks')).toBe(1);
  });

  it('ロックを取ったあとの updatedAt が開いた時点とずれていれば、ロックを持ったまま競合にする', async () => {
    const calls = stubFetch({
      'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
      'GET /api/drafts': { draft: null },
      'GET /api/docs': docResponse('2026-07-01T05:00:00+09:00'),
    });

    const { result } = renderHook(() => useEditingSession({ path: 'a.md', baseUpdatedAt: BASE }), {
      wrapper,
    });
    await act(async () => {
      await result.current.startEditing('本文', []);
    });

    act(() => result.current.updateBody('自分の変更'));
    await flush();

    expect(result.current.conflict).toBe('acquire');
    expect(result.current.mode).toBe('edit');
    expect(result.current.dirty).toBe(true);
    // 競合ダイアログのボタンはロックを持っている前提で動くので、解放しない
    expect(countCalls(calls, 'DELETE', '/api/locks')).toBe(0);
    expect(useEditStore.getState().lockedPath).toBe('a.md');

    // 競合が出ている間は保存しない
    let saved = true;
    await act(async () => {
      saved = await result.current.save();
    });
    expect(saved).toBe(false);
    expect(countCalls(calls, 'PUT', '/api/docs')).toBe(0);
  });

  it('ロック取得が DOC_LOCKED のときは閲覧モードへ戻し、トーストで知らせて文書を取り直す', async () => {
    const calls = stubFetch({
      'POST /api/locks': { status: 409, error: { code: 'DOC_LOCKED', message: '次郎さんが編集中です' } },
      'GET /api/drafts': { draft: null },
    });

    const { result } = renderHook(() => useEditingSession({ path: 'a.md', baseUpdatedAt: BASE }), {
      wrapper,
    });
    await act(async () => {
      await result.current.startEditing('本文', []);
    });
    expect(result.current.mode).toBe('edit');

    act(() => result.current.updateBody('自分の変更'));
    await flush();

    expect(result.current.mode).toBe('view');
    expect(result.current.dirty).toBe(false);
    expect(useToastStore.getState().toast).toMatchObject({ kind: 'error', message: '次郎さんが編集中です' });
    expect(useEditStore.getState().lockedPath).toBeNull();
    // ロックの表示を最新にするため、文書のクエリを invalidate する(このテストでは購読者がいないので
    // 再取得はされない)。少なくとも閲覧モードに戻ったあとはロックを取りにいかない
    expect(countCalls(calls, 'POST', '/api/locks')).toBe(1);
  });

  it('ロック取得が通信失敗などのときは編集を続け、次の変更でもう一度取りにいく', async () => {
    let lockAttempts = 0;
    const calls = stubFetch({
      'POST /api/locks': () => {
        lockAttempts += 1;
        return lockAttempts === 1
          ? { status: 500, error: { code: 'INTERNAL_ERROR', message: 'サーバーエラー' } }
          : { lock: { userId: 1, displayName: '太郎' } };
      },
      'GET /api/drafts': { draft: null },
      'GET /api/docs': docResponse(BASE),
    });

    const { result } = renderHook(() => useEditingSession({ path: 'a.md', baseUpdatedAt: BASE }), {
      wrapper,
    });
    await act(async () => {
      await result.current.startEditing('本文', []);
    });

    act(() => result.current.updateBody('1'));
    await flush();
    expect(result.current.mode).toBe('edit');
    expect(result.current.dirty).toBe(true);
    expect(useToastStore.getState().toast).toMatchObject({ kind: 'error', message: 'サーバーエラー' });
    expect(useEditStore.getState().lockedPath).toBeNull();

    // 失敗から10秒の間は、入力のたびには取り直さず、トーストも重ねて出さない
    useToastStore.setState({ toast: null });
    act(() => result.current.updateBody('12'));
    await flush();
    expect(countCalls(calls, 'POST', '/api/locks')).toBe(1);
    expect(useToastStore.getState().toast).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    act(() => result.current.updateBody('123'));
    await flush();
    expect(countCalls(calls, 'POST', '/api/locks')).toBe(2);
    expect(useEditStore.getState().lockedPath).toBe('a.md');
  });

  it('取得の失敗が続いても、トーストは1回だけ出す', async () => {
    const calls = stubFetch({
      'POST /api/locks': { status: 500, error: { code: 'INTERNAL_ERROR', message: 'サーバーエラー' } },
      'GET /api/drafts': { draft: null },
    });

    const { result } = renderHook(() => useEditingSession({ path: 'a.md', baseUpdatedAt: BASE }), {
      wrapper,
    });
    await act(async () => {
      await result.current.startEditing('本文', []);
    });

    act(() => result.current.updateBody('1'));
    await flush();
    expect(useToastStore.getState().toast).toMatchObject({ message: 'サーバーエラー' });
    useToastStore.setState({ toast: null });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    act(() => result.current.updateBody('12'));
    await flush();

    expect(countCalls(calls, 'POST', '/api/locks')).toBe(2);
    expect(useToastStore.getState().toast).toBeNull();
  });

  it('ロックを持っている間だけ、一定間隔でハートビートを送る', async () => {
    const calls = stubFetch({
      'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
      'GET /api/drafts': { draft: null },
      'GET /api/docs': docResponse(BASE),
      'PUT /api/docs': { updatedAt: '2026-07-02T00:00:00+09:00' },
    });

    const { result } = renderHook(
      () =>
        useEditingSession({
          path: 'a.md',
          baseUpdatedAt: BASE,
          heartbeatIntervalMs: 1000,
          autosaveIntervalMs: 100_000,
          idleReleaseMs: 5000,
        }),
      { wrapper },
    );

    await act(async () => {
      await result.current.startEditing('本文', []);
    });

    // ロックを持っていない間は送らない
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(countCalls(calls, 'PUT', '/api/locks/refresh')).toBe(0);

    act(() => result.current.updateBody('自分の変更'));
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(countCalls(calls, 'PUT', '/api/locks/refresh')).toBe(1);

    // 保存してロックを手放したあとは送らない
    await act(async () => {
      await result.current.save();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(countCalls(calls, 'DELETE', '/api/locks')).toBe(1);
    const afterRelease = countCalls(calls, 'PUT', '/api/locks/refresh');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(countCalls(calls, 'PUT', '/api/locks/refresh')).toBe(afterRelease);
  });

  it('ハートビートが LOCK_EXPIRED を返したら閲覧モードへ戻す', async () => {
    stubFetch({
      'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
      'GET /api/drafts': { draft: null },
      'GET /api/docs': docResponse(BASE),
      'PUT /api/locks/refresh': {
        status: 409,
        error: { code: 'LOCK_EXPIRED', message: 'ロックの有効期限が切れました' },
      },
    });

    const { result } = renderHook(
      () =>
        useEditingSession({
          path: 'a.md',
          baseUpdatedAt: BASE,
          heartbeatIntervalMs: 1000,
          autosaveIntervalMs: 100_000,
        }),
      { wrapper },
    );
    await act(async () => {
      await result.current.startEditing('本文', []);
    });
    act(() => result.current.updateBody('自分の変更'));
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(result.current.mode).toBe('view');
    expect(useToastStore.getState().toast).toMatchObject({ kind: 'error' });
  });

  it('dirtyな場合のみ下書きの自動保存が発火する', async () => {
    const calls = stubFetch({
      'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
      'GET /api/drafts': { draft: null },
    });

    const { result } = renderHook(
      () =>
        useEditingSession({
          path: 'a.md',
          baseUpdatedAt: '2026-07-01T00:00:00+09:00',
          heartbeatIntervalMs: 100_000,
          autosaveIntervalMs: 1000,
        }),
      { wrapper },
    );

    await act(async () => {
      await result.current.startEditing('本文', []);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(calls.some((c) => c.method === 'PUT' && c.path === '/api/drafts')).toBe(false);

    act(() => {
      result.current.updateBody('更新した本文');
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(calls.some((c) => c.method === 'PUT' && c.path === '/api/drafts')).toBe(true);
    expect(result.current.lastDraftSavedAt).not.toBeNull();
  });

  it('保存に成功しても編集モードを継続し、dirty はクリアされる(#51)', async () => {
    const calls = stubFetch({
      'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
      'GET /api/drafts': { draft: null },
      'PUT /api/docs': { updatedAt: '2026-07-02T00:00:00+09:00' },
    });

    const { result } = renderHook(
      () => useEditingSession({ path: 'a.md', baseUpdatedAt: '2026-07-01T00:00:00+09:00' }),
      { wrapper },
    );

    await act(async () => {
      await result.current.startEditing('本文', []);
    });
    act(() => result.current.updateBody('新しい本文'));

    await act(async () => {
      await result.current.save();
    });

    // #51 シームレスUX: 保存後もロックは保持したまま編集モードを継続
    expect(result.current.mode).toBe('edit');
    expect(result.current.dirty).toBe(false);
    expect(calls.some((c) => c.method === 'PUT' && c.path === '/api/docs')).toBe(true);
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/locks')).toBe(false);
    // #300: 保存より前にロックを取っている
    const lockIndex = calls.findIndex((c) => c.method === 'POST' && c.path === '/api/locks');
    const saveIndex = calls.findIndex((c) => c.method === 'PUT' && c.path === '/api/docs');
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(lockIndex).toBeLessThan(saveIndex);
  });

  it('syncBody は dirty を変えずに保存対象の本文だけ差し替える(添付リネームの参照書き換え用)', async () => {
    const calls = stubFetch({
      'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
      'GET /api/drafts': { draft: null },
      'PUT /api/docs': { updatedAt: '2026-07-02T00:00:00+09:00' },
    });

    const { result } = renderHook(
      () => useEditingSession({ path: 'a.md', baseUpdatedAt: '2026-07-01T00:00:00+09:00' }),
      { wrapper },
    );
    await act(async () => {
      await result.current.startEditing('![[old.png]]', []);
    });

    // 未編集のまま syncBody しても dirty にはならない
    act(() => result.current.syncBody('![[new.png]]'));
    expect(result.current.dirty).toBe(false);

    // 未保存編集中に syncBody された本文が、そのまま保存内容になる
    act(() => result.current.updateBody('![[old.png]] 追記'));
    act(() => result.current.syncBody('![[new.png]] 追記'));
    expect(result.current.dirty).toBe(true);
    await act(async () => {
      await result.current.save();
    });
    const put = calls.find((c) => c.method === 'PUT' && c.path === '/api/docs');
    expect(put?.body).toMatchObject({ body: '![[new.png]] 追記' });
  });

  it('未変更(dirty=false)で save() を呼んでも PUT /api/docs は飛ばない', async () => {
    const calls = stubFetch({
      'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
      'GET /api/drafts': { draft: null },
      'PUT /api/docs': { updatedAt: '2026-07-02T00:00:00+09:00' },
    });

    const { result } = renderHook(
      () => useEditingSession({ path: 'a.md', baseUpdatedAt: '2026-07-01T00:00:00+09:00' }),
      { wrapper },
    );

    await act(async () => {
      await result.current.startEditing('本文', []);
    });

    await act(async () => {
      await result.current.save();
    });

    expect(calls.some((c) => c.method === 'PUT' && c.path === '/api/docs')).toBe(false);
  });

  it('保存中に連続で呼び出しても多重送信しない', async () => {
    const calls = stubFetch({
      'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
      'GET /api/drafts': { draft: null },
      'PUT /api/docs': { updatedAt: '2026-07-02T00:00:00+09:00' },
    });

    const { result } = renderHook(
      () => useEditingSession({ path: 'a.md', baseUpdatedAt: '2026-07-01T00:00:00+09:00' }),
      { wrapper },
    );

    await act(async () => {
      await result.current.startEditing('本文', []);
    });
    act(() => result.current.updateBody('新しい本文'));

    await act(async () => {
      await Promise.all([result.current.save(), result.current.save()]);
    });

    const saveCalls = calls.filter((c) => c.method === 'PUT' && c.path === '/api/docs');
    expect(saveCalls).toHaveLength(1);
  });

  it('保存が競合(409 CONFLICT)の場合は編集モードを継続する', async () => {
    stubFetch({
      'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
      'GET /api/drafts': { draft: null },
      'PUT /api/docs': {
        status: 409,
        error: { code: 'CONFLICT', message: 'この文書は取得後に変更されています' },
      },
    });

    const { result } = renderHook(
      () => useEditingSession({ path: 'a.md', baseUpdatedAt: '2026-07-01T00:00:00+09:00' }),
      { wrapper },
    );

    await act(async () => {
      await result.current.startEditing('本文', []);
    });
    act(() => result.current.updateBody('新しい本文'));

    await act(async () => {
      await result.current.save();
    });

    expect(result.current.mode).toBe('edit');
    expect(result.current.dirty).toBe(true);
    expect(result.current.conflict).toBe('save');
    expect(useToastStore.getState().toast).toMatchObject({ kind: 'error' });
  });

  it('競合解消(上書き保存)は最新のupdatedAtを取得し直して再保存し、編集モードを継続する(#51)', async () => {
    // GET /api/docs が開いた時点より新しい updatedAt を返すので、最初の入力でロックを取った時点で競合になる
    const calls = stubFetch({
      'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
      'GET /api/drafts': { draft: null },
      'GET /api/docs': { path: 'a.md', frontmatter: {}, tags: [], body: '他者更新後の本文', updatedAt: '2026-07-01T05:00:00+09:00', lock: null },
      'PUT /api/docs': { updatedAt: '2026-07-02T00:00:00+09:00' },
    });

    const { result } = renderHook(
      () => useEditingSession({ path: 'a.md', baseUpdatedAt: '2026-07-01T00:00:00+09:00' }),
      { wrapper },
    );

    await act(async () => {
      await result.current.startEditing('本文', []);
    });
    act(() => result.current.updateBody('自分の変更'));
    await flush();
    expect(result.current.conflict).toBe('acquire');

    await act(async () => {
      await result.current.resolveConflictOverwrite();
    });

    expect(calls.some((c) => c.method === 'GET' && c.path === '/api/docs')).toBe(true);
    const saveCall = calls.find((c) => c.method === 'PUT' && c.path === '/api/docs')!;
    expect((saveCall.body as { baseUpdatedAt: string }).baseUpdatedAt).toBe('2026-07-01T05:00:00+09:00');
    // #51 シームレスUX: 保存後もロックは保持したまま編集モードを継続
    expect(result.current.mode).toBe('edit');
    expect(result.current.dirty).toBe(false);
    expect(result.current.conflict).toBe(false);
  });

  it('競合解消(破棄)は編集を破棄し、文書クエリを更新して閲覧モードへ戻る', async () => {
    const calls = stubFetch({
      'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
      'GET /api/drafts': { draft: null },
    });

    const { result } = renderHook(
      () => useEditingSession({ path: 'a.md', baseUpdatedAt: '2026-07-01T00:00:00+09:00' }),
      { wrapper },
    );

    await act(async () => {
      await result.current.startEditing('本文', []);
    });
    act(() => result.current.updateBody('自分の変更'));
    await flush();

    await act(async () => {
      await result.current.resolveConflictDiscard();
    });

    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/drafts')).toBe(true);
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/locks')).toBe(true);
    expect(result.current.mode).toBe('view');
    expect(result.current.conflict).toBe(false);
  });

  it('取消すると下書きを破棄し、ロックを持っていれば解放して閲覧モードへ戻る', async () => {
    const calls = stubFetch({
      'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
      'GET /api/drafts': { draft: null },
    });

    const { result } = renderHook(() => useEditingSession({ path: 'a.md', baseUpdatedAt: BASE }), {
      wrapper,
    });

    await act(async () => {
      await result.current.startEditing('本文', []);
    });
    act(() => result.current.updateBody('自分の変更'));
    await flush();

    await act(async () => {
      await result.current.cancelEditing();
    });

    expect(result.current.mode).toBe('view');
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/drafts')).toBe(true);
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/locks')).toBe(true);
  });

  it('ロックを持っていないときの取消はロックの解放を送らない', async () => {
    const calls = stubFetch({ 'GET /api/drafts': { draft: null } });

    const { result } = renderHook(() => useEditingSession({ path: 'a.md', baseUpdatedAt: BASE }), {
      wrapper,
    });
    await act(async () => {
      await result.current.startEditing('本文', []);
    });
    await act(async () => {
      await result.current.cancelEditing();
    });

    expect(result.current.mode).toBe('view');
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/drafts')).toBe(true);
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/locks')).toBe(false);
  });

  it('編集開始時に自分の下書きがあれば復元プロンプトを提示し、復元すると内容が反映される', async () => {
    const calls = stubFetch({
      'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
      'GET /api/drafts': { draft: { content: '下書き本文', updatedAt: '2026-07-01T09:00:00+09:00' } },
    });

    const { result } = renderHook(
      () => useEditingSession({ path: 'a.md', baseUpdatedAt: '2026-07-01T00:00:00+09:00' }),
      { wrapper },
    );

    await act(async () => {
      await result.current.startEditing('本文', []);
    });

    expect(result.current.draftPrompt).toEqual({
      content: '下書き本文',
      updatedAt: '2026-07-01T09:00:00+09:00',
    });

    let restored = '';
    act(() => {
      restored = result.current.restoreDraft();
    });

    expect(restored).toBe('下書き本文');
    expect(result.current.draftPrompt).toBeNull();
    expect(result.current.dirty).toBe(true);
    // 復元は書き換えなので、ロックを取りにいく(#300)
    await flush();
    expect(countCalls(calls, 'POST', '/api/locks')).toBe(1);
  });

  // Epic #133 タブ導入: active=false の非アクティブタブは useEditStore(グローバル)を
  // 触らない。false→true に切り替わったタイミングで local state の現在値を store に流し込む。
  it('active=false のときは useEditStore に mode/dirty/lockedPath を書かない', async () => {
    stubFetch({
      'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
      'GET /api/drafts': { draft: null },
    });

    // 事前に別のアクティブタブが store に書いた想定の値を置いておく
    useEditStore.setState({
      mode: 'edit',
      dirty: true,
      lockedPath: 'other.md',
      lastDraftSavedAt: null,
    });

    const { result } = renderHook(
      () =>
        useEditingSession({
          path: 'bg.md',
          baseUpdatedAt: '2026-07-01T00:00:00+09:00',
          active: false,
        }),
      { wrapper },
    );

    await act(async () => {
      await result.current.startEditing('bg body', []);
    });
    act(() => {
      result.current.updateBody('bg edited');
    });
    await flush();

    // 非アクティブなので store は他タブの値のまま
    expect(useEditStore.getState().mode).toBe('edit');
    expect(useEditStore.getState().dirty).toBe(true);
    expect(useEditStore.getState().lockedPath).toBe('other.md');
    // 自分の session は真の値を持っている
    expect(result.current.mode).toBe('edit');
    expect(result.current.dirty).toBe(true);
  });

  it('active が false→true に切り替わると自タブの現在値が useEditStore に反映される', async () => {
    stubFetch({
      'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
      'GET /api/drafts': { draft: null },
    });

    useEditStore.setState({
      mode: 'view',
      dirty: false,
      lockedPath: null,
      lastDraftSavedAt: null,
    });

    let currentActive = false;
    const { result, rerender } = renderHook(
      ({ active }: { active: boolean }) =>
        useEditingSession({
          path: 'me.md',
          baseUpdatedAt: '2026-07-01T00:00:00+09:00',
          active,
        }),
      { wrapper, initialProps: { active: currentActive } },
    );

    await act(async () => {
      await result.current.startEditing('me body', []);
    });
    act(() => {
      result.current.updateBody('me edited');
    });
    await flush();

    // active=false 中は store は空のまま
    expect(useEditStore.getState().mode).toBe('view');
    expect(useEditStore.getState().dirty).toBe(false);
    expect(useEditStore.getState().lockedPath).toBeNull();

    // active=true に切替
    currentActive = true;
    rerender({ active: true });

    expect(useEditStore.getState().mode).toBe('edit');
    expect(useEditStore.getState().dirty).toBe(true);
    expect(useEditStore.getState().lockedPath).toBe('me.md');
  });
  describe('#300 ロックの取得と解放', () => {
    it('ロックを持っていなければ、保存の前に取ってから保存する(取得中ならその完了を待つ)', async () => {
      let resolveLock: (() => void) | undefined;
      const calls = stubFetch({
        'POST /api/locks': () =>
          new Promise((resolve) => {
            resolveLock = () => resolve({ lock: { userId: 1, displayName: '太郎' } });
          }),
        'GET /api/drafts': { draft: null },
        'GET /api/docs': docResponse(BASE),
        'PUT /api/docs': { updatedAt: '2026-07-02T00:00:00+09:00' },
      });

      const { result } = renderHook(() => useEditingSession({ path: 'a.md', baseUpdatedAt: BASE }), {
        wrapper,
      });
      await act(async () => {
        await result.current.startEditing('本文', []);
      });

      act(() => result.current.updateBody('新しい本文'));
      let savePromise: Promise<boolean> | undefined;
      act(() => {
        savePromise = result.current.save();
      });
      await flush();
      // ロックの取得が終わるまでは保存しない
      expect(countCalls(calls, 'PUT', '/api/docs')).toBe(0);

      resolveLock?.();
      let saved = false;
      await act(async () => {
        saved = await savePromise!;
      });

      expect(saved).toBe(true);
      expect(countCalls(calls, 'POST', '/api/locks')).toBe(1);
      expect(countCalls(calls, 'PUT', '/api/docs')).toBe(1);
    });

    it('保存の前のロック取得に失敗したら保存しない', async () => {
      const calls = stubFetch({
        'POST /api/locks': { status: 500, error: { code: 'INTERNAL_ERROR', message: 'サーバーエラー' } },
        'GET /api/drafts': { draft: null },
        'PUT /api/docs': { updatedAt: '2026-07-02T00:00:00+09:00' },
      });

      const { result } = renderHook(() => useEditingSession({ path: 'a.md', baseUpdatedAt: BASE }), {
        wrapper,
      });
      await act(async () => {
        await result.current.startEditing('本文', []);
      });
      act(() => result.current.updateBody('新しい本文'));
      await flush();

      let saved = true;
      await act(async () => {
        saved = await result.current.save();
      });

      expect(saved).toBe(false);
      // 入力時に1回、保存時にもう1回取りにいく
      expect(countCalls(calls, 'POST', '/api/locks')).toBe(2);
      expect(countCalls(calls, 'PUT', '/api/docs')).toBe(0);
      expect(result.current.dirty).toBe(true);
      expect(result.current.mode).toBe('edit');
    });

    it('保存のあと idleReleaseMs のあいだ入力が無ければ、編集モードのままロックを手放す', async () => {
      const calls = stubFetch({
        'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
        'GET /api/drafts': { draft: null },
        'GET /api/docs': docResponse(BASE),
        'PUT /api/docs': { updatedAt: '2026-07-02T00:00:00+09:00' },
      });

      const { result } = renderHook(
        () =>
          useEditingSession({
            path: 'a.md',
            baseUpdatedAt: BASE,
            heartbeatIntervalMs: 100_000,
            autosaveIntervalMs: 100_000,
            idleReleaseMs: 5000,
          }),
        { wrapper },
      );
      await act(async () => {
        await result.current.startEditing('本文', []);
      });
      act(() => result.current.updateBody('新しい本文'));
      await act(async () => {
        await result.current.save();
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(4999);
      });
      expect(countCalls(calls, 'DELETE', '/api/locks')).toBe(0);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(countCalls(calls, 'DELETE', '/api/locks')).toBe(1);
      expect(result.current.mode).toBe('edit');
      expect(useEditStore.getState().lockedPath).toBeNull();
    });

    it('保存のあと idleReleaseMs が過ぎる前に入力すれば、ロックを手放さない', async () => {
      const calls = stubFetch({
        'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
        'GET /api/drafts': { draft: null },
        'GET /api/docs': docResponse(BASE),
        'PUT /api/docs': { updatedAt: '2026-07-02T00:00:00+09:00' },
      });

      const { result } = renderHook(
        () =>
          useEditingSession({
            path: 'a.md',
            baseUpdatedAt: BASE,
            heartbeatIntervalMs: 100_000,
            autosaveIntervalMs: 100_000,
            idleReleaseMs: 5000,
          }),
        { wrapper },
      );
      await act(async () => {
        await result.current.startEditing('本文', []);
      });
      act(() => result.current.updateBody('新しい本文'));
      await act(async () => {
        await result.current.save();
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      act(() => result.current.updateBody('さらに追記'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });

      expect(countCalls(calls, 'DELETE', '/api/locks')).toBe(0);
      // ロックを持ったままなので取り直さない
      expect(countCalls(calls, 'POST', '/api/locks')).toBe(1);
      expect(useEditStore.getState().lockedPath).toBe('a.md');
    });

    it('手放したあとでまた入力すれば、最後に保存した updatedAt を基準にロックを取り直す', async () => {
      const SAVED_AT = '2026-07-02T00:00:00+09:00';
      const calls = stubFetch({
        'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
        'GET /api/drafts': { draft: null },
        'GET /api/docs': () => docResponse(calls.some((c) => c.method === 'PUT' && c.path === '/api/docs') ? SAVED_AT : BASE),
        'PUT /api/docs': { updatedAt: SAVED_AT },
      });

      // 実際の DocView と同じく、保存で更新された文書のキャッシュから baseUpdatedAt を渡す
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      queryClient.setQueryData(['doc', 'a.md'], docResponse(BASE));
      const localWrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      );
      const { result } = renderHook(
        () => {
          const doc = queryClient.getQueryData<{ updatedAt: string }>(['doc', 'a.md']);
          return useEditingSession({
            path: 'a.md',
            baseUpdatedAt: doc?.updatedAt,
            heartbeatIntervalMs: 100_000,
            autosaveIntervalMs: 100_000,
            idleReleaseMs: 5000,
          });
        },
        { wrapper: localWrapper },
      );
      await act(async () => {
        await result.current.startEditing('本文', []);
      });
      act(() => result.current.updateBody('新しい本文'));
      await act(async () => {
        await result.current.save();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(countCalls(calls, 'DELETE', '/api/locks')).toBe(1);

      act(() => result.current.updateBody('もう一度書き換える'));
      await flush();

      expect(countCalls(calls, 'POST', '/api/locks')).toBe(2);
      expect(result.current.conflict).toBe(false);
      expect(useEditStore.getState().lockedPath).toBe('a.md');
    });

    it('競合が出ている間は、タイマーが満了してもロックを手放さない', async () => {
      const calls = stubFetch({
        'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
        'GET /api/drafts': { draft: null },
        'GET /api/docs': docResponse(BASE),
        'PUT /api/docs': () => {
          const n = countCalls(calls, 'PUT', '/api/docs');
          return n === 1
            ? { updatedAt: '2026-07-02T00:00:00+09:00' }
            : { status: 409, error: { code: 'CONFLICT', message: 'この文書は取得後に変更されています' } };
        },
      });

      const { result } = renderHook(
        () =>
          useEditingSession({
            path: 'a.md',
            baseUpdatedAt: BASE,
            heartbeatIntervalMs: 100_000,
            autosaveIntervalMs: 100_000,
            idleReleaseMs: 5000,
          }),
        { wrapper },
      );
      await act(async () => {
        await result.current.startEditing('本文', []);
      });
      act(() => result.current.updateBody('1回目'));
      await act(async () => {
        await result.current.save();
      });
      // タイマー満了前に書き換えて保存し、競合にする
      act(() => result.current.updateBody('2回目'));
      await act(async () => {
        await result.current.save();
      });
      expect(result.current.conflict).toBe('save');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(countCalls(calls, 'DELETE', '/api/locks')).toBe(0);
    });

    it('上書き保存で競合を解決したあとも、入力が無ければロックを手放す', async () => {
      const calls = stubFetch({
        'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
        'GET /api/drafts': { draft: null },
        'GET /api/docs': docResponse('2026-07-01T05:00:00+09:00'),
        'PUT /api/docs': { updatedAt: '2026-07-02T00:00:00+09:00' },
      });

      const { result } = renderHook(
        () =>
          useEditingSession({
            path: 'a.md',
            baseUpdatedAt: BASE,
            heartbeatIntervalMs: 100_000,
            autosaveIntervalMs: 100_000,
            idleReleaseMs: 5000,
          }),
        { wrapper },
      );
      await act(async () => {
        await result.current.startEditing('本文', []);
      });
      act(() => result.current.updateBody('自分の変更'));
      await flush();
      expect(result.current.conflict).toBe('acquire');

      await act(async () => {
        await result.current.resolveConflictOverwrite();
      });
      expect(result.current.conflict).toBe(false);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(countCalls(calls, 'DELETE', '/api/locks')).toBe(1);
      expect(result.current.mode).toBe('edit');
    });

    it('ロックの取得中に取消したら、取れたロックをすぐ手放して閲覧モードのままにする', async () => {
      let resolveLock: (() => void) | undefined;
      const calls = stubFetch({
        'POST /api/locks': () =>
          new Promise((resolve) => {
            resolveLock = () => resolve({ lock: { userId: 1, displayName: '太郎' } });
          }),
        'GET /api/drafts': { draft: null },
        'GET /api/docs': docResponse(BASE),
      });

      const { result } = renderHook(() => useEditingSession({ path: 'a.md', baseUpdatedAt: BASE }), {
        wrapper,
      });
      await act(async () => {
        await result.current.startEditing('本文', []);
      });
      act(() => result.current.updateBody('自分の変更'));
      await flush();

      // 取消は、取得中だったロック確保の後始末(取れたロックの解放)が済むまで返らない
      let cancelled = false;
      let cancelPromise: Promise<void> | undefined;
      act(() => {
        cancelPromise = result.current.cancelEditing().then(() => {
          cancelled = true;
          calls.push({ method: 'MARK', path: 'cancel-resolved', body: undefined });
        });
      });
      await flush();
      expect(cancelled).toBe(false);
      expect(result.current.mode).toBe('view');

      resolveLock?.();
      await act(async () => {
        await cancelPromise;
      });

      expect(useEditStore.getState().lockedPath).toBeNull();
      const releaseIndex = calls.findIndex((c) => c.method === 'DELETE' && c.path === '/api/locks');
      const cancelIndex = calls.findIndex((c) => c.method === 'MARK');
      expect(releaseIndex).toBeGreaterThanOrEqual(0);
      // 履歴の復元などは取消のあとで自前のロックを取るので、古い取得の解放はそれより前に済んでいる
      expect(releaseIndex).toBeLessThan(cancelIndex);
      expect(countCalls(calls, 'DELETE', '/api/locks')).toBe(1);
    });

    it('古いセッションのロック確保は、新しいセッションが取ったロックを解放しない', async () => {
      const lockResolvers: (() => void)[] = [];
      const calls = stubFetch({
        'POST /api/locks': () =>
          new Promise((resolve) => {
            lockResolvers.push(() => resolve({ lock: { userId: 1, displayName: '太郎' } }));
          }),
        'GET /api/drafts': { draft: null },
        'GET /api/docs': docResponse(BASE),
      });

      const { result } = renderHook(() => useEditingSession({ path: 'a.md', baseUpdatedAt: BASE }), {
        wrapper,
      });
      await act(async () => {
        await result.current.startEditing('本文', []);
      });
      act(() => result.current.updateBody('1回目のセッション'));
      await flush();
      expect(lockResolvers).toHaveLength(1);

      // 取得中に閲覧へ戻り(LOCK_EXPIRED 等を想定)、すぐ編集し直す。開始は古い取得の後始末を待つ
      let restarted: Promise<void> | undefined;
      act(() => {
        restarted = result.current.cancelEditing().then(() => result.current.startEditing('本文', []));
      });
      lockResolvers[0]();
      await act(async () => {
        await restarted;
      });
      const releasesAfterRestart = countCalls(calls, 'DELETE', '/api/locks');

      act(() => result.current.updateBody('2回目のセッション'));
      await flush();
      lockResolvers[1]?.();
      await flush();

      expect(useEditStore.getState().lockedPath).toBe('a.md');
      // 2回目に取ったロックは解放されない
      expect(countCalls(calls, 'DELETE', '/api/locks')).toBe(releasesAfterRestart);
    });

    it('ロックが無く dirty なままアンマウントしたら、下書きだけ保存してロックの解放は送らない', async () => {
      const calls = stubFetch({
        'POST /api/locks': { status: 500, error: { code: 'INTERNAL_ERROR', message: 'サーバーエラー' } },
        'GET /api/drafts': { draft: null },
      });

      const { result, unmount } = renderHook(
        () => useEditingSession({ path: 'a.md', baseUpdatedAt: BASE }),
        { wrapper },
      );
      await act(async () => {
        await result.current.startEditing('本文', []);
      });
      act(() => result.current.updateBody('書きかけ'));
      await flush();

      unmount();

      const draft = calls.find((c) => c.method === 'PUT' && c.path === '/api/drafts');
      expect(draft?.body).toMatchObject({ path: 'a.md', content: '書きかけ' });
      expect(countCalls(calls, 'DELETE', '/api/locks')).toBe(0);
    });

    it('ロックを持ったままアンマウントしたら、ロックの解放を送る', async () => {
      const calls = stubFetch({
        'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
        'GET /api/drafts': { draft: null },
        'GET /api/docs': docResponse(BASE),
      });

      const { result, unmount } = renderHook(
        () => useEditingSession({ path: 'a.md', baseUpdatedAt: BASE }),
        { wrapper },
      );
      await act(async () => {
        await result.current.startEditing('本文', []);
      });
      act(() => result.current.updateBody('書きかけ'));
      await flush();

      unmount();

      expect(countCalls(calls, 'PUT', '/api/drafts')).toBe(1);
      expect(countCalls(calls, 'DELETE', '/api/locks')).toBe(1);
    });

    it('開いただけ(入力なし)でアンマウントしたら、何も送らない', async () => {
      const calls = stubFetch({ 'GET /api/drafts': { draft: null } });

      const { result, unmount } = renderHook(
        () => useEditingSession({ path: 'a.md', baseUpdatedAt: BASE }),
        { wrapper },
      );
      await act(async () => {
        await result.current.startEditing('本文', []);
      });
      unmount();

      expect(countCalls(calls, 'PUT', '/api/drafts')).toBe(0);
      expect(countCalls(calls, 'DELETE', '/api/locks')).toBe(0);
      expect(countCalls(calls, 'POST', '/api/locks')).toBe(0);
    });
    it('取消を待たずに編集し直して取得を始めたら、古い取得の後始末はロックを解放しない', async () => {
      const lockResolvers: (() => void)[] = [];
      const calls = stubFetch({
        'POST /api/locks': () =>
          new Promise((resolve) => {
            lockResolvers.push(() => resolve({ lock: { userId: 1, displayName: '太郎' } }));
          }),
        'GET /api/drafts': { draft: null },
        'GET /api/docs': docResponse(BASE),
      });

      const { result } = renderHook(() => useEditingSession({ path: 'a.md', baseUpdatedAt: BASE }), {
        wrapper,
      });
      await act(async () => {
        await result.current.startEditing('本文', []);
      });
      act(() => result.current.updateBody('1回目のセッション'));
      await flush();

      let cancelPromise: Promise<void> | undefined;
      act(() => {
        cancelPromise = result.current.cancelEditing();
      });
      await act(async () => {
        await result.current.startEditing('本文', []);
      });
      act(() => result.current.updateBody('2回目のセッション'));
      await flush();
      expect(lockResolvers).toHaveLength(2);

      // 古い取得が先に完了しても、新しい取得が進んでいるので解放しない
      lockResolvers[0]();
      await flush();
      lockResolvers[1]();
      await act(async () => {
        await cancelPromise;
      });
      await flush();

      expect(countCalls(calls, 'DELETE', '/api/locks')).toBe(0);
      expect(useEditStore.getState().lockedPath).toBe('a.md');
    });

    it('ロックを取ったあとの fetchDoc が失敗しても、ロックを持ったまま編集を続け、開いた時点の基準で保存する', async () => {
      const calls = stubFetch({
        'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
        'GET /api/drafts': { draft: null },
        'GET /api/docs': { status: 500, error: { code: 'INTERNAL_ERROR', message: 'サーバーエラー' } },
        'PUT /api/docs': { updatedAt: '2026-07-02T00:00:00+09:00' },
      });

      const { result } = renderHook(() => useEditingSession({ path: 'a.md', baseUpdatedAt: BASE }), {
        wrapper,
      });
      await act(async () => {
        await result.current.startEditing('本文', []);
      });
      act(() => result.current.updateBody('自分の変更'));
      await flush();

      expect(useEditStore.getState().lockedPath).toBe('a.md');
      expect(result.current.conflict).toBe(false);
      expect(result.current.mode).toBe('edit');

      await act(async () => {
        await result.current.save();
      });
      const put = calls.find((c) => c.method === 'PUT' && c.path === '/api/docs');
      // サーバーが baseUpdatedAt を比べるので、ほかの変更があっても黙って消すことはない
      expect(put?.body).toMatchObject({ baseUpdatedAt: BASE });
    });

    it('編集中にキャッシュの updatedAt が進んでも、競合検知の基準は編集を始めた時点のまま', async () => {
      const LATER = '2026-07-01T05:00:00+09:00';
      const calls = stubFetch({
        'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
        'GET /api/drafts': { draft: null },
        'GET /api/docs': docResponse(LATER),
        'PUT /api/docs': { updatedAt: '2026-07-02T00:00:00+09:00' },
      });

      const { result, rerender } = renderHook(
        ({ base }: { base: string }) => useEditingSession({ path: 'a.md', baseUpdatedAt: base }),
        { wrapper, initialProps: { base: BASE } },
      );
      await act(async () => {
        await result.current.startEditing('本文', []);
      });
      // フォーカス復帰や開き直しの再取得で、キャッシュだけが新しい値になった状態
      rerender({ base: LATER });

      act(() => result.current.updateBody('古い本文に足した変更'));
      await flush();
      expect(result.current.conflict).toBe('acquire');

      await act(async () => {
        await result.current.save();
      });
      expect(countCalls(calls, 'PUT', '/api/docs')).toBe(0);
    });

    it('アイドル解放の直後に入力しても、取得は解放が済んでから送る', async () => {
      let resolveRelease: (() => void) | undefined;
      const calls = stubFetch({
        'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
        'DELETE /api/locks': () =>
          new Promise((resolve) => {
            resolveRelease = () => resolve({ ok: true });
          }),
        'GET /api/drafts': { draft: null },
        'GET /api/docs': () =>
          docResponse(countCalls(calls, 'PUT', '/api/docs') > 0 ? '2026-07-02T00:00:00+09:00' : BASE),
        'PUT /api/docs': { updatedAt: '2026-07-02T00:00:00+09:00' },
      });

      const { result } = renderHook(
        () =>
          useEditingSession({
            path: 'a.md',
            baseUpdatedAt: BASE,
            heartbeatIntervalMs: 100_000,
            autosaveIntervalMs: 100_000,
            idleReleaseMs: 5000,
          }),
        { wrapper },
      );
      await act(async () => {
        await result.current.startEditing('本文', []);
      });
      act(() => result.current.updateBody('1回目'));
      await act(async () => {
        await result.current.save();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(countCalls(calls, 'DELETE', '/api/locks')).toBe(1);

      act(() => result.current.updateBody('2回目'));
      await flush();
      // 解放の応答が返るまでは取得を送らない
      expect(countCalls(calls, 'POST', '/api/locks')).toBe(1);

      resolveRelease?.();
      await flush();
      expect(countCalls(calls, 'POST', '/api/locks')).toBe(2);
      expect(useEditStore.getState().lockedPath).toBe('a.md');
    });

    it('サーバー側の書き換え(添付リネーム)は、ロックを持っているときだけ基準を進める', async () => {
      const REWRITTEN = '2026-07-01T03:00:00+09:00';
      const calls = stubFetch({
        'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
        'GET /api/drafts': { draft: null },
        'GET /api/docs': docResponse(BASE),
        'PUT /api/docs': { updatedAt: '2026-07-02T00:00:00+09:00' },
      });

      const { result } = renderHook(() => useEditingSession({ path: 'a.md', baseUpdatedAt: BASE }), {
        wrapper,
      });
      await act(async () => {
        await result.current.startEditing('本文', []);
      });
      // 未変更・ロックなしなら読み込み直しを求める
      expect(result.current.noteServerRewrite(REWRITTEN)).toBe('reload');

      act(() => result.current.updateBody('自分の変更'));
      await flush();
      expect(useEditStore.getState().lockedPath).toBe('a.md');
      expect(result.current.noteServerRewrite(REWRITTEN)).toBe('advanced');
      // ロック中はもう読み込み直さない
      expect(result.current.reloadFromLatest({ body: 'x', tags: [], updatedAt: 'y' })).toBe(false);

      await act(async () => {
        await result.current.save();
      });
      const put = calls.find((c) => c.method === 'PUT' && c.path === '/api/docs');
      expect(put?.body).toMatchObject({ baseUpdatedAt: REWRITTEN, body: '自分の変更' });
    });

    it('ロックが無いまま書き換え中なら、サーバー側の書き換えで基準を進めない', async () => {
      stubFetch({
        'POST /api/locks': { status: 500, error: { code: 'INTERNAL_ERROR', message: 'サーバーエラー' } },
        'GET /api/drafts': { draft: null },
      });

      const { result } = renderHook(() => useEditingSession({ path: 'a.md', baseUpdatedAt: BASE }), {
        wrapper,
      });
      await act(async () => {
        await result.current.startEditing('本文', []);
      });
      act(() => result.current.updateBody('自分の変更'));
      await flush();

      expect(result.current.noteServerRewrite('2026-07-01T03:00:00+09:00')).toBe('dirty');
      expect(result.current.reloadFromLatest({ body: 'x', tags: [], updatedAt: 'y' })).toBe(false);
    });

    it('未変更・ロックなしなら、取り直した最新の文書を起点にし、その updatedAt を基準にする', async () => {
      const LATEST = '2026-07-01T03:00:00+09:00';
      const calls = stubFetch({
        'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
        'GET /api/drafts': { draft: null },
        'GET /api/docs': docResponse(LATEST),
        'PUT /api/docs': { updatedAt: '2026-07-02T00:00:00+09:00' },
      });

      const { result } = renderHook(() => useEditingSession({ path: 'a.md', baseUpdatedAt: BASE }), {
        wrapper,
      });
      await act(async () => {
        await result.current.startEditing('本文', ['旧タグ']);
      });
      expect(result.current.reloadFromLatest({ body: '最新の本文', tags: ['新タグ'], updatedAt: LATEST })).toBe(
        true,
      );

      act(() => result.current.syncBody('最新の本文'));
      act(() => result.current.updateBody('最新の本文に追記'));
      await flush();
      expect(result.current.conflict).toBe(false);
      await act(async () => {
        await result.current.save();
      });
      const put = calls.find((c) => c.method === 'PUT' && c.path === '/api/docs');
      expect(put?.body).toMatchObject({ baseUpdatedAt: LATEST, tags: ['新タグ'] });
    });
  });

  describe('フロントマター編集連携 (#282)', () => {
    it('① updateFrontmatter で dirty=true になりロックを取得する', async () => {
      const calls = stubFetch({
        'GET /api/drafts': { draft: null },
        'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
        'GET /api/docs': docResponse(BASE),
      });
      const { result } = renderHook(() => useEditingSession({ path: 'a.md', baseUpdatedAt: BASE }), {
        wrapper,
      });
      await act(async () => {
        await result.current.startEditing('本文', []);
      });
      expect(result.current.dirty).toBe(false);
      expect(countCalls(calls, 'POST', '/api/locks')).toBe(0);

      act(() => {
        result.current.updateFrontmatter([{ op: 'set', key: 'title', value: '新' }], true);
      });
      await flush();
      expect(result.current.dirty).toBe(true);
      expect(countCalls(calls, 'POST', '/api/locks')).toBe(1);
    });

    it('② valid=false のとき save は PUT を行わず false を返しトーストを表示する', async () => {
      const calls = stubFetch({
        'GET /api/drafts': { draft: null },
        'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
        'GET /api/docs': docResponse(BASE),
      });
      const { result } = renderHook(() => useEditingSession({ path: 'a.md', baseUpdatedAt: BASE }), {
        wrapper,
      });
      await act(async () => {
        await result.current.startEditing('本文', []);
      });
      act(() => {
        result.current.updateFrontmatter([], false);
      });
      await flush();

      let saveResult = true;
      await act(async () => {
        saveResult = await result.current.save();
      });
      expect(saveResult).toBe(false);
      expect(countCalls(calls, 'PUT', '/api/docs')).toBe(0);
      expect(useToastStore.getState().toast?.message).toBe('プロパティに入力エラーがあります');
    });

    it('③ 送信した ops が PUT body の frontmatterOps に載る', async () => {
      const calls = stubFetch({
        'GET /api/drafts': { draft: null },
        'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
        'GET /api/docs': docResponse(BASE),
        'PUT /api/docs': { updatedAt: '2026-07-02T00:00:00+09:00', frontmatter: { title: '新' } },
      });
      const { result } = renderHook(() => useEditingSession({ path: 'a.md', baseUpdatedAt: BASE }), {
        wrapper,
      });
      await act(async () => {
        await result.current.startEditing('本文', []);
      });
      act(() => {
        result.current.updateFrontmatter([{ op: 'set', key: 'title', value: '新' }], true);
      });
      await flush();

      await act(async () => {
        await result.current.save();
      });
      const put = calls.find((c) => c.method === 'PUT' && c.path === '/api/docs');
      expect(put?.body).toMatchObject({
        frontmatterOps: [{ op: 'set', key: 'title', value: '新' }],
      });
    });

    it('④ 成功後に ops が空になり、続けて本文のみ変更した保存では frontmatterOps が再送されない', async () => {
      const calls = stubFetch({
        'GET /api/drafts': { draft: null },
        'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
        'GET /api/docs': docResponse(BASE),
        'PUT /api/docs': { updatedAt: '2026-07-02T00:00:00+09:00', frontmatter: { title: '新' } },
      });
      const { result } = renderHook(() => useEditingSession({ path: 'a.md', baseUpdatedAt: BASE }), {
        wrapper,
      });
      await act(async () => {
        await result.current.startEditing('本文', []);
      });
      act(() => {
        result.current.updateFrontmatter([{ op: 'set', key: 'title', value: '新' }], true);
      });
      await flush();
      await act(async () => {
        await result.current.save();
      });
      expect(result.current.dirty).toBe(false);

      // 続けて本文のみ変更して保存
      act(() => {
        result.current.updateBody('本文2');
      });
      await flush();
      await act(async () => {
        await result.current.save();
      });
      const putCalls = calls.filter((c) => c.method === 'PUT' && c.path === '/api/docs');
      expect(putCalls.length).toBe(2);
      expect((putCalls[1].body as Record<string, unknown>).frontmatterOps).toBeUndefined();
    });

    it('⑤ 送信中に updateFrontmatter されたら、成功後も ops が残り dirty=true のまま(アイドル解放タイマーも起動しない)', async () => {
      let resolvePut: (val: unknown) => void;
      const putPromise = new Promise((res) => {
        resolvePut = res;
      });
      const calls = stubFetch({
        'GET /api/drafts': { draft: null },
        'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
        'GET /api/docs': docResponse(BASE),
        'PUT /api/docs': () => putPromise,
      });
      const { result } = renderHook(() => useEditingSession({ path: 'a.md', baseUpdatedAt: BASE }), {
        wrapper,
      });
      await act(async () => {
        await result.current.startEditing('本文', []);
      });
      act(() => {
        result.current.updateFrontmatter([{ op: 'set', key: 'title', value: '1' }], true);
      });
      await flush();

      // 保存開始 (未解決)
      let savePromise!: Promise<boolean>;
      act(() => {
        savePromise = result.current.save();
      });
      await flush(); // PUT /api/docs の送信開始まで待つ

      // 送信中にプロパティを変更
      act(() => {
        result.current.updateFrontmatter([{ op: 'set', key: 'title', value: '2' }], true);
      });

      // PUT を解決
      await act(async () => {
        resolvePut!({ updatedAt: '2026-07-02T00:00:00+09:00', frontmatter: { title: '1' } });
        await savePromise!;
      });

      // dirty=true が維持されていること
      expect(result.current.dirty).toBe(true);
      // アイドル解放タイマー時間を進めてもロック解放されないこと
      act(() => vi.advanceTimersByTime(120_000));
      expect(countCalls(calls, 'DELETE', '/api/locks')).toBe(0);
    });

    it('⑥ 上書き保存 (resolveConflictOverwrite) でも ops が載る', async () => {
      const LATEST = '2026-07-01T02:00:00+09:00';
      const calls = stubFetch({
        'GET /api/drafts': { draft: null },
        'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
        'GET /api/docs': docResponse(LATEST),
        'PUT /api/docs': { updatedAt: '2026-07-02T00:00:00+09:00', frontmatter: { k: 'v' } },
      });
      const { result } = renderHook(() => useEditingSession({ path: 'a.md', baseUpdatedAt: BASE }), {
        wrapper,
      });
      await act(async () => {
        await result.current.startEditing('本文', []);
      });
      act(() => {
        result.current.updateFrontmatter([{ op: 'set', key: 'k', value: 'v' }], true);
      });
      await flush();

      await act(async () => {
        await result.current.resolveConflictOverwrite();
      });
      const put = calls.find((c) => c.method === 'PUT' && c.path === '/api/docs');
      expect(put?.body).toMatchObject({
        baseUpdatedAt: LATEST,
        frontmatterOps: [{ op: 'set', key: 'k', value: 'v' }],
      });
    });

    it('⑦ startEditing で ops が空に戻る', async () => {
      stubFetch({
        'GET /api/drafts': { draft: null },
        'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
        'GET /api/docs': docResponse(BASE),
        'PUT /api/docs': { updatedAt: '2026-07-02T00:00:00+09:00' },
      });
      const { result } = renderHook(() => useEditingSession({ path: 'a.md', baseUpdatedAt: BASE }), {
        wrapper,
      });
      await act(async () => {
        await result.current.startEditing('本文', []);
      });
      act(() => {
        result.current.updateFrontmatter([{ op: 'set', key: 'k', value: 'v' }], true);
      });
      await flush();

      // 再度 startEditing
      await act(async () => {
        await result.current.startEditing('新しい本文', []);
      });
      expect(result.current.dirty).toBe(false);
      // 本文を編集して保存したときに ops が送られないこと
      act(() => {
        result.current.updateBody('編集後本文');
      });
      await flush();
      const calls2 = stubFetch({
        'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
        'PUT /api/docs': { updatedAt: '2026-07-02T00:00:00+09:00' },
      });
      await act(async () => {
        await result.current.save();
      });
      const put = calls2.find((c) => c.method === 'PUT' && c.path === '/api/docs');
      expect((put?.body as Record<string, unknown> | undefined)?.frontmatterOps).toBeUndefined();
    });
  });
});
