import Image from '@tiptap/extension-image';
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { type MouseEvent as ReactMouseEvent, useEffect, useState } from 'react';
import {
  ATTACHMENT_CHANGED_EVENT,
  type AttachmentChangedDetail,
  withCacheBuster,
} from '../../lib/attachment-events';
import { imageFallbackSrc, isAbsoluteUrl, resolveImageSrc } from '../../lib/resolve-embed-src';
import type { TsumiwikiDocStorage } from '../doc-storage';

// 標準画像記法 ![alt](src) の表示解決(FR-OBS-03)。まず相対パスを文書フォルダ基準で
// /api/files/...に解決し、404(onError)ならsrcのファイル名だけで/api/embedに
// フォールバックする(#198)。それも失敗したら壊れた画像アイコンのまま。
// シリアライズ(Image拡張の標準実装)には触れない
//
// #199: 画像の管理メニュー(名前変更/削除/パスをコピー)。絶対URL、および
// フォールバックも失敗した「壊れた画像」状態には出さない

function basenameOf(pathOrSrc: string): string {
  const withoutQueryOrHash = pathOrSrc.split(/[?#]/, 1)[0] ?? '';
  const idx = withoutQueryOrHash.lastIndexOf('/');
  return idx === -1 ? withoutQueryOrHash : withoutQueryOrHash.slice(idx + 1);
}

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
  // フォールバックも失敗し「壊れた画像アイコン」のまま表示している状態(brokenSrcと同じ理由でtarget差し替えに追随)
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null);
  const broken = brokenSrc === src;
  // #199実機確認: 削除/リネーム後、ブラウザが同じURLの<img>を再取得しないため
  // 古い画像が残り続ける不具合への対応。ATTACHMENT_CHANGED_EVENTを受けたら
  // このノードのbasenameが対象に含まれる場合だけ再取得(キャッシュバスター付与)する
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    function handleAttachmentChanged(e: Event) {
      const detail = (e as CustomEvent<AttachmentChangedDetail>).detail;
      if (!detail?.names.some((name) => name.toLowerCase() === basenameOf(src).toLowerCase())) {
        return;
      }
      setFailedSrc(null);
      setBrokenSrc(null);
      setReloadKey((k) => k + 1);
    }
    window.addEventListener(ATTACHMENT_CHANGED_EVENT, handleAttachmentChanged);
    return () => window.removeEventListener(ATTACHMENT_CHANGED_EVENT, handleAttachmentChanged);
  }, [src]);

  const fallback = imageFallbackSrc(src, docPath);
  const resolvedSrc = stage === 'primary' ? resolveImageSrc(src, docFolder) : (fallback ?? src);
  const currentSrc = isAbsoluteUrl(resolvedSrc)
    ? resolvedSrc
    : withCacheBuster(resolvedSrc, reloadKey);

  function handleError() {
    if (stage === 'primary' && fallback !== null) {
      setFailedSrc(src);
      return;
    }
    // fallback段階(またはフォールバック先が無い)での失敗は何もしない=壊れた画像アイコンのまま
    setBrokenSrc(src);
  }

  const showMenu = !isAbsoluteUrl(src) && !broken;

  function openMenu(x: number, y: number) {
    docStorage?.openAttachmentMenu?.({ target: src, kind: 'image', x, y });
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

  return (
    <NodeViewWrapper as="span" className="tiptap-image">
      <span className="attachment-frame" onContextMenu={handleContextMenu}>
        <img src={currentSrc} alt={alt} title={title} onError={handleError} />
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
    </NodeViewWrapper>
  );
}

export const ImageWithResolvedSrc = Image.extend({
  addNodeView() {
    return ReactNodeViewRenderer(ImageView);
  },
});
