import Image from '@tiptap/extension-image';
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { useEffect, useState } from 'react';
import { imageFallbackSrc, resolveImageSrc } from '../../lib/resolve-embed-src';
import type { TsumiwikiDocStorage } from '../doc-storage';

// 標準画像記法 ![alt](src) の表示解決(FR-OBS-03)。まず相対パスを文書フォルダ基準で
// /api/files/...に解決し、404(onError)ならsrcのファイル名だけで/api/embedに
// フォールバックする(#198)。それも失敗したら壊れた画像アイコンのまま。
// シリアライズ(Image拡張の標準実装)には触れない

type Stage = 'primary' | 'fallback';

function ImageView({ node, editor }: NodeViewProps) {
  const src = node.attrs.src as string;
  const alt = (node.attrs.alt as string | null) ?? undefined;
  const title = (node.attrs.title as string | null) ?? undefined;
  const docStorage = editor.storage.tsumiwikiDoc as TsumiwikiDocStorage | undefined;
  const docFolder = docStorage?.folder ?? '';
  const docPath = docStorage?.path ?? '';

  const [stage, setStage] = useState<Stage>('primary');
  // node.attrs.srcが変わったら(別の画像に差し替わったら)解決段階をリセットする
  useEffect(() => {
    setStage('primary');
  }, [src]);

  const fallback = imageFallbackSrc(src, docPath);
  const currentSrc = stage === 'primary' ? resolveImageSrc(src, docFolder) : (fallback ?? src);

  function handleError() {
    if (stage === 'primary' && fallback !== null) {
      setStage('fallback');
    }
    // fallback段階(またはフォールバック先が無い)での失敗は何もしない=壊れた画像アイコンのまま
  }

  return (
    <NodeViewWrapper as="span" className="tiptap-image">
      <img src={currentSrc} alt={alt} title={title} onError={handleError} />
    </NodeViewWrapper>
  );
}

export const ImageWithResolvedSrc = Image.extend({
  addNodeView() {
    return ReactNodeViewRenderer(ImageView);
  },
});
