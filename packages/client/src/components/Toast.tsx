import { useEffect } from 'react';
import { useToastStore, type ToastKind } from '../stores/toast';

// トースト通知(デザインhandoff components.md)。右下・panel背景・アイコン+本文。
// error(danger扱い)は自動消滅せず、×ボタンでの手動クローズのみ

const TOAST_DURATION_MS = 3000;

const KIND_STYLE: Record<ToastKind, { icon: string; text: string }> = {
  success: { icon: '✓', text: 'text-success' },
  info: { icon: 'ℹ', text: 'text-info' },
  warning: { icon: '⚠', text: 'text-warning' },
  error: { icon: '✕', text: 'text-danger' },
};

export function Toast() {
  const toast = useToastStore((s) => s.toast);
  const clear = useToastStore((s) => s.clear);

  useEffect(() => {
    if (!toast) return;
    if (toast.kind === 'error') return; // errorは手動クローズのみ(見逃し防止)
    const timer = setTimeout(clear, TOAST_DURATION_MS);
    return () => clearTimeout(timer);
  }, [toast, clear]);

  if (!toast) return null;

  const style = KIND_STYLE[toast.kind];

  return (
    <div
      role="status"
      data-testid="toast"
      className="fixed bottom-4 right-4 z-[60] flex max-w-sm items-start gap-2.5 rounded-lg border border-line bg-panel p-3.5 text-sm text-ink shadow-lg"
    >
      <span className={`flex-shrink-0 ${style.text}`} aria-hidden="true">
        {style.icon}
      </span>
      <span className="flex-1">{toast.message}</span>
      <button
        type="button"
        onClick={clear}
        aria-label="閉じる"
        className="flex-shrink-0 text-ink-faint hover:text-ink"
      >
        ×
      </button>
    </div>
  );
}
