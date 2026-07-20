import { useLayoutEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useTabsStore } from '../stores/tabs';

// URL(/doc/*)→ タブストアへの一方向同期。
// - URL に文書パスがあれば openDoc(存在すればアクティブ切替、無ければ preview 作成)
// - 逆方向(activeId → URL)は TabBar など「タブを切り替えた側」が明示的に navigate() する。
//   両方向 effect にすると初期マウント時に activeId(古い値)と URL(新しい値)が競合し
//   ループの原因になるため、一方向に保つ
//
// 初回描画時に「タブ0個 + urlPath あり」の空白フレームが出るのを避けるため useLayoutEffect を使う。
// paint 前に openDoc → 再描画されるので、ユーザーは空白を目にしない

export function useTabsUrlSync(): string {
  const params = useParams();
  const urlPath = params['*'] ?? '';

  useLayoutEffect(() => {
    if (!urlPath) return;
    useTabsStore.getState().openDoc(urlPath);
  }, [urlPath]);

  return urlPath;
}
