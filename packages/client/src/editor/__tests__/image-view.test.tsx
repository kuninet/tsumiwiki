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
  docFolder,
  docPath,
}: {
  content: string;
  docFolder: string;
  docPath: string;
}) {
  const editor = useEditor({
    extensions: createEditorExtensions(),
    content: '',
    onCreate: ({ editor: e }) => {
      const storage: TsumiwikiDocStorage = { folder: docFolder, path: docPath };
      e.storage.tsumiwikiDoc = storage;
      e.commands.setContent(content);
    },
  });
  return <EditorContent editor={editor} />;
}

describe('ImageWithResolvedSrc', () => {
  it('相対パスを文書フォルダ基準で/api/files/...に解決する', async () => {
    render(
      <TestEditor
        content={'![alt](sub/a.png)'}
        docFolder={'フォルダ'}
        docPath={'フォルダ/文書.md'}
      />,
    );
    let img: HTMLImageElement;
    await waitFor(() => {
      const el = document.querySelector('.tiptap-image img');
      expect(el).toBeTruthy();
      img = el as HTMLImageElement;
    });
    expect(img!.getAttribute('src')).toBe(
      `/api/files/${encodeURIComponent('フォルダ')}/sub/a.png`,
    );
  });

  it('読み込み失敗時はファイル名だけで/api/embedへフォールバックする', async () => {
    render(
      <TestEditor
        content={'![alt](sub/a.png)'}
        docFolder={'フォルダ'}
        docPath={'フォルダ/文書.md'}
      />,
    );
    let img: HTMLImageElement;
    await waitFor(() => {
      const el = document.querySelector('.tiptap-image img');
      expect(el).toBeTruthy();
      img = el as HTMLImageElement;
    });
    img!.dispatchEvent(new Event('error'));
    await waitFor(() => {
      expect(img!.getAttribute('src')).toBe(
        `/api/embed?target=${encodeURIComponent('a.png')}&from=${encodeURIComponent('フォルダ/文書.md')}`,
      );
    });
  });

  it('フォールバックも失敗したらそのまま(壊れた画像アイコン)にする', async () => {
    render(
      <TestEditor
        content={'![alt](sub/a.png)'}
        docFolder={'フォルダ'}
        docPath={'フォルダ/文書.md'}
      />,
    );
    let img: HTMLImageElement;
    await waitFor(() => {
      const el = document.querySelector('.tiptap-image img');
      expect(el).toBeTruthy();
      img = el as HTMLImageElement;
    });
    img!.dispatchEvent(new Event('error'));
    let fallbackSrc: string | null = null;
    await waitFor(() => {
      fallbackSrc = img!.getAttribute('src');
      expect(fallbackSrc).toContain('/api/embed');
    });
    img!.dispatchEvent(new Event('error'));
    // waitForは初回評価で条件を満たして即抜けてしまい、srcが変化してから
    // 元に戻る/変わらないような回帰を検出できない。1tick進めてから同期的に検証する
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(img!.getAttribute('src')).toBe(fallbackSrc);
  });
});
