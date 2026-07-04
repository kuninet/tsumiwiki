import { useEffect } from 'react';
import { useToastStore } from '../stores/toast';

const TOAST_DURATION_MS = 3000;

export function Toast() {
  const toast = useToastStore((s) => s.toast);
  const clear = useToastStore((s) => s.clear);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(clear, TOAST_DURATION_MS);
    return () => clearTimeout(timer);
  }, [toast, clear]);

  if (!toast) return null;

  const kindClass =
    toast.kind === 'success'
      ? 'bg-emerald-600 text-white'
      : 'bg-red-600 text-white';

  return (
    <div
      role="status"
      data-testid="toast"
      className={`fixed bottom-4 right-4 rounded px-4 py-2 text-sm shadow-lg ${kindClass}`}
    >
      {toast.message}
    </div>
  );
}
