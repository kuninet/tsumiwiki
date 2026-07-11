import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TagChipEditor } from './TagChipEditor';

// #118: 「+ タグを追加」の既存タグサジェスト。fetch モックで useTags() に候補を注入する

function mockTags(tags: { tag: string; count: number }[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ tags }),
      }),
    ),
  );
}

function renderEditor(props: Partial<React.ComponentProps<typeof TagChipEditor>> = {}) {
  const onNavigate = props.onNavigate ?? vi.fn();
  const onRename = props.onRename ?? vi.fn();
  const onRemove = props.onRemove ?? vi.fn();
  const onAdd = props.onAdd ?? vi.fn();
  const tags = props.tags ?? [];
  const editable = props.editable ?? true;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <TagChipEditor
        tags={tags}
        editable={editable}
        onNavigate={onNavigate}
        onRename={onRename}
        onRemove={onRemove}
        onAdd={onAdd}
      />
    </QueryClientProvider>,
  );
  return { ...result, onNavigate, onRename, onRemove, onAdd };
}

describe('TagChipEditor サジェスト', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it('「+ タグを追加」クリックで候補が表示され、付与済みタグは候補に出ない', async () => {
    mockTags([
      { tag: '設計', count: 12 },
      { tag: '議事録', count: 3 },
      { tag: '日誌', count: 1 },
    ]);
    renderEditor({ tags: ['日誌'] });

    fireEvent.click(screen.getByRole('button', { name: '+ タグを追加' }));

    expect(await screen.findByText('#設計')).toBeTruthy();
    expect(screen.getByText('#議事録')).toBeTruthy();
    // 「#日誌」は付与済みタグのチップとしては表示されるが、候補ポップアップには出ないため1件のみ
    expect(screen.getAllByText('#日誌')).toHaveLength(1);
  });

  it('入力で候補が部分一致フィルタされる(大文字小文字無視)', async () => {
    mockTags([
      { tag: '設計', count: 12 },
      { tag: '議事録', count: 3 },
    ]);
    renderEditor();

    fireEvent.click(screen.getByRole('button', { name: '+ タグを追加' }));
    await screen.findByText('#設計');

    fireEvent.change(screen.getByLabelText('タグを追加'), { target: { value: '議' } });

    expect(await screen.findByText('#議事録')).toBeTruthy();
    expect(screen.queryByText('#設計')).toBeNull();
  });

  it('候補クリックで onAdd がそのタグ名で呼ばれ、ポップアップが閉じる', async () => {
    mockTags([{ tag: '設計', count: 12 }]);
    const { onAdd } = renderEditor();

    fireEvent.click(screen.getByRole('button', { name: '+ タグを追加' }));
    fireEvent.click(await screen.findByText('#設計'));

    expect(onAdd).toHaveBeenCalledWith('設計');
    expect(screen.queryByText('#設計')).toBeNull();
    expect(screen.getByRole('button', { name: '+ タグを追加' })).toBeTruthy();
  });

  it('ArrowDown + Enter で候補を選択できる', async () => {
    mockTags([
      { tag: '設計', count: 12 },
      { tag: '議事録', count: 3 },
    ]);
    const { onAdd } = renderEditor();

    fireEvent.click(screen.getByRole('button', { name: '+ タグを追加' }));
    await screen.findByText('#設計');
    const input = screen.getByLabelText('タグを追加');

    // count 降順なので先頭は #設計。1回 ArrowDown で最初の候補が選択状態になる
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onAdd).toHaveBeenCalledWith('設計');
  });

  it('候補にない名前の Enter は従来どおり新規タグとして onAdd される', async () => {
    mockTags([{ tag: '設計', count: 12 }]);
    const { onAdd } = renderEditor();

    fireEvent.click(screen.getByRole('button', { name: '+ タグを追加' }));
    await screen.findByText('#設計');
    const input = screen.getByLabelText('タグを追加');

    fireEvent.change(input, { target: { value: '新規タグ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onAdd).toHaveBeenCalledWith('新規タグ');
  });

  it('Escape でキャンセルされ onAdd が呼ばれない', async () => {
    mockTags([{ tag: '設計', count: 12 }]);
    const { onAdd } = renderEditor();

    fireEvent.click(screen.getByRole('button', { name: '+ タグを追加' }));
    await screen.findByText('#設計');
    const input = screen.getByLabelText('タグを追加');

    fireEvent.change(input, { target: { value: '設計' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '+ タグを追加' })).toBeTruthy();
  });

  it('IME変換中の Enter では確定しない', async () => {
    mockTags([{ tag: '設計', count: 12 }]);
    const { onAdd } = renderEditor();

    fireEvent.click(screen.getByRole('button', { name: '+ タグを追加' }));
    await screen.findByText('#設計');
    const input = screen.getByLabelText('タグを追加');

    fireEvent.change(input, { target: { value: '設計' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });

    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.getByLabelText('タグを追加')).toBeTruthy();
  });

  it('候補は count 降順の上位20件までに制限される', async () => {
    // 25件のタグ(tag01 が count=25 で最多、tag25 が count=1 で最少)
    mockTags(
      Array.from({ length: 25 }, (_, i) => ({
        tag: `tag${String(i + 1).padStart(2, '0')}`,
        count: 25 - i,
      })),
    );
    renderEditor();

    fireEvent.click(screen.getByRole('button', { name: '+ タグを追加' }));

    expect(await screen.findByText('#tag01')).toBeTruthy();
    expect(screen.getByText('#tag20')).toBeTruthy();
    expect(screen.queryByText('#tag21')).toBeNull();
  });
});
