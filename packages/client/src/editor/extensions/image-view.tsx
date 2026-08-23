import Image from '@tiptap/extension-image';
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { useState } from 'react';
import { imageFallbackSrc, resolveImageSrc } from '../../lib/resolve-embed-src';
import type { TsumiwikiDocStorage } from '../doc-storage';

// 標準画像記法 ![alt](src) の表示解決(FR-OBS-03)。まず相対パスを文書フォルダ基準で
// /api/files/...に解決し、404(onError)ならsrcのファイル名だけで/api/embedに
// フォールバックする(#198)。それも失敗したら壊れた画像アイコンのまま。
// シリアライズ(Image拡張の標準実装)には触れない

function ImageView({ node, editor }: NodeViewProps) {
  const src = node.attrs.src as string;
  const alt = (node.attrs.alt as string | null) ?? undefined;
  const title = (node.attrs.title as string | null) ?? undefined;
  const docStorage = editor.storage.tsumiwikiDoc as TsumiwikiDocStorage | undefined;
  const docFolder = docStorage?.folder ?? '';
  const docPath = docStorage?.path ?? '';

  // 「どのsrcに対して失敗したか」を保持する。src自体が変わった場合は
  // failedSrcと一致しなくなるため、useEffectでのリセットなしに自動でprimaryへ戻る
  // (useEffectだと反映がコミット後になり、差し替え直後の1レンダーで旧stageのまま
  // 新srcのfallbackを描画してしまい不要な/api/embedリクエストが発生するため)
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const stage: 'primary' | 'fallback' = failedSrc === src ? 'fallback' : 'primary';

  const fallback = imageFallbackSrc(src, docPath);
  const currentSrc = stage === 'primary' ? resolveImageSrc(src, docFolder) : (fallback ?? src);

  function handleError() {
    if (stage === 'primary' && fallback !== null) {
      setFailedSrc(src);
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
