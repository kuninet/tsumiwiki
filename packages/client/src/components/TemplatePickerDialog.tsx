import { type FormEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import type { TemplateSummary } from '@tsumiwiki/shared';
import { useTemplates } from '../api/templates';

// #84 Phase B/C: テンプレート選択モーダル。
// 2 段階の UI:
//   Step 1: テンプレ一覧 + インクリメンタル絞り込み(↑↓/Enter/Esc に対応)
//   Step 2: mode='create' → 新規文書のタイトル + 作成先フォルダ(Phase B)
//           mode='apply'  → 挿入 / 追記 の 2 ボタン(Phase C。既存文書へ流し込む)
// フィルタは `name` / `path` の部分一致で緩めに拾う。IME 変換確定中の Enter は無視する。

export type TemplatePickerResult =
  | {
      mode: 'create';
      templatePath: string;
      title: string;
      // 空文字なら「未指定」= サーバー側で frontmatter → ライブラリ直下 の順にフォールバック
      targetFolder: string;
    }
  | {
      mode: 'apply';
      templatePath: string;
      applyMode: 'insert' | 'append';
    };

interface TemplatePickerDialogProps {
  // 既定は 'create'(#84 Phase B の従来挙動)
  mode?: 'create' | 'apply';
  onSubmit: (result: TemplatePickerResult) => void;
  onCancel: () => void;
}

export function TemplatePickerDialog({
  mode = 'create',
  onSubmit,
  onCancel,
}: TemplatePickerDialogProps) {
  const { data, isLoading, error } = useTemplates();
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [selected, setSelected] = useState<TemplateSummary | null>(null);
  const [title, setTitle] = useState('');
  const [targetFolder, setTargetFolder] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const insertBtnRef = useRef<HTMLButtonElement>(null);

  const filtered = useMemo(() => {
    const list = data?.templates ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (t) => t.name.toLowerCase().includes(q) || t.path.toLowerCase().includes(q),
    );
  }, [data, query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, data]);

  useEffect(() => {
    if (selected) {
      // apply モードでは「挿入」ボタンに、create モードではタイトル欄にフォーカス
      if (mode === 'apply') {
        insertBtnRef.current?.focus();
      } else {
        titleRef.current?.focus();
      }
    } else {
      searchRef.current?.focus();
    }
  }, [selected, mode]);

  function pickTemplate(t: TemplateSummary) {
    setSelected(t);
    setTitle('');
    setTargetFolder(t.targetFolder ?? '');
  }

  function handleListKey(e: KeyboardEvent<HTMLInputElement>) {
    // IME 変換中の Enter/矢印は無視する(検索ボックス側と同じ方針)
    if (e.nativeEvent.isComposing) return;
    // Escape はダイアログ全体の onKeyDown で拾うのでここでは扱わない
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const target = filtered[activeIndex];
      if (target) pickTemplate(target);
    }
  }

  function handleTitleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!selected) return;
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return;
    onSubmit({
      mode: 'create',
      templatePath: selected.path,
      title: trimmedTitle,
      targetFolder: targetFolder.trim(),
    });
  }

  function submitApply(applyMode: 'insert' | 'append') {
    if (!selected) return;
    onSubmit({ mode: 'apply', templatePath: selected.path, applyMode });
  }

  // 中#2: Step 2 でも Escape でモーダルを閉じられるようにダイアログ全体で拾う
  //       (Step 1 は検索ボックスの onKeyDown で拾っているのでそちらを優先)
  function handleDialogKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  }

  const dialogLabel = mode === 'apply' ? 'テンプレートを適用' : 'テンプレートから新規作成';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={dialogLabel}
      className="fixed inset-0 z-[80] flex items-start justify-center bg-black/40 px-4 pt-24 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      onKeyDown={handleDialogKey}
    >
      <div className="w-full max-w-lg rounded-lg border border-line bg-panel shadow-lg">
        {!selected ? (
          <div className="flex flex-col">
            <div className="border-b border-line p-3">
              <input
                ref={searchRef}
                type="text"
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleListKey}
                placeholder="テンプレートを絞り込み..."
                aria-label="テンプレートを絞り込み"
                className="w-full rounded border border-line bg-panel-2 px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
              />
            </div>
            <ul
              role="listbox"
              aria-label="テンプレート一覧"
              className="max-h-80 overflow-y-auto"
            >
              {isLoading && (
                <li className="px-4 py-3 text-sm text-ink-faint">読み込み中...</li>
              )}
              {error && (
                <li className="px-4 py-3 text-sm text-red-500">
                  テンプレート一覧の取得に失敗しました
                </li>
              )}
              {!isLoading && !error && filtered.length === 0 && (
                <li className="px-4 py-3 text-sm text-ink-faint">
                  {(data?.templates.length ?? 0) === 0
                    ? 'テンプレートがありません。設定でフォルダを確認してください'
                    : '該当するテンプレートがありません'}
                </li>
              )}
              {filtered.map((t, i) => (
                <li key={t.path}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === activeIndex}
                    onMouseEnter={() => setActiveIndex(i)}
                    onClick={() => pickTemplate(t)}
                    className={`flex w-full flex-col items-start gap-0.5 px-4 py-2 text-left text-sm ${
                      i === activeIndex ? 'bg-active text-accent' : 'text-ink hover:bg-hoverbg'
                    }`}
                  >
                    <span className="font-medium">{t.name}</span>
                    <span className="text-xs text-ink-faint">
                      {t.path}
                      {mode === 'create' && t.targetFolder ? ` → ${t.targetFolder}/` : ''}
                    </span>
                    {t.description && (
                      <span className="text-xs text-ink-soft">{t.description}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
            <div className="flex justify-end gap-2 border-t border-line p-3">
              <button
                type="button"
                onClick={onCancel}
                className="rounded border border-line px-3 py-1.5 text-sm text-ink-soft hover:bg-hoverbg"
              >
                キャンセル
              </button>
            </div>
          </div>
        ) : mode === 'apply' ? (
          <div className="p-6">
            <h2 className="mb-1 text-base font-bold text-ink">テンプレートを適用</h2>
            <p className="mb-4 text-xs text-ink-faint">{selected.path}</p>
            <p className="mb-4 text-sm text-ink-soft">
              現在の編集中文書のどこにテンプレートを流し込みますか?
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="rounded border border-line px-3 py-1.5 text-sm text-ink-soft hover:bg-hoverbg"
              >
                戻る
              </button>
              <button
                type="button"
                onClick={() => submitApply('append')}
                className="rounded border border-line px-3 py-1.5 text-sm text-ink-soft hover:bg-hoverbg"
                title="文書の末尾に追記します"
              >
                追記
              </button>
              <button
                ref={insertBtnRef}
                type="button"
                onClick={() => submitApply('insert')}
                className="rounded bg-accent px-3 py-1.5 text-sm text-white hover:bg-accent-hover"
                title="カーソル位置に挿入します"
              >
                挿入
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleTitleSubmit} className="p-6">
            <h2 className="mb-1 text-base font-bold text-ink">テンプレートから新規作成</h2>
            <p className="mb-4 text-xs text-ink-faint">{selected.path}</p>

            <label htmlFor="template-title" className="block text-sm font-medium text-ink-soft">
              タイトル
            </label>
            <input
              ref={titleRef}
              id="template-title"
              type="text"
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              // 中#1: IME 変換確定 Enter で form submit が走ると意図せず新規作成される
              onKeyDown={(e) => {
                if (e.key === 'Enter' && e.nativeEvent.isComposing) e.preventDefault();
              }}
              placeholder="新規文書のタイトル"
              className="mt-1 w-full rounded border border-line bg-panel-2 px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
            />

            <label
              htmlFor="template-target-folder"
              className="mt-4 block text-sm font-medium text-ink-soft"
            >
              作成先フォルダ
            </label>
            <input
              id="template-target-folder"
              type="text"
              value={targetFolder}
              onChange={(e) => setTargetFolder(e.target.value)}
              placeholder="(空欄でライブラリ直下)"
              className="mt-1 w-full rounded border border-line bg-panel-2 px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
            />
            {selected.targetFolder && (
              <p className="mt-1 text-xs text-ink-faint">
                テンプレの target_folder: {selected.targetFolder}
              </p>
            )}

            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="rounded border border-line px-3 py-1.5 text-sm text-ink-soft hover:bg-hoverbg"
              >
                戻る
              </button>
              <button
                type="submit"
                disabled={!title.trim()}
                className="rounded bg-accent px-3 py-1.5 text-sm text-white hover:bg-accent-hover disabled:opacity-50"
              >
                作成
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
