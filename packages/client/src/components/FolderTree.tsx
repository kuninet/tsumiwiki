import { useQueryClient } from '@tanstack/react-query';
import type React from 'react';
import { type KeyboardEvent, type MouseEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  createFolder as createFolderApi,
  docQueryKey,
  moveDoc as moveDocApi,
  moveFolder as moveFolderApi,
  TAGS_QUERY_KEY,
  TREE_QUERY_KEY,
  useCreateDoc,
  useCreateFolder,
  useDeleteDoc,
  useDeleteFolder,
  useMoveDoc,
  useMoveFolder,
  useTree,
} from '../api/docs';
import { ApiRequestError } from '../api/client';
import { buildTree, parentOf, type TreeNode } from '../lib/build-tree';
import { docUrl } from '../lib/doc-path';
import { confirmNavigationIfDirty } from '../lib/navigation-guard';
import { useTabsStore } from '../stores/tabs';
import { useToastStore } from '../stores/toast';
import { useUIStore } from '../stores/ui';
import { ConfirmDialog } from './ConfirmDialog';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { PromptDialog } from './PromptDialog';


// フォルダツリー(設計04章4.2・デザインhandoff components.md)。ルート・フォルダ・文書の
// 右クリックメニューから新規作成・リネーム・削除を行う。キーボード操作にも対応する

type MenuTarget =
  | { type: 'root' }
  | { type: 'folder'; path: string; name: string }
  | { type: 'doc'; path: string; folder: string; title: string };

type DialogState =
  | { kind: 'createDoc'; folder: string }
  | { kind: 'createFolder'; parent: string }
  | { kind: 'renameDoc'; path: string; folder: string; title: string }
  | { kind: 'renameFolder'; path: string; name: string }
  // #73: 選択したものを新規サブフォルダにまとめる。commonParent は移動先フォルダの親
  // (選択物の共通親フォルダ)、selection は移動対象のパス集合
  | { kind: 'groupIntoNewFolder'; commonParent: string; selection: string[] }
  | null;

type ConfirmState =
  | { kind: 'deleteDoc'; path: string; title: string }
  | { kind: 'deleteFolder'; path: string; name: string }
  | null;

interface FlatEntry {
  node: TreeNode;
  depth: number;
  parentPath: string | null;
}

function flattenVisible(
  nodes: TreeNode[],
  expandedFolders: Set<string>,
  depth = 0,
  parentPath: string | null = null,
): FlatEntry[] {
  const result: FlatEntry[] = [];
  for (const node of nodes) {
    result.push({ node, depth, parentPath });
    if (node.type === 'folder' && expandedFolders.has(node.path)) {
      result.push(...flattenVisible(node.children, expandedFolders, depth + 1, node.path));
    }
  }
  return result;
}

