import { useQueryClient } from '@tanstack/react-query';
import {
  ATTACHMENT_FOLDER_DEFAULT,
  LIBRARY_SETTINGS_DEFAULTS,
  librarySettingsSchema,
  normalizeAttachmentFolder,
  type AttachmentDirMode,
  type LibrarySettings,
  type ReorganizeExecuteResponse,
  type ReorganizePreviewResponse,
  type ReorganizeSkipReason,
} from '@tsumiwiki/shared';
import { useEffect, useState } from 'react';
import { previewReorganizeAttachments, useReorganizeAttachments } from '../api/attachments';
import { ApiRequestError } from '../api/client';
import {
  LIBRARY_SETTINGS_QUERY_KEY,
  useLibrarySettings,
  useUpdateLibrarySettings,
} from '../api/library-settings';
import { ConfirmDialog } from '../components/ConfirmDialog';

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

const SKIP_REASON_LABEL: Record<ReorganizeSkipReason, string> = {
  'already-in-place': '配置済み',
  'shared-across-folders': 'フォルダ横断共有',
  unreferenced: '未参照',
  'template-folder': 'テンプレート',
};

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

function settingsEqual(a: LibrarySettings, b: LibrarySettings): boolean {
  const attA = a.attachments ?? LIBRARY_SETTINGS_DEFAULTS.attachments;
  const attB = b.attachments ?? LIBRARY_SETTINGS_DEFAULTS.attachments;
  return (
    a.templates.folder === b.templates.folder &&
    a.dailyNotes.folder === b.dailyNotes.folder &&
    a.dailyNotes.template === b.dailyNotes.template &&
    a.dailyNotes.filenamePattern === b.dailyNotes.filenamePattern &&
    attA.mode === attB.mode &&
    attA.folder === attB.folder
  );
}

