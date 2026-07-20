import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTabsStore } from '../stores/tabs';
import { useUserSettingsStore } from '../stores/user-settings';
import { useNewDocShortcut } from './use-new-doc-shortcut';

// #153: Ctrl+N はモーダル無しで '無題.md' を自動採番して即作成 → pinned タブで開く

interface Call {
  method: string;
  path: string;
  body: unknown;
}

function stubFetch(overrides: {
  treeDocs: { path: string; title: string; folder: string }[];
  createResponse?: { path: string; updatedAt: string };
}) {
  const calls: Call[] = [];
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const [path] = url.split('?');
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    if (path === '/api/tree' && method === 'GET') {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            folders: [],
            docs: overrides.treeDocs.map((d) => ({ ...d, updatedAt: '2026-07-20T00:00:00Z' })),
          }),
      });
    }
    if (path === '/api/docs' && method === 'POST') {
      return Promise.resolve({
        ok: true,
        status: 201,
        json: () => Promise.resolve(overrides.createResponse ?? { path: 'default.md', updatedAt: '' }),
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

function Probe() {
  useNewDocShortcut();
  return null;
}

function render_() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Probe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('useNewDocShortcut (#153: モーダル無し即作成)', () => {
  beforeEach(() => {
    useTabsStore.getState().reset();
    useUserSettingsStore.setState({ newDocPolicy: 'same-folder', fixedFolder: '' });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it('Ctrl+N で ルート直下に "無題" を title として POST /api/docs する', async () => {
    const calls = stubFetch({
      treeDocs: [],
      createResponse: { path: '無題.md', updatedAt: '' },
    });
    render_();
    // tree fetch が完走し useQuery に state が入るまで待つ(単に fetch 呼ばれるだけでは足りない)
    await waitFor(() => expect(calls.filter((c) => c.path === '/api/tree').length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 20));
    fireEvent.keyDown(window, { key: 'n', ctrlKey: true });
    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST' && c.path === '/api/docs');
      expect(post).toBeTruthy();
      expect(post?.body).toEqual({ folder: '', title: '無題' });
    });
  });

  it('無題 が既に存在すれば "無題(1)" を作る', async () => {
    const calls = stubFetch({
      treeDocs: [{ path: '無題.md', title: '無題', folder: '' }],
      createResponse: { path: '無題(1).md', updatedAt: '' },
    });
    render_();
    await waitFor(() =>
      expect(calls.filter((c) => c.path === '/api/tree').length).toBeGreaterThan(0),
    );
    await new Promise((r) => setTimeout(r, 20));
    fireEvent.keyDown(window, { key: 'n', ctrlKey: true });
    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST' && c.path === '/api/docs');
      expect(post?.body).toEqual({ folder: '', title: '無題(1)' });
    });
  });

  it('activePath のフォルダで採番する(same-folder ポリシー)', async () => {
    const calls = stubFetch({
      treeDocs: [
        { path: 'notes/無題.md', title: '無題', folder: 'notes' },
        // 別フォルダの 無題 は無関係
        { path: 'foo/無題.md', title: '無題', folder: 'foo' },
      ],
      createResponse: { path: 'notes/無題(1).md', updatedAt: '' },
    });
    useTabsStore.getState().openDoc('notes/existing.md', { pinned: true });
    render_();
    await waitFor(() =>
      expect(calls.filter((c) => c.path === '/api/tree').length).toBeGreaterThan(0),
    );
    await new Promise((r) => setTimeout(r, 20));
    fireEvent.keyDown(window, { key: 'n', ctrlKey: true });
    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST' && c.path === '/api/docs');
      expect(post?.body).toEqual({ folder: 'notes', title: '無題(1)' });
    });
  });

  it('IME 変換中は無視', async () => {
    const calls = stubFetch({ treeDocs: [] });
    render_();
    await waitFor(() =>
      expect(calls.filter((c) => c.path === '/api/tree').length).toBeGreaterThan(0),
    );
    await new Promise((r) => setTimeout(r, 20));
    fireEvent.keyDown(window, { key: 'n', ctrlKey: true, isComposing: true });
    // POST は発火しない
    expect(calls.find((c) => c.method === 'POST' && c.path === '/api/docs')).toBeUndefined();
  });

  it('Ctrl+Shift+N など修飾違いは無視', async () => {
    const calls = stubFetch({ treeDocs: [] });
    render_();
    await waitFor(() =>
      expect(calls.filter((c) => c.path === '/api/tree').length).toBeGreaterThan(0),
    );
    await new Promise((r) => setTimeout(r, 20));
    fireEvent.keyDown(window, { key: 'n', ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: 'n', ctrlKey: true, altKey: true });
    expect(calls.find((c) => c.method === 'POST' && c.path === '/api/docs')).toBeUndefined();
  });
});
