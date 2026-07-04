import { type FormEvent, useId, useState } from 'react';

// テキスト入力を伴う確認モーダル(新規文書・新規フォルダ・リネームで共用。
// 設計04章4.2・デザインhandoff components.md)

interface PromptDialogProps {
  title: string;
  label: string;
  defaultValue?: string;
  confirmLabel?: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
  // パスワード入力等に使う。既定はtext
  inputType?: 'text' | 'password';
  autoComplete?: string;
}

export function PromptDialog({
  title,
  label,
  defaultValue = '',
  confirmLabel = 'OK',
  onConfirm,
  onCancel,
  inputType = 'text',
  autoComplete,
}: PromptDialogProps) {
  const inputId = useId();
  const [value, setValue] = useState(defaultValue);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    onConfirm(trimmed);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 backdrop-blur-sm"
    >
      <form onSubmit={handleSubmit} className="w-80 rounded-lg border border-line bg-panel p-6 shadow-lg">
        <h2 className="mb-4 text-base font-bold text-ink">{title}</h2>
        <label htmlFor={inputId} className="block text-sm font-medium text-ink-soft">
          {label}
        </label>
        <input
          type={inputType}
          autoComplete={autoComplete}
          id={inputId}
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="mt-1 w-full rounded border border-line bg-panel-2 px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
        />
        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-line px-3 py-1.5 text-sm text-ink-soft hover:bg-hoverbg"
          >
            キャンセル
          </button>
          <button
            type="submit"
            className="rounded bg-accent px-3 py-1.5 text-sm text-white hover:bg-accent-hover"
          >
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
