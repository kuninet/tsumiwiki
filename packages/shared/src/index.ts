import { z } from 'zod';
export * from './template-vars.js';

// API入出力スキーマはこのパッケージに集約する(設計01章1.3)。
// サーバーはバリデーション、クライアントは型として利用する。

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  name: z.string(),
  version: z.string(),
  time: z.string(),
  // バックアップpushの概況(設計06章6.5)。healthは未認証で読めるため
  // 詳細(エラー文字列=内部パスを含みうる)は認証必須の/api/library/statusで返す
  backup: z
    .object({
      configured: z.boolean(),
      healthy: z.boolean(),
      lastSuccessAt: z.string().nullable(),
    })
    .optional(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

// ---- 認証・ユーザー(FR-AUTH) ----

export const userRoleSchema = z.enum(['admin', 'user']);
export type UserRole = z.infer<typeof userRoleSchema>;

export const userSchema = z.object({
  id: z.number(),
  username: z.string(),
  displayName: z.string(),
  role: userRoleSchema,
  disabled: z.boolean(),
});
export type User = z.infer<typeof userSchema>;

export const loginRequestSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

// パスワードポリシーは「空禁止」のみ(FR-AUTH-07)
export const createUserRequestSchema = z.object({
  username: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9_.-]+$/, 'ユーザーIDは半角英数と _.- のみ使用できます'),
  displayName: z.string().min(1),
  password: z.string().min(1),
  role: userRoleSchema.default('user'),
});
export type CreateUserRequest = z.infer<typeof createUserRequestSchema>;

export const updateUserRequestSchema = z.object({
  displayName: z.string().min(1).optional(),
  role: userRoleSchema.optional(),
  disabled: z.boolean().optional(),
  password: z.string().min(1).optional(),
});
export type UpdateUserRequest = z.infer<typeof updateUserRequestSchema>;

export const changePasswordRequestSchema = z.object({
  currentPassword: z.string(),
  newPassword: z.string().min(1),
});
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

// ---- 文書・フォルダ(FR-DOC / 設計03章) ----

export const docSummarySchema = z.object({
  path: z.string(),
  title: z.string(),
  folder: z.string(),
  updatedAt: z.string(),
});
export type DocSummary = z.infer<typeof docSummarySchema>;

export const treeResponseSchema = z.object({
  folders: z.array(z.string()),
  docs: z.array(docSummarySchema),
});
export type TreeResponse = z.infer<typeof treeResponseSchema>;

export const docResponseSchema = z.object({
  path: z.string(),
  // フロントマター全体(未知キー含む)。エディタにはbodyのみ渡す(設計05章5.1)
  frontmatter: z.record(z.string(), z.unknown()),
  tags: z.array(z.string()),
  body: z.string(),
  updatedAt: z.string(),
  // 編集中ユーザー(FR-LOCK-01)。ロックなしはnull
  lock: z.object({ userId: z.number(), displayName: z.string() }).nullable(),
});
export type DocResponse = z.infer<typeof docResponseSchema>;

export const createDocRequestSchema = z.object({
  folder: z.string(), // '' = ルート
  title: z.string().min(1),
});
export type CreateDocRequest = z.infer<typeof createDocRequestSchema>;

export const saveDocRequestSchema = z.object({
  path: z.string().min(1),
  body: z.string(),
  tags: z.array(z.string()).optional(), // 省略時はタグ変更なし
  baseUpdatedAt: z.string().min(1), // 競合検知用(取得時のupdatedAt)
});
export type SaveDocRequest = z.infer<typeof saveDocRequestSchema>;

export const moveDocRequestSchema = z.object({
  path: z.string().min(1),
  newFolder: z.string(),
  newTitle: z.string().min(1),
});
export type MoveDocRequest = z.infer<typeof moveDocRequestSchema>;

export const createFolderRequestSchema = z.object({
  path: z.string().min(1),
});
export type CreateFolderRequest = z.infer<typeof createFolderRequestSchema>;

