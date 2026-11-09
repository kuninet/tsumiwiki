import { Editor } from '@tiptap/core';
import { DOMParser } from '@tiptap/pm/model';
import { afterEach, describe, expect, it } from 'vitest';
import { createEditorExtensions } from '../markdown';

describe('LinkWithTitle / MarkdownLinkSchemes (issue #325)', () => {
  let editor: Editor | null = null;
  const originalPlatform = navigator.platform;

  afterEach(() => {
    editor?.destroy();
    editor = null;
    Object.defineProperty(navigator, 'platform', {
      value: originalPlatform,
      configurable: true,
    });
  });

  function createTestEditor(md: string): Editor {
    editor = new Editor({
      extensions: createEditorExtensions({ nodeViews: false, getWikilinkDocs: () => [] }),
      content: md,
    });
    return editor;
  }

  it('外部リンクの属性とヒント文言を正しくレンダリングする', () => {
    Object.defineProperty(navigator, 'platform', {
      value: 'Win32',
      configurable: true,
    });

    const ed = createTestEditor('[d](https://ex.com "T")');
    const a = ed.view.dom.querySelector('a');
    expect(a).not.toBeNull();
    expect(a?.getAttribute('data-link-kind')).toBe('external');
    expect(a?.getAttribute('target')).toBe('_blank');
    expect(a?.getAttribute('title')).toBe('T');
    expect(a?.getAttribute('data-link-hint')).toBe('Ctrl+クリックで開く');
    expect(a?.hasAttribute('data-link-hint-view')).toBe(false);
  });

  it('Mac環境では編集モードのヒント文言が Cmd+クリック になる', () => {
    Object.defineProperty(navigator, 'platform', {
      value: 'MacIntel',
      configurable: true,
    });

    const ed = createTestEditor('[d](https://ex.com)');
    const a = ed.view.dom.querySelector('a');
    expect(a?.getAttribute('data-link-hint')).toBe('Cmd+クリックで開く');
  });

  it('file: リンクの属性とヒント文言を正しくレンダリングする', () => {
    const ed = createTestEditor('[c](<file:///C:/a b>)');
    const a = ed.view.dom.querySelector('a');
    expect(a).not.toBeNull();
    expect(a?.getAttribute('data-link-kind')).toBe('file');
    expect(a?.hasAttribute('target')).toBe(false);
    expect(a?.getAttribute('data-link-hint-view')).toBe('クリックでパスをコピー');
  });

  it('UNC パスのリンクを file として正しくレンダリングする', () => {
    // Markdown 原文で \\\\srv\\s (JS 文字列内では \\\\\\\\srv\\\\s)
    const ed = createTestEditor('[h](\\\\\\\\srv\\\\s)');
    const a = ed.view.dom.querySelector('a');
    expect(a).not.toBeNull();
    expect(a?.getAttribute('data-link-kind')).toBe('file');
    expect(a?.hasAttribute('target')).toBe(false);
  });

  it('相対リンク、mailto、anchor リンクの属性を正しくレンダリングする', () => {
    const ed = createTestEditor('[a](設計.md) [g](mailto:a@b) [f](#head)');
    const links = Array.from(ed.view.dom.querySelectorAll('a'));
    expect(links).toHaveLength(3);

    const [relLink, mailtoLink, anchorLink] = links;

    // 相対リンク
    expect(relLink.getAttribute('data-link-kind')).toBe('relative');
    expect(relLink.hasAttribute('target')).toBe(false);
    expect(relLink.hasAttribute('data-link-hint-view')).toBe(false);

    // mailto
    expect(mailtoLink.getAttribute('data-link-kind')).toBe('mailto');
    expect(mailtoLink.hasAttribute('target')).toBe(false);
    expect(mailtoLink.hasAttribute('data-link-hint-view')).toBe(false);

    // anchor
    expect(anchorLink.getAttribute('data-link-kind')).toBe('anchor');
    expect(anchorLink.hasAttribute('target')).toBe(false);
    expect(anchorLink.hasAttribute('data-link-hint')).toBe(false);
    expect(anchorLink.hasAttribute('data-link-hint-view')).toBe(false);
  });

  it('Markdown 往復で data-link やヒント文言が混入せず保全される', () => {
    const md =
      '[a](設計.md) [b](sub/x%20y.md#h) [c](<file:///C:/a b>) [d](https://ex.com "T") [e](../up.md) [f](#head) [g](mailto:a@b) [h](\\\\srv\\s) [i](memo)';
    const ed = createTestEditor(md);

    const markdownOut = ed.storage.markdown.getMarkdown() as string;
    expect(markdownOut).not.toContain('data-link');
    expect(markdownOut).not.toContain('target');
    expect(markdownOut).not.toContain('クリック');
    expect(markdownOut).not.toContain('noopener');

    // 既存挙動通りのフォーマットでシリアライズされること
    expect(markdownOut).toContain('[a](%E8%A8%AD%E8%A8%88.md)');
    expect(markdownOut).toContain('[b](sub/x%20y.md#h)');
    expect(markdownOut).toContain('[c](file:///C:/a%20b)');
    expect(markdownOut).toContain('[d](https://ex.com "T")');
    expect(markdownOut).toContain('[e](../up.md)');
    expect(markdownOut).toContain('[f](#head)');
    expect(markdownOut).toContain('[g](mailto:a@b)');
    expect(markdownOut).toContain('[i](memo)');
  });

  it('HTML 経由の往復で title 属性にヒント文言が混入しない', () => {
    const ed = createTestEditor('[d](https://ex.com "T")');
    const html = ed.getHTML();

    const div = document.createElement('div');
    div.innerHTML = html;

    const parsedNode = DOMParser.fromSchema(ed.schema).parse(div);
    const ed2 = new Editor({
      extensions: createEditorExtensions({ nodeViews: false, getWikilinkDocs: () => [] }),
      content: parsedNode.toJSON(),
    });
    try {
      const a = ed2.view.dom.querySelector('a');
      expect(a?.getAttribute('title')).toBe('T');
    } finally {
      ed2.destroy();
    }
  });
});
