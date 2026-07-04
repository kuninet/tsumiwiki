import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { useState } from 'react';
import { embedSrcCandidates } from '../../lib/resolve-embed-src';
import { ObsidianEmbed } from './embed';

// ![[target]]の表示解決(FR-OBS-03)。画像拡張子は<img>で表示し、onErrorで
// 候補(同フォルダ→ルート→attachments/)を順に試す。画像以外は従来のチップ表示のまま。
// シリアライズ(embed.ts)には一切手を加えない

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp']);

function isImageTarget(target: string): boolean {
  const dot = target.lastIndexOf('.');
  if (dot < 0) return false;
  return IMAGE_EXTENSIONS.has(target.slice(dot).toLowerCase());
}

interface TsumiwikiDocStorage {
  folder?: string;
}

function ObsidianEmbedView({ node, editor }: NodeViewProps) {
  const target = node.attrs.target as string;
  const [candidateIndex, setCandidateIndex] = useState(0);

  if (!isImageTarget(target)) {
    return (
      <NodeViewWrapper as="span" className="obsidian-embed" contentEditable={false}>
        {`![[${target}]]`}
      </NodeViewWrapper>
    );
  }

  const docFolder = (editor.storage.tsumiwikiDoc as TsumiwikiDocStorage | undefined)?.folder ?? '';
  const candidates = embedSrcCandidates(target, docFolder);
  const exhausted = candidateIndex >= candidates.length;

  return (
    <NodeViewWrapper as="span" className="obsidian-embed-image" contentEditable={false}>
      {exhausted ? (
        <span className="obsidian-embed">{`![[${target}]]`}</span>
      ) : (
        <img
          src={candidates[candidateIndex]}
          alt={target}
          onError={() => setCandidateIndex((i) => i + 1)}
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
