import { describe, expect, it } from 'vitest';
import {
  computeRightPanelWidth,
  resolveSideConflict,
  rightPanelMaxWidth,
} from './right-panel-layout';

describe('right-panel-layout (C-2)', () => {
  it('C-2-1: stored=320, innerWidth=1440, 左 260 で 320 を返す', () => {
    expect(computeRightPanelWidth(320, { innerWidth: 1440, leftWidth: 260 })).toBe(320);
  });

  it('C-2-2: stored=600, innerWidth=1920, 左 260 で上限 560 にクランプされる', () => {
    expect(computeRightPanelWidth(600, { innerWidth: 1920, leftWidth: 260 })).toBe(560);
  });

  it('C-2-3: stored=320, innerWidth=1024, 左 260 で max=332 のとき 320 を返す', () => {
    const max = rightPanelMaxWidth({ innerWidth: 1024, leftWidth: 260 });
    expect(max).toBe(332);
    expect(computeRightPanelWidth(320, { innerWidth: 1024, leftWidth: 260 })).toBe(320);
  });

  it('C-2-4: stored=500, innerWidth=1024, 左 260 で描画上限 332 にクランプされる', () => {
    expect(computeRightPanelWidth(500, { innerWidth: 1024, leftWidth: 260 })).toBe(332);
  });

  it('C-2-5: innerWidth=900, 左 260, 左が開・右を開こうとすると "close-left" を返す', () => {
    expect(
      resolveSideConflict({
        innerWidth: 900,
        sidebarWidth: 260,
        leftOpen: true,
        rightOpen: false,
        justOpened: 'right',
      }),
    ).toBe('close-left');
  });

  it('C-2-6: innerWidth=900, 左 260, 右が開・左を開こうとすると "close-right" を返す', () => {
    expect(
      resolveSideConflict({
        innerWidth: 900,
        sidebarWidth: 260,
        leftOpen: false,
        rightOpen: true,
        justOpened: 'left',
      }),
    ).toBe('close-right');
  });

  it('C-2-7: innerWidth=1280, 左 260 で十分な幅がある場合は null を返す', () => {
    expect(
      resolveSideConflict({
        innerWidth: 1280,
        sidebarWidth: 260,
        leftOpen: true,
        rightOpen: false,
        justOpened: 'right',
      }),
    ).toBeNull();
  });

  it('C-2-8: 左右とも開で innerWidth が 1280→900 に縮小した場合は "close-left" を返す', () => {
    expect(
      resolveSideConflict({
        innerWidth: 900,
        sidebarWidth: 260,
        leftOpen: true,
        rightOpen: true,
        justOpened: 'resize',
      }),
    ).toBe('close-left');
  });

  it('C-2-9: 左が閉で innerWidth=768 の場合は null を返す', () => {
    expect(
      resolveSideConflict({
        innerWidth: 768,
        sidebarWidth: 260,
        leftOpen: false,
        rightOpen: false,
        justOpened: 'right',
      }),
    ).toBeNull();
  });
});
