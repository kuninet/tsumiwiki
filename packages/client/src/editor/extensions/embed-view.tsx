import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { type MouseEvent as ReactMouseEvent, useEffect, useState } from 'react';
import {
  ATTACHMENT_CHANGED_EVENT,
  type AttachmentChangedDetail,
  getAttachmentGeneration,
  withCacheBuster,
} from '../../lib/attachment-events';
import {
  embedSrc,
  isAbsoluteUrl,
  isImageFile,
  isPdfFile,
  parseEmbedTarget,
} from '../../lib/resolve-embed-src';
import type { TsumiwikiDocStorage } from '../doc-storage';
import { ObsidianEmbed } from './embed';

// ![[target]]の表示解決(FR-OBS-03)。画像拡張子はサーバーの添付索引(attachment_index)を
// 使う/api/embed?target=&from=に1回のリクエストで解決して<img>表示、PDFは同じ解決先を
// <iframe>で表示する(#198/#204)。`|幅` `|幅x高さ`は表示サイズに反映し、`#anchor`は
// PDFのみ`#page=N`等としてiframe srcに引き継ぐ(画像では未使用)。別名指定(`|別名`)は解決に使わない。
// 画像・PDF以外は従来どおりチップ表示のまま。シリアライズ(embed.ts)には一切手を加えない
//
// #199: 画像・PDFの管理メニュー(名前変更/削除/パスをコピー)。右クリックまたは「⋯」ボタンで
// DocView側(editor.storage.tsumiwikiDoc.openAttachmentMenu)にメニュー表示を依頼する。
// 絶対URL(http/https/data)には出さない(添付索引の管理対象外のため)。
// PDFは iframe がホバー/右クリックを吸うため、ボタンを常時表示(--persistent)にして
// 「見えない・押せない」状態を回避する(#204)

function basenameOf(pathOrTarget: string): string {
  const idx = pathOrTarget.lastIndexOf('/');
  return idx === -1 ? pathOrTarget : pathOrTarget.slice(idx + 1);
}

function ObsidianEmbedView({ node, editor }: NodeViewProps) {
  const target = node.attrs.target as string;
  const { file, width, height, anchor } = parseEmbedTarget(target);
  // targetが変わっても(同位置ノードのattrs更新)ReactのNodeViewインスタンスは
  // 再利用されuseStateが残るため、「どのtargetで失敗したか」を持ち、target変更時は
  // 描画と同時に失敗状態が解ける(image-viewと同じ方式)。PDF(iframe)はonErrorが効かないため
  // failedTargetは画像のみで使う
  const [failedTarget, setFailedTarget] = useState<string | null>(null);
  const failed = failedTarget === target;
  // #199実機確認: 削除/リネーム後、ブラウザが同じURLの<img>を再取得しないため
  // 古い画像が残り続ける不具合への対応。ATTACHMENT_CHANGED_EVENTを受けたら
  // このノードのbasenameが対象に含まれる場合だけ再取得(キャッシュバスター付与)する。
  // #199軽微4: reloadKeyの初期値もモジュールスコープの世代カウンタから読むことで、
  // タブ切替等でこのNodeViewが再マウントされても`v=`が失われず、HTTPキャッシュ
  // (max-age=60)から消えた画像が再表示されてしまう問題を避ける
  const [reloadKey, setReloadKey] = useState(() => getAttachmentGeneration(basenameOf(file)));

  useEffect(() => {
    setReloadKey(getAttachmentGeneration(basenameOf(file)));
    function handleAttachmentChanged(e: Event) {
      const detail = (e as CustomEvent<AttachmentChangedDetail>).detail;
      if (!detail?.names.some((name) => name.toLowerCase() === basenameOf(file).toLowerCase())) {
        return;
      }
      setFailedTarget(null);
      setReloadKey(getAttachmentGeneration(basenameOf(file)));
    }
    window.addEventListener(ATTACHMENT_CHANGED_EVENT, handleAttachmentChanged);
    return () => window.removeEventListener(ATTACHMENT_CHANGED_EVENT, handleAttachmentChanged);
  }, [file]);

  const docStorage = editor.storage.tsumiwikiDoc as TsumiwikiDocStorage | undefined;
  const docPath = docStorage?.path ?? '';
  const showMenu = !isAbsoluteUrl(file);

  function openMenu(x: number, y: number) {
    docStorage?.openAttachmentMenu?.({ target: file, kind: 'embed', x, y });
  }

  function handleContextMenu(e: ReactMouseEvent) {
    if (!showMenu) return;
    e.preventDefault();
    openMenu(e.clientX, e.clientY);
  }

  function handleMenuButtonClick(e: ReactMouseEvent<HTMLButtonElement>) {
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    openMenu(rect.left, rect.bottom);
  }

  if (isPdfFile(file)) {
    // PDF は iframe がホバー・右クリック・クリック全てを吸うため、`.attachment-frame:hover`
    // が発火せずメニューボタンが見えない・押せない。--persistent 修飾で常時表示にする
    return (
      <NodeViewWrapper as="span" className="obsidian-embed-pdf-wrapper" contentEditable={false}>
        <span
          className="attachment-frame attachment-frame--persistent"
          onContextMenu={handleContextMenu}
        >
          <iframe
            src={embedSrc(file, docPath, { anchor })}
            title={file}
            width={width ?? '100%'}
            height={height ?? 600}
            className="obsidian-embed-pdf"
            loading="lazy"
          />
          {showMenu && (
            <button
              type="button"
              className="attachment-menu-button"
              aria-label="PDFメニュー"
              aria-haspopup="menu"
              contentEditable={false}
              onClick={handleMenuButtonClick}
            >
              ⋯
            </button>
          )}
        </span>
      </NodeViewWrapper>
    );
  }

  if (!isImageFile(file)) {
    return (
      <NodeViewWrapper as="span" className="obsidian-embed" contentEditable={false}>
        {`![[${target}]]`}
      </NodeViewWrapper>
    );
  }

  const src = isAbsoluteUrl(file)
    ? embedSrc(file, docPath)
    : withCacheBuster(embedSrc(file, docPath), reloadKey);

  return (
    <NodeViewWrapper as="span" className="obsidian-embed-image" contentEditable={false}>
      {failed ? (
        <span className="obsidian-embed">{`![[${target}]]`}</span>
      ) : (
        <span className="attachment-frame" onContextMenu={handleContextMenu}>
          <img
            src={src}
            alt={file}
            width={width}
            height={height}
            onError={() => setFailedTarget(target)}
          />
          {showMenu && (
            <button
              type="button"
              className="attachment-menu-button"
              aria-label="画像メニュー"
              aria-haspopup="menu"
              contentEditable={false}
              onClick={handleMenuButtonClick}
            >
              ⋯
            </button>
          )}
        </span>
      )}
    </NodeViewWrapper>
  );
}

export const ObsidianEmbedWithPreview = ObsidianEmbed.extend({
  addNodeView() {
    return ReactNodeViewRenderer(ObsidianEmbedView);
  },
});
