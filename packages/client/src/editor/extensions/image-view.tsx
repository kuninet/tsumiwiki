import Image from '@tiptap/extension-image';
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { resolveImageSrc } from '../../lib/resolve-embed-src';

// 標準画像記法 ![alt](src) の表示解決(FR-OBS-03)。相対パスを文書フォルダ基準で
// /api/files/...に解決して表示するのみで、シリアライズ(Image拡張の標準実装)には触れない

interface TsumiwikiDocStorage {
  folder?: string;
}

function ImageView({ node, editor }: NodeViewProps) {
  const src = node.attrs.src as string;
  const alt = (node.attrs.alt as string | null) ?? undefined;
  const title = (node.attrs.title as string | null) ?? undefined;
  const docFolder = (editor.storage.tsumiwikiDoc as TsumiwikiDocStorage | undefined)?.folder ?? '';
  const resolvedSrc = resolveImageSrc(src, docFolder);

  return (
    <NodeViewWrapper as="span" className="tiptap-image">
      <img src={resolvedSrc} alt={alt} title={title} />
    </NodeViewWrapper>
  );
}

export const ImageWithResolvedSrc = Image.extend({
  addNodeView() {
    return ReactNodeViewRenderer(ImageView);
  },
});
