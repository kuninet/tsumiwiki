import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { useEditStore } from '../stores/edit';
import { StatusBar } from './StatusBar';

function renderStatusBar(initialPath = '/doc/メモ.md') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/" element={<StatusBar />} />
        <Route path="/doc/*" element={<StatusBar />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('StatusBar', () => {
  afterEach(() => {
    cleanup();
    useEditStore.setState({
      mode: 'view',
      dirty: false,
      lockedPath: null,
      lastDraftSavedAt: null,
      lockedByOtherName: null,
      saveError: false,
    });
  });

  it('文書表示中は閲覧モードを表示する', () => {
    renderStatusBar();
    expect(screen.getByTestId('status-bar').textContent).toBe('閲覧モード');
  });

  it('編集中はロック取得済み(あなた)を表示する', () => {
    useEditStore.setState({ mode: 'edit' });
    renderStatusBar();
    expect(screen.getByTestId('status-bar').textContent).toContain('編集中');
  });

  it('他者がロック中のときは他者編集中を表示する', () => {
    useEditStore.setState({ lockedByOtherName: '次郎' });
    renderStatusBar();
    expect(screen.getByTestId('status-bar').textContent).toBe('他者編集中(次郎さん)');
  });

  it('保存エラー時は他の状態より優先して表示する', () => {
    useEditStore.setState({ mode: 'edit', saveError: true });
    renderStatusBar();
    expect(screen.getByTestId('status-bar').textContent).toBe('保存エラー');
  });

  it('文書未選択時は何も表示しない', () => {
    renderStatusBar('/');
    expect(screen.queryByTestId('status-bar')).toBeNull();
  });
});
