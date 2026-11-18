import type { TreeResponse } from '@tsumiwiki/shared';
import { isImageFile, isPdfFile } from './resolve-embed-src';

// TreeResponse(folders[] + docs[] (+ attachments[])のフラット構造)から階層ツリーを組み立てる純粋関数(設計04章4.2)
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

export interface AttachmentNode {
  type: 'attachment';
  path: string;
  name: string;
  kind: 'image' | 'pdf';
  updatedAt: string;
}

export type TreeNode = FolderNode | DocNode | AttachmentNode;

export function parentOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

// 文書またはフォルダのパスから、祖先フォルダのパスを浅い順に返す(#323)。
// 自分自身は含めない。'a/b/c.md' → ['a', 'a/b']、'a/b' → ['a']、'root.md' → []
// 先頭・末尾の '/' は取り除いてから扱う
export function ancestorFolderPaths(path: string): string[] {
  const normalized = path.replace(/^\/+|\/+$/g, '');
  if (!normalized) return [];
  const segments = normalized.split('/');
  if (segments.length <= 1) return [];
  const result: string[] = [];
  let current = '';
  for (let i = 0; i < segments.length - 1; i++) {
    current = current ? `${current}/${segments[i]}` : segments[i];
    result.push(current);
  }
  return result;
}

function nameOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

const NODE_TYPE_RANK: Record<TreeNode['type'], number> = {
  folder: 0,
  doc: 1,
  attachment: 2,
};

function labelOf(node: TreeNode): string {
  return node.type === 'doc' ? node.title : node.name;
}

function sortChildren(nodes: TreeNode[]): void {
  nodes.sort((a, b) => {
    const rankDiff = NODE_TYPE_RANK[a.type] - NODE_TYPE_RANK[b.type];
    if (rankDiff !== 0) return rankDiff;
    return labelOf(a).localeCompare(labelOf(b), 'ja');
  });
}

export interface BuildTreeOptions {
  showAttachments?: boolean;
}

export function buildTree(tree: TreeResponse, options?: BuildTreeOptions): TreeNode[] {
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
    const node: DocNode = {
      type: 'doc',
      path: doc.path,
      title: doc.title,
      updatedAt: doc.updatedAt,
    };
    const parentNode = doc.folder ? foldersByPath.get(doc.folder) : undefined;
    (parentNode ? parentNode.children : root).push(node);
  }

  if (options?.showAttachments && tree.attachments) {
    for (const att of tree.attachments) {
      const kind = isImageFile(att.name) ? 'image' : isPdfFile(att.name) ? 'pdf' : null;
      if (!kind) continue;
      const node: AttachmentNode = {
        type: 'attachment',
        path: att.path,
        name: att.name,
        kind,
        updatedAt: att.updatedAt,
      };
      const parentNode = att.folder ? foldersByPath.get(att.folder) : undefined;
      (parentNode ? parentNode.children : root).push(node);
    }
  }

  sortChildren(root);
  for (const node of foldersByPath.values()) {
    sortChildren(node.children);
  }

  return root;
}
