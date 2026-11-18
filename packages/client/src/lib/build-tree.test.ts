import { describe, expect, it } from 'vitest';
import { ancestorFolderPaths, buildTree, type FolderNode } from './build-tree';

describe('ancestorFolderPaths (#323)', () => {
  it('U-1: 文書パスから祖先フォルダのパスを浅い順に返す', () => {
    expect(ancestorFolderPaths('a/b/c.md')).toEqual(['a', 'a/b']);
  });

  it('U-2: フォルダパスでは自分自身を含めず祖先フォルダのみ返す', () => {
    expect(ancestorFolderPaths('a/b')).toEqual(['a']);
  });

  it('U-3: ルート直下および空文字では空配列を返す', () => {
    expect(ancestorFolderPaths('root.md')).toEqual([]);
    expect(ancestorFolderPaths('')).toEqual([]);
  });

  it('U-4: 先頭・末尾にスラッシュが付いていても正規化して正しく返す', () => {
    expect(ancestorFolderPaths('/a/b/')).toEqual(['a']);
  });

  it('U-5: 日本語や記号を含むパスでも祖先フォルダを正しく返す', () => {
    expect(ancestorFolderPaths('フォルダA/見出し#1/文書.md')).toEqual([
      'フォルダA',
      'フォルダA/見出し#1',
    ]);
  });
});

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
    const folderA = nodes.find((n) => n.type === 'folder' && n.path === 'a') as
      FolderNode | undefined;
    expect(folderA).toBeTruthy();
    expect(folderA?.children).toHaveLength(1);

    const folderB = folderA?.children[0] as FolderNode;
    expect(folderB.type).toBe('folder');
    expect(folderB.path).toBe('a/b');
    expect(folderB.children).toEqual([
      { type: 'doc', path: 'a/b/c.md', title: 'c', updatedAt: 't' },
    ]);

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

  describe('添付ファイルの表示切替と並び順 (#318)', () => {
    const TREE_WITH_ATTACHMENTS = {
      folders: ['sub'],
      docs: [
        { path: 'sub/z.md', title: 'z', folder: 'sub', updatedAt: 't' },
        { path: 'a.md', title: 'a', folder: '', updatedAt: 't' },
      ],
      attachments: [
        { path: 'sub/1.png', name: '1.png', folder: 'sub', updatedAt: 't' },
        { path: 'img.webp', name: 'img.webp', folder: '', updatedAt: 't' },
        { path: 'doc.pdf', name: 'doc.pdf', folder: '', updatedAt: 't' },
        { path: 'raw.bin', name: 'raw.bin', folder: '', updatedAt: 't' },
      ],
    };

    it('AT-03-1: showAttachments 未指定または false のときは添付を含めない', () => {
      const nodesDefault = buildTree(TREE_WITH_ATTACHMENTS);
      const nodesOff = buildTree(TREE_WITH_ATTACHMENTS, { showAttachments: false });
      expect(nodesDefault.some((n) => n.type === 'attachment')).toBe(false);
      expect(nodesOff.some((n) => n.type === 'attachment')).toBe(false);
    });

    it('AT-03-2: showAttachments: true で画像・PDFのみをフォルダ→ノート→添付の順で並べる', () => {
      const nodes = buildTree(TREE_WITH_ATTACHMENTS, { showAttachments: true });

      expect(nodes.map((n) => `${n.type}:${n.path}`)).toEqual([
        'folder:sub',
        'doc:a.md',
        'attachment:doc.pdf',
        'attachment:img.webp',
      ]);
      expect(nodes.find((n) => n.path === 'doc.pdf')).toMatchObject({
        type: 'attachment',
        kind: 'pdf',
        name: 'doc.pdf',
      });
      expect(nodes.find((n) => n.path === 'img.webp')).toMatchObject({
        type: 'attachment',
        kind: 'image',
        name: 'img.webp',
      });

      const sub = nodes[0] as FolderNode;
      expect(sub.children.map((n) => `${n.type}:${n.path}`)).toEqual([
        'doc:sub/z.md',
        'attachment:sub/1.png',
      ]);
    });
  });
});
