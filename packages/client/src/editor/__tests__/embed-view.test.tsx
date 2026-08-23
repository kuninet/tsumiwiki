import { EditorContent, useEditor } from '@tiptap/react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { TsumiwikiDocStorage } from '../doc-storage';
import { createEditorExtensions } from '../markdown';

// vitestのglobals無効構成ではTesting Libraryの自動cleanupが効かないため明示する
afterEach(cleanup);

// tsumiwikiDocストレージはeditor.storageに直接書き込む値のためエディタ生成時には
// まだ反映されない(onCreateは初期NodeViewマウント後に発火する)。NodeView側は
// レンダリング毎にeditor.storageを直接参照するため、ストレージ設定後にsetContentで
// ノードを(再)生成すれば設定済みの値で描画される
function TestEditor({ content, docPath }: { content: string; docPath: string }) {
  const editor = useEditor({
    extensions: createEditorExtensions(),
    content: '',
    onCreate: ({ editor: e }) => {
      const storage: TsumiwikiDocStorage = { folder: '', path: docPath };
      e.storage.tsumiwikiDoc = storage;
      e.commands.setContent(content);
    },
  });
  return <EditorContent editor={editor} />;
}

describe('ObsidianEmbedWithPreview', () => {
  it('画像targetは/api/embedへ解決し、|幅x高さをimgのwidth/heightに反映する', async () => {
    render(<TestEditor content={'![[a.png|300x200]]'} docPath={'フォルダ/文書.md'} />);
    let img: HTMLImageElement;
    await waitFor(() => {
      const el = document.querySelector('.obsidian-embed-image img');
      expect(el).toBeTruthy();
      img = el as HTMLImageElement;
    });
    expect(img!.getAttribute('src')).toBe(
      `/api/embed?target=${encodeURIComponent('a.png')}&from=${encodeURIComponent('フォルダ/文書.md')}`,
    );
    expect(img!.getAttribute('width')).toBe('300');
    expect(img!.getAttribute('height')).toBe('200');
  });

  it('#anchorや|別名は解決に使わず、fileのみで/api/embedへ解決する', async () => {
    render(<TestEditor content={'![[a.png#見出し|別名]]'} docPath={'文書.md'} />);
    await waitFor(() => {
      expect(document.querySelector('.obsidian-embed-image img')).toBeTruthy();
    });
    const img = document.querySelector('.obsidian-embed-image img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe(
      `/api/embed?target=${encodeURIComponent('a.png')}&from=${encodeURIComponent('文書.md')}`,
    );
    expect(img.hasAttribute('width')).toBe(false);
  });

  it('画像読み込み失敗時はチップ表示(原文)に切り替える', async () => {
    render(<TestEditor content={'![[a.png]]'} docPath={'文書.md'} />);
    let img: HTMLImageElement;
    await waitFor(() => {
      const el = document.querySelector('.obsidian-embed-image img');
      expect(el).toBeTruthy();
      img = el as HTMLImageElement;
    });
    img!.dispatchEvent(new Event('error'));
    await waitFor(() => {
      expect(document.querySelector('.obsidian-embed-image img')).toBeNull();
      expect(document.body.textContent).toContain('![[a.png]]');
    });
  });

  it('画像以外の拡張子はチップ表示のまま(従来どおり)', async () => {
    render(<TestEditor content={'![[note.md]]'} docPath={'文書.md'} />);
    await waitFor(() => {
      expect(document.querySelector('.obsidian-embed')).toBeTruthy();
    });
    expect(document.querySelector('.obsidian-embed img')).toBeNull();
    expect(document.body.textContent).toContain('![[note.md]]');
  });
});