export const moveFolderRequestSchema = z.object({
  path: z.string().min(1),
  newPath: z.string().min(1),
});
export type MoveFolderRequest = z.infer<typeof moveFolderRequestSchema>;

// ---- 編集ロック・下書き(FR-LOCK / FR-EDIT-08) ----

export const lockInfoSchema = z.object({
  userId: z.number(),
  displayName: z.string(),
});
export type LockInfo = z.infer<typeof lockInfoSchema>;

export const lockRequestSchema = z.object({
  path: z.string().min(1),
});
export type LockRequest = z.infer<typeof lockRequestSchema>;

export const saveDraftRequestSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});
export type SaveDraftRequest = z.infer<typeof saveDraftRequestSchema>;

// ---- 履歴(FR-HIST) ----

// Gitリビジョン指定として許可する形式(hex 4〜40桁のみ。オプション偽装防止)
export const REV_PATTERN = /^[0-9a-f]{4,40}$/i;

export const historyEntrySchema = z.object({
  rev: z.string(),
  authorName: z.string(),
  date: z.string(),
  message: z.string(),
});
export type HistoryEntry = z.infer<typeof historyEntrySchema>;

// ライブラリ全体の履歴(issue #66)。1コミットで複数ファイルが変わりうるため
// pathsを配列で持つ(このコミットで変更されたファイルパス。1件以上)
export const allHistoryEntrySchema = historyEntrySchema.extend({
  paths: z.array(z.string()),
});
export type AllHistoryEntry = z.infer<typeof allHistoryEntrySchema>;

export const restoreRequestSchema = z.object({
  path: z.string().min(1),
  rev: z.string().regex(REV_PATTERN, 'リビジョン指定が不正です'),
});
export type RestoreRequest = z.infer<typeof restoreRequestSchema>;

// ---- ごみ箱(FR-DOC-07) ----

export const trashEntrySchema = z.object({
  trashPath: z.string(), // .trash/内のパス
  name: z.string(),
  isFolder: z.boolean(),
  originalPath: z.string().nullable(), // trash:コミットから復元(不明ならnull)
  deletedAt: z.string().nullable(),
  deletedBy: z.string().nullable(),
});
export type TrashEntry = z.infer<typeof trashEntrySchema>;

export const restoreTrashRequestSchema = z.object({
  trashPath: z.string().min(1),
});
export type RestoreTrashRequest = z.infer<typeof restoreTrashRequestSchema>;

// ---- 検索・タグ(FR-NAV) ----

export const searchResultSchema = z.object({
  path: z.string(),
  title: z.string(),
  snippet: z.string(), // HTMLエスケープ済み抜粋(<mark>ハイライトのみHTML)。innerHTML描画可
});
export type SearchResult = z.infer<typeof searchResultSchema>;

export const tagCountSchema = z.object({
  tag: z.string(),
  count: z.number(),
});
export type TagCount = z.infer<typeof tagCountSchema>;

// ---- ライブラリ設定(#84 テンプレート機能・デイリーノート) ----
// ライブラリルート直下の .tsumiwiki/settings.yaml に保存し、gitでバックアップする
// 全社(=ライブラリ)共通の設定。個人別化は将来検討(ライブラリを個人別にした段階)

// パスとしての最低限の妥当性(ドット始まりセグメント・`..`・空白のみ を弾く)。
// 空文字は許容(『ルート直下』『テンプレ未設定』の意)
function isSafeSubPath(v: string): boolean {
  if (v === '') return true;
  if (/^\s+$/.test(v)) return false;
  const parts = v.replaceAll('\\', '/').split('/').filter(Boolean);
  return parts.every((p) => p !== '..' && !p.startsWith('.'));
}

