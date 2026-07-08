import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ListTemplatesResponse } from '@tsumiwiki/shared';
import { TemplatePickerDialog } from './TemplatePickerDialog';

// #84 Phase B: テンプレ選択ダイアログのテスト。API は fetch モックで注入する。

function mockTemplates(templates: ListTemplatesResponse['templates']) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ templates }),
      }),
    ),
  );
}

function renderPicker(props: Partial<React.ComponentProps<typeof TemplatePickerDialog>> = {}) {
  const onSubmit = props.onSubmit ?? vi.fn();
  const onCancel = props.onCancel ?? vi.fn();
  const mode = props.mode;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <TemplatePickerDialog mode={mode} onSubmit={onSubmit} onCancel={onCancel} />
    </QueryClientProvider>,
  );
  return { ...result, onSubmit, onCancel };
}

describe('TemplatePickerDialog', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it('テンプレ一覧を表示し、クリックで Step2 に進んで作成できる', async () => {
    mockTemplates([
      { path: '_templates/日誌.md', name: '日誌', targetFolder: '日記', description: '毎日' },
      { path: '_templates/週報.md', name: '週報', targetFolder: null },
    ]);
    const { onSubmit } = renderPicker();

    // 一覧描画
    await screen.findByText('日誌');
    expect(screen.getByText('_templates/日誌.md → 日記/')).toBeTruthy();
    expect(screen.getByText('毎日')).toBeTruthy();

    // クリックで Step2 に遷移し、targetFolder に frontmatter の値が入る
    fireEvent.click(screen.getByRole('option', { name: /日誌/ }));
    const titleInput = screen.getByLabelText('タイトル') as HTMLInputElement;
    const targetInput = screen.getByLabelText('作成先フォルダ') as HTMLInputElement;
    expect(targetInput.value).toBe('日記');

    fireEvent.change(titleInput, { target: { value: '20260707' } });
    fireEvent.click(screen.getByRole('button', { name: '作成' }));

    expect(onSubmit).toHaveBeenCalledWith({
      mode: 'create',
      templatePath: '_templates/日誌.md',
      title: '20260707',
      targetFolder: '日記',
    });
  });

  it('空文字のタイトルでは作成ボタンが disabled', async () => {
    mockTemplates([{ path: '_templates/x.md', name: 'x', targetFolder: null }]);
    renderPicker();

    fireEvent.click(await screen.findByRole('option', { name: /x/ }));
    const submit = screen.getByRole('button', { name: '作成' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });

  it('絞り込み入力で一覧がフィルタされる', async () => {
    mockTemplates([
      { path: '_templates/日誌.md', name: '日誌', targetFolder: null },
      { path: '_templates/週報.md', name: '週報', targetFolder: null },
    ]);
    renderPicker();

    await screen.findByText('日誌');
    fireEvent.change(screen.getByLabelText('テンプレートを絞り込み'), { target: { value: '週' } });
    await waitFor(() => {
      expect(screen.queryByText('日誌')).toBeNull();
    });
    expect(screen.getByText('週報')).toBeTruthy();
  });

  it('Esc キーで onCancel が呼ばれる', async () => {
    mockTemplates([{ path: '_templates/x.md', name: 'x', targetFolder: null }]);
    const { onCancel } = renderPicker();

    await screen.findByText('x');
    fireEvent.keyDown(screen.getByLabelText('テンプレートを絞り込み'), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('テンプレが 0 件のときは案内メッセージが出る', async () => {
    mockTemplates([]);
    renderPicker();
    await screen.findByText('テンプレートがありません。設定でフォルダを確認してください');
  });

  it('Step2 の「戻る」で Step1 に戻れる', async () => {
    mockTemplates([{ path: '_templates/x.md', name: 'x', targetFolder: null }]);
    renderPicker();

    fireEvent.click(await screen.findByRole('option', { name: /x/ }));
    expect(screen.getByLabelText('タイトル')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '戻る' }));
    // Step1 の絞り込みボックスが再表示される
    expect(screen.getByLabelText('テンプレートを絞り込み')).toBeTruthy();
  });

  it('Step1 で Enter を押すと Step2 に進める(キーボードのみで前進)', async () => {
    mockTemplates([{ path: '_templates/x.md', name: 'x', targetFolder: null }]);
    renderPicker();

    await screen.findByText('x');
    const search = screen.getByLabelText('テンプレートを絞り込み');
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(screen.getByLabelText('タイトル')).toBeTruthy();
  });

  it('Step2 のタイトル入力中に IME 変換確定 Enter で submit されない', async () => {
    mockTemplates([{ path: '_templates/x.md', name: 'x', targetFolder: null }]);
    const { onSubmit } = renderPicker();

    fireEvent.click(await screen.findByRole('option', { name: /x/ }));
    const titleInput = screen.getByLabelText('タイトル') as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: 'にっし' } });
    // IME 変換確定の Enter は preventDefault で form submit を止める
    fireEvent.keyDown(titleInput, { key: 'Enter', isComposing: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('Step2 でも Escape で onCancel が呼ばれる', async () => {
    mockTemplates([{ path: '_templates/x.md', name: 'x', targetFolder: null }]);
    const { onCancel } = renderPicker();

    fireEvent.click(await screen.findByRole('option', { name: /x/ }));
    // タイトル欄にフォーカスが当たった状態で Esc
    fireEvent.keyDown(screen.getByLabelText('タイトル'), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('mode=apply では Step2 に「挿入」「追記」の 2 ボタンが出て、それぞれ applyMode 付きで onSubmit を呼ぶ', async () => {
    mockTemplates([{ path: '_templates/日誌.md', name: '日誌', targetFolder: '日記' }]);
    const { onSubmit } = renderPicker({ mode: 'apply' });

    fireEvent.click(await screen.findByRole('option', { name: /日誌/ }));

    // create モード用の入力欄は出ない
    expect(screen.queryByLabelText('タイトル')).toBeNull();
    expect(screen.queryByLabelText('作成先フォルダ')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '挿入' }));
    expect(onSubmit).toHaveBeenCalledWith({
      mode: 'apply',
      templatePath: '_templates/日誌.md',
      applyMode: 'insert',
    });
  });

  it('mode=apply の「追記」ボタンで applyMode=append の onSubmit', async () => {
    mockTemplates([{ path: '_templates/日誌.md', name: '日誌', targetFolder: null }]);
    const { onSubmit } = renderPicker({ mode: 'apply' });

    fireEvent.click(await screen.findByRole('option', { name: /日誌/ }));
    fireEvent.click(screen.getByRole('button', { name: '追記' }));
    expect(onSubmit).toHaveBeenCalledWith({
      mode: 'apply',
      templatePath: '_templates/日誌.md',
      applyMode: 'append',
    });
  });
});
