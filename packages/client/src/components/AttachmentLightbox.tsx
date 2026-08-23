import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

// 画像・PDFのクリックによる拡大表示(#211)。ProseMirror内から独立させるため
// document.bodyへPortal化する。フォーカス管理・Escape/背景クリックでの
// 閉じる導線・スクロールロックを自前で持つ(WAI-ARIA APG Modal Dialog Pattern に準拠)

export interface AttachmentLightboxProps {
  kind: 'image' | 'pdf';
  src: string;
  // 表示ラベル(未指定時はsrcのbasename)。srcにフルパス/URLがそのまま入ると
  // スクリーンリーダーがURLを読み上げるため、basenameへフォールバックする(レビュー軽微#12)
  alt?: string;
  onClose: () => void;
}

// Tab循環の対象。PDFの<iframe>はtabIndex=-1を付けてTabトラップから外す
// (WebKit/Chromium で iframe に一度Tabが渡ると親DOMに戻ってこないため。レビュー重大#3)
const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

function basenameOf(src: string): string {
  const withoutQuery = src.split(/[?#]/, 1)[0] ?? '';
  const idx = withoutQuery.lastIndexOf('/');
  const name = idx === -1 ? withoutQuery : withoutQuery.slice(idx + 1);
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

export function AttachmentLightbox({ kind, src, alt, onClose }: AttachmentLightboxProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  // 背景クリック検出用: mousedownがoverlay上で始まった場合のみ、mouseupで閉じる。
  // 画像上でmousedownしてoverlay上でmouseupすると click は共通祖先(overlay)で発火し
  // 意図せず閉じてしまうため(レビュー重大#4)
  const mouseDownOnOverlayRef = useRef(false);

  // 開いている間は背景のスクロールを止め、閉じたら元に戻す。
  // 開く直前にフォーカスされていた要素を保存し、閉じたら復元する(レビュー重大#2、a11y必須)
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    document.body.style.overflow = 'hidden';
    closeButtonRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus?.();
    };
  }, []);

  // Escapeはcapture=trueで最上位で先取りする。既定(bubble)だとProseMirror/TipTap側の
  // Escapeハンドラが先に stopPropagation してwindowまで届かず、lightboxが閉じない
  // ケースがある(レビュー重大#1)
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const focusable = cardRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [onClose]);

  function handleOverlayMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    mouseDownOnOverlayRef.current = e.target === overlayRef.current;
  }

  function handleOverlayClick(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === overlayRef.current && mouseDownOnOverlayRef.current) {
      onClose();
    }
  }

  const label = alt ?? (basenameOf(src) || 'プレビュー');

  return createPortal(
    <div
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      // iOS Safariのbodyスクロール抑止を強化(レビュー中#6)。touch-actionとoverscroll-behavior
      // でtouchmoveの伝播も止める
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70 p-6 touch-none overscroll-contain"
      onMouseDown={handleOverlayMouseDown}
      onClick={handleOverlayClick}
    >
      <div
        ref={cardRef}
        className="relative flex h-full max-h-[90vh] w-full max-w-5xl items-center justify-center"
      >
        <button
          ref={closeButtonRef}
          type="button"
          aria-label="閉じる"
          onClick={onClose}
          className="absolute -top-10 right-0 flex h-8 w-8 items-center justify-center rounded text-lg text-white hover:bg-white/10"
        >
          ×
        </button>
        {kind === 'image' ? (
          <img
            src={src}
            alt={label}
            style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
          />
        ) : (
          <iframe
            src={src}
            title={label}
            // Tabトラップから外す(iframe内から戻れないため。レビュー重大#3)
            tabIndex={-1}
            style={{ width: '100%', height: '100%', border: 0 }}
          />
        )}
      </div>
    </div>,
    document.body,
  );
}
