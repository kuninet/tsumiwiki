import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
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

function stubFetch(overrides: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const [path] = url.split('?');
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });

    const key = `${method} ${path}`;
    const override = overrides[key];
    if (isErrorOverride(override)) {
      return Promise.resolve({
        ok: false,
        status: override.status,
        json: () => Promise.resolve({ error: override.error }),
      });
    }
    if (key in overrides) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(override) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
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
    vi.useRealTimers();
    vi.unstubAllGlobals();
    useEditStore.setState({ mode: 'view', dirty: false, lockedPath: null, lastDraftSavedAt: null });
    useToastStore.setState({ toast: null });
  });

  it('編集開始でロックを取得し、編集モードに遷移する', async () => {
    const calls = stubFetch({
      'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
      'GET /api/drafts': { draft: null },
    });

    const { result } = renderHook(
      () => useEditingSession({ path: 'a.md', baseUpdatedAt: '2026-07-01T00:00:00+09:00' }),
      { wrapper },
    );

    await act(async () => {
      await result.current.startEditing('本文', ['tag1']);
    });

    expect(result.current.mode).toBe('edit');
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/locks')).toBe(true);
  });

  it('DOC_LOCKEDの場合は編集モードに入らずエラートーストを表示する', async () => {
    stubFetch({
      'POST /api/locks': { status: 409, error: { code: 'DOC_LOCKED', message: '次郎さんが編集中です' } },
    });

    const { result } = renderHook(
      () => useEditingSession({ path: 'a.md', baseUpdatedAt: '2026-07-01T00:00:00+09:00' }),
      { wrapper },
    );

    await act(async () => {
      await result.current.startEditing('本文', []);
    });

    expect(result.current.mode).toBe('view');
    expect(useToastStore.getState().toast).toMatchObject({ kind: 'error', message: '次郎さんが編集中です' });
  });

  it('編集中は一定間隔でロックのハートビートを送る', async () => {
    const calls = stubFetch({
      'POST /api/locks': { lock: { userId: 1, displayName: '太郎' } },
      'GET /api/drafts': { draft: null },
    });

    const { result } = renderHook(
      () =>
        useEditingSession({
          path: 'a.md',
          baseUpdatedAt: '2026-07-01T00:00:00+09:00',
          heartbeatIntervalMs: 1000,
          autosaveIntervalMs: 100_000,
        }),
      { wrapper },
    );

    await act(async () => {
      await result.current.startEditing('本文', []);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(calls.some((c) => c.method === 'PUT' && c.path === '/api/locks/refresh')).toBe(true);
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

  it('保存に成功するとロックを解放して閲覧モードへ戻る', async () => {
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

    expect(result.current.mode).toBe('view');
    expect(calls.some((c) => c.method === 'PUT' && c.path === '/api/docs')).toBe(true);
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/locks')).toBe(true);
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
    expect(useToastStore.getState().toast).toMatchObject({ kind: 'error' });
  });

  it('取消すると下書きを破棄してロックを解放し閲覧モードへ戻る', async () => {
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

    await act(async () => {
      await result.current.cancelEditing();
    });

    expect(result.current.mode).toBe('view');
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/drafts')).toBe(true);
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/locks')).toBe(true);
  });

  it('編集開始時に自分の下書きがあれば復元プロンプトを提示し、復元すると内容が反映される', async () => {
    stubFetch({
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
  });
});
