import type { Editor } from '@tiptap/core';
import { EditorContent, useEditor } from '@tiptap/react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { TsumiwikiDocStorage } from '../doc-storage';
import { createEditorExtensions } from '../markdown';

// vitestのglobals無効構成ではTesting Libraryの自動cleanupが効かないため明示する
afterEach(cleanup);

// tsumiwikiDocストレージはeditor.storageに直接書き込む値のためエディタ生成時には
// まだ反映されない(onCreateは初期NodeViewマウント後に発火する)。NodeView側は
// レンダリング毎にeditor.storageを直接参照するため、ストレージ設定後にsetContentで
// ノードを(再)生成すれば設定済みの値で描画される
function TestEditor({
  content,
  docPath,
  editorRef,
}: {
  content: string;
  docPath: string;
  editorRef?: { current: Editor | null };
}) {
  const editor = useEditor({
    extensions: createEditorExtensions(),
    content: '',
    onCreate: ({ editor: e }) => {
      const storage: TsumiwikiDocStorage = { folder: '', path: docPath };
      e.storage.tsumiwikiDoc = storage;
      e.commands.setContent(content);
      if (editorRef) editorRef.current = e;
    },
  });
  return <EditorContent editor={editor} />;
}

// obsidianEmbedノードの文書内位置を探す(テスト内でtargetを差し替えるために使う)
function findEmbedPos(editor: Editor): number {
  let pos: number | null = null;
  editor.state.doc.descendants((node, nodePos) => {
    if (node.type.name === 'obsidianEmbed') {
      pos = nodePos;
      return false;
    }
    return true;
  });
  if (pos === null) throw new Error('obsidianEmbedノードが見つかりません');
  return pos;
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

  it('target差し替えで失敗チップから画像表示に戻る', async () => {
    const editorRef: { current: Editor | null } = { current: null };
    render(<TestEditor content={'![[a.png]]'} docPath={'文書.md'} editorRef={editorRef} />);
    let img: HTMLImageElement;
    await waitFor(() => {
      const el = document.querySelector('.obsidian-embed-image img');
      expect(el).toBeTruthy();
      img = el as HTMLImageElement;
    });
    img!.dispatchEvent(new Event('error'));
    await waitFor(() => {
      expect(document.querySelector('.obsidian-embed-image img')).toBeNull();
    });

    // 同位置ノードのattrsをtarget違いで更新する(ReactのNodeViewインスタンスは再利用される)
    act(() => {
      const editor = editorRef.current!;
      const pos = findEmbedPos(editor);
      editor
        .chain()
        .setNodeSelection(pos)
        .updateAttributes('obsidianEmbed', { target: 'b.png' })
        .run();
    });

    await waitFor(() => {
      expect(document.querySelector('.obsidian-embed-image img')).toBeTruthy();
    });
    const newImg = document.querySelector('.obsidian-embed-image img') as HTMLImageElement;
    expect(newImg.getAttribute('src')).toBe(
      `/api/embed?target=${encodeURIComponent('b.png')}&from=${encodeURIComponent('文書.md')}`,
    );
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
