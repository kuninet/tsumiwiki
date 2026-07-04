import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { InvalidPathError, isProtectedPath, normalizeRelPath, resolveInLibrary } from './paths.js';

describe('normalizeRelPath', () => {
  it('NFDのパスをNFCへ正規化する(macOS対策)', () => {
    const nfd = 'ブログ/メモ.md'; // 濁点が分解された「ブログ」
    expect(normalizeRelPath(nfd)).toBe('ブログ/メモ.md');
  });

  it('バックスラッシュ区切りを/に統一する(Windows対策)', () => {
    expect(normalizeRelPath('folder\\文書.md')).toBe('folder/文書.md');
  });

  it('空セグメント・カレント参照を除去する', () => {
    expect(normalizeRelPath('./folder//文書.md')).toBe('folder/文書.md');
    expect(normalizeRelPath('/folder/文書.md/')).toBe('folder/文書.md');
  });

  it('..を含むパスを拒否する', () => {
    expect(() => normalizeRelPath('../etc/passwd')).toThrow(InvalidPathError);
    expect(() => normalizeRelPath('folder/../../secret')).toThrow(InvalidPathError);
  });
});

describe('isProtectedPath', () => {
  it('.git/.obsidian等のドットセグメントを保護対象とする', () => {
    expect(isProtectedPath('.git/config')).toBe(true);
    expect(isProtectedPath('.obsidian/app.json')).toBe(true);
    expect(isProtectedPath('folder/.hidden.md')).toBe(true);
  });

  it('.trashと通常パスは保護対象外', () => {
    expect(isProtectedPath('.trash/削除済み.md')).toBe(false);
    expect(isProtectedPath('folder/文書.md')).toBe(false);
  });
});

describe('resolveInLibrary', () => {
  const root = path.resolve('/tmp/library');

  it('ルート配下の絶対パスへ解決する', () => {
    expect(resolveInLibrary(root, '議事録/週次.md')).toBe(path.join(root, '議事録', '週次.md'));
  });

  it('ルート外への脱出を拒否する', () => {
    expect(() => resolveInLibrary(root, '../outside.md')).toThrow(InvalidPathError);
  });
});
