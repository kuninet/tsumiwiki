import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCreateDoc, useTree } from '../api/docs';
import { docUrl } from '../lib/doc-path';
import { pickUniqueUntitledTitle } from '../lib/untitled';
import { getActivePaneActiveIdFromState, useTabsStore } from '../stores/tabs';
import { resolveNewDocInitialFolder, useUserSettingsStore } from '../stores/user-settings';

// Phase C-1 (#137) + C-2 (#138) + #153: Ctrl+N(Mac: ⌘N)で新規文書を即座に作成する。
//
// #137 の初版は「モーダルを開く」だったが、#153 で「モーダル無しで '無題.md' を
// 自動採番して即作成し pinned タブで開く」に変更。理由: 頻繁に新規を作るユーザーの
// クリック数を減らす。タイトルは後からインラインリネーム(#152)で変えれば良い。
//
// 初期フォルダは userSettings.newDocPolicy に従う(#138):
// - same-folder: アクティブタブと同じフォルダ(既定)
// - fixed-folder: 設定した固定フォルダ
// - root: 常にルート
//
// preventDefault は多くのブラウザで無効(Chrome の Ctrl+N は新規ウィンドウ)。
// 「試すだけ試す」実装で、ブラウザ側のショートカットが優先されるのは受容する(#145)

function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPod|iPhone|iPad/.test(navigator.platform);
}

export function useNewDocShortcut() {
  const { data: tree } = useTree();
  const createDoc = useCreateDoc();
  const navigate = useNavigate();

  // 最新値を event handler 内で参照するために ref で保持(effect の再登録は最小化)
  const treeRef = useRef(tree);
  treeRef.current = tree;
  const createDocRef = useRef(createDoc);
  createDocRef.current = createDoc;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (e.isComposing) return;
      const modOk = isMac() ? e.metaKey : e.ctrlKey;
      if (!(modOk && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'n')) return;
      e.preventDefault();

      const tree = treeRef.current;
      if (!tree) return; // tree 未取得時は諦める(初回起動直後の稀なケース)
      // Opus M1: 連打時の 409 抑止。1 発目 mutation が終わるまで次を撃たない。
      // これで「短時間に同じ '無題' を 2 回作りに行って 409 で red toast が出る」を防ぐ
      if (createDocRef.current.isPending) return;

      const activePath = getActivePaneActiveIdFromState(useTabsStore.getState());
      const settings = useUserSettingsStore.getState();
      const folder = resolveNewDocInitialFolder(
        activePath,
        settings.newDocPolicy,
        settings.fixedFolder,
      );
      const existingTitles = tree.docs.filter((d) => d.folder === folder).map((d) => d.title);
      const title = pickUniqueUntitledTitle(existingTitles);

      createDocRef.current.mutate(
        { folder, title },
        {
          onSuccess: (data) => {
            useTabsStore.getState().openDoc(data.path, { pinned: true });
            navigateRef.current(docUrl(data.path));
          },
        },
      );
    }
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
}
