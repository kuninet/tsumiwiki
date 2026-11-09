import { useEffect, useLayoutEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTree } from '../api/docs';
import { docUrl } from '../lib/doc-path';
import { useTabsStore } from '../stores/tabs';

// URL(/doc/*)→ タブストアへの一方向同期。
// - URL に文書パスがあれば openDoc(存在すればアクティブ切替、無ければ preview 作成)
// - 逆方向(activeId → URL)は TabBar など「タブを切り替えた側」が明示的に navigate() する。
//   両方向 effect にすると初期マウント時に activeId(古い値)と URL(新しい値)が競合し
//   ループの原因になるため、一方向に保つ
//
// 初回描画時に「タブ0個 + urlPath あり」の空白フレームが出るのを避けるため useLayoutEffect を使う。
// paint 前に openDoc → 再描画されるので、ユーザーは空白を目にしない
//
// #321: .md なし URL (例: /doc/folder/doc) や大文字拡張子 (.MD) の正規化:
// - 小文字の .md で終わるパスはツリー取得を待たずに即時 openDoc して初期表示パフォーマンスを維持
// - それ以外 (.md なしや .MD) はツリー取得完了を待ち、tree.docs から対象を検索して正規 URL へ navigate(..., { replace: true })
// - ツリー待ちの間はツリー到着まで待機し、取得エラー時は openDoc(urlPath) にフォールバックして DocTab のエラー表示に委ねる

export function useTabsUrlSync(): string {
  const params = useParams();
  const urlPath = params['*'] ?? '';
  const navigate = useNavigate();
  const { data: tree, isError } = useTree();

  // 同期処理済みの urlPath を記録し、tree の refetch や他 state 更新による無駄な再実行・再オープンを防ぐ
  const lastSyncedUrlRef = useRef<string | null>(null);

  // 小文字の .md で終わるパスはツリーを待たずに即時 openDoc (paint 前にタブを開く)
  useLayoutEffect(() => {
    if (!urlPath) {
      lastSyncedUrlRef.current = null;
      return;
    }

    if (urlPath.endsWith('.md')) {
      if (lastSyncedUrlRef.current !== urlPath) {
        lastSyncedUrlRef.current = urlPath;
        useTabsStore.getState().openDoc(urlPath);
      }
    }
  }, [urlPath]);

  // .md なしパスまたは大文字拡張子: ツリー解決・正規 URL への navigate 置換
  // (React Router の規約に従い、navigate() は useEffect 内で呼び出す)
  useEffect(() => {
    if (!urlPath) return;

    // 既に .md で終わるパスは layoutEffect 側で同期済み
    if (urlPath.endsWith('.md')) return;

    // 同一 URL で既に同期処理済みならスキップ (tree refetch 等による再実行を防止)
    if (lastSyncedUrlRef.current === urlPath) {
      return;
    }

    // ツリー取得エラー時は URL のまま開いて DocTab のエラー表示に委ねる
    if (isError) {
      lastSyncedUrlRef.current = urlPath;
      useTabsStore.getState().openDoc(urlPath);
      return;
    }

    // ツリー取得完了を待つ
    if (!tree) return;

    // 優先度順に探索:
    // 1. 完全一致
    // 2. 大文字小文字フォールバック (urlPath そのもの、例: .MD -> .md)
    // 3. .md 補完
    // 4. 大文字小文字フォールバック (.md 補完)
    const targetDoc =
      tree.docs.find((d) => d.path === urlPath) ??
      tree.docs.find((d) => d.path.toLowerCase() === urlPath.toLowerCase()) ??
      tree.docs.find((d) => d.path === `${urlPath}.md`) ??
      tree.docs.find((d) => d.path.toLowerCase() === `${urlPath}.md`.toLowerCase());

    if (targetDoc) {
      const resolved = targetDoc.path;
      // navigate による再描画後に urlPath === resolved の .md 分岐で再実行されないよう resolved を記録
      lastSyncedUrlRef.current = resolved;
      navigate(docUrl(resolved), { replace: true });
      useTabsStore.getState().openDoc(resolved);
    } else {
      // 見つからなかった場合は URL を維持して openDoc し、DocTab のエラーハンドリングに委ねる
      lastSyncedUrlRef.current = urlPath;
      useTabsStore.getState().openDoc(urlPath);
    }
  }, [urlPath, tree, isError, navigate]);

  return urlPath;
}
