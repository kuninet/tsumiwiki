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

interface UserSettingsState {
  newDocPolicy: NewDocPolicy;
  fixedFolder: string;
  setNewDocPolicy: (policy: NewDocPolicy) => void;
  setFixedFolder: (folder: string) => void;
}

export const useUserSettingsStore = create<UserSettingsState>()(
  persist(
    (set) => ({
      newDocPolicy: 'same-folder',
      fixedFolder: '',
      setNewDocPolicy: (newDocPolicy) => set({ newDocPolicy }),
      setFixedFolder: (fixedFolder) => set({ fixedFolder }),
    }),
    { name: 'tsumiwiki-user-settings' },
  ),
);

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