export function FolderTree() {
  const { data: tree } = useTree();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const showToast = useToastStore((s) => s.show);
  const params = useParams();
  const currentPath = params['*'];
  // stale closure 対策: mutation.onSuccess は非同期完了時に発火するため、
  // 発火時点の最新 currentPath を ref 経由で参照する
  const currentPathRef = useRef<string | undefined>(currentPath);
  useEffect(() => {
    currentPathRef.current = currentPath;
  }, [currentPath]);

  const expandedFolders = useUIStore((s) => s.expandedFolders);
  const toggleFolderExpanded = useUIStore((s) => s.toggleFolderExpanded);
  const createDocRequest = useUIStore((s) => s.createDocRequest);

  // AppShell の「+ 新規文書」/ Ctrl+N ショートカット / その他外部要求(#137)を拾って
  // 新規文書ダイアログを開く。初期フォルダは request payload に載って来る。
  // 「処理済みの nonce」を ref で持ち、FolderTree 再マウント時に前回の要求で
  // 誤ってダイアログが開かないようガードする(Opus C レビュー M1)
  const lastHandledNonceRef = useRef(createDocRequest.nonce);
  useEffect(() => {
    if (createDocRequest.nonce === lastHandledNonceRef.current) return;
    lastHandledNonceRef.current = createDocRequest.nonce;
    if (createDocRequest.nonce > 0) {
      setDialog({ kind: 'createDoc', folder: createDocRequest.folder });
    }
  }, [createDocRequest]);

  const createDoc = useCreateDoc();
  const createFolder = useCreateFolder();
  const moveDoc = useMoveDoc();
  const moveFolder = useMoveFolder();
  const deleteDoc = useDeleteDoc();
  const deleteFolder = useDeleteFolder();

  const [menu, setMenu] = useState<{ x: number; y: number; target: MenuTarget } | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [confirm, setConfirm] = useState<ConfirmState>(null);
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  // D&D 移動用の状態(#71)。draggedItem はドラッグ元・dragOverPath はハイライト対象。
  // dragOverPath は '' = ルート、'foo/bar' = 特定フォルダ、null = ハイライトなし
  const [draggedItem, setDraggedItem] = useState<
    { path: string; kind: 'doc' | 'folder'; title?: string } | null
  >(null);
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);
  // 複数選択と一括移動(#72)。selectedPaths は選択された行のパス集合、
  // lastClickedPath は Shift+クリックの起点として使う
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [lastClickedPath, setLastClickedPath] = useState<string | null>(null);
  // #152: インラインリネーム対象パス。null なら通常表示、非 null なら該当行を input に置換
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  // Opus #152 レビュー M1: rename 終了後にツリー行にフォーカスを戻すため、
  // 「直前の renamingPath / 復帰先候補 path(commit 成功で移動後の新 path)」を追跡する
  const prevRenamingRef = useRef<string | null>(null);
  const focusAfterRenameRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevRenamingRef.current;
    prevRenamingRef.current = renamingPath;
    if (prev && !renamingPath) {
      // rename 終了。tree が非同期に更新されるまで path が変わっている可能性あり。
      // 新 path(focusAfterRenameRef)→ 旧 path の順で 2 tick 試して、最初に見つかった
      // 行に focus を戻す。どちらも取れなければあきらめる(実害なしで矢印キーで戻せる)
      const newPath = focusAfterRenameRef.current;
      focusAfterRenameRef.current = null;
      const tryFocus = () => {
        const target = (newPath && rowRefs.current.get(newPath)) || rowRefs.current.get(prev);
        if (target) target.focus();
      };
      requestAnimationFrame(tryFocus);
      // 2 tick 目にも試す(tree refetch 完了後に新 path 行が出現する場合)
      setTimeout(tryFocus, 60);
    }
  }, [renamingPath]);
  // #82 fix-forward: 新規フォルダにまとめる操作の in-flight ロック(二重発火防止)
  const isGroupingRef = useRef(false);

  const rowRefs = useRef(new Map<string, HTMLButtonElement>());

  const nodes = tree ? buildTree(tree) : [];
  const flat = useMemo(() => flattenVisible(nodes, expandedFolders), [nodes, expandedFolders]);

  function registerRow(path: string, el: HTMLButtonElement | null) {
    if (el) rowRefs.current.set(path, el);
    else rowRefs.current.delete(path);
  }

  function focusEntry(path: string) {
    setFocusedPath(path);
    rowRefs.current.get(path)?.focus();
  }

  function openMenu(e: MouseEvent, target: MenuTarget) {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, target });
  }

  function menuItemsFor(target: MenuTarget): ContextMenuItem[] {
    // #73: 右クリック対象が選択中で 2件以上選ばれていれば「まとめる」を先頭に出す
    const groupItem: ContextMenuItem | null =
      target.type !== 'root' &&
      selectedPaths.has(target.path) &&
      selectedPaths.size > 1
        ? {
            label: `選択したものを新規フォルダに移動(${selectedPaths.size}件)`,
            onSelect: () =>
              setDialog({
                kind: 'groupIntoNewFolder',
                commonParent: commonParent([...selectedPaths]),
                selection: [...selectedPaths],
              }),
          }
        : null;

    if (target.type === 'root') {
      return [
        { label: '新規文書', onSelect: () => setDialog({ kind: 'createDoc', folder: '' }) },
        { label: '新規フォルダ', onSelect: () => setDialog({ kind: 'createFolder', parent: '' }) },
      ];
    }
    if (target.type === 'folder') {
      const items: ContextMenuItem[] = [
        {
          label: '新規文書',
          onSelect: () => setDialog({ kind: 'createDoc', folder: target.path }),
        },
        {
          label: '新規フォルダ',
          onSelect: () => setDialog({ kind: 'createFolder', parent: target.path }),
        },
        {
          // #152: モーダルではなく inline 編集を発火
          label: 'リネーム',
          onSelect: () => startInlineRename(target.path),
        },
        {
          label: '削除',
          danger: true,
          onSelect: () => setConfirm({ kind: 'deleteFolder', path: target.path, name: target.name }),
        },
      ];
      return groupItem ? [groupItem, ...items] : items;
    }
    const items: ContextMenuItem[] = [
      {
        // #152: モーダルではなく inline 編集を発火
        label: 'リネーム',
        onSelect: () => startInlineRename(target.path),
      },
      {
        label: '削除',
        danger: true,
        onSelect: () => setConfirm({ kind: 'deleteDoc', path: target.path, title: target.title }),
      },
    ];
    return groupItem ? [groupItem, ...items] : items;
  }

  // 文書リネームの実処理(dialog 経路 / inline 経路 の両方から使う)。
  // 現在文書と一致 + dirty なら離脱確認、成功時は URL 追従
  function performRenameDoc(oldPath: string, folder: string, newTitle: string) {
    if (currentPath === oldPath && !confirmNavigationIfDirty()) return;
    moveDoc.mutate(
      { path: oldPath, newFolder: folder, newTitle },
      {
        onSuccess: (data) => {
          if (currentPathRef.current === oldPath && oldPath !== data.path) {
            queryClient.removeQueries({ queryKey: docQueryKey(oldPath) });
            navigate(docUrl(data.path), { replace: true });
          }
        },
      },
    );
  }

  // フォルダリネームの実処理(dialog 経路 / inline 経路 の両方から使う)
  function performRenameFolder(oldFolder: string, newName: string) {
    const parent = parentOf(oldFolder);
    const newPath = parent ? `${parent}/${newName}` : newName;
    if (
      currentPath &&
      (currentPath === oldFolder || currentPath.startsWith(`${oldFolder}/`)) &&
      !confirmNavigationIfDirty()
    ) {
      return;
    }
    moveFolder.mutate(
      { path: oldFolder, newPath },
      {
        onSuccess: (data) => {
          const nowPath = currentPathRef.current;
          if (nowPath && (nowPath === oldFolder || nowPath.startsWith(`${oldFolder}/`))) {
            const rewritten = data.path + nowPath.slice(oldFolder.length);
            queryClient.removeQueries({
              predicate: (q) => {
                const key = q.queryKey;
                if (!Array.isArray(key) || key[0] !== 'doc') return false;
                const p = key[1];
                return typeof p === 'string' && (p === oldFolder || p.startsWith(`${oldFolder}/`));
              },
            });
            navigate(docUrl(rewritten), { replace: true });
          }
        },
      },
    );
  }

  // #152: インラインリネーム開始・確定・キャンセル
  function startInlineRename(path: string) {
    setRenamingPath(path);
  }
  function cancelInlineRename() {
    setRenamingPath(null);
  }
  function commitInlineRename(node: TreeNode, newValue: string) {
    setRenamingPath(null);
    const trimmed = newValue.trim();
    if (!trimmed) return; // 空はキャンセル扱い(focus は元 path に戻る)
    if (node.type === 'doc') {
      if (trimmed === node.title) return; // 変更なし → focus は元 path
      // rename 後の新 path(親フォルダ + 新タイトル + .md)を focus 復帰先候補にする。
      // サーバの sanitizeTitle で変わる可能性があるが、その場合は new path が存在せず
      // rowRefs から取れないので何もフォーカスしない(実害は限定的)
      const folder = parentOf(node.path);
      const newPath = folder ? `${folder}/${trimmed}.md` : `${trimmed}.md`;
      focusAfterRenameRef.current = newPath;
      performRenameDoc(node.path, folder, trimmed);
    } else {
      if (trimmed === node.name) return;
      const folder = parentOf(node.path);
      const newPath = folder ? `${folder}/${trimmed}` : trimmed;
      focusAfterRenameRef.current = newPath;
      performRenameFolder(node.path, trimmed);
    }
  }

  function handleDialogConfirm(value: string) {
    if (!dialog) return;
    if (dialog.kind === 'createDoc') {
      createDoc.mutate(
        { folder: dialog.folder, title: value },
        {
          onSuccess: (data) => {
            // 作成した文書は「意図的な作成」なので pinned で開く(preview で流されない)
            useTabsStore.getState().openDoc(data.path, { pinned: true });
            navigate(docUrl(data.path));
          },
        },
      );
    } else if (dialog.kind === 'createFolder') {
      const path = dialog.parent ? `${dialog.parent}/${value}` : value;
      createFolder.mutate({ path });
    } else if (dialog.kind === 'renameDoc') {
      performRenameDoc(dialog.path, dialog.folder, value);
    } else if (dialog.kind === 'renameFolder') {
      performRenameFolder(dialog.path, value);
    } else if (dialog.kind === 'groupIntoNewFolder') {
      // #73 選択物を新規サブフォルダにまとめる。
      // 新規フォルダを共通親配下に作り、その配下へ選択物を一括移動する
      const { commonParent: parent, selection } = dialog;
      // #82 fix-forward: 入力値を trim + `/`/`\`/制御文字拒否
      const trimmed = value.trim();
      if (!trimmed || /[\\/ -]/.test(trimmed)) {
        showToast('error', 'フォルダ名に / や制御文字は使えません');
        return; // ダイアログは閉じず再入力できる
      }
      const newFolderPath = parent ? `${parent}/${trimmed}` : trimmed;
      // #82 fix-forward: 非同期IIFEの投げっぱなしで二重発火する問題への対処
      // ダイアログを閉じる前に処理を開始し、submitting 中は再クリックしても無視
      if (isGroupingRef.current) return;
      isGroupingRef.current = true;
      setDialog(null);
      void (async () => {
        try {
          await createFolderApi({ path: newFolderPath });
        } catch (err) {
          showToast(
            'error',
            err instanceof ApiRequestError ? err.message : 'フォルダを作成できませんでした',
          );
          queryClient.invalidateQueries({ queryKey: TREE_QUERY_KEY });
          return;
        } finally {
          isGroupingRef.current = false;
        }
        const nodes = filterMovable(selection, newFolderPath);
        if (nodes.length === 0) {
          queryClient.invalidateQueries({ queryKey: TREE_QUERY_KEY });
          showToast('info', '新規フォルダを作成しましたが、移動対象がありませんでした');
          return;
        }
        await performBatchMove(nodes, newFolderPath);
        setSelectedPaths(new Set());
      })();
      return; // setDialog は上で呼んだのでここでは呼ばない
    }
    setDialog(null);
  }

  function handleConfirmDelete() {
    if (!confirm) return;
    if (confirm.kind === 'deleteDoc') {
      const deletedPath = confirm.path;
      deleteDoc.mutate(deletedPath, {
        onSuccess: () => {
          // 表示中の文書を削除した場合は追従して閲覧不能な画面に留まらないようにする
          if (currentPath === deletedPath) {
            queryClient.removeQueries({ queryKey: docQueryKey(deletedPath) });
            navigate('/');
          }
        },
      });
    } else {
      deleteFolder.mutate(confirm.path);
    }
    setConfirm(null);
  }

  function handleNavigateToDoc(path: string) {
    // タブ化(#133 Phase A-1)以降、別文書を開いても現在のタブ(dirty 含む)は
    // マウント保存されるので離脱確認は不要。draft はサーバー側で自動保存される。
    // Opus #152 レビュー M2: 同 URL への navigate は history が無駄に積まれ
    // 「戻る」で 2 回押しが必要になる(ダブルクリックで顕在化)。同じ path なら skip
    if (currentPathRef.current === path) return;
    navigate(docUrl(path));
  }

  // D&D: 現在ドラッグ中のアイテムを targetFolderPath("" = ルート)へ落とせるか
  function canDropOn(targetFolderPath: string): boolean {
    if (!draggedItem) return false;
    const currentParent = parentOf(draggedItem.path);
    // 同じ親フォルダへの移動は無意味
    if (currentParent === targetFolderPath) return false;
    // フォルダを自分自身または自分の子孫へ落とすことはできない
    if (draggedItem.kind === 'folder') {
      if (targetFolderPath === draggedItem.path) return false;
      if (targetFolderPath.startsWith(`${draggedItem.path}/`)) return false;
    }
    return true;
  }

  function handleDragStartItem(
    path: string,
    kind: 'doc' | 'folder',
    title: string | undefined,
  ) {
    setDraggedItem({ path, kind, title });
  }

  function handleDragEndItem() {
    setDraggedItem(null);
    setDragOverPath(null);
  }

  function handleDragEnterTarget(targetFolderPath: string) {
    if (canDropOn(targetFolderPath)) setDragOverPath(targetFolderPath);
  }

  // #73 選択物の共通親フォルダを求める(全てルートなら空文字)
  function commonParent(paths: string[]): string {
    if (paths.length === 0) return '';
    const parents = paths.map((p) => parentOf(p) ?? '');
    if (parents.length === 1) return parents[0];
    const firstParts = parents[0].split('/').filter(Boolean);
    let common = firstParts;
    for (const p of parents.slice(1)) {
      const parts = p.split('/').filter(Boolean);
      let i = 0;
      while (i < common.length && i < parts.length && common[i] === parts[i]) i++;
      common = common.slice(0, i);
    }
    return common.join('/');
  }

  // ツリー全体の Map<path, TreeNode> を組む。折りたたみ状態(可視な flat)には依存しない。
  // #76 fix-forward: 折りたたみで選択が可視から外れると batch から無音で脱落する問題への対処
  const treeByPath = useMemo(() => {
    const m = new Map<string, TreeNode>();
    function walk(list: TreeNode[]) {
      for (const n of list) {
        m.set(n.path, n);
        if (n.type === 'folder') walk(n.children);
      }
    }
    walk(nodes);
    return m;
  }, [nodes]);

  // ドロップ先が targetFolderPath のとき、対象パス群のうち移動しても意味のある/矛盾しないものだけを返す
  function filterMovable(paths: string[], targetFolderPath: string): TreeNode[] {
    // #76 fix-forward: 選択集合内の祖先フォルダの子孫は除外する。
    // 祖先が一緒に移動すれば子孫も自動的に付いてくるため、個別に移動を試みると
    // 404 や順序依存の部分失敗が発生する
    const selectedSet = new Set(paths);
    const isDescendantOfSelected = (path: string): boolean => {
      for (const sel of selectedSet) {
        if (sel !== path && path.startsWith(`${sel}/`)) {
          const ancestor = treeByPath.get(sel);
          if (ancestor?.type === 'folder') return true;
        }
      }
      return false;
    };
    return paths
      .map((p) => treeByPath.get(p))
      .filter((n): n is TreeNode => !!n)
      .filter((node) => !isDescendantOfSelected(node.path))
      .filter((node) => {
        if (parentOf(node.path) === targetFolderPath) return false;
        if (node.type === 'folder') {
          if (targetFolderPath === node.path) return false;
          if (targetFolderPath.startsWith(`${node.path}/`)) return false;
        }
        return true;
      });
  }

  // 選択された複数アイテムを targetFolderPath へ移動する(#72)。
  // useMoveDoc/useMoveFolder は個別トーストを出すため、生API + 一括サマリートーストで対応する
  // #163: 1件移動が成功するたびに TREE を invalidate してツリーを追従更新し、URL 追従も
  // 該当ファイルが動いた時点で前倒しする(進捗が視覚的に分かる)
  async function performBatchMove(nodes: TreeNode[], targetFolderPath: string) {
    let succeeded = 0;
    let failed = 0;
    let lastError: string | null = null;
    for (const node of nodes) {
      try {
        let oldPath: string;
        let newPath: string;
        let kind: 'doc' | 'folder';
        if (node.type === 'doc') {
          const data = await moveDocApi({
            path: node.path,
            newFolder: targetFolderPath,
            newTitle: node.title,
          });
          oldPath = node.path;
          newPath = data.path;
          kind = 'doc';
        } else {
          const folderName = node.path.split('/').pop()!;
          const rawNew = targetFolderPath ? `${targetFolderPath}/${folderName}` : folderName;
          const data = await moveFolderApi({ path: node.path, newPath: rawNew });
          oldPath = node.path;
          newPath = data.path;
          kind = 'folder';
        }
        succeeded++;

        // #97: 表示中文書が今動いたファイル(またはその配下)なら、この時点で URL を追従する。
        // filterMovable が同一選択集合内の子孫を除外しているため、iteration k で nowPath を
        // 新パスに書き換えた後の iteration k+1 で「更新前の古い nowPath」と偶然マッチする
        // ケースは発生しない(祖先が既に動いた後の子孫は選択から除外されている)
        const nowPath = currentPathRef.current;
        const hit =
          !!nowPath &&
          (nowPath === oldPath || (kind === 'folder' && nowPath.startsWith(`${oldPath}/`)));
        if (nowPath && hit) {
          const rewritten = newPath + nowPath.slice(oldPath.length);
          queryClient.removeQueries({
            predicate: (q) => {
              const key = q.queryKey;
              if (!Array.isArray(key) || key[0] !== 'doc') return false;
              const p = key[1];
              return typeof p === 'string' && (p === oldPath || p.startsWith(`${oldPath}/`));
            },
          });
          navigate(docUrl(rewritten), { replace: true });
        }

        // 1件成功ごとにツリーを refetch(await して次の移動より先にツリー反映を待つ)
        await queryClient.invalidateQueries({ queryKey: TREE_QUERY_KEY });
      } catch (err) {
        failed++;
        if (err instanceof ApiRequestError) lastError = err.message;
      }
    }
    // 全件失敗時はループ内 invalidate が一度も走らないため、フォールバックとして
    // 末尾でもう1回 TREE を invalidate する(冪等)。並行編集で古い状態を残さないため
    if (succeeded === 0) {
      queryClient.invalidateQueries({ queryKey: TREE_QUERY_KEY });
    }
    // タグはコンテンツ由来で folder 移動では変化しないため、末尾で1回だけ invalidate すれば足りる
    queryClient.invalidateQueries({ queryKey: TAGS_QUERY_KEY });
    if (failed === 0) {
      showToast('success', succeeded === 1 ? '移動しました' : `${succeeded}件を移動しました`);
    } else if (succeeded === 0) {
      showToast('error', lastError ?? '移動に失敗しました');
    } else {
      showToast(
        'warning',
        `${succeeded}件を移動しました。${failed}件が失敗しました${lastError ? `: ${lastError}` : ''}`,
      );
    }
  }

  function handleDropTarget(targetFolderPath: string) {
    const item = draggedItem;
    setDraggedItem(null);
    setDragOverPath(null);
    if (!item) return;
    if (!canDropOn(targetFolderPath)) return;

    // ドラッグ元が選択中に含まれていて 2件以上あるときは、選択全体を一括移動する。
    // それ以外(単独ドラッグ or 選択外のものをドラッグ)は従来通り単体移動
    const isBatch = selectedPaths.has(item.path) && selectedPaths.size > 1;
    if (isBatch) {
      const nodes = filterMovable([...selectedPaths], targetFolderPath);
      if (nodes.length === 0) return;
      void performBatchMove(nodes, targetFolderPath).then(() => setSelectedPaths(new Set()));
      return;
    }

    if (item.kind === 'doc') {
      const title = item.title ?? item.path.split('/').pop()!.replace(/\.md$/i, '');
      moveDoc.mutate({ path: item.path, newFolder: targetFolderPath, newTitle: title });
    } else {
      const folderName = item.path.split('/').pop()!;
      const newPath = targetFolderPath ? `${targetFolderPath}/${folderName}` : folderName;
      moveFolder.mutate({ path: item.path, newPath });
    }
  }

  // 行クリック処理(#72)。修飾キーの有無で単一選択 / 追加解除 / 範囲選択を切替
  function handleRowClick(
    e: React.MouseEvent<HTMLButtonElement>,
    node: TreeNode,
  ) {
    const isModifier = e.metaKey || e.ctrlKey;
    const isShift = e.shiftKey;

    if (isShift && lastClickedPath) {
      e.preventDefault();
      const startIdx = flat.findIndex((f) => f.node.path === lastClickedPath);
      const endIdx = flat.findIndex((f) => f.node.path === node.path);
      if (startIdx !== -1 && endIdx !== -1) {
        const [lo, hi] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
        setSelectedPaths(new Set(flat.slice(lo, hi + 1).map((f) => f.node.path)));
      }
      return;
    }

    if (isModifier) {
      e.preventDefault();
      setSelectedPaths((prev) => {
        const next = new Set(prev);
        if (next.has(node.path)) next.delete(node.path);
        else next.add(node.path);
        return next;
      });
      setLastClickedPath(node.path);
      return;
    }

    // 通常クリック: 選択を単一化 + 従来の動作(フォルダ=展開、文書=遷移)
    setSelectedPaths(new Set([node.path]));
    setLastClickedPath(node.path);
    if (node.type === 'folder') {
      toggleFolderExpanded(node.path);
    } else {
      handleNavigateToDoc(node.path);
    }
  }

  // キーボード操作(デザインhandoff components.md): ↑/↓移動・→展開・←折りたたみ・
  // Enter開く・F2リネーム・Deleteごみ箱
  function handleRowKeyDown(e: KeyboardEvent, entry: FlatEntry) {
    const idx = flat.findIndex((f) => f.node.path === entry.node.path);

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = flat[idx + 1];
      if (next) focusEntry(next.node.path);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = flat[idx - 1];
      if (prev) focusEntry(prev.node.path);
      return;
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (entry.node.type !== 'folder') return;
      if (!expandedFolders.has(entry.node.path)) {
        toggleFolderExpanded(entry.node.path);
      } else {
        const next = flat[idx + 1];
        if (next && next.parentPath === entry.node.path) focusEntry(next.node.path);
      }
      return;
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (entry.node.type === 'folder' && expandedFolders.has(entry.node.path)) {
        toggleFolderExpanded(entry.node.path);
      } else if (entry.parentPath) {
        focusEntry(entry.parentPath);
      }
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (entry.node.type === 'doc') {
        handleNavigateToDoc(entry.node.path);
      } else {
        toggleFolderExpanded(entry.node.path);
      }
      return;
    }
    if (e.key === 'F2') {
      e.preventDefault();
      // #152: モーダルではなく inline リネームに切替
      startInlineRename(entry.node.path);
      return;
    }
    if (e.key === 'Delete') {
      e.preventDefault();
      if (entry.node.type === 'folder') {
        setConfirm({ kind: 'deleteFolder', path: entry.node.path, name: entry.node.name });
      } else {
        setConfirm({ kind: 'deleteDoc', path: entry.node.path, title: entry.node.title });
      }
    }
  }

  const activeFocusPath = focusedPath ?? flat[0]?.node.path ?? null;

  const dnd: TreeDndHandlers = {
    draggedPath: draggedItem?.path ?? null,
    dragOverPath,
    onDragStart: handleDragStartItem,
    onDragEnd: handleDragEndItem,
    onDragEnter: handleDragEnterTarget,
    onDrop: handleDropTarget,
    canDropOn,
  };

  const rootCanAccept = draggedItem !== null && canDropOn('');
  const rootIsDropTarget = dragOverPath === '' && rootCanAccept;

  return (
    <div
      className={`min-h-full p-2 ${
        rootIsDropTarget ? 'ring-2 ring-inset ring-accent bg-accent-soft/50' : ''
      }`}
      onContextMenu={(e) => openMenu(e, { type: 'root' })}
      onDragEnter={(e) => {
        // フォルダ行が stopPropagation しているので、ここに来るのは空白領域上のときだけ
        if (e.target === e.currentTarget) handleDragEnterTarget('');
      }}
      onDragOver={(e) => {
        // #75 fix-forward: doc行やヘッダのボタン上でのリリースが root drop としてバブル
        // しないよう、ラッパ自身上でだけ受け入れる(currentTarget === target のときのみ)
        if (rootCanAccept && e.target === e.currentTarget) e.preventDefault();
      }}
      onDrop={(e) => {
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        handleDropTarget('');
      }}
    >
      <div className="mb-2 flex gap-2">
        <button
          type="button"
          onClick={() => setDialog({ kind: 'createDoc', folder: '' })}
          className="flex-1 rounded border border-line px-2 py-1 text-xs text-ink-soft hover:bg-hoverbg"
        >
          +文書
        </button>
        <button
          type="button"
          onClick={() => setDialog({ kind: 'createFolder', parent: '' })}
          className="flex-1 rounded border border-line px-2 py-1 text-xs text-ink-soft hover:bg-hoverbg"
        >
          +フォルダ
        </button>
      </div>

      {selectedPaths.size > 1 && (
        <div className="mb-2 flex flex-col gap-1 rounded border border-accent-border bg-accent-soft px-2 py-1 text-xs text-accent">
          <div className="flex items-center justify-between">
            <span>{selectedPaths.size}件選択中</span>
            <button
              type="button"
              onClick={() => setSelectedPaths(new Set())}
              className="text-ink-faint hover:text-ink"
              aria-label="選択解除"
            >
              ×
            </button>
          </div>
          <button
            type="button"
            onClick={() =>
              setDialog({
                kind: 'groupIntoNewFolder',
                commonParent: commonParent([...selectedPaths]),
                selection: [...selectedPaths],
              })
            }
            className="rounded border border-accent/40 px-2 py-0.5 text-left text-accent hover:bg-accent-soft"
          >
            + 選択したものを新規フォルダに移動
          </button>
        </div>
      )}

      <ul role="tree">
        {nodes.map((node) => (
          <TreeItem
            key={node.path}
            node={node}
            depth={0}
            parentPath={null}
            currentPath={currentPath}
            expandedFolders={expandedFolders}
            activeFocusPath={activeFocusPath}
            selectedPaths={selectedPaths}
            onRowClick={handleRowClick}
            onContextMenu={openMenu}
            onKeyDown={handleRowKeyDown}
            registerRow={registerRow}
            dnd={dnd}
            renamingPath={renamingPath}
            onStartInlineRename={startInlineRename}
            onCommitInlineRename={commitInlineRename}
            onCancelInlineRename={cancelInlineRename}
          />
        ))}
      </ul>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItemsFor(menu.target)}
          onClose={() => setMenu(null)}
        />
      )}

      {dialog?.kind === 'createDoc' && (
        <PromptDialog
          title="新規文書"
          label="タイトル"
          confirmLabel="作成"
          onConfirm={handleDialogConfirm}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'createFolder' && (
        <PromptDialog
          title="新規フォルダ"
          label="フォルダ名"
          confirmLabel="作成"
          onConfirm={handleDialogConfirm}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'renameDoc' && (
        <PromptDialog
          title="文書のリネーム"
          label="タイトル"
          defaultValue={dialog.title}
          confirmLabel="変更"
          onConfirm={handleDialogConfirm}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'renameFolder' && (
        <PromptDialog
          title="フォルダのリネーム"
          label="フォルダ名"
          defaultValue={dialog.name}
          confirmLabel="変更"
          onConfirm={handleDialogConfirm}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'groupIntoNewFolder' && (
        <PromptDialog
          title={`選択したものを新規フォルダに移動(${dialog.selection.length}件)`}
          label={
            dialog.commonParent
              ? `新規フォルダ名(親: ${dialog.commonParent})`
              : '新規フォルダ名(ルート直下)'
          }
          confirmLabel="作成して移動"
          onConfirm={handleDialogConfirm}
          onCancel={() => setDialog(null)}
        />
      )}

      {confirm?.kind === 'deleteDoc' && (
        <ConfirmDialog
          title="文書の削除"
          message={`「${confirm.title}」をごみ箱へ移動しますか?`}
          onConfirm={handleConfirmDelete}
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm?.kind === 'deleteFolder' && (
        <ConfirmDialog
          title="フォルダの削除"
          message={`「${confirm.name}」をごみ箱へ移動しますか?`}
          onConfirm={handleConfirmDelete}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}

export interface TreeDndHandlers {
  draggedPath: string | null;
  dragOverPath: string | null;
  onDragStart: (path: string, kind: 'doc' | 'folder', title: string | undefined) => void;
  onDragEnd: () => void;
  onDragEnter: (targetPath: string) => void;
  onDrop: (targetPath: string) => void;
  canDropOn: (targetPath: string) => boolean;
}

interface TreeItemProps {
  node: TreeNode;
  depth: number;
  parentPath: string | null;
  currentPath: string | undefined;
  expandedFolders: Set<string>;
  activeFocusPath: string | null;
  selectedPaths: Set<string>;
  onRowClick: (e: React.MouseEvent<HTMLButtonElement>, node: TreeNode) => void;
  onContextMenu: (e: MouseEvent, target: MenuTarget) => void;
  onKeyDown: (e: KeyboardEvent, entry: FlatEntry) => void;
  registerRow: (path: string, el: HTMLButtonElement | null) => void;
  dnd: TreeDndHandlers;
  // #152: インラインリネーム関連
  renamingPath: string | null;
  onStartInlineRename: (path: string) => void;
  onCommitInlineRename: (node: TreeNode, value: string) => void;
  onCancelInlineRename: () => void;
}

function TreeItem({
  node,
  depth,
  parentPath,
  currentPath,
  expandedFolders,
  activeFocusPath,
  selectedPaths,
  onRowClick,
  onContextMenu,
  onKeyDown,
  registerRow,
  dnd,
  renamingPath,
  onStartInlineRename,
  onCommitInlineRename,
  onCancelInlineRename,
}: TreeItemProps) {
  const indent = { paddingLeft: `${depth * 16 + 8}px` };
  const entry: FlatEntry = { node, depth, parentPath };
  const isFocusTarget = node.path === activeFocusPath;
  const isRenaming = node.path === renamingPath;

  const isDragging = dnd.draggedPath === node.path;
  const isDropTarget =
    node.type === 'folder' && dnd.dragOverPath === node.path && dnd.canDropOn(node.path);
  const isSelected = selectedPaths.has(node.path);
  // 選択行(かつ現在文書として色付けされていない)ときは accent-soft で塗る
  const selectedBgClass = isSelected ? 'bg-accent-soft' : '';

  const dragHandlers = {
    draggable: true,
    onDragStart: (e: React.DragEvent<HTMLElement>) => {
      e.stopPropagation();
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        // #75 fix-forward: Firefox は dragstart で setData を呼ばないと以降の
        // dragover/drop を発行しない。text/plain にパスを載せておく(実データは
        // 内部 state を優先し、これは互換性目的のプレースホルダ)
        e.dataTransfer.setData('text/plain', node.path);
      }
      const title = node.type === 'doc' ? node.title : undefined;
      dnd.onDragStart(node.path, node.type, title);
    },
    onDragEnd: () => dnd.onDragEnd(),
  };

  if (node.type === 'folder') {
    const expanded = expandedFolders.has(node.path);
    const canAcceptHere = dnd.draggedPath !== null && dnd.canDropOn(node.path);
    return (
      <li role="none">
        {isRenaming ? (
          // #152: folder の inline リネーム(コンテキストメニュー / F2 経由で発火)
          <div
            style={indent}
            className="flex h-[30px] w-full items-center gap-1 px-2 text-sm"
            data-testid={`folder-rename-${node.path}`}
          >
            <span className="inline-block w-3 text-ink-faint">{expanded ? '▾' : '▸'}</span>
            <span aria-hidden="true">📂</span>
            <InlineRenameInput
              initialValue={node.name}
              onCommit={(value) => onCommitInlineRename(node, value)}
              onCancel={onCancelInlineRename}
            />
          </div>
        ) : (
          <button
            type="button"
            role="treeitem"
            aria-expanded={expanded}
            tabIndex={isFocusTarget ? 0 : -1}
            ref={(el) => registerRow(node.path, el)}
            style={indent}
            onClick={(e) => onRowClick(e, node)}
            onKeyDown={(e) => onKeyDown(e, entry)}
            onContextMenu={(e) => onContextMenu(e, { type: 'folder', path: node.path, name: node.name })}
            {...dragHandlers}
            onDragEnter={(e) => {
              e.stopPropagation();
              dnd.onDragEnter(node.path);
            }}
            onDragOver={(e) => {
              if (canAcceptHere) e.preventDefault();
            }}
            onDrop={(e) => {
              e.stopPropagation();
              e.preventDefault();
              dnd.onDrop(node.path);
            }}
            className={`flex h-[30px] w-full items-center gap-1 px-2 text-left text-sm text-ink-soft hover:bg-hoverbg focus:outline-none focus-visible:bg-active ${
              isDragging ? 'opacity-50' : ''
            } ${isDropTarget ? 'bg-accent-soft ring-2 ring-accent' : selectedBgClass}`}
          >
            <span className="inline-block w-3 text-ink-faint">{expanded ? '▾' : '▸'}</span>
            <span aria-hidden="true">📂</span>
            <span className="truncate">{node.name}</span>
          </button>
        )}
        {expanded && (
          <ul role="group">
            {node.children.map((child) => (
              <TreeItem
                key={child.path}
                node={child}
                depth={depth + 1}
                parentPath={node.path}
                currentPath={currentPath}
                expandedFolders={expandedFolders}
                activeFocusPath={activeFocusPath}
                selectedPaths={selectedPaths}
                onRowClick={onRowClick}
                onContextMenu={onContextMenu}
                onKeyDown={onKeyDown}
                registerRow={registerRow}
                dnd={dnd}
                renamingPath={renamingPath}
                onStartInlineRename={onStartInlineRename}
                onCommitInlineRename={onCommitInlineRename}
                onCancelInlineRename={onCancelInlineRename}
              />
            ))}
          </ul>
        )}
      </li>
    );
  }

  const isCurrent = currentPath === node.path;
  if (isRenaming) {
    // #152: doc の inline リネーム
    return (
      <li role="none">
        <div
          style={indent}
          className="flex h-[30px] w-full items-center gap-1 px-2 text-sm"
          data-testid={`doc-rename-${node.path}`}
        >
          <span className="inline-block w-3" aria-hidden="true" />
          <span aria-hidden="true">📄</span>
          <InlineRenameInput
            initialValue={node.title}
            onCommit={(value) => onCommitInlineRename(node, value)}
            onCancel={onCancelInlineRename}
          />
        </div>
      </li>
    );
  }
  return (
    <li role="none">
      <button
        type="button"
        role="treeitem"
        tabIndex={isFocusTarget ? 0 : -1}
        ref={(el) => registerRow(node.path, el)}
        style={indent}
        onClick={(e) => onRowClick(e, node)}
        onDoubleClick={(e) => {
          // #152: ダブルクリックで inline リネーム開始
          // (祖先に dblclick リスナは無いので stopPropagation は保険レベル)
          e.stopPropagation();
          onStartInlineRename(node.path);
        }}
        onKeyDown={(e) => onKeyDown(e, entry)}
        onContextMenu={(e) =>
          onContextMenu(e, { type: 'doc', path: node.path, folder: parentOf(node.path), title: node.title })
        }
        {...dragHandlers}
        data-testid={`doc-${node.path}`}
        className={`flex h-[30px] w-full items-center gap-1 px-2 text-left text-sm focus:outline-none focus-visible:bg-active ${
          isCurrent ? 'bg-active font-semibold text-accent' : `text-ink-soft hover:bg-hoverbg ${selectedBgClass}`
        } ${isDragging ? 'opacity-50' : ''}`}
      >
        <span className="inline-block w-3" aria-hidden="true" />
        <span aria-hidden="true">📄</span>
        <span className="truncate">{node.title}</span>
      </button>
    </li>
  );
}

// #152: インラインリネーム用の <input>。マウント時にフォーカス + 全選択、
// Enter/blur で確定、Esc でキャンセル。空値は commit 側でキャンセル扱い
interface InlineRenameInputProps {
  initialValue: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}
function InlineRenameInput({ initialValue, onCommit, onCancel }: InlineRenameInputProps) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const committedRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  function commit() {
    if (committedRef.current) return;
    committedRef.current = true;
    onCommit(value);
  }

  return (
    <input
      ref={inputRef}
      type="text"
      value={value}
      aria-label="新しい名前"
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        // Opus #152 軽微 3: React の SyntheticKeyboardEvent には isComposing が無い。
        // Safari は変換確定 Enter で isComposing=false / keyCode=229 になるので併せて判定
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          committedRef.current = true;
          onCancel();
        }
      }}
      onBlur={commit}
      data-testid="inline-rename-input"
      className="min-w-0 flex-1 rounded border border-accent bg-canvas px-1 py-0.5 text-sm text-ink focus:outline-none"
    />
  );
}
