import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
});
