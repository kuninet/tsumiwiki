// Phase A-2 タブ閉じ時の「保存 / 破棄」を DocView 外から呼び出すためのレジストリ。
// TabBar クリック → CloseConfirmDialog(MainPage 常駐) → 該当 path の save/discard 呼び出し
// という流れを直接的な props 伝搬なしに実現する。
//
// DocView は編集モード中に registerTabActions で自 path の save/cancel を登録し、
// unmount/edit終了で unregister する。呼び出し側は該当 path が登録済みでない可能性を
// 考慮して no-op にフォールバックする。

export interface TabActions {
  // 真に保存できたかを返す。true なら閉じてよい(呼び出し側)。
  // dirty=false のときの no-op も true(閉じてよい)扱いとする。
  save: () => Promise<boolean>;
  discard: () => Promise<void>;
}

const registry = new Map<string, TabActions>();

export function registerTabActions(path: string, actions: TabActions): () => void {
  registry.set(path, actions);
  return () => {
    // 登録時と同じ actions オブジェクトが今も入っているときだけ解除する
    // (稀に unmount 順序で別インスタンスが上書きしたあと解除するのを避ける)
    if (registry.get(path) === actions) registry.delete(path);
  };
}

export function getTabActions(path: string): TabActions | undefined {
  return registry.get(path);
}