export function LibrarySettingsPage() {
  const { data, isLoading } = useLibrarySettings();
  const update = useUpdateLibrarySettings();
  const reorganizeMutation = useReorganizeAttachments();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<LibrarySettings | null>(null);
  const [moveSharedToCommonFolder, setMoveSharedToCommonFolder] = useState(false);
  const [preview, setPreview] = useState<ReorganizePreviewResponse | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [lastResult, setLastResult] = useState<ReorganizeExecuteResponse | null>(null);

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
    setPreview(null);
    setPreviewError(null);
  }

  const attachmentFolderError = validateAttachmentField(form);
  const savedSettings = data?.settings;
  const savedAttachments = savedSettings?.attachments ?? LIBRARY_SETTINGS_DEFAULTS.attachments;
  const isDirty =
    form !== null && savedSettings !== undefined && !settingsEqual(form, savedSettings);
  const commonFolderLabel = savedAttachments.folder || ATTACHMENT_FOLDER_DEFAULT;

  function handleSave() {
    if (!form || attachmentFolderError) return;
    update.mutate(form, {
      onSuccess: () => {
        setPreview(null);
        setPreviewError(null);
        setLastResult(null);
      },
    });
  }

  async function handlePreview() {
    if (isDirty || data?.corrupted) return;
    setPreviewLoading(true);
    setPreviewError(null);
    setLastResult(null);
    try {
      const res = await previewReorganizeAttachments({ moveSharedToCommonFolder });
      setPreview(res);
    } catch (err) {
      setPreview(null);
      setPreviewError(
        err instanceof ApiRequestError ? err.message : 'プレビューの取得に失敗しました',
      );
    } finally {
      setPreviewLoading(false);
    }
  }

  function handleExecuteConfirm() {
    reorganizeMutation.mutate(
      { moveSharedToCommonFolder },
      {
        onSuccess: (res) => {
          setConfirmOpen(false);
          setPreview(null);
          setLastResult(res);
        },
        onError: () => {
          setConfirmOpen(false);
        },
      },
    );
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
            このまま保存すると git
            上の正しい過去版が上書きされます。ファイルを直接修復するか、履歴から復元してください。
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
              <span className="mx-1 font-mono">YYYY-MM</span>等の日付書式が使えます。 曜日は
              <span className="mx-1 font-mono">aaa</span>(月/火/…)や
              <span className="mx-1 font-mono">aaaa</span>(月曜日/…)、 英語なら
              <span className="mx-1 font-mono">ddd</span>(Mon)/
              <span className="mx-1 font-mono">dddd</span>(Monday)で埋め込めます (例:{' '}
              <span className="font-mono">YYYY-MM-DD(aaa)</span>)。
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
              を貼り付け・ドロップしたときの保存先を設定します（設定の保存だけでは既存の添付ファイルは移動しません）。
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

          <section
            data-testid="reorganize-attachments-section"
            className="rounded-lg border border-line bg-panel p-5"
          >
            <h2 className="text-base font-bold text-ink">既存添付ファイルの整理</h2>
            <p className="mt-1 text-xs text-ink-faint">
              保存されている設定（
              <span className="font-mono">{savedAttachments.mode}</span>
              ）に沿って既存の画像・PDF を移動し、文書内のリンクを自動更新します。
            </p>

            {isDirty && (
              <p
                data-testid="reorganize-dirty-warning"
                className="mt-3 rounded border border-warning bg-warning/10 px-3 py-2 text-xs text-ink"
              >
                設定に未保存の変更があります。整理する前に「保存」してください。
              </p>
            )}

            {savedAttachments.mode !== 'vault-folder' && (
              <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm text-ink-soft">
                <input
                  type="checkbox"
                  checked={moveSharedToCommonFolder}
                  onChange={(e) => {
                    setMoveSharedToCommonFolder(e.target.checked);
                    setPreview(null);
                    setPreviewError(null);
                  }}
                  className="accent-accent"
                />
                <span>
                  フォルダ横断で共有されている添付を共通フォルダ（
                  <span className="font-mono">{commonFolderLabel}</span>
                  ）へまとめる
                </span>
              </label>
            )}

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handlePreview}
                disabled={
                  isDirty ||
                  data?.corrupted === true ||
                  previewLoading ||
                  reorganizeMutation.isPending
                }
                className="rounded border border-line bg-panel-2 px-3 py-1.5 text-sm font-medium text-ink hover:border-accent disabled:cursor-not-allowed disabled:opacity-50"
              >
                {previewLoading ? '確認中...' : '整理内容をプレビュー'}
              </button>
            </div>

            {previewError && (
              <p data-testid="reorganize-error" className="mt-2 text-xs text-danger">
                {previewError}
              </p>
            )}

            {lastResult && (
              <div
                data-testid="reorganize-result"
                className="mt-4 rounded border border-line bg-panel-2 px-3 py-2.5 text-xs text-ink"
              >
                <p className="font-medium">
                  整理を完了しました: 移動 {lastResult.moved.length} 件 / 文書リンク更新{' '}
                  {lastResult.rewrittenDocs.length} 件 / スキップ {lastResult.skippedCount} 件
                </p>
              </div>
            )}

            {preview && (
              <div data-testid="reorganize-preview" className="mt-4 space-y-4">
                <div className="grid grid-cols-2 gap-2 rounded bg-panel-2 p-3 text-xs sm:grid-cols-4">
                  <div>
                    <span className="text-ink-faint">対象合計: </span>
                    <span className="font-medium text-ink">
                      {preview.summary.totalAttachments} 件
                    </span>
                  </div>
                  <div>
                    <span className="text-ink-faint">移動予定: </span>
                    <span className="font-medium text-ink">{preview.summary.moveCount} 件</span>
                  </div>
                  <div>
                    <span className="text-ink-faint">自動リネーム: </span>
                    <span className="font-medium text-ink">{preview.summary.renameCount} 件</span>
                  </div>
                  <div>
                    <span className="text-ink-faint">文書更新: </span>
                    <span className="font-medium text-ink">
                      {preview.summary.rewriteDocCount} 件
                    </span>
                  </div>
                </div>
                <p className="text-xs text-ink-faint">
                  スキップ内訳: 配置済み {preview.summary.skipAlreadyInPlace} 件 / フォルダ横断共有{' '}
                  {preview.summary.skipShared} 件 / 未参照 {preview.summary.skipUnreferenced} 件 /
                  テンプレート {preview.summary.skipTemplate} 件
                </p>

                {preview.lockedWarnings.length > 0 && (
                  <div
                    data-testid="reorganize-lock-warning"
                    className="rounded border border-warning bg-warning/10 px-3 py-2.5 text-xs text-ink"
                  >
                    <p className="font-medium text-warning">
                      リンク更新が必要な文書が編集中（ロック中）のため、整理を実行できません。編集終了後に再試行してください。
                    </p>
                    <ul className="mt-1 list-disc pl-4 text-ink-soft">
                      {preview.lockedWarnings.map((w) => (
                        <li key={w.docPath}>
                          <span className="font-mono">{w.docPath}</span>（{w.displayName}）
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {preview.moves.length > 0 && (
                  <div>
                    <h3 className="text-xs font-bold text-ink-soft">
                      移動予定（{preview.moves.length} 件）
                    </h3>
                    <ul className="mt-1 max-h-48 space-y-1.5 overflow-y-auto rounded border border-line bg-panel-2 p-2.5 text-xs">
                      {preview.moves.map((m) => (
                        <li key={m.fromPath} className="space-y-0.5">
                          <div className="flex flex-wrap items-center gap-1.5 font-mono text-ink">
                            <span>{m.fromPath}</span>
                            <span className="text-ink-faint">→</span>
                            <span className="font-medium">{m.toPath}</span>
                            {m.renamed && (
                              <span className="rounded bg-warning/20 px-1.5 py-0.5 font-sans text-[11px] font-medium text-warning">
                                リネーム
                              </span>
                            )}
                          </div>
                          {m.referencedBy.length > 0 && (
                            <p className="text-[11px] text-ink-faint">
                              参照: {m.referencedBy.join(', ')}
                            </p>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {preview.rewrites.length > 0 && (
                  <div>
                    <h3 className="text-xs font-bold text-ink-soft">
                      リンク更新（{preview.rewrites.length} 件）
                    </h3>
                    <ul className="mt-1 max-h-48 space-y-1.5 overflow-y-auto rounded border border-line bg-panel-2 p-2.5 text-xs">
                      {preview.rewrites.map((r) => (
                        <li key={r.docPath} className="space-y-0.5">
                          <div className="font-mono font-medium text-ink">
                            {r.docPath}
                            {r.lockedBy && (
                              <span className="ml-2 font-sans text-[11px] text-warning">
                                （ロック中: {r.lockedBy.displayName}）
                              </span>
                            )}
                          </div>
                          <ul className="space-y-0.5 pl-3 font-mono text-[11px] text-ink-soft">
                            {r.replacements.map((rep) => (
                              <li key={`${rep.from}->${rep.to}`}>
                                {rep.from} → {rep.to}
                              </li>
                            ))}
                          </ul>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {preview.skipped.length > 0 && (
                  <div>
                    <h3 className="text-xs font-bold text-ink-soft">
                      スキップ対象（{preview.skipped.length} 件）
                    </h3>
                    <ul className="mt-1 max-h-40 space-y-1.5 overflow-y-auto rounded border border-line bg-panel-2 p-2.5 text-xs">
                      {preview.skipped.map((s) => (
                        <li key={s.path} className="space-y-0.5">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="rounded bg-panel px-1.5 py-0.5 text-[11px] text-ink-soft">
                              {SKIP_REASON_LABEL[s.reason]}
                            </span>
                            <span className="font-mono text-ink">{s.path}</span>
                          </div>
                          {s.referencedBy.length > 0 && (
                            <p className="text-[11px] text-ink-faint">
                              参照元: {s.referencedBy.join(', ')}
                            </p>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="flex items-center justify-between gap-2 pt-1">
                  {preview.summary.moveCount === 0 && preview.summary.rewriteDocCount === 0 ? (
                    <span className="text-xs text-ink-faint">
                      移動またはリンク更新が必要な添付ファイルはありません。
                    </span>
                  ) : (
                    <span />
                  )}
                  <button
                    type="button"
                    onClick={() => setConfirmOpen(true)}
                    disabled={
                      isDirty ||
                      preview.lockedWarnings.length > 0 ||
                      reorganizeMutation.isPending ||
                      (preview.summary.moveCount === 0 && preview.summary.rewriteDocCount === 0)
                    }
                    className="rounded bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    整理を実行
                  </button>
                </div>
              </div>
            )}
          </section>
        </div>
      )}

      {confirmOpen && preview && (
        <ConfirmDialog
          variant="primary"
          title="既存添付ファイルを整理しますか？"
          message={`${preview.summary.moveCount} 件の添付ファイルを移動し、${preview.summary.rewriteDocCount} 件の文書のリンクを更新します（自動リネーム ${preview.summary.renameCount} 件）。変更は Git 履歴に 1 件のコミットとして記録されます。`}
          confirmLabel="実行する"
          cancelLabel="キャンセル"
          confirmDisabled={reorganizeMutation.isPending}
          onConfirm={handleExecuteConfirm}
          onCancel={() => setConfirmOpen(false)}
        />
      )}
    </div>
  );
}
