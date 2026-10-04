import { describe, expect, it } from 'vitest';
import { buildWikilinkResolver, type DocSummary } from '@tsumiwiki/shared';
import { planNewDocFromWikilink } from './wikilink-new-doc';

function makeDoc(path: string, title: string): DocSummary {
  const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  return { path, title, folder, updatedAt: '2026-01-01T00:00:00Z' };
}

describe('planNewDocFromWikilink', () => {
  const sourceDoc = '業務/メモ.md';

  describe('リンク文字列ごとの作成結果 (リンク元: 業務/メモ.md)', () => {
    it('[[新しい文書]] - 同じフォルダなら 業務/新しい文書.md、ルートなら 新しい文書.md', () => {
      const same = planNewDocFromWikilink('[[新しい文書]]', sourceDoc, 'same-folder');
      expect(same).toEqual({
        folder: '業務',
        title: '新しい文書',
        path: '業務/新しい文書.md',
        invalidChars: [],
      });

      const root = planNewDocFromWikilink('[[新しい文書]]', sourceDoc, 'root');
      expect(root).toEqual({
        folder: '',
        title: '新しい文書',
        path: '新しい文書.md',
        invalidChars: [],
      });
    });

    it('[[議事録/定例]] - 最後の / でフォルダとタイトルを分割', () => {
      const same = planNewDocFromWikilink('[[議事録/定例]]', sourceDoc, 'same-folder');
      expect(same).toEqual({
        folder: '業務/議事録',
        title: '定例',
        path: '業務/議事録/定例.md',
        invalidChars: [],
      });

      const root = planNewDocFromWikilink('[[議事録/定例]]', sourceDoc, 'root');
      expect(root).toEqual({
        folder: '議事録',
        title: '定例',
        path: '議事録/定例.md',
        invalidChars: [],
      });
    });

    it('[[新しい文書#見出し]] - 見出しアンカーは除外される', () => {
      const same = planNewDocFromWikilink('[[新しい文書#見出し]]', sourceDoc, 'same-folder');
      expect(same).toEqual({
        folder: '業務',
        title: '新しい文書',
        path: '業務/新しい文書.md',
        invalidChars: [],
      });

      const root = planNewDocFromWikilink('[[新しい文書#見出し]]', sourceDoc, 'root');
      expect(root).toEqual({
        folder: '',
        title: '新しい文書',
        path: '新しい文書.md',
        invalidChars: [],
      });
    });

    it('[[新しい文書|別名]] - エイリアスは除外される', () => {
      const same = planNewDocFromWikilink('[[新しい文書|別名]]', sourceDoc, 'same-folder');
      expect(same).toEqual({
        folder: '業務',
        title: '新しい文書',
        path: '業務/新しい文書.md',
        invalidChars: [],
      });

      const root = planNewDocFromWikilink('[[新しい文書|別名]]', sourceDoc, 'root');
      expect(root).toEqual({
        folder: '',
        title: '新しい文書',
        path: '新しい文書.md',
        invalidChars: [],
      });
    });

    it('[[新しい文書.md]] - 末尾の .md は除外される', () => {
      const same = planNewDocFromWikilink('[[新しい文書.md]]', sourceDoc, 'same-folder');
      expect(same).toEqual({
        folder: '業務',
        title: '新しい文書',
        path: '業務/新しい文書.md',
        invalidChars: [],
      });

      const root = planNewDocFromWikilink('[[新しい文書.md]]', sourceDoc, 'root');
      expect(root).toEqual({
        folder: '',
        title: '新しい文書',
        path: '新しい文書.md',
        invalidChars: [],
      });
    });

    it('[[A:B]] - 禁止文字 : が検出される', () => {
      const same = planNewDocFromWikilink('[[A:B]]', sourceDoc, 'same-folder');
      expect(same).toEqual({
        folder: '業務',
        title: 'A:B',
        path: '業務/A:B.md',
        invalidChars: [':'],
      });

      const root = planNewDocFromWikilink('[[A:B]]', sourceDoc, 'root');
      expect(root).toEqual({
        folder: '',
        title: 'A:B',
        path: 'A:B.md',
        invalidChars: [':'],
      });
    });

    it('[[...]] なしのプレーンなターゲット文字列でも同一に動作する', () => {
      const plan = planNewDocFromWikilink('議事録/定例', sourceDoc, 'same-folder');
      expect(plan).toEqual({
        folder: '業務/議事録',
        title: '定例',
        path: '業務/議事録/定例.md',
        invalidChars: [],
      });
    });
  });

  describe('自文書内リンクおよび無効なリンク', () => {
    it('[[#見出し]] は null を返す', () => {
      expect(planNewDocFromWikilink('[[#見出し]]', sourceDoc, 'same-folder')).toBeNull();
      expect(planNewDocFromWikilink('#見出し', sourceDoc, 'same-folder')).toBeNull();
    });

    it('空文字列や空白のみは null を返す', () => {
      expect(planNewDocFromWikilink('', sourceDoc, 'same-folder')).toBeNull();
      expect(planNewDocFromWikilink('   ', sourceDoc, 'same-folder')).toBeNull();
      expect(planNewDocFromWikilink('[[]]', sourceDoc, 'same-folder')).toBeNull();
    });

    it('末尾が / でタイトルが空の場合は null を返す', () => {
      expect(planNewDocFromWikilink('フォルダ/', sourceDoc, 'same-folder')).toBeNull();
    });
  });

  describe('ルート直下の文書がリンク元の場合', () => {
    it('リンク元が memo.md なら same-folder でも folder は ""', () => {
      const plan = planNewDocFromWikilink('新しい文書', 'memo.md', 'same-folder');
      expect(plan).toEqual({
        folder: '',
        title: '新しい文書',
        path: '新しい文書.md',
        invalidChars: [],
      });
    });

    it('リンク元が memo.md かつサブパス指定ならそのパスになる', () => {
      const plan = planNewDocFromWikilink('議事録/定例', 'memo.md', 'same-folder');
      expect(plan).toEqual({
        folder: '議事録',
        title: '定例',
        path: '議事録/定例.md',
        invalidChars: [],
      });
    });
  });

  describe('禁止文字と制御文字の検出', () => {
    it('複数の禁止文字を重複なしで検出する', () => {
      const plan = planNewDocFromWikilink('a:b?c:d*e', sourceDoc, 'same-folder');
      expect(plan?.invalidChars).toEqual([':', '?', '*']);
    });

    it('制御文字を検出する', () => {
      const plan = planNewDocFromWikilink('hello\u0000world\u001f!', sourceDoc, 'same-folder');
      expect(plan?.invalidChars).toEqual(['\u0000', '\u001f']);
    });
  });

  describe('buildWikilinkResolver との整合性検証', () => {
    const testCases = [
      '新しい文書',
      '議事録/定例',
      '新しい文書#見出し',
      '新しい文書|別名',
      '新しい文書.md',
    ];

    for (const target of testCases) {
      it(`same-folder で作成した文書が ${target} で解決される`, () => {
        const plan = planNewDocFromWikilink(target, sourceDoc, 'same-folder')!;
        expect(plan).not.toBeNull();

        const docs = [
          makeDoc(sourceDoc, 'メモ'),
          makeDoc(plan.path, plan.title),
        ];
        const resolver = buildWikilinkResolver(docs);

        expect(resolver(target)).toBe(plan.path);
      });

      it(`root で作成した文書が ${target} で解決される`, () => {
        const plan = planNewDocFromWikilink(target, sourceDoc, 'root')!;
        expect(plan).not.toBeNull();

        const docs = [
          makeDoc(sourceDoc, 'メモ'),
          makeDoc(plan.path, plan.title),
        ];
        const resolver = buildWikilinkResolver(docs);

        expect(resolver(target)).toBe(plan.path);
      });
    }
  });
});
