import { describe, expect, it } from 'vitest';
import { useUIStore } from './ui';

describe('uiストア', () => {
  it('サイドバー幅が200〜480pxにクランプされる', () => {
    const { setSidebarWidth } = useUIStore.getState();
    setSidebarWidth(100);
    expect(useUIStore.getState().sidebarWidth).toBe(200);
    setSidebarWidth(900);
    expect(useUIStore.getState().sidebarWidth).toBe(480);
    setSidebarWidth(300);
    expect(useUIStore.getState().sidebarWidth).toBe(300);
  });
});
