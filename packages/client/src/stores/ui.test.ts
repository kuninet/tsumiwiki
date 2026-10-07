import { beforeEach, describe, expect, it } from 'vitest';
import { useUIStore } from './ui';

describe('uiストア', () => {
  beforeEach(() => {
    useUIStore.setState({
      sidebarCollapsed: false,
      rightDrawerOpen: false,
      rightPanelSlot: null,
    });
  });

  it('サイドバー幅が200〜480pxにクランプされる', () => {
    const { setSidebarWidth } = useUIStore.getState();
    setSidebarWidth(100);
    expect(useUIStore.getState().sidebarWidth).toBe(200);
    setSidebarWidth(900);
    expect(useUIStore.getState().sidebarWidth).toBe(480);
    setSidebarWidth(300);
    expect(useUIStore.getState().sidebarWidth).toBe(300);
  });

  describe('右ドロワーと排他状態 (C-3-7 〜 C-3-10)', () => {
    it('C-3-7: 初期状態では rightDrawerOpen=false, rightPanelSlot=null', () => {
      const state = useUIStore.getState();
      expect(state.rightDrawerOpen).toBe(false);
      expect(state.rightPanelSlot).toBeNull();
    });

    it('C-3-8: 左が開のとき setRightDrawerOpen(true) で右が開・左が閉(sidebarCollapsed=true)になる', () => {
      useUIStore.setState({ sidebarCollapsed: false, rightDrawerOpen: false });
      useUIStore.getState().setRightDrawerOpen(true);
      const state = useUIStore.getState();
      expect(state.rightDrawerOpen).toBe(true);
      expect(state.sidebarCollapsed).toBe(true);
    });

    it('C-3-9: 右が開のとき toggleSidebarCollapsed() で左を開くと右が閉じる', () => {
      useUIStore.setState({ sidebarCollapsed: true, rightDrawerOpen: true });
      useUIStore.getState().toggleSidebarCollapsed();
      const state = useUIStore.getState();
      expect(state.sidebarCollapsed).toBe(false);
      expect(state.rightDrawerOpen).toBe(false);
    });

    it('C-3-10: 左が開・右閉のとき toggleSidebarCollapsed() で左を閉じても右は閉のまま', () => {
      useUIStore.setState({ sidebarCollapsed: false, rightDrawerOpen: false });
      useUIStore.getState().toggleSidebarCollapsed();
      const state = useUIStore.getState();
      expect(state.sidebarCollapsed).toBe(true);
      expect(state.rightDrawerOpen).toBe(false);
    });
  });
});
