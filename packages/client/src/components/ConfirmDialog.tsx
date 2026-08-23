// 削除など取り消しにくい操作向けの確認モーダル(設計04章4.2・デザインhandoff components.md)

interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  // 破壊的操作は既定のdanger、下書き復元など非破壊にはprimaryを指定する
  variant?: 'danger' | 'primary';
  // #199: 削除確認で参照文書数の取得中など、確定操作をまだ受け付けられない間は
  // 確定ボタンを無効化する(中#7)。省略時はfalse(既定挙動互換)
  confirmDisabled?: boolean;
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = '削除',
  cancelLabel = 'キャンセル',
  onConfirm,
  onCancel,
  variant = 'danger',
  confirmDisabled = false,
}: ConfirmDialogProps) {
  const confirmClass =
    variant === 'primary'
      ? 'rounded bg-accent px-3 py-1.5 text-sm text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50'
      : 'rounded bg-danger px-3 py-1.5 text-sm text-white hover:bg-danger-hover disabled:cursor-not-allowed disabled:opacity-50';
  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 backdrop-blur-sm"
    >
      <div className="w-80 rounded-lg border border-line bg-panel p-6 shadow-lg">
        <h2 className="mb-2 text-base font-bold text-ink">{title}</h2>
        <p className="text-sm text-ink-soft">{message}</p>
        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-line px-3 py-1.5 text-sm text-ink-soft hover:bg-hoverbg"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={confirmDisabled}
            className={confirmClass}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
