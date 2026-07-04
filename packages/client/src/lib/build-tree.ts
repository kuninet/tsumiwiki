import type { TreeResponse } from '@tsumiwiki/shared';

// TreeResponse(folders[] + docs[]のフラット構造)から階層ツリーを組み立てる純粋関数(設計04章4.2)
// folders配列はwalkFoldersにより祖先フォルダを全て含む前提(空フォルダも要素として現れる)

export interface FolderNode {
  type: 'folder';
  path: string;
  name: string;
  children: TreeNode[];
}

export interface DocNode {
  type: 'doc';
  path: string;
  title: string;
  updatedAt: string;
}

export type TreeNode = FolderNode | DocNode;

export function parentOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

function nameOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

function sortChildren(nodes: TreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    const nameA = a.type === 'folder' ? a.name : a.title;
    const nameB = b.type === 'folder' ? b.name : b.title;
    return nameA.localeCompare(nameB, 'ja');
  });
}

export function buildTree(tree: TreeResponse): TreeNode[] {
  const foldersByPath = new Map<string, FolderNode>();
  for (const path of tree.folders) {
    foldersByPath.set(path, { type: 'folder', path, name: nameOf(path), children: [] });
  }

  const root: TreeNode[] = [];

  for (const path of tree.folders) {
    const node = foldersByPath.get(path)!;
    const parent = parentOf(path);
    const parentNode = parent ? foldersByPath.get(parent) : undefined;
    (parentNode ? parentNode.children : root).push(node);
  }

  for (const doc of tree.docs) {
    const node: DocNode = { type: 'doc', path: doc.path, title: doc.title, updatedAt: doc.updatedAt };
    const parentNode = doc.folder ? foldersByPath.get(doc.folder) : undefined;
    (parentNode ? parentNode.children : root).push(node);
  }

  sortChildren(root);
  for (const node of foldersByPath.values()) {
    sortChildren(node.children);
  }

  return root;
}
