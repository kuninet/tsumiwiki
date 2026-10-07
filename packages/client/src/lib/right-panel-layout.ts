// #271: 右パネルの幅計算とデスクトップ左右排他レイアウト判定

export const RIGHT_PANEL_MIN_WIDTH = 240;
export const RIGHT_PANEL_MAX_WIDTH = 560;
export const RIGHT_PANEL_DEFAULT_WIDTH = 320;
export const MAIN_MIN_WIDTH = 400;
export const COLLAPSE_BUTTON_WIDTH = 16;

export interface RightPanelLayoutContext {
  innerWidth: number;
  leftWidth: number;
}

/**
 * 右パネルが取りうる最大幅を計算する。
 * innerWidth − leftWidth − 16×2(左右折りたたみボタン) − 400(本文最小幅)
 * leftWidth は左サイドバーが閉じている場合は 0 を渡す。
 */
export function rightPanelMaxWidth({ innerWidth, leftWidth }: RightPanelLayoutContext): number {
  return innerWidth - leftWidth - COLLAPSE_BUTTON_WIDTH * 2 - MAIN_MIN_WIDTH;
}

/**
 * 描画時の右パネル幅を計算する(D6)。
 * 永続化された幅(stored)を 240〜min(560, max) の範囲に clamp する。
 * 永続値そのものは変更しない。
 */
export function computeRightPanelWidth(
  stored: number,
  ctx: RightPanelLayoutContext,
): number {
  const max = rightPanelMaxWidth(ctx);
  const upper = Math.min(RIGHT_PANEL_MAX_WIDTH, max);
  if (upper < RIGHT_PANEL_MIN_WIDTH) {
    return RIGHT_PANEL_MIN_WIDTH;
  }
  return Math.min(Math.max(RIGHT_PANEL_MIN_WIDTH, stored), upper);
}

export interface ResolveSideConflictParams {
  innerWidth: number;
  sidebarWidth: number;
  leftOpen: boolean;
  rightOpen: boolean;
  justOpened: 'left' | 'right' | 'resize';
}

/**
 * 本文 400px を確保できない場合の左右排他フォールバック判定(D7)。
 * 左右両方が開いている(または開こうとしている)ときに
 * innerWidth − sidebarWidth − 16×2 − 400 < 240 であれば衝突と判定する。
 */
export function resolveSideConflict({
  innerWidth,
  sidebarWidth,
  leftOpen,
  rightOpen,
  justOpened,
}: ResolveSideConflictParams): 'close-left' | 'close-right' | null {
  const willBeLeftOpen = justOpened === 'left' ? true : leftOpen;
  const willBeRightOpen = justOpened === 'right' ? true : rightOpen;

  // 両方が開く状態でなければ衝突は起きない
  if (!willBeLeftOpen || !willBeRightOpen) {
    return null;
  }

  const maxRight = rightPanelMaxWidth({ innerWidth, leftWidth: sidebarWidth });
  if (maxRight >= RIGHT_PANEL_MIN_WIDTH) {
    return null;
  }

  if (justOpened === 'right') {
    return 'close-left';
  }
  if (justOpened === 'left') {
    return 'close-right';
  }
  // 'resize' の場合は左サイドバーを折りたたむ
  return 'close-left';
}
