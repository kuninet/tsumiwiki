import { type FormEvent, type KeyboardEvent, useId, useState } from 'react';

// #189: 日付を指定して日誌を作成するためのダイアログ。
// input[type=date] のネイティブカレンダーUIを使う。ESC/オーバーレイクリックでの閉じ方は
// TemplatePickerDialog に揃える(PromptDialog/ConfirmDialogにはその2つがないため)。

function todayAsDateString(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

interface DatePickerDialogProps {
  open: boolean;
  initialDate?: string;
  onCancel: () => void;
  onConfirm: (date: string) => void;
  busy?: boolean;
}

// 選択可能な日付範囲。運用外のノイズ(0001年・9999年)を抑えるための緩いガード。
// 今日の ±100年 とし、境界に触れたい要件が出たら緩める
const DATE_RANGE_YEARS = 100;

function todayYearOffset(offset: number): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() + offset);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function DatePickerDialog({
  open,
  initialDate,
  onCancel,
  onConfirm,
  busy = false,
}: DatePickerDialogProps) {
  const inputId = useId();
  const titleId = useId();
  const [date, setDate] = useState(initialDate ?? todayAsDateString());

  if (!open) return null;

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!date || busy) return;
    onConfirm(date);
  }

  function handleDialogKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      onKeyDown={handleDialogKey}
    >
      <form onSubmit={handleSubmit} className="w-80 rounded-lg border border-line bg-panel p-6 shadow-lg">
        <h2 id={titleId} className="mb-4 text-base font-bold text-ink">
          日付を指定して日誌を作成
        </h2>
        <label htmlFor={inputId} className="block text-sm font-medium text-ink-soft">
          日付
        </label>
        <input
          type="date"
          id={inputId}
          autoFocus
          value={date}
          min={todayYearOffset(-DATE_RANGE_YEARS)}
          max={todayYearOffset(DATE_RANGE_YEARS)}
          onChange={(e) => setDate(e.target.value)}
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
            disabled={busy || !date}
            aria-busy={busy}
            className="rounded bg-accent px-3 py-1.5 text-sm text-white hover:bg-accent-hover disabled:opacity-50"
          >
            OK
          </button>
        </div>
      </form>
    </div>
  );
}
