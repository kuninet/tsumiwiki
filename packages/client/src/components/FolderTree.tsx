import { useQueryClient } from '@tanstack/react-query';
import { type MouseEvent, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  docQueryKey,
  useCreateDoc,
  useCreateFolder,
  useDeleteDoc,
  useDeleteFolder,
  useMoveDoc,
  useMoveFolder,
  useTree,
} from '../api/docs';
import { buildTree, parentOf, type TreeNode } from '../lib/build-tree';
import { docUrl } from '../lib/doc-path';
import { confirmNavigationIfDirty } from '../lib/navigation-guard';
import { useUIStore } from '../stores/ui';
import { ConfirmDialog } from './ConfirmDialog';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { PromptDialog } from './PromptDialog';


// フォルダツリー(設計04章4.2)。ルート・フォルダ・文書の右クリックメニューから
// 新規作成・リネーム・削除を行う

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

export function FolderTree() {
  const { data: tree } = useTree();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const params = useParams();
  const currentPath = params['*'];

  const expandedFolders = useUIStore((s) => s.expandedFolders);
  const toggleFolderExpanded = useUIStore((s) => s.toggleFolderExpanded);

  const createDoc = useCreateDoc();
  const createFolder = useCreateFolder();
  const moveDoc = useMoveDoc();
  const moveFolder = useMoveFolder();
  const deleteDoc = useDeleteDoc();
  const deleteFolder = useDeleteFolder();

  const [menu, setMenu] = useState<{ x: number; y: number; target: MenuTarget } | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [confirm, setConfirm] = useState<ConfirmState>(null);

  const nodes = tree ? buildTree(tree) : [];

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

  return (
    <div
      className="min-h-full p-2"
      onContextMenu={(e) => openMenu(e, { type: 'root' })}
    >
      <div className="mb-2 flex gap-2">
        <button
          type="button"
          onClick={() => setDialog({ kind: 'createDoc', folder: '' })}
          className="flex-1 rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-100"
        >
          +文書
        </button>
        <button
          type="button"
          onClick={() => setDialog({ kind: 'createFolder', parent: '' })}
          className="flex-1 rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-100"
        >
          +フォルダ
        </button>
      </div>

      <ul>
        {nodes.map((node) => (
          <TreeItem
            key={node.path}
            node={node}
            depth={0}
            currentPath={currentPath}
            expandedFolders={expandedFolders}
            onToggle={toggleFolderExpanded}
            onNavigate={handleNavigateToDoc}
            onContextMenu={openMenu}
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

interface TreeItemProps {
  node: TreeNode;
  depth: number;
  currentPath: string | undefined;
  expandedFolders: Set<string>;
  onToggle: (path: string) => void;
  onNavigate: (path: string) => void;
  onContextMenu: (e: MouseEvent, target: MenuTarget) => void;
}

function TreeItem({
  node,
  depth,
  currentPath,
  expandedFolders,
  onToggle,
  onNavigate,
  onContextMenu,
}: TreeItemProps) {
  const indent = { paddingLeft: `${depth * 16 + 8}px` };

  if (node.type === 'folder') {
    const expanded = expandedFolders.has(node.path);
    return (
      <li>
        <button
          type="button"
          style={indent}
          onClick={() => onToggle(node.path)}
          onContextMenu={(e) => onContextMenu(e, { type: 'folder', path: node.path, name: node.name })}
          className="flex w-full items-center gap-1 py-1 text-left text-sm text-gray-700 hover:bg-gray-100"
        >
          <span className="inline-block w-3">{expanded ? '▾' : '▸'}</span>
          {node.name}
        </button>
        {expanded && (
          <ul>
            {node.children.map((child) => (
              <TreeItem
                key={child.path}
                node={child}
                depth={depth + 1}
                currentPath={currentPath}
                expandedFolders={expandedFolders}
                onToggle={onToggle}
                onNavigate={onNavigate}
                onContextMenu={onContextMenu}
              />
            ))}
          </ul>
        )}
      </li>
    );
  }

  const isCurrent = currentPath === node.path;
  return (
    <li>
      <button
        type="button"
        style={indent}
        onClick={() => onNavigate(node.path)}
        onContextMenu={(e) =>
          onContextMenu(e, { type: 'doc', path: node.path, folder: parentOf(node.path), title: node.title })
        }
        data-testid={`doc-${node.path}`}
        className={`block w-full truncate py-1 text-left text-sm ${
          isCurrent ? 'bg-blue-50 font-medium text-blue-700' : 'text-gray-700 hover:bg-gray-100'
        }`}
      >
        {node.title}
      </button>
    </li>
  );
}
