import { describe, expect, it } from 'vitest';
import {
  applyPatches,
  countOccurrences,
  guardFrontmatter,
  NotePatchError,
  PatchEdit,
} from './note-patch.js';

describe('note-patch 単体テスト', () => {
  describe('countOccurrences', () => {
    it('存在しない文字列の場合は count: 0, first: -1 を返す', () => {
      expect(countOccurrences('hello world', 'xyz')).toEqual({ first: -1, count: 0 });
    });

    it('1回だけ出現する場合は count: 1 とその開始位置を返す', () => {
      expect(countOccurrences('hello world', 'world')).toEqual({ first: 6, count: 1 });
    });

    it('複数回出現する場合は count と最初の開始位置を返す', () => {
      expect(countOccurrences('foo bar foo baz', 'foo')).toEqual({ first: 0, count: 2 });
    });

    it('重なり出現もすべてカウントする', () => {
      // "aaaa" の中に "aa" は 0..2, 1..3, 2..4 の3箇所
      expect(countOccurrences('aaaa', 'aa')).toEqual({ first: 0, count: 3 });
    });

    it('needle が空文字の場合は count: 0, first: -1 を返す', () => {
      expect(countOccurrences('hello', '')).toEqual({ first: -1, count: 0 });
    });
  });

  describe('applyPatches', () => {
    it('単一の置換を適用できる', () => {
      const body = '項目A: 未完了\n項目B: 完了';
      const edits: PatchEdit[] = [{ oldText: '項目A: 未完了', newText: '項目A: 完了' }];
      expect(applyPatches(body, edits)).toBe('項目A: 完了\n項目B: 完了');
    });

    it('複数件の置換を位置に依存せず正確に適用できる(末尾から適用)', () => {
      const body = 'apple banana cherry';
      const edits: PatchEdit[] = [
        { oldText: 'cherry', newText: 'orange' },
        { oldText: 'apple', newText: 'pineapple' },
      ];
      expect(applyPatches(body, edits)).toBe('pineapple banana orange');
    });

    it('空文字を指定することで対象文字列を削除できる', () => {
      const body = 'タイトル\n\n不要な行\n\n本文';
      const edits: PatchEdit[] = [{ oldText: '不要な行\n\n', newText: '' }];
      expect(applyPatches(body, edits)).toBe('タイトル\n\n本文');
    });

    it('隣接する置換範囲は許可される', () => {
      const body = 'ABCDEF';
      const edits: PatchEdit[] = [
        { oldText: 'ABC', newText: '123' },
        { oldText: 'DEF', newText: '456' },
      ];
      expect(applyPatches(body, edits)).toBe('123456');
    });

    it('newText が他の oldText と同一でも連鎖置換されない', () => {
      // A -> B, B -> C の置換で、元の A が C になってしまわない
      const body = 'A and B';
      const edits: PatchEdit[] = [
        { oldText: 'A', newText: 'B' },
        { oldText: 'B', newText: 'C' },
      ];
      expect(applyPatches(body, edits)).toBe('B and C');
    });

    it('CRLF の改行コードが混在していても LF に統一されて置換される', () => {
      const body = 'line1\r\nline2\r\nline3';
      const edits: PatchEdit[] = [{ oldText: 'line2\r\n', newText: 'modified\n' }];
      expect(applyPatches(body, edits)).toBe('line1\nmodified\nline3');
    });

    it('置換対象が見つからない場合は PATCH_NOT_FOUND エラーになる', () => {
      const body = 'hello world';
      const edits: PatchEdit[] = [
        { oldText: 'hello', newText: 'hi' },
        { oldText: 'not_found', newText: 'xxx' },
      ];
      try {
        applyPatches(body, edits);
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(NotePatchError);
        const err = e as NotePatchError;
        expect(err.payload).toEqual({
          code: 'PATCH_NOT_FOUND',
          message: '置換対象の文字列が見つかりません (edits[1])',
          editIndex: 1,
        });
      }
    });

    it('置換対象が複数箇所見つかる場合は PATCH_AMBIGUOUS エラーになる', () => {
      const body = 'item\nitem\nitem';
      const edits: PatchEdit[] = [{ oldText: 'item', newText: 'new_item' }];
      try {
        applyPatches(body, edits);
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(NotePatchError);
        const err = e as NotePatchError;
        expect(err.payload).toEqual({
          code: 'PATCH_AMBIGUOUS',
          message: '置換対象の文字列が複数箇所 (3箇所) 見つかりました (edits[0])',
          editIndex: 0,
          occurrences: 3,
        });
      }
    });

    it('置換範囲が重複している場合は PATCH_OVERLAP エラーになる', () => {
      const body = 'abcdefg';
      const edits: PatchEdit[] = [
        { oldText: 'bcd', newText: '1' },
        { oldText: 'cde', newText: '2' },
      ];
      try {
        applyPatches(body, edits);
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(NotePatchError);
        const err = e as NotePatchError;
        expect(err.payload).toEqual({
          code: 'PATCH_OVERLAP',
          message: '置換範囲が重複しています (edits[0] と edits[1])',
          editIndexes: [0, 1],
        });
      }
    });

    it('包含関係にある重複でも PATCH_OVERLAP エラーになる', () => {
      const body = 'hello big world';
      const edits: PatchEdit[] = [
        { oldText: 'big', newText: 'huge' },
        { oldText: 'hello big world', newText: 'all' },
      ];
      try {
        applyPatches(body, edits);
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(NotePatchError);
        const err = e as NotePatchError;
        expect(err.payload).toEqual({
          code: 'PATCH_OVERLAP',
          message: '置換範囲が重複しています (edits[0] と edits[1])',
          editIndexes: [0, 1],
        });
      }
    });
  });

  describe('guardFrontmatter', () => {
    it('元々フロントマターがある場合は、本文先頭が --- で始まってもエラーにしない', () => {
      const original = 'body text';
      const patched = '---\nline';
      expect(guardFrontmatter(original, patched, true)).toBe(patched);
    });

    it('元々フロントマターがない場合で、本文先頭が --- で始まらなければ成功する', () => {
      const original = 'body text';
      const patched = '# Title\nbody text';
      expect(guardFrontmatter(original, patched, false)).toBe(patched);
    });

    it('元々先頭が --- (閉じ記号なし、水平線等)のフロントマターなしノートで、末尾のテキストを置換してもエラーにならず正常に置換できる', () => {
      const original = '---\n水平線下のメモ\n旧テキスト';
      const patched = '---\n水平線下のメモ\n新テキスト';
      expect(guardFrontmatter(original, patched, false)).toBe(patched);
    });

    it('元々フロントマターがない場合で、置換により有効なフロントマターブロックが新たに挿入された場合は PATCH_FRONTMATTER エラーになる', () => {
      const original = 'some content';
      const patched = '---\ntitle: x\n---\nsome content';
      try {
        guardFrontmatter(original, patched, false);
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(NotePatchError);
        const err = e as NotePatchError;
        expect(err.payload).toEqual({
          code: 'PATCH_FRONTMATTER',
          message: '置換後の本文がフロントマター開始記号(---)で始まっているため拒否されました',
        });
      }
    });
  });
});
