import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useTabsStore } from '../stores/tabs';
import { TabBar } from './TabBar';

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderTabBar(initialPath = '/') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <TabBar />
      <LocationProbe />
    </MemoryRouter>,
  );
}

describe('TabBar', () => {
  beforeEach(() => {
    useTabsStore.getState().reset();
  });
  afterEach(() => cleanup());

  it('タブが無ければ何も描画しない', () => {
    const { container } = renderTabBar();
    expect(container.querySelector('[data-testid="tabbar"]')).toBeNull();
  });

  it('タブ一覧を描画し、アクティブタブに aria-selected を付ける', () => {
    useTabsStore.getState().openDoc('a.md');
    useTabsStore.getState().openDoc('b.md', { pinned: true });
    renderTabBar();
    const a = screen.getByTestId('tab-a.md');
    const b = screen.getByTestId('tab-b.md');
    // 直近に openDoc したのが b.md なのでアクティブ
    expect(b.getAttribute('aria-selected')).toBe('true');
    expect(a.getAttribute('aria-selected')).toBe('false');
  });

  it('preview タブは italic クラスを付ける', () => {
    useTabsStore.getState().openDoc('a.md');
    renderTabBar();
    expect(screen.getByTestId('tab-a.md').className).toMatch(/italic/);
  });

  it('dirty タブは先頭に「●」を出す', () => {
    useTabsStore.getState().openDoc('a.md');
    useTabsStore.getState().markDirty('a.md', true);
    renderTabBar();
    expect(screen.getByTestId('tab-a.md').textContent).toMatch(/^●/);
  });

  it('タブクリックでアクティブが切り替わり URL が /doc/<path> に更新される', () => {
    useTabsStore.getState().openDoc('a.md', { pinned: true });
    useTabsStore.getState().openDoc('b.md', { pinned: true });
    const { getByTestId } = renderTabBar('/doc/b.md');
    fireEvent.click(screen.getByTestId('tab-a.md'));
    expect(useTabsStore.getState().activeId).toBe('a.md');
    expect(getByTestId('location').textContent).toBe('/doc/a.md');
  });

  it('既にアクティブなタブをクリックしても navigate は起きない(L2)', () => {
    useTabsStore.getState().openDoc('a.md', { pinned: true });
    const { getByTestId } = renderTabBar('/doc/a.md');
    fireEvent.click(screen.getByTestId('tab-a.md'));
    // URL は変わらないまま
    expect(getByTestId('location').textContent).toBe('/doc/a.md');
  });

  it('preview タブをダブルクリックすると pinned に昇格する', () => {
    useTabsStore.getState().openDoc('a.md');
    renderTabBar();
    fireEvent.doubleClick(screen.getByTestId('tab-a.md'));
    expect(useTabsStore.getState().tabs[0].kind).toBe('pinned');
  });

  // Phase A-2
  describe('閉じる操作', () => {
    it('× ボタンで clean タブを閉じる', () => {
      useTabsStore.getState().openDoc('a.md', { pinned: true });
      useTabsStore.getState().openDoc('b.md', { pinned: true });
      renderTabBar('/doc/b.md');
      fireEvent.click(screen.getByTestId('tab-close-a.md'));
      const s = useTabsStore.getState();
      expect(s.tabs.map((t) => t.path)).toEqual(['b.md']);
      expect(s.pendingCloseId).toBeNull();
    });

    it('× ボタンで dirty タブを閉じようとすると pendingCloseId が立つ(閉じは保留)', () => {
      useTabsStore.getState().openDoc('a.md');
      useTabsStore.getState().markDirty('a.md', true);
      renderTabBar('/doc/a.md');
      fireEvent.click(screen.getByTestId('tab-close-a.md'));
      const s = useTabsStore.getState();
      expect(s.pendingCloseId).toBe('a.md');
      // ダイアログ表示中はまだ閉じない
      expect(s.tabs).toHaveLength(1);
    });

    it('middle-click(button===1)でも閉じる', () => {
      useTabsStore.getState().openDoc('a.md', { pinned: true });
      useTabsStore.getState().openDoc('b.md', { pinned: true });
      renderTabBar('/doc/b.md');
      fireEvent.mouseDown(screen.getByTestId('tab-a.md'), { button: 1 });
      expect(useTabsStore.getState().tabs.map((t) => t.path)).toEqual(['b.md']);
    });

    it('タブクリックがタブ全体のアクティブ化(× 内クリックはアクティブ化しない)', () => {
      useTabsStore.getState().openDoc('a.md', { pinned: true });
      useTabsStore.getState().openDoc('b.md', { pinned: true });
      renderTabBar('/doc/b.md');
      // × クリックは stopPropagation されるので activeId は b のまま(a に切替って a を閉じる、じゃない)
      fireEvent.click(screen.getByTestId('tab-close-a.md'));
      // a が閉じられて b だけ残る
      expect(useTabsStore.getState().tabs.map((t) => t.path)).toEqual(['b.md']);
      expect(useTabsStore.getState().activeId).toBe('b.md');
    });

    it('アクティブタブを閉じたら URL が新アクティブに追随する', async () => {
      useTabsStore.getState().openDoc('a.md', { pinned: true });
      useTabsStore.getState().openDoc('b.md', { pinned: true });
      const { getByTestId } = renderTabBar('/doc/b.md');
      // ● のない b(clean)を × で閉じる
      fireEvent.click(screen.getByTestId('tab-close-b.md'));
      // a が新アクティブ → URL 追随
      expect(useTabsStore.getState().activeId).toBe('a.md');
      // useEffect 経由で navigate されるので次のマイクロタスクで反映
      await Promise.resolve();
      expect(getByTestId('location').textContent).toBe('/doc/a.md');
    });
  });

  describe('Ctrl+W(⌘W)', () => {
    it('clean なアクティブタブを閉じる', () => {
      useTabsStore.getState().openDoc('a.md', { pinned: true });
      useTabsStore.getState().openDoc('b.md', { pinned: true });
      renderTabBar('/doc/b.md');
      fireEvent.keyDown(window, { key: 'w', ctrlKey: true });
      const s = useTabsStore.getState();
      expect(s.tabs.map((t) => t.path)).toEqual(['a.md']);
      expect(s.pendingCloseId).toBeNull();
    });

    it('dirty なアクティブタブでは pendingCloseId を立てる(閉じは保留)', () => {
      useTabsStore.getState().openDoc('a.md');
      useTabsStore.getState().markDirty('a.md', true);
      renderTabBar('/doc/a.md');
      fireEvent.keyDown(window, { key: 'w', ctrlKey: true });
      expect(useTabsStore.getState().pendingCloseId).toBe('a.md');
      expect(useTabsStore.getState().tabs).toHaveLength(1);
    });

    it('IME 変換中(isComposing=true)は無視する', () => {
      useTabsStore.getState().openDoc('a.md', { pinned: true });
      useTabsStore.getState().openDoc('b.md', { pinned: true });
      renderTabBar('/doc/b.md');
      fireEvent.keyDown(window, { key: 'w', ctrlKey: true, isComposing: true });
      // 変化なし
      expect(useTabsStore.getState().tabs).toHaveLength(2);
    });
  });

  describe('全部閉じた後の URL', () => {
    it('コンテキストメニューの「すべて閉じる」で URL が / に戻る', async () => {
      useTabsStore.getState().openDoc('a.md');
      const { getByTestId } = renderTabBar('/doc/a.md');
      // 右クリックメニュー → すべて閉じる
      fireEvent.contextMenu(screen.getByTestId('tab-a.md'));
      fireEvent.click(screen.getByRole('menuitem', { name: 'すべて閉じる' }));
      await waitFor(() => {
        expect(getByTestId('location').textContent).toBe('/');
      });
    });
  });

  describe('右クリックメニュー', () => {
    it('コンテキストメニューが表示され、「ピン留め」で pinned になる', () => {
      useTabsStore.getState().openDoc('a.md');
      renderTabBar();
      fireEvent.contextMenu(screen.getByTestId('tab-a.md'));
      const pinItem = screen.getByRole('menuitem', { name: 'ピン留め' });
      fireEvent.click(pinItem);
      expect(useTabsStore.getState().tabs[0].kind).toBe('pinned');
    });

    it('「他をすべて閉じる」で該当以外を閉じる', () => {
      useTabsStore.getState().openDoc('a.md', { pinned: true });
      useTabsStore.getState().openDoc('b.md', { pinned: true });
      useTabsStore.getState().openDoc('c.md', { pinned: true });
      renderTabBar();
      fireEvent.contextMenu(screen.getByTestId('tab-b.md'));
      fireEvent.click(screen.getByRole('menuitem', { name: '他をすべて閉じる' }));
      expect(useTabsStore.getState().tabs.map((t) => t.path)).toEqual(['b.md']);
    });
  });
});
