import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useUIStore } from '../stores/ui';
import { TagPane } from './TagPane';

function renderTagPane() {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (url.startsWith('/api/tags/docs')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              docs: [
                { path: '設計.md', title: '設計ドキュメント', folder: '', updatedAt: '2026-07-01T00:00:00+09:00' },
              ],
            }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            tags: [
              { tag: '設計', count: 12 },
              { tag: '議事録', count: 3 },
            ],
          }),
      });
    }),
  );
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <TagPane />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('TagPane', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
    useUIStore.setState({ selectedTags: [] });
  });

  it('タグ一覧を件数付きで表示する', async () => {
    renderTagPane();

    expect(await screen.findByText('設計')).toBeTruthy();
    expect(screen.getByText('12')).toBeTruthy();
    expect(screen.getByText('議事録')).toBeTruthy();
  });

  it('タグを選択すると該当文書一覧を取得して表示し、選択解除ボタンが現れる', async () => {
    renderTagPane();

    fireEvent.click(await screen.findByText('設計'));

    expect(await screen.findByText('設計ドキュメント')).toBeTruthy();
    expect(screen.getByRole('button', { name: '選択解除' })).toBeTruthy();
  });
});
