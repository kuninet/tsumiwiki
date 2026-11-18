import { useQueryClient } from '@tanstack/react-query';
import {
  LIBRARY_SETTINGS_DEFAULTS,
  librarySettingsSchema,
  normalizeAttachmentFolder,
  type AttachmentDirMode,
  type LibrarySettings,
} from '@tsumiwiki/shared';
import { useEffect, useState } from 'react';
import {
  LIBRARY_SETTINGS_QUERY_KEY,
  useLibrarySettings,
  useUpdateLibrarySettings,
} from '../api/library-settings';

// #84 Phase 1: ライブラリ全体のテンプレート・デイリーノート等設定編集画面(admin専用)。
// 一般ユーザーからも API 経由で読み取れるが、更新は admin のみ。UI は RequireAdmin で保護。

const ATTACHMENT_MODES: { value: AttachmentDirMode; label: string; description: string }[] = [
  {
    value: 'same-folder',
    label: '文書と同じフォルダ（既定）',
    description: '各文書と同じフォルダに直接保存します。',
  },
  {
    value: 'vault-folder',
    label: 'ライブラリ全体で 1 つのフォルダ',
    description: 'すべての添付を指定した 1 つのフォルダへまとめて保存します。',
  },
  {
    value: 'doc-subfolder',
    label: '文書のフォルダ直下のサブフォルダ',
    description: '文書があるフォルダの下にサブフォルダを作って保存します。',
  },
];

function previewAttachmentPath(mode: AttachmentDirMode, folder: string): string {
  const sample = 'image-20261118110000.png';
  const norm = normalizeAttachmentFolder(folder) || '<フォルダ名>';
  if (mode === 'same-folder') return `企画/${sample}`;
  if (mode === 'vault-folder') return `${norm}/${sample}`;
  return `企画/${norm}/${sample}`;
}

function validateAttachmentField(form: LibrarySettings | null): string | null {
  if (!form) return null;
  const parsed = librarySettingsSchema.safeParse(form);
  if (parsed.success) return null;
  const issue = parsed.error.issues.find((i) => i.path[0] === 'attachments');
  return issue?.message ?? null;
}

export function LibrarySettingsPage() {
  const { data, isLoading } = useLibrarySettings();
  const update = useUpdateLibrarySettings();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<LibrarySettings | null>(null);

  // #99: admin が settings.yaml を手動で修復した後、キャッシュを更新して再取得するための導線
  function handleReload() {
    void queryClient.invalidateQueries({ queryKey: LIBRARY_SETTINGS_QUERY_KEY });
  }

  useEffect(() => {
    if (data) {
      setForm({
        ...data.settings,
        attachments: data.settings.attachments ?? LIBRARY_SETTINGS_DEFAULTS.attachments,
      });
    }
  }, [data]);

  function handleChange<K extends keyof LibrarySettings, F extends keyof LibrarySettings[K]>(
    section: K,
    field: F,
    value: LibrarySettings[K][F],
  ) {
    setForm((prev) => (prev ? { ...prev, [section]: { ...prev[section], [field]: value } } : prev));
  }

  const attachmentFolderError = validateAttachmentField(form);

  function handleSave() {
    if (!form || attachmentFolderError) return;
    update.mutate(form);
  }

  return (
    <div className="mx-auto max-w-[720px] p-8">
      <h1 className="text-h1 font-bold text-ink">ライブラリ設定</h1>
      <p className="mt-2 text-sm text-ink-faint">
        テンプレート・デイリーノート・添付ファイルの共通設定です。ライブラリ全体で共有されます。
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
          <button
            type="button"
            onClick={handleReload}
            className="mt-2 rounded border border-warning px-3 py-1 text-xs font-medium text-warning hover:bg-warning/20"
          >
            再読込
          </button>
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

          <section>
            <h2 className="text-base font-bold text-ink">添付ファイル</h2>
            <p className="mt-1 text-xs text-ink-faint">
              画像や PDF
              を貼り付け・ドロップしたときの保存先を設定します（既存の添付ファイルは移動しません）。
            </p>
            <fieldset className="mt-3 space-y-2">
              <legend className="text-sm font-medium text-ink-soft">保存先の決め方</legend>
              {ATTACHMENT_MODES.map((opt) => {
                const selected = form.attachments.mode === opt.value;
                return (
                  <label
                    key={opt.value}
                    className={`flex cursor-pointer items-start gap-2.5 rounded border px-3 py-2.5 text-sm transition-colors ${
                      selected
                        ? 'border-accent bg-accent/10'
                        : 'border-line bg-panel-2 hover:border-accent/60'
                    }`}
                  >
                    <input
                      type="radio"
                      name="attachment-dir-mode"
                      value={opt.value}
                      checked={selected}
                      onChange={() => handleChange('attachments', 'mode', opt.value)}
                      className="mt-0.5 accent-accent"
                    />
                    <span>
                      <span className="block font-medium text-ink">{opt.label}</span>
                      <span className="block text-xs text-ink-faint">{opt.description}</span>
                    </span>
                  </label>
                );
              })}
            </fieldset>

            <label className="mt-3 block text-sm font-medium text-ink-soft">
              添付フォルダ名
              <input
                type="text"
                value={form.attachments.folder}
                onChange={(e) => handleChange('attachments', 'folder', e.target.value)}
                disabled={form.attachments.mode === 'same-folder'}
                placeholder="attachments"
                className="mt-1 w-full rounded border border-line bg-panel-2 px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
              />
            </label>
            {attachmentFolderError && (
              <p data-testid="attachment-folder-error" className="mt-1 text-xs text-danger">
                {attachmentFolderError}
              </p>
            )}

            <p
              data-testid="attachment-path-preview"
              className="mt-2 rounded bg-panel-2 px-3 py-2 text-xs text-ink-soft"
            >
              例: <span className="font-mono">企画/メモ.md</span> に画像を添付 →{' '}
              <span className="font-mono font-medium text-ink">
                {previewAttachmentPath(form.attachments.mode, form.attachments.folder)}
              </span>
            </p>
          </section>

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={handleSave}
              disabled={update.isPending || attachmentFolderError !== null}
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
