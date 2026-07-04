import { useQueryClient } from '@tanstack/react-query';
import { type KeyboardEvent, type MouseEvent, useMemo, useRef, useState } from 'react';
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
  const [focusedPath, setFocusedPath] = useState<string | null>(null);

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

  return (
    <div className="min-h-full p-2" onContextMenu={(e) => openMenu(e, { type: 'root' })}>
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
            onToggle={toggleFolderExpanded}
            onNavigate={handleNavigateToDoc}
            onContextMenu={openMenu}
            onKeyDown={handleRowKeyDown}
            registerRow={registerRow}
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
  parentPath: string | null;
  currentPath: string | undefined;
  expandedFolders: Set<string>;
  activeFocusPath: string | null;
  onToggle: (path: string) => void;
  onNavigate: (path: string) => void;
  onContextMenu: (e: MouseEvent, target: MenuTarget) => void;
  onKeyDown: (e: KeyboardEvent, entry: FlatEntry) => void;
  registerRow: (path: string, el: HTMLButtonElement | null) => void;
}

function TreeItem({
  node,
  depth,
  parentPath,
  currentPath,
  expandedFolders,
  activeFocusPath,
  onToggle,
  onNavigate,
  onContextMenu,
  onKeyDown,
  registerRow,
}: TreeItemProps) {
  const indent = { paddingLeft: `${depth * 16 + 8}px` };
  const entry: FlatEntry = { node, depth, parentPath };
  const isFocusTarget = node.path === activeFocusPath;

  if (node.type === 'folder') {
    const expanded = expandedFolders.has(node.path);
    return (
      <li role="none">
        <button
          type="button"
          role="treeitem"
          aria-expanded={expanded}
          tabIndex={isFocusTarget ? 0 : -1}
          ref={(el) => registerRow(node.path, el)}
          style={indent}
          onClick={() => onToggle(node.path)}
          onKeyDown={(e) => onKeyDown(e, entry)}
          onContextMenu={(e) => onContextMenu(e, { type: 'folder', path: node.path, name: node.name })}
          className="flex h-[30px] w-full items-center gap-1 px-2 text-left text-sm text-ink-soft hover:bg-hoverbg focus:outline-none focus-visible:bg-active"
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
                onToggle={onToggle}
                onNavigate={onNavigate}
                onContextMenu={onContextMenu}
                onKeyDown={onKeyDown}
                registerRow={registerRow}
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
        onClick={() => onNavigate(node.path)}
        onKeyDown={(e) => onKeyDown(e, entry)}
        onContextMenu={(e) =>
          onContextMenu(e, { type: 'doc', path: node.path, folder: parentOf(node.path), title: node.title })
        }
        data-testid={`doc-${node.path}`}
        className={`flex h-[30px] w-full items-center gap-1 px-2 text-left text-sm focus:outline-none focus-visible:bg-active ${
          isCurrent ? 'bg-active font-semibold text-accent' : 'text-ink-soft hover:bg-hoverbg'
        }`}
      >
        <span className="inline-block w-3" aria-hidden="true" />
        <span aria-hidden="true">📄</span>
        <span className="truncate">{node.title}</span>
      </button>
    </li>
  );
}
