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
// 過去に iPhone 用の追加バッファ(AutoFill/Passkey/入力支援バーが visualViewport 外に
// 重ねて描画される問題への対策)を持っていたが、iOS 26 実機検証でバー出現が不安定
// (pinch/scroll/操作状況で出入りする)、固定バッファはバー無し時の空きが目立つと
// 判断され撤去。将来 iOS が visualViewport にバー分を含める、または VirtualKeyboard API
// が iOS Safari で使えるようになれば再導入検討(#175 FU 実機フィードバック)。

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
      // pinch zoom(vv.scale != 1)時は vv.height/offsetTop は visual viewport の
      // CSS px 表示なのでレイアウト viewport の px と単位が合わない。scale を掛けて
      // レイアウト viewport の座標系に揃えないと、ズーム量が「キーボード分」として
      // 誤検出される。offsetTop はレイアウト座標そのものなので掛けない。ピンチは
      // vv.width/height を変えるため resize イベントで拾える(個別購読不要)。
      // iOS Safari のバウンススクロール中は vv.offsetTop が一時的にマイナスになり、
      // その値のまま resize が固定される既知挙動があるため 0 でクランプする(負の値だと
      // keyboardOffset が過大に計算されツールバーが上へ吊り上がったまま残る)。
      // scale は仕様上正の実数だが、実装バグ / polyfill で 0 を返す事故に備えて 1 に fallback。
      // TODO: ピンチズーム中に下方向 pan した場合(offsetTop > 0)はキーボード分から
      // pan 量を差し引く方向に働くため、キーボード裏へツールバーが埋もれる可能性がある。
      // ピンチ + キーボード + 下パンの同時発生は頻度が低いため現状は割り切り(#175 FU)。
      const scale = vv.scale && vv.scale > 0 ? vv.scale : 1;
      const offsetTop = Math.max(0, vv.offsetTop);
      const offset = Math.max(0, window.innerHeight - (vv.height * scale + offsetTop));
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
  return {
    visible,
    bottomOffset: visible ? keyboardOffset : 0,
    isTouch,
    keyboardOffset,
  };
}
