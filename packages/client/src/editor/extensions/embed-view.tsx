import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { useState } from 'react';
import { embedSrc, parseEmbedTarget } from '../../lib/resolve-embed-src';
import type { TsumiwikiDocStorage } from '../doc-storage';
import { ObsidianEmbed } from './embed';

// ![[target]]の表示解決(FR-OBS-03)。画像拡張子はサーバーの添付索引(attachment_index)を
// 使う/api/embed?target=&from=に1回のリクエストで解決して<img>表示する(#198)。
// `|幅` `|幅x高さ`は表示サイズに反映し、`#anchor`・別名指定(`|別名`)は解決に使わない。
// 画像以外は従来どおりチップ表示のまま。シリアライズ(embed.ts)には一切手を加えない

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp']);

function isImageTarget(file: string): boolean {
  const dot = file.lastIndexOf('.');
  if (dot < 0) return false;
  return IMAGE_EXTENSIONS.has(file.slice(dot).toLowerCase());
}

function ObsidianEmbedView({ node, editor }: NodeViewProps) {
  const target = node.attrs.target as string;
  const { file, width, height } = parseEmbedTarget(target);
  // targetが変わっても(同位置ノードのattrs更新)ReactのNodeViewインスタンスは
  // 再利用されuseStateが残るため、「どのtargetで失敗したか」を持ち、target変更時は
  // 描画と同時に失敗状態が解ける(image-viewと同じ方式)
  const [failedTarget, setFailedTarget] = useState<string | null>(null);
  const failed = failedTarget === target;

  if (!isImageTarget(file)) {
    return (
      <NodeViewWrapper as="span" className="obsidian-embed" contentEditable={false}>
        {`![[${target}]]`}
      </NodeViewWrapper>
    );
  }

  const docPath = (editor.storage.tsumiwikiDoc as TsumiwikiDocStorage | undefined)?.path ?? '';

  return (
    <NodeViewWrapper as="span" className="obsidian-embed-image" contentEditable={false}>
      {failed ? (
        <span className="obsidian-embed">{`![[${target}]]`}</span>
      ) : (
        <img
          src={embedSrc(file, docPath)}
          alt={file}
          width={width}
          height={height}
          onError={() => setFailedTarget(target)}
        />
      )}
    </NodeViewWrapper>
  );
}

export const ObsidianEmbedWithPreview = ObsidianEmbed.extend({
  addNodeView() {
    return ReactNodeViewRenderer(ObsidianEmbedView);
  },
});
