import { type FormEvent, useId, useState } from 'react';

// テキスト入力を伴う確認モーダル(新規文書・新規フォルダ・リネームで共用。設計04章4.2)

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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
    >
      <form onSubmit={handleSubmit} className="w-80 rounded-lg bg-white p-6 shadow-lg">
        <h2 className="mb-4 text-lg font-bold text-gray-800">{title}</h2>
        <label htmlFor={inputId} className="block text-sm font-medium text-gray-700">
          {label}
        </label>
        <input
          type={inputType}
          autoComplete={autoComplete}
          id={inputId}
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
        />
        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
          >
            キャンセル
          </button>
          <button
            type="submit"
            className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700"
          >
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
