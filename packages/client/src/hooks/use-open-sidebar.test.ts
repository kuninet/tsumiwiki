import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUIStore } from '../stores/ui';
import { useUserSettingsStore } from '../stores/user-settings';
import { useOpenSidebar } from './use-open-sidebar';

describe('useOpenSidebar (#322, #271 D7)', () => {
  const origInnerWidth = window.innerWidth;

  beforeEach(() => {
    useUserSettingsStore.setState({ rightPanelOpen: false });
    useUIStore.setState({
      sidebarCollapsed: true,
      sidebarWidth: 260,
      rightDrawerOpen: false,
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', {
      writable: true,
      configurable: true,
      value: origInnerWidth,
    });
    vi.unstubAllGlobals();
    cleanup();
  });

  it('狭いデスクトップ幅(800px)で右パネルが開いている場合、右パネルを閉じてサイドバーを開く', () => {
    Object.defineProperty(window, 'innerWidth', {
      writable: true,
      configurable: true,
      value: 800,
    });
    useUserSettingsStore.setState({ rightPanelOpen: true });
    useUIStore.setState({ sidebarCollapsed: true, sidebarWidth: 260 });

    const { result } = renderHook(() => useOpenSidebar());
    result.current();

    expect(useUserSettingsStore.getState().rightPanelOpen).toBe(false);
    expect(useUIStore.getState().sidebarCollapsed).toBe(false);
  });

  it('十分なデスクトップ幅(1280px)の場合、右パネルを開いたままサイドバーを開く', () => {
    Object.defineProperty(window, 'innerWidth', {
      writable: true,
      configurable: true,
      value: 1280,
    });
    useUserSettingsStore.setState({ rightPanelOpen: true });
    useUIStore.setState({ sidebarCollapsed: true, sidebarWidth: 260 });

    const { result } = renderHook(() => useOpenSidebar());
    result.current();

    expect(useUserSettingsStore.getState().rightPanelOpen).toBe(true);
    expect(useUIStore.getState().sidebarCollapsed).toBe(false);
  });

  it('既にサイドバーが開いている(sidebarCollapsed: false)場合は何もしない', () => {
    Object.defineProperty(window, 'innerWidth', {
      writable: true,
      configurable: true,
      value: 800,
    });
    useUserSettingsStore.setState({ rightPanelOpen: true });
    useUIStore.setState({ sidebarCollapsed: false, sidebarWidth: 260 });

    const { result } = renderHook(() => useOpenSidebar());
    result.current();

    expect(useUserSettingsStore.getState().rightPanelOpen).toBe(true);
    expect(useUIStore.getState().sidebarCollapsed).toBe(false);
  });
});
