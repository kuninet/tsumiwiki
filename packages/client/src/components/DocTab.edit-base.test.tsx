import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DocResponse, User } from '@tsumiwiki/shared';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { docQueryKey } from '../api/docs';
import { ME_QUERY_KEY } from '../api/auth';
import { useEditStore } from '../stores/edit';
import { useToastStore } from '../stores/toast';
import { DocTab } from './DocTab';

// #300: 競合検知の基準(updatedAt)は、編集を始めた時点の値に固定する。
// 文書キャッシュの再取得(開き直し・ペイン移動での再マウント、フォーカス復帰など)で
// updatedAt だけが進んでも、エディタの内容は差し替わらないので、それを基準にすると
// ほかからの変更を黙って上書きしてしまう。実際の DocTab と QueryClient のキャッシュで確かめる

const OLD: DocResponse = {
  path: 'メモ.md',
  frontmatter: {},
  tags: ['設計'],
  body: '古い本文',
  updatedAt: '2026-07-01T00:00:00+09:00',
  lock: null,
};

const LATEST: DocResponse = {
  ...OLD,
  body: 'ほかから書き換えた本文',
  updatedAt: '2026-07-01T05:00:00+09:00',
};

const CURRENT_USER: User = {
  id: 1,
  username: 'taro',
  displayName: '太郎',
  role: 'user',
  disabled: false,
};

interface Call {
  method: string;
  path: string;
  body: unknown;
}

describe('DocTab の競合検知の基準(#300)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    useEditStore.setState({ mode: 'view', dirty: false, lockedPath: null, lastDraftSavedAt: null });
    useToastStore.setState({ toast: null });
  });

  it('古いキャッシュで編集を始めたあと再取得で updatedAt が進んでも、書き換えると競合を出し、黙って上書きしない', async () => {
    const calls: Call[] = [];
    // マウント時の再取得の応答は、編集モードに入ったあとで返す
    let releaseFirstDocFetch: (() => void) | undefined;
    const firstDocFetch = new Promise<void>((resolve) => {
      releaseFirstDocFetch = resolve;
    });
    let docFetches = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        const [path] = url.split('?');
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
        calls.push({ method, path, body });
        const ok = (value: unknown) => ({ ok: true, status: 200, json: () => Promise.resolve(value) });
        if (method === 'GET' && path === '/api/docs') {
          docFetches += 1;
          if (docFetches === 1) await firstDocFetch;
          return ok(LATEST);
        }
        if (method === 'POST' && path === '/api/locks') return ok({ lock: { userId: 1, displayName: '太郎' } });
        if (method === 'PUT' && path === '/api/docs') return ok({ updatedAt: '2026-07-02T00:00:00+09:00' });
        return ok({ ok: true, draft: null, docs: [], folders: [] });
      }),
    );

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(ME_QUERY_KEY, CURRENT_USER);
    // 前に開いたときのキャッシュが残っている(タブを閉じて開き直した・ペインを移した等)
    queryClient.setQueryData(docQueryKey(OLD.path), OLD);

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/doc/メモ.md']}>
          <DocTab path={OLD.path} active />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // 古いキャッシュの内容で編集モードに入る
    await waitFor(() => {
      expect((screen.getByRole('button', { name: /保存/ }) as HTMLButtonElement).disabled).toBe(true);
    });
    // 再取得が返り、キャッシュの updatedAt だけが進む(エディタの内容は古いまま)
    releaseFirstDocFetch?.();
    await waitFor(() => {
      expect(queryClient.getQueryData<DocResponse>(docQueryKey(OLD.path))?.updatedAt).toBe(
        LATEST.updatedAt,
      );
    });

    fireEvent.click(screen.getByRole('button', { name: 'タグ #設計 を削除' }));

    expect(await screen.findByText('開いたあとで、ほかから更新されています。')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    // 古い本文を新しい基準で送る(=ほかの変更を黙って消す)ことはしない
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls.some((c) => c.method === 'PUT' && c.path === '/api/docs')).toBe(false);
  });
});
