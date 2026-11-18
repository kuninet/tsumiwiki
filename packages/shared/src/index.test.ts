import { describe, expect, it } from 'vitest';
import {
  LIBRARY_SETTINGS_DEFAULTS,
  attachmentSettingsFromEnv,
  isSafeAttachmentFolder,
  librarySettingsSchema,
  normalizeAttachmentFolder,
} from './index.js';

describe('添付フォルダ名バリデーション・正規化', () => {
  it('normalizeAttachmentFolder: 前後空白と末尾スラッシュを除去し NFC 正規化する', () => {
    expect(normalizeAttachmentFolder('  attachments/  ')).toBe('attachments');
    expect(normalizeAttachmentFolder('assets/images///')).toBe('assets/images');
    // NFD の「ガ」(カ + 濁点) を NFC へ正規化
    expect(normalizeAttachmentFolder('カ\u3099ゾウ')).toBe('ガゾウ');
  });

  it('isSafeAttachmentFolder: 安全なフォルダ名・サブパスを許可する', () => {
    expect(isSafeAttachmentFolder('attachments')).toBe(true);
    expect(isSafeAttachmentFolder('assets/images')).toBe(true);
    expect(isSafeAttachmentFolder('添付ファイル')).toBe(true);
    expect(isSafeAttachmentFolder('attachments/')).toBe(true);
  });

  it('isSafeAttachmentFolder: トラバーサル・ドット始まり・禁止文字・予約名を拒否する', () => {
    const invalid = [
      '',
      '   ',
      '/',
      '/attachments',
      './attachments',
      '../out',
      'a/../b',
      '.trash',
      '.obsidian',
      '.tsumiwiki',
      'a/.hidden',
      'a//b',
      'a\\b',
      'foo:bar',
      'foo*bar',
      'foo?bar',
      'foo"bar',
      'foo<bar',
      'foo>bar',
      'foo|bar',
      'foo\nbar',
      'CON',
      'aux.dir',
      'foo.',
      'foo /bar',
    ];
    for (const v of invalid) {
      expect(isSafeAttachmentFolder(v), `expected ${JSON.stringify(v)} to be invalid`).toBe(false);
    }
  });
});

describe('attachmentSettingsFromEnv', () => {
  it('same-folder とフォルダ指定を AttachmentSettings へ変換する', () => {
    expect(attachmentSettingsFromEnv('same-folder')).toEqual({
      mode: 'same-folder',
      folder: 'attachments',
    });
    expect(attachmentSettingsFromEnv('assets')).toEqual({
      mode: 'vault-folder',
      folder: 'assets',
    });
  });
});

describe('librarySettingsSchema (attachments)', () => {
  const base = {
    templates: { folder: '_templates' },
    dailyNotes: { folder: '日記', template: '', filenamePattern: 'YYYY-MM-DD' },
  };

  it('attachments 省略時はデフォルト値が補完される', () => {
    const parsed = librarySettingsSchema.safeParse(base);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual(LIBRARY_SETTINGS_DEFAULTS);
    }
  });

  it('3モードいずれも妥当な設定ならパースでき、末尾スラッシュは正規化される', () => {
    for (const mode of ['same-folder', 'vault-folder', 'doc-subfolder'] as const) {
      const parsed = librarySettingsSchema.safeParse({
        ...base,
        attachments: { mode, folder: 'assets/' },
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.attachments).toEqual({ mode, folder: 'assets' });
      }
    }
  });

  it('same-folder 時は folder が空文字でも許可されるが不正文字は拒否される', () => {
    expect(
      librarySettingsSchema.safeParse({
        ...base,
        attachments: { mode: 'same-folder', folder: '' },
      }).success,
    ).toBe(true);

    expect(
      librarySettingsSchema.safeParse({
        ...base,
        attachments: { mode: 'same-folder', folder: '../out' },
      }).success,
    ).toBe(false);
  });

  it('vault-folder / doc-subfolder 時は空文字・ドット始まり・.. を拒否する', () => {
    for (const mode of ['vault-folder', 'doc-subfolder'] as const) {
      for (const folder of ['', '  ', '.trash', '../out', './attachments']) {
        expect(
          librarySettingsSchema.safeParse({
            ...base,
            attachments: { mode, folder },
          }).success,
        ).toBe(false);
      }
    }
  });

  it('vault-folder と templates.folder の衝突は拒否され、doc-subfolder では許可される', () => {
    expect(
      librarySettingsSchema.safeParse({
        ...base,
        attachments: { mode: 'vault-folder', folder: '_templates' },
      }).success,
    ).toBe(false);

    // 大文字小文字違いも衝突として拒否する
    expect(
      librarySettingsSchema.safeParse({
        ...base,
        attachments: { mode: 'vault-folder', folder: '_TEMPLATES' },
      }).success,
    ).toBe(false);

    // doc-subfolder は各文書フォルダ配下のため同名でも許可する
    expect(
      librarySettingsSchema.safeParse({
        ...base,
        attachments: { mode: 'doc-subfolder', folder: '_templates' },
      }).success,
    ).toBe(true);
  });
});

import { reorganizeAttachmentsRequestSchema } from './index.js';

describe('reorganizeAttachmentsRequestSchema', () => {
  it('省略時は moveSharedToCommonFolder: false を補完する', () => {
    expect(reorganizeAttachmentsRequestSchema.parse({})).toEqual({
      moveSharedToCommonFolder: false,
    });
    expect(reorganizeAttachmentsRequestSchema.parse({ moveSharedToCommonFolder: true })).toEqual({
      moveSharedToCommonFolder: true,
    });
  });

  it('boolean 以外は拒否する', () => {
    expect(
      reorganizeAttachmentsRequestSchema.safeParse({ moveSharedToCommonFolder: 'yes' }).success,
    ).toBe(false);
  });
});

import { moveDocsBatchRequestSchema, skippedAttachmentSchema } from './index.js';

describe('moveDocsBatchRequestSchema / skippedAttachmentSchema (#334)', () => {
  it('1件以上の移動リストを受理し、0件または201件以上は拒否する', () => {
    expect(
      moveDocsBatchRequestSchema.safeParse({
        moves: [{ path: 'a.md', newFolder: 'dest', newTitle: 'a' }],
      }).success,
    ).toBe(true);
    expect(moveDocsBatchRequestSchema.safeParse({ moves: [] }).success).toBe(false);
    const over = Array.from({ length: 201 }, (_, i) => ({
      path: `doc-${i}.md`,
      newFolder: 'dest',
      newTitle: `doc-${i}`,
    }));
    expect(moveDocsBatchRequestSchema.safeParse({ moves: over }).success).toBe(false);
  });

  it('skippedAttachmentSchema は shared / conflict のみ受理する', () => {
    expect(skippedAttachmentSchema.safeParse({ fileName: 'a.png', reason: 'shared' }).success).toBe(
      true,
    );
    expect(
      skippedAttachmentSchema.safeParse({ fileName: 'b.png', reason: 'conflict' }).success,
    ).toBe(true);
    expect(skippedAttachmentSchema.safeParse({ fileName: 'c.png', reason: 'other' }).success).toBe(
      false,
    );
  });
});
