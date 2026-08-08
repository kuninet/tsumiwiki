import { useEffect, useState } from 'react';

// タッチ端末で仮想キーボードが表示されているかを検知するフック(#175)。
//
// - デバイス判定: `(hover: none) and (pointer: coarse)`。iPadOS Safari は UA が Mac 扱いに
//   なるため、pointer/hover メディアクエリで iPhone/iPad/Android タッチ端末をまとめて拾う。
// - キーボード検知: `window.visualViewport` の縮小から算出する。iOS Safari は
//   `navigator.virtualKeyboard` (VirtualKeyboard API) 非対応のため visualViewport が唯一の
//   真実源。TipTap の focus/blur には依存しない — iOS/Android では focus 状態と
//   実キーボード表示が一致しない期間(候補確定中・blur アニメーション中・focus 復帰待ち等)
//   があり、focus をトリガにすると「blur した瞬間にツールバーが元位置へ戻り、
//   直後の tap が空振り」する原因になる。
// - 閾値: 150px。iOS Safari の URL バー折りたたみは 50〜85px 変動するため、この帯域を
//   誤検知しないマージンを取る。iPad Slide Over のミニキーボードでも 250〜300px 出るので
//   取りこぼしはない。外部キーボード接続時に下辺へ出るショートカットバー(~50px)も
//   ここで除外される。

const TOUCH_QUERY = '(hover: none) and (pointer: coarse)';
export const KEYBOARD_THRESHOLD_PX = 150;
// iPhone Safari 系(iPhone を含む WebKit/CriOS/FxiOS 等)では、変換候補行の上に
// AutoFill/Passkey/入力支援バー(約1行)が visualViewport の外側に重ねて描画され、
// ツールバーがその裏に隠れる。iPad(UA が Mac 扱いで isIPhone に該当しない)は影響なし。
// iPhone 判定時のみバッファを加算する(#175 FU)。実測 44〜52px の帯を想定して 52px。
// バーが出ないケース(iCloud キーチェーン無効化・AutoFill 無効)ではその分だけ
// ツールバーが浮く見た目になるが、隠れて操作不能になる方が実害が大きいため許容する。
export const IPHONE_EXTRA_BOTTOM_PX = 52;

// iPad は UA が Mac 扱いなので `iPhone` の有無だけを見れば iPhone を確実に狙える。
function isIPhone(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPhone/i.test(navigator.userAgent);
}

export interface VirtualKeyboardState {
  /** タッチのみの端末で仮想キーボードが表示中 (= ツールバーを浮かせるべき状態) */
  visible: boolean;
  /** floating 中にツールバーの底を持ち上げる px 数。非 floating 時は 0 */
  bottomOffset: number;
  /** タッチ端末かどうか (`(hover: none) and (pointer: coarse)`) */
  isTouch: boolean;
  /** 実際に visualViewport が縮小している px 数 (閾値未満は 0) */
  keyboardOffset: number;
}

export function useVirtualKeyboard(): VirtualKeyboardState {
  const [isTouch, setIsTouch] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia(TOUCH_QUERY).matches;
  });
  const [keyboardOffset, setKeyboardOffset] = useState(0);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia(TOUCH_QUERY);
    const handler = (e: MediaQueryListEvent) => setIsTouch(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

  useEffect(() => {
    if (!isTouch) {
      setKeyboardOffset(0);
      return;
    }
    if (typeof window === 'undefined' || !window.visualViewport) return;
    const vv = window.visualViewport;
    const update = () => {
      const offset = window.innerHeight - (vv.height + vv.offsetTop);
      setKeyboardOffset(offset > KEYBOARD_THRESHOLD_PX ? offset : 0);
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, [isTouch]);

  const visible = isTouch && keyboardOffset > 0;
  const extra = visible && isIPhone() ? IPHONE_EXTRA_BOTTOM_PX : 0;
  return {
    visible,
    bottomOffset: visible ? keyboardOffset + extra : 0,
    isTouch,
    keyboardOffset,
  };
}
