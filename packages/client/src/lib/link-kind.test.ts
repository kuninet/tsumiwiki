import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyLinkHref,
  isLinkOpenModifier,
  linkHintEdit,
  linkHintView,
  resolveRelativeLink,
  safeDecodeHref,
} from './link-kind';

describe('link-kind', () => {
  describe('safeDecodeHref', () => {
    it('パーセントエンコードされた文字列をデコードする', () => {
      expect(safeDecodeHref('%E8%A8%AD%E8%A8%88.md')).toBe('設計.md');
      expect(safeDecodeHref('%5C%5Csrv%5Cs')).toBe('\\\\srv\\s');
    });

    it('不正なパーセントエンコードは例外を出さず原文のまま返す', () => {
      expect(safeDecodeHref('%E3%81')).toBe('%E3%81');
    });
  });

  describe('classifyLinkHref', () => {
    it('http/https リンクを external と判定する', () => {
      expect(classifyLinkHref('https://ex.com')).toBe('external');
      expect(classifyLinkHref('HTTP://A')).toBe('external');
    });

    it('mailto リンクを mailto と判定する', () => {
      expect(classifyLinkHref('mailto:a@b')).toBe('mailto');
    });

    it('file リンクおよび UNC パスを file と判定する', () => {
      expect(classifyLinkHref('file:///C:/a%20b')).toBe('file');
      expect(classifyLinkHref('%5C%5Csrv%5Cs')).toBe('file');
      expect(classifyLinkHref('\\\\srv\\s')).toBe('file');
    });

    it('ハッシュから始まるリンクを anchor と判定する', () => {
      expect(classifyLinkHref('#head')).toBe('anchor');
    });

    it('相対パスおよび不正なエンコードを relative と判定する', () => {
      expect(classifyLinkHref('%E8%A8%AD%E8%A8%88.md')).toBe('relative');
      expect(classifyLinkHref('../up.md')).toBe('relative');
      expect(classifyLinkHref('memo')).toBe('relative');
      expect(classifyLinkHref('%E3%81')).toBe('relative');
    });
  });

  describe('resolveRelativeLink', () => {
    it('同階層の Markdown 相対リンクを解決する', () => {
      expect(resolveRelativeLink('%E8%A8%AD%E8%A8%88.md', 'メモ.md')).toEqual({
        type: 'doc',
        path: '設計.md',
      });
    });

    it('上位階層(..)を含む Markdown 相対リンクを解決する', () => {
      expect(resolveRelativeLink('../up.md', 'a/b/c.md')).toEqual({
        type: 'doc',
        path: 'a/up.md',
      });
    });

    it('スペースやハッシュを含む Markdown 相対リンクを解決する', () => {
      expect(resolveRelativeLink('sub/x%20y.md#h', 'a/c.md')).toEqual({
        type: 'doc',
        path: 'a/sub/x y.md',
      });
    });

    it('拡張子なしのリンクを Markdown 文書として解決する', () => {
      expect(resolveRelativeLink('memo', 'a/c.md')).toEqual({
        type: 'doc',
        path: 'a/memo',
      });
    });

    it('大文字拡張子 .MD を Markdown 文書として解決する', () => {
      expect(resolveRelativeLink('Memo.MD', 'a/c.md')).toEqual({
        type: 'doc',
        path: 'a/Memo.MD',
      });
    });

    it('ルート基準(/)のリンクを解決する', () => {
      expect(resolveRelativeLink('/root.md', 'a/c.md')).toEqual({
        type: 'doc',
        path: 'root.md',
      });
    });

    it('非 Markdown 拡張子(PDF等)を /api/files/... URL として解決する', () => {
      expect(resolveRelativeLink('資料.pdf?x=1', 'a/c.md')).toEqual({
        type: 'file',
        url: '/api/files/a/%E8%B3%87%E6%96%99.pdf',
      });
    });

    it('ルートより上の階層指定はルートで止まる', () => {
      expect(resolveRelativeLink('../../x.md', 'c.md')).toEqual({
        type: 'doc',
        path: 'x.md',
      });
    });

    it('クエリのみなど解決結果が空になる場合は null を返す', () => {
      expect(resolveRelativeLink('?only', 'c.md')).toBeNull();
    });
  });

  describe('linkHintEdit / linkHintView', () => {
    const originalPlatform = navigator.platform;

    afterEach(() => {
      Object.defineProperty(navigator, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
    });

    it('Windows環境(Win32)での編集モード用ヒント文言', () => {
      Object.defineProperty(navigator, 'platform', {
        value: 'Win32',
        configurable: true,
      });

      expect(linkHintEdit('external')).toBe('Ctrl+クリックで開く');
      expect(linkHintEdit('relative')).toBe('Ctrl+クリックで開く');
      expect(linkHintEdit('file')).toBe('Ctrl+クリックでパスをコピー');
      expect(linkHintEdit('mailto')).toBe('Ctrl+クリックでメールを作成');
      expect(linkHintEdit('anchor')).toBeNull();
    });

    it('Mac環境(MacIntel)での編集モード用ヒント文言', () => {
      Object.defineProperty(navigator, 'platform', {
        value: 'MacIntel',
        configurable: true,
      });

      expect(linkHintEdit('external')).toBe('Cmd+クリックで開く');
      expect(linkHintEdit('relative')).toBe('Cmd+クリックで開く');
      expect(linkHintEdit('file')).toBe('Cmd+クリックでパスをコピー');
      expect(linkHintEdit('mailto')).toBe('Cmd+クリックでメールを作成');
      expect(linkHintEdit('anchor')).toBeNull();
    });

    it('閲覧モード用ヒント文言は file のみで、他は null', () => {
      expect(linkHintView('file')).toBe('クリックでパスをコピー');
      expect(linkHintView('external')).toBeNull();
      expect(linkHintView('relative')).toBeNull();
      expect(linkHintView('mailto')).toBeNull();
      expect(linkHintView('anchor')).toBeNull();
    });
  });

  describe('isLinkOpenModifier', () => {
    it('ctrlKey または metaKey が true のとき true を返す', () => {
      expect(isLinkOpenModifier({ ctrlKey: true, metaKey: false })).toBe(true);
      expect(isLinkOpenModifier({ ctrlKey: false, metaKey: true })).toBe(true);
      expect(isLinkOpenModifier({ ctrlKey: true, metaKey: true })).toBe(true);
      expect(isLinkOpenModifier({ ctrlKey: false, metaKey: false })).toBe(false);
    });
  });
});