// ファイル名パターンは Obsidian と同じく素の日付フォーマット文字列(YYYY-MM-DD 等)を想定。
// {{...}} 変数構文は誤解の元になるので受け付けない
function isSafeFilenamePattern(v: string): boolean {
  if (v.trim() === '') return false;
  if (v.includes('{{')) return false;
  // ファイルシステム禁止文字と改行を弾く(Windows想定)。'/' は許容(サブフォルダ運用のため)
  if (/[\\:*?"<>|\r\n]/.test(v)) return false;
  // 各セグメントが '.' や '..' 単独 or ドット始まり(隠しファイル化)でないこと
  const segments = v.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..' || s.startsWith('.'))) {
    return false;
  }
  return true;
}

export const librarySettingsSchema = z.object({
  templates: z.object({
    // .md をテンプレとして扱うフォルダ(ライブラリ直下からの相対パス。空でルート)
    folder: z.string().refine(isSafeSubPath, 'フォルダパスが不正です'),
  }),
  dailyNotes: z.object({
    // 「今日の日誌」を作る先のフォルダ
    folder: z.string().refine(isSafeSubPath, 'フォルダパスが不正です'),
    // デイリーノートに適用するテンプレのパス(空文字で空白ノート作成)
    template: z.string().refine(isSafeSubPath, 'テンプレートパスが不正です'),
    // ファイル名パターン(日付フォーマット)。既定 'YYYY-MM-DD'。{{...}} 変数は不可
    filenamePattern: z.string().refine(isSafeFilenamePattern, 'ファイル名パターンが不正です'),
  }),
});
export type LibrarySettings = z.infer<typeof librarySettingsSchema>;

export const LIBRARY_SETTINGS_DEFAULTS: LibrarySettings = {
  templates: { folder: '_templates' },
  dailyNotes: { folder: '日記', template: '', filenamePattern: 'YYYY-MM-DD' },
};

// ---- #84 Phase B: テンプレート API ----

export const templateSummarySchema = z.object({
  // ライブラリ相対パス(例: `_templates/日誌.md`)
  path: z.string(),
  // ファイル名から `.md` を除いた表示名
  name: z.string(),
  // frontmatter.target_folder(なければ null)。新規作成の既定フォルダとして使う
  targetFolder: z.string().nullable(),
  // frontmatter.description(あれば選択UIで補助表示)
  description: z.string().optional(),
});
export type TemplateSummary = z.infer<typeof templateSummarySchema>;

export const listTemplatesResponseSchema = z.object({
  templates: z.array(templateSummarySchema),
});
export type ListTemplatesResponse = z.infer<typeof listTemplatesResponseSchema>;

// テンプレを適用して新規文書を作成する。target_folder は body で上書き可能
export const applyTemplateRequestSchema = z.object({
  templatePath: z.string().min(1),
  title: z.string().min(1),
  // 未指定なら frontmatter.target_folder を、それも無ければライブラリ直下を使う
  targetFolder: z.string().optional(),
});
export type ApplyTemplateRequest = z.infer<typeof applyTemplateRequestSchema>;

export const applyTemplateResponseSchema = z.object({
  path: z.string(),
});
export type ApplyTemplateResponse = z.infer<typeof applyTemplateResponseSchema>;

// ---- #84 Phase C: 既存文書へのテンプレ適用 API ----

// 選択したテンプレの変数を展開して Markdown 本文を返す(新規文書は作らない)。
// クライアントはこの Markdown を Tiptap で挿入/追記する。`{{cursor}}` はマーカー文字列として
// レスポンスに残るので、クライアント側で split してカーソル位置を決める
export const expandTemplateRequestSchema = z.object({
  templatePath: z.string().min(1),
  // 展開時の `{{title}}` に使う値。編集中文書のタイトルをクライアントが渡す
  title: z.string().min(1),
});
export type ExpandTemplateRequest = z.infer<typeof expandTemplateRequestSchema>;

export const expandTemplateResponseSchema = z.object({
  markdown: z.string(),
});
export type ExpandTemplateResponse = z.infer<typeof expandTemplateResponseSchema>;

// カーソル位置マーカーは template-vars.ts の内部定数と同一。二重定義を避けるため
// template-vars.ts 側を単一のソースオブトゥルースにして、こちらから re-export する
// (中#3 対応: shared/index.ts と template-vars.ts で独立に持っていた `'{{cursor}}'`
// 値が食い違うと server↔client 契約が黙って壊れるため)。

// APIエラー共通形式(設計03章3.1)
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
