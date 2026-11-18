import { LIBRARY_SETTINGS_DEFAULTS, type LibrarySettings } from '@tsumiwiki/shared';
import { describe, expect, it } from 'vitest';
import { InvalidPathError } from '../lib/paths.js';
import {
  planAttachmentReorganization,
  resolveMarkdownRelPath,
  type ReorgInputDoc,
} from './attachment-reorganizer.js';

function makeSettings(
  mode: LibrarySettings['attachments']['mode'],
  folder = 'attachments',
  templateFolder = '_templates',
): LibrarySettings {
  return {
    templates: { folder: templateFolder },
    dailyNotes: { ...LIBRARY_SETTINGS_DEFAULTS.dailyNotes },
    attachments: { mode, folder },
  };
}

describe('resolveMarkdownRelPath', () => {
  it('相対パス・親参照・ルート始まり・脱出を正しく解決する', () => {
    expect(resolveMarkdownRelPath('', 'a.png')).toBe('a.png');
    expect(resolveMarkdownRelPath('docs/sub', './a.png')).toBe('docs/sub/a.png');
    expect(resolveMarkdownRelPath('docs/sub', '../assets/a.png')).toBe('docs/assets/a.png');
    expect(resolveMarkdownRelPath('docs/sub', '/media/a.png')).toBe('media/a.png');
    expect(resolveMarkdownRelPath('docs', '../../outside.png')).toBeNull();
  });
});

