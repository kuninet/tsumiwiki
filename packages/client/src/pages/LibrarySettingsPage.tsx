import type { LibrarySettings } from '@tsumiwiki/shared';
import { useEffect, useState } from 'react';
import { useLibrarySettings, useUpdateLibrarySettings } from '../api/library-settings';

// #84 Phase 1: ライブラリ全体のテンプレート・デイリーノート設定編集画面(admin専用)。
// 一般ユーザーからも API 経由で読み取れるが、更新は admin のみ。UI は RequireAdmin で保護。

export function LibrarySettingsPage() {
  const { data, isLoading } = useLibrarySettings();
  const update = useUpdateLibrarySettings();
  const [form, setForm] = useState<LibrarySettings | null>(null);

  useEffect(() => {
    if (data) setForm(data.settings);
  }, [data]);

  function handleChange<K extends keyof LibrarySettings, F extends keyof LibrarySettings[K]>(
    section: K,
    field: F,
    value: LibrarySettings[K][F],
  ) {
    setForm((prev) => (prev ? { ...prev, [section]: { ...prev[section], [field]: value } } : prev));
  }

  function handleSave() {
    if (!form) return;
    update.mutate(form);
  }

  return (
    <div className="mx-auto max-w-[720px] p-8">
      <h1 className="text-h1 font-bold text-ink">ライブラリ設定</h1>
      <p className="mt-2 text-sm text-ink-faint">
        テンプレート・デイリーノートの共通設定です。ライブラリ全体で共有されます。
      </p>

      {isLoading && <p className="mt-6 text-sm text-ink-faint">読み込み中...</p>}

      {data?.corrupted === true && (
        <div
          role="alert"
          className="mt-6 rounded border border-warning bg-warning/10 px-4 py-3 text-sm text-ink"
        >
          <p className="font-medium text-warning">
            設定ファイル(.tsumiwiki/settings.yaml)を読み込めませんでした。表示されているのは初期値です。
          </p>
          <p className="mt-1 text-ink-soft">
            このまま保存すると git 上の正しい過去版が上書きされます。ファイルを直接修復するか、履歴から復元してください。
          </p>
        </div>
      )}

      {form && (
        <div className="mt-6 space-y-8">
          <section>
            <h2 className="text-base font-bold text-ink">テンプレート</h2>
            <p className="mt-1 text-xs text-ink-faint">
              このフォルダ配下の <span className="font-mono">.md</span> がテンプレとして扱われます。
            </p>
            <label className="mt-3 block text-sm font-medium text-ink-soft">
              テンプレートフォルダ
              <input
                type="text"
                value={form.templates.folder}
                onChange={(e) => handleChange('templates', 'folder', e.target.value)}
                placeholder="_templates"
                className="mt-1 w-full rounded border border-line bg-panel-2 px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
              />
            </label>
          </section>

          <section>
            <h2 className="text-base font-bold text-ink">デイリーノート</h2>
            <p className="mt-1 text-xs text-ink-faint">
              「今日の日誌」ボタンで作成されるノートの規約です。ファイル名パターンで
              <span className="mx-1 font-mono">YYYY-MM-DD</span>や
              <span className="mx-1 font-mono">YYYY-MM</span>等の日付書式が使えます。
              曜日は<span className="mx-1 font-mono">aaa</span>(月/火/…)や
              <span className="mx-1 font-mono">aaaa</span>(月曜日/…)、
              英語なら<span className="mx-1 font-mono">ddd</span>(Mon)/
              <span className="mx-1 font-mono">dddd</span>(Monday)で埋め込めます
              (例: <span className="font-mono">YYYY-MM-DD(aaa)</span>)。
            </p>
            <label className="mt-3 block text-sm font-medium text-ink-soft">
              作成先フォルダ
              <input
                type="text"
                value={form.dailyNotes.folder}
                onChange={(e) => handleChange('dailyNotes', 'folder', e.target.value)}
                placeholder="日記"
                className="mt-1 w-full rounded border border-line bg-panel-2 px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
              />
            </label>
            <label className="mt-3 block text-sm font-medium text-ink-soft">
              適用するテンプレート
              <input
                type="text"
                value={form.dailyNotes.template}
                onChange={(e) => handleChange('dailyNotes', 'template', e.target.value)}
                placeholder="_templates/日誌.md"
                className="mt-1 w-full rounded border border-line bg-panel-2 px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
              />
              <span className="mt-1 block text-xs text-ink-faint">
                空にすると空白のノートが作られます。
              </span>
            </label>
            <label className="mt-3 block text-sm font-medium text-ink-soft">
              ファイル名パターン
              <input
                type="text"
                value={form.dailyNotes.filenamePattern}
                onChange={(e) => handleChange('dailyNotes', 'filenamePattern', e.target.value)}
                placeholder="YYYY-MM-DD"
                className="mt-1 w-full rounded border border-line bg-panel-2 px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
              />
            </label>
          </section>

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={handleSave}
              disabled={update.isPending}
              className="rounded bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              保存
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
