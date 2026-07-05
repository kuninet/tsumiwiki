import { useQueryClient } from '@tanstack/react-query';
import type React from 'react';
import { type KeyboardEvent, type MouseEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
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

  const expandedFolders = useUIStore((s) => s.expandedFolders);
  const toggleFolderExpanded = useUIStore((s) => s.toggleFolderExpanded);
  const createDocRequestNonce = useUIStore((s) => s.createDocRequestNonce);

  // AppShellのサイドバーフッター「+ 新規文書」の要求を拾ってルート直下の新規文書ダイアログを開く
  useEffect(() => {
    if (createDocRequestNonce > 0) {
      setDialog({ kind: 'createDoc', folder: '' });
    }
    // 初期nonce=0では発火しない。以降は変化のたびにダイアログを再表示する
  }, [createDocRequestNonce]);

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
    if (target.type === 'root') {
      return [
        { label: '新規文書', onSelect: () => setDialog({ kind: 'createDoc', folder: '' }) },
        { label: '新規フォルダ', onSelect: () => setDialog({ kind: 'createFolder', parent: '' }) },
      ];
    }
    if (target.type === 'folder') {
      return [
        {
          label: '新規文書',
          onSelect: () => setDialog({ kind: 'createDoc', folder: target.path }),
        },
        {
          label: '新規フォルダ',
          onSelect: () => setDialog({ kind: 'createFolder', parent: target.path }),
        },
        {
          label: 'リネーム',
          onSelect: () => setDialog({ kind: 'renameFolder', path: target.path, name: target.name }),
        },
        {
          label: '削除',
          danger: true,
          onSelect: () => setConfirm({ kind: 'deleteFolder', path: target.path, name: target.name }),
        },
      ];
    }
    return [
      {
        label: 'リネーム',
        onSelect: () =>
          setDialog({ kind: 'renameDoc', path: target.path, folder: target.folder, title: target.title }),
      },
      {
        label: '削除',
        danger: true,
        onSelect: () => setConfirm({ kind: 'deleteDoc', path: target.path, title: target.title }),
      },
    ];
  }

  function handleDialogConfirm(value: string) {
    if (!dialog) return;
    if (dialog.kind === 'createDoc') {
      createDoc.mutate({ folder: dialog.folder, title: value });
    } else if (dialog.kind === 'createFolder') {
      const path = dialog.parent ? `${dialog.parent}/${value}` : value;
      createFolder.mutate({ path });
    } else if (dialog.kind === 'renameDoc') {
      moveDoc.mutate({ path: dialog.path, newFolder: dialog.folder, newTitle: value });
    } else if (dialog.kind === 'renameFolder') {
      const parent = parentOf(dialog.path);
      const newPath = parent ? `${parent}/${value}` : value;
      moveFolder.mutate({ path: dialog.path, newPath });
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
    if (!confirmNavigationIfDirty()) {
      return;
    }
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

  // ドロップ先が targetFolderPath のとき、対象パス群のうち移動しても意味のある/矛盾しないものだけを返す
  function filterMovable(paths: string[], targetFolderPath: string): TreeNode[] {
    const byPath = new Map<string, TreeNode>();
    for (const f of flat) byPath.set(f.node.path, f.node);
    return paths
      .map((p) => byPath.get(p))
      .filter((n): n is TreeNode => !!n)
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
  async function performBatchMove(nodes: TreeNode[], targetFolderPath: string) {
    let succeeded = 0;
    let failed = 0;
    let lastError: string | null = null;
    for (const node of nodes) {
      try {
        if (node.type === 'doc') {
          await moveDocApi({
            path: node.path,
            newFolder: targetFolderPath,
            newTitle: node.title,
          });
        } else {
          const folderName = node.path.split('/').pop()!;
          const newPath = targetFolderPath ? `${targetFolderPath}/${folderName}` : folderName;
          await moveFolderApi({ path: node.path, newPath });
        }
        succeeded++;
      } catch (err) {
        failed++;
        if (err instanceof ApiRequestError) lastError = err.message;
      }
    }
    queryClient.invalidateQueries({ queryKey: TREE_QUERY_KEY });
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
      if (entry.node.type === 'folder') {
        setDialog({ kind: 'renameFolder', path: entry.node.path, name: entry.node.name });
      } else {
        setDialog({
          kind: 'renameDoc',
          path: entry.node.path,
          folder: parentOf(entry.node.path),
          title: entry.node.title,
        });
      }
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
        if (rootCanAccept) e.preventDefault();
      }}
      onDrop={(e) => {
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
        <div className="mb-2 flex items-center justify-between rounded border border-accent-border bg-accent-soft px-2 py-1 text-xs text-accent">
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
}: TreeItemProps) {
  const indent = { paddingLeft: `${depth * 16 + 8}px` };
  const entry: FlatEntry = { node, depth, parentPath };
  const isFocusTarget = node.path === activeFocusPath;

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
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
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
              />
            ))}
          </ul>
        )}
      </li>
    );
  }

  const isCurrent = currentPath === node.path;
  return (
    <li role="none">
      <button
        type="button"
        role="treeitem"
        tabIndex={isFocusTarget ? 0 : -1}
        ref={(el) => registerRow(node.path, el)}
        style={indent}
        onClick={(e) => onRowClick(e, node)}
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
