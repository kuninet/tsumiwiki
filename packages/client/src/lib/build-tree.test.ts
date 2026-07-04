import { describe, expect, it } from 'vitest';
import { buildTree, type FolderNode } from './build-tree';

describe('buildTree', () => {
  it('ネストしたフォルダと文書を階層化する', () => {
    const nodes = buildTree({
      folders: ['a', 'a/b'],
      docs: [
        { path: 'a/b/c.md', title: 'c', folder: 'a/b', updatedAt: 't' },
        { path: 'root.md', title: 'root', folder: '', updatedAt: 't' },
      ],
    });

    expect(nodes).toHaveLength(2);
    const folderA = nodes.find((n) => n.type === 'folder' && n.path === 'a') as FolderNode | undefined;
    expect(folderA).toBeTruthy();
    expect(folderA?.children).toHaveLength(1);

    const folderB = folderA?.children[0] as FolderNode;
    expect(folderB.type).toBe('folder');
    expect(folderB.path).toBe('a/b');
    expect(folderB.children).toEqual([{ type: 'doc', path: 'a/b/c.md', title: 'c', updatedAt: 't' }]);

    const rootDoc = nodes.find((n) => n.type === 'doc');
    expect(rootDoc).toEqual({ type: 'doc', path: 'root.md', title: 'root', updatedAt: 't' });
  });

  it('空フォルダも表示対象として残る', () => {
    const nodes = buildTree({ folders: ['empty'], docs: [] });
    expect(nodes).toEqual([{ type: 'folder', path: 'empty', name: 'empty', children: [] }]);
  });

  it('フォルダを文書より先に、日本語ロケールの名前順でソートする', () => {
    const nodes = buildTree({
      folders: ['あ'],
      docs: [
        { path: 'い.md', title: 'い', folder: '', updatedAt: 't' },
        { path: 'a.md', title: 'a', folder: '', updatedAt: 't' },
      ],
    });

    expect(nodes[0]).toMatchObject({ type: 'folder', name: 'あ' });
    expect(nodes[1]).toMatchObject({ type: 'doc', title: 'a' });
    expect(nodes[2]).toMatchObject({ type: 'doc', title: 'い' });
  });

  it('所属フォルダが見つからない文書はルート直下に置く', () => {
    const nodes = buildTree({
      folders: [],
      docs: [{ path: '迷子.md', title: '迷子', folder: '存在しない', updatedAt: 't' }],
    });
    expect(nodes).toEqual([{ type: 'doc', path: '迷子.md', title: '迷子', updatedAt: 't' }]);
  });
});