describe('planAttachmentReorganization', () => {
  it('vault-folder: 未参照も含めて全添付を対象フォルダへ集約し、配置済みはスキップする', async () => {
    const docs: ReorgInputDoc[] = [
      { docPath: '企画/メモ.md', content: '本文\n![[pic.png]]\n', lockedBy: null },
    ];
    const plan = await planAttachmentReorganization({
      attachmentPaths: ['pic.png', 'media/stay.png', 'orphan.pdf'],
      docs,
      settings: makeSettings('vault-folder', 'media'),
      moveSharedToCommonFolder: false,
    });

    expect(plan.preview.moves).toEqual([
      {
        fromPath: 'orphan.pdf',
        toPath: 'media/orphan.pdf',
        renamed: false,
        referencedBy: [],
      },
      {
        fromPath: 'pic.png',
        toPath: 'media/pic.png',
        renamed: false,
        referencedBy: ['企画/メモ.md'],
      },
    ]);
    expect(plan.preview.skipped).toEqual([
      { path: 'media/stay.png', reason: 'already-in-place', referencedBy: [] },
    ]);
    // bare ![[pic.png]] は移動後も一意に解決できるため書き換え不要
    expect(plan.preview.rewrites).toEqual([]);
    expect(plan.preview.summary).toEqual({
      totalAttachments: 3,
      moveCount: 2,
      renameCount: 0,
      rewriteDocCount: 0,
      skipAlreadyInPlace: 1,
      skipShared: 0,
      skipUnreferenced: 0,
      skipTemplate: 0,
    });
  });

  it('同名衝突時に決定論的連番リネームし、リネームされた側のリンクだけを書き換える', async () => {
    const docs: ReorgInputDoc[] = [
      { docPath: 'a/doc.md', content: 'Aの図\n![[fig.png]]\n', lockedBy: null },
      {
        docPath: 'b/doc.md',
        content: 'Bの図\n![[fig.png#center|幅]]\n[[fig.png]]\n',
        lockedBy: null,
      },
    ];
    const plan = await planAttachmentReorganization({
      attachmentPaths: ['a/fig.png', 'b/fig.png'],
      docs,
      settings: makeSettings('vault-folder', 'assets'),
      moveSharedToCommonFolder: false,
    });

    expect(plan.preview.moves).toEqual([
      {
        fromPath: 'a/fig.png',
        toPath: 'assets/fig.png',
        renamed: false,
        referencedBy: ['a/doc.md'],
      },
      {
        fromPath: 'b/fig.png',
        toPath: 'assets/fig-2.png',
        renamed: true,
        referencedBy: ['b/doc.md'],
      },
    ]);
    expect(plan.preview.rewrites).toEqual([
      {
        docPath: 'b/doc.md',
        lockedBy: null,
        replacements: [{ from: 'fig.png', to: 'fig-2.png' }],
      },
    ]);
    expect(plan.rewritesWithContent[0].nextContent).toBe(
      'Bの図\n![[fig-2.png#center|幅]]\n[[fig-2.png]]\n',
    );
  });

  it('doc-subfolder: 単一フォルダ専属のみ移動し、共有と未参照をスキップ・オプションで共通フォルダへ退避する', async () => {
    const docs: ReorgInputDoc[] = [
      { docPath: 'note.md', content: '![[root-only.png]]\n![[shared.png]]\n', lockedBy: null },
      { docPath: 'sub/memo.md', content: '![[sub-only.png]]\n![[shared.png]]\n', lockedBy: null },
    ];
    const commonArgs = {
      attachmentPaths: ['root-only.png', 'shared.png', 'sub-only.png', 'unused.png'],
      docs,
      settings: makeSettings('doc-subfolder', 'assets'),
    };

    const pFalse = await planAttachmentReorganization({
      ...commonArgs,
      moveSharedToCommonFolder: false,
    });
    expect(pFalse.preview.moves).toEqual([
      {
        fromPath: 'root-only.png',
        toPath: 'assets/root-only.png',
        renamed: false,
        referencedBy: ['note.md'],
      },
      {
        fromPath: 'sub-only.png',
        toPath: 'sub/assets/sub-only.png',
        renamed: false,
        referencedBy: ['sub/memo.md'],
      },
    ]);
    expect(pFalse.preview.skipped).toEqual([
      {
        path: 'shared.png',
        reason: 'shared-across-folders',
        referencedBy: ['note.md', 'sub/memo.md'],
      },
      { path: 'unused.png', reason: 'unreferenced', referencedBy: [] },
    ]);

    const pTrue = await planAttachmentReorganization({
      ...commonArgs,
      moveSharedToCommonFolder: true,
    });
    expect(pTrue.preview.moves.map((m) => [m.fromPath, m.toPath])).toEqual([
      ['root-only.png', 'assets/root-only.png'],
      ['shared.png', 'assets/shared.png'],
      ['sub-only.png', 'sub/assets/sub-only.png'],
    ]);
    expect(pTrue.preview.skipped).toEqual([
      { path: 'unused.png', reason: 'unreferenced', referencedBy: [] },
    ]);
  });

  it('same-folder: 単一フォルダ専属は文書と同フォルダへ移動し、ルート直下の共有退避は既定フォルダ名を使う', async () => {
    const docs: ReorgInputDoc[] = [
      { docPath: '企画/A.md', content: '![[img.png]]\n![[common.png]]\n', lockedBy: null },
      { docPath: '議事/B.md', content: '![[common.png]]\n', lockedBy: null },
    ];
    const plan = await planAttachmentReorganization({
      attachmentPaths: ['old/img.png', 'common.png'],
      docs,
      settings: makeSettings('same-folder', 'attachments'),
      moveSharedToCommonFolder: true,
    });

    expect(plan.preview.moves).toEqual([
      {
        fromPath: 'common.png',
        toPath: 'attachments/common.png',
        renamed: false,
        referencedBy: ['企画/A.md', '議事/B.md'],
      },
      {
        fromPath: 'old/img.png',
        toPath: '企画/img.png',
        renamed: false,
        referencedBy: ['企画/A.md'],
      },
    ]);
  });

  it('スワップ配置(a/x -> b/x と b/x -> a/x)でも不要な連番リネームを発生させない', async () => {
    const docs: ReorgInputDoc[] = [
      { docPath: 'a/doc.md', content: '![[b/x.png]]\n', lockedBy: null },
      { docPath: 'b/doc.md', content: '![[a/x.png]]\n', lockedBy: null },
    ];
    const plan = await planAttachmentReorganization({
      attachmentPaths: ['a/x.png', 'b/x.png'],
      docs,
      settings: makeSettings('same-folder', 'attachments'),
      moveSharedToCommonFolder: false,
    });

    expect(plan.preview.moves).toEqual([
      { fromPath: 'a/x.png', toPath: 'b/x.png', renamed: false, referencedBy: ['b/doc.md'] },
      { fromPath: 'b/x.png', toPath: 'a/x.png', renamed: false, referencedBy: ['a/doc.md'] },
    ]);
    expect(plan.preview.summary.renameCount).toBe(0);
    // 書き換え後のパス付きリンクも各文書にとって新しい相対/最短パスへ更新される
    expect(plan.rewritesWithContent.find((r) => r.docPath === 'a/doc.md')?.nextContent).toBe(
      '![[x.png]]\n',
    );
    expect(plan.rewritesWithContent.find((r) => r.docPath === 'b/doc.md')?.nextContent).toBe(
      '![[x.png]]\n',
    );
  });

  it('標準 Markdown 画像・リンクの相対パスを書き換え、パス付き wikilink は最短一意ターゲットへ更新する', async () => {
    const docs: ReorgInputDoc[] = [
      {
        docPath: 'docs/note.md',
        content: [
          '![図](sub/pic.png "説明")',
          '[仕様](../files/spec.pdf#page=2)',
          '![[sub/pic.png]]',
          '![外部](https://example.com/a.png)',
          '`![[sub/pic.png]]` ![x](sub/pic.png)',
          '```md',
          '![](sub/pic.png)',
          '```',
        ].join('\n'),
        lockedBy: null,
      },
    ];
    const plan = await planAttachmentReorganization({
      attachmentPaths: ['docs/sub/pic.png', 'files/spec.pdf'],
      docs,
      settings: makeSettings('vault-folder', 'media'),
      moveSharedToCommonFolder: false,
    });

    expect(plan.rewritesWithContent).toHaveLength(1);
    expect(plan.rewritesWithContent[0].nextContent).toBe(
      [
        '![図](../media/pic.png "説明")',
        '[仕様](../media/spec.pdf#page=2)',
        '![[pic.png]]',
        '![外部](https://example.com/a.png)',
        '`![[sub/pic.png]]` ![x](../media/pic.png)',
        '```md',
        '![](sub/pic.png)',
        '```',
      ].join('\n'),
    );
  });

  it('フロントマターは書き換えず、CRLF 改行を維持し、ロック警告を収集する', async () => {
    const docs: ReorgInputDoc[] = [
      {
        docPath: 'docs/a.md',
        content: '---\r\ntitle: "![[old/img.png]]"\r\n---\r\n![[old/img.png]]\r\n',
        lockedBy: { userId: 2, displayName: '佐藤' },
      },
    ];
    const plan = await planAttachmentReorganization({
      attachmentPaths: ['old/img.png'],
      docs,
      settings: makeSettings('vault-folder', 'media'),
      moveSharedToCommonFolder: false,
    });

    expect(plan.rewritesWithContent[0].nextContent).toBe(
      '---\r\ntitle: "![[old/img.png]]"\r\n---\r\n![[img.png]]\r\n',
    );
    expect(plan.preview.lockedWarnings).toEqual([{ docPath: 'docs/a.md', displayName: '佐藤' }]);
  });

  it('非移動対象の実ファイルが移動先に既にある場合は isOccupiedOnDisk で検知して連番リネームする', async () => {
    const docs: ReorgInputDoc[] = [
      { docPath: 'note.md', content: '![[pic.png]]\n', lockedBy: null },
    ];
    const plan = await planAttachmentReorganization({
      attachmentPaths: ['pic.png'],
      docs,
      settings: makeSettings('vault-folder', 'media'),
      moveSharedToCommonFolder: false,
      isOccupiedOnDisk: async (rel) => rel === 'media/pic.png',
    });

    expect(plan.preview.moves[0].toPath).toBe('media/pic-2.png');
    expect(plan.preview.moves[0].renamed).toBe(true);
  });

  it('テンプレートフォルダ重複の vault-folder 移動計画は InvalidPathError を投げる', async () => {
    await expect(
      planAttachmentReorganization({
        attachmentPaths: ['pic.png'],
        docs: [],
        settings: makeSettings('vault-folder', '_templates'),
        moveSharedToCommonFolder: false,
      }),
    ).rejects.toBeInstanceOf(InvalidPathError);
  });

  it('テンプレート配下の添付やテンプレート文書のみ参照の添付は全モードで template-folder スキップする', async () => {
    const docs: ReorgInputDoc[] = [
      {
        docPath: '_templates/議事録.md',
        content: '![[logo.png]]\n![[loose/banner.png]]\n',
        lockedBy: null,
      },
      {
        docPath: '企画/メモ.md',
        content: '![[old/fig.png]]\n',
        lockedBy: null,
      },
    ];
    const attachmentPaths = ['_templates/logo.png', 'loose/banner.png', 'old/fig.png'];

    const sameFolder = await planAttachmentReorganization({
      attachmentPaths,
      docs,
      settings: makeSettings('same-folder', 'attachments'),
      moveSharedToCommonFolder: false,
    });
    expect(sameFolder.preview.moves).toEqual([
      {
        fromPath: 'old/fig.png',
        toPath: '企画/fig.png',
        renamed: false,
        referencedBy: ['企画/メモ.md'],
      },
    ]);
    expect(sameFolder.preview.skipped).toEqual([
      {
        path: '_templates/logo.png',
        reason: 'template-folder',
        referencedBy: ['_templates/議事録.md'],
      },
      {
        path: 'loose/banner.png',
        reason: 'template-folder',
        referencedBy: ['_templates/議事録.md'],
      },
    ]);
    expect(sameFolder.preview.summary.skipTemplate).toBe(2);

    const docSubfolder = await planAttachmentReorganization({
      attachmentPaths,
      docs,
      settings: makeSettings('doc-subfolder', 'assets'),
      moveSharedToCommonFolder: false,
    });
    expect(docSubfolder.preview.skipped).toEqual([
      {
        path: '_templates/logo.png',
        reason: 'template-folder',
        referencedBy: ['_templates/議事録.md'],
      },
      {
        path: 'loose/banner.png',
        reason: 'template-folder',
        referencedBy: ['_templates/議事録.md'],
      },
    ]);

    const vaultFolder = await planAttachmentReorganization({
      attachmentPaths,
      docs,
      settings: makeSettings('vault-folder', 'media'),
      moveSharedToCommonFolder: false,
    });
    expect(vaultFolder.preview.moves.map((m) => m.fromPath)).toEqual([
      'loose/banner.png',
      'old/fig.png',
    ]);
    expect(vaultFolder.preview.skipped).toEqual([
      {
        path: '_templates/logo.png',
        reason: 'template-folder',
        referencedBy: ['_templates/議事録.md'],
      },
    ]);
  });

  it('未移動添付の短縮 wikilink が他ファイルの移動で別実体に乗っ取られる場合は最短一意ターゲットへ書き換える', async () => {
    const docs: ReorgInputDoc[] = [
      { docPath: 'p/a.md', content: '![[x.png]]\n', lockedBy: null },
      { docPath: 'q/b.md', content: '![[p/sub/x.png]]\n', lockedBy: null },
      { docPath: 'p/c.md', content: '![[r/x.png]]\n', lockedBy: null },
    ];
    const plan = await planAttachmentReorganization({
      attachmentPaths: ['p/sub/x.png', 'r/x.png'],
      docs,
      settings: makeSettings('same-folder', 'attachments'),
      moveSharedToCommonFolder: false,
    });

    expect(plan.preview.moves).toEqual([
      {
        fromPath: 'r/x.png',
        toPath: 'p/x.png',
        renamed: false,
        referencedBy: ['p/c.md'],
      },
    ]);
    // p/a.md の ![[x.png]] はそのままでは新 p/x.png に奪われるため sub/x.png へ書き換えて元実体 p/sub/x.png を守る。
    // p/c.md の ![[r/x.png]] は移動後の p/x.png を指す最短一意ターゲット ![[x.png]] へ更新される。
    expect(plan.rewritesWithContent.map((r) => [r.docPath, r.nextContent])).toEqual([
      ['p/a.md', '![[sub/x.png]]\n'],
      ['p/c.md', '![[x.png]]\n'],
    ]);
  });
});
