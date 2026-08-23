import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// #138 Phase C-2: 新規文書の作成先ポリシー(ユーザー個人設定)。
// - same-folder: 現在のアクティブタブの文書と同じフォルダ(既定)
// - fixed-folder: 設定した固定フォルダ(fixedFolder に格納)
// - root: 常にルート
//
// zustand/persist で localStorage に保存する(サーバ側にはない設定)。
// 将来サーバサイドの user settings に移す場合は persist の代わりに
// react-query のクエリ + mutation に差し替えれば良い

export type NewDocPolicy = 'same-folder' | 'fixed-folder' | 'root';

// #212: 編集/閲覧の本文最大幅。モバイル(<768px)では常に 100%(ここでは
// ラッパの max-width のみを制御し、モバイル分岐は CSS の viewport 相対値で吸収)
export type ContentWidth = 'normal' | 'wide' | 'full';

interface UserSettingsState {
  newDocPolicy: NewDocPolicy;
  fixedFolder: string;
  contentWidth: ContentWidth;
  setNewDocPolicy: (policy: NewDocPolicy) => void;
  setFixedFolder: (folder: string) => void;
  setContentWidth: (width: ContentWidth) => void;
}

export const useUserSettingsStore = create<UserSettingsState>()(
  persist(
    (set) => ({
      newDocPolicy: 'same-folder',
      fixedFolder: '',
      contentWidth: 'normal',
      setNewDocPolicy: (newDocPolicy) => set({ newDocPolicy }),
      setFixedFolder: (fixedFolder) => set({ fixedFolder }),
      setContentWidth: (contentWidth) => set({ contentWidth }),
    }),
    { name: 'tsumiwiki-user-settings' },
  ),
);

// DocView の本文ラッパに適用する Tailwind max-width クラス。
// - normal: 760px(既定)/ wide: 1040px を上限とし、viewport 幅より広くはしない
// - full: 制約なし(親コンテナ幅まで広がる)
// いずれもモバイル幅では上限が viewport 幅で抑えられ、既存挙動を維持する。
//
// 実装メモ: Tailwind v4 の source scanner が拾えるよう、各 case は動的組み立て
// (テンプレートリテラル連結)を避け完全な文字列リテラルを返す。既存の
// `--spacing-content: 760px` トークン(index.css)や `max-w-[760px]`
// (SettingsPage 見出しラッパ)と数値が重複するが、選択肢ごとに任意 arbitrary value
// を並べるためあえてリテラルで持たせている。トークン統合は別 issue で扱う
export function contentWidthMaxClass(width: ContentWidth): string {
  switch (width) {
    case 'wide':
      return 'max-w-[min(1040px,100%)]';
    case 'full':
      return 'max-w-full';
    case 'normal':
    default:
      return 'max-w-[min(760px,100%)]';
  }
}

/** ポリシーに従って新規文書作成の初期フォルダを解決する。
 *  - same-folder: activeDocPath があればそのフォルダ、無ければ ''
 *  - fixed-folder: fixedFolder(空なら '' でルートにフォールバック)
 *  - root: 常に ''
 *
 *  存在しないフォルダを指定していても、ここではその判定はしない
 *  (作成時に FolderTree/サーバ側でハンドリング)。
 *  副作用のあるデフォルト引数(store.getState)は静的解析の落とし穴になるので、
 *  policy/fixedFolder は呼び出し側から明示的に渡す(Opus C レビュー M2) */
export function resolveNewDocInitialFolder(
  activeDocPath: string | null,
  policy: NewDocPolicy,
  fixedFolder: string,
): string {
  switch (policy) {
    case 'same-folder': {
      if (!activeDocPath) return '';
      const idx = activeDocPath.lastIndexOf('/');
      return idx === -1 ? '' : activeDocPath.slice(0, idx);
    }
    case 'fixed-folder':
      return fixedFolder;
    case 'root':
    default:
      return '';
  }
}
