import { z } from 'zod';

// API入出力スキーマはこのパッケージに集約する(設計01章1.3)。
// サーバーはバリデーション、クライアントは型として利用する。

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  name: z.string(),
  version: z.string(),
  time: z.string(),
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
  snippet: z.string(), // <mark>ハイライト付き抜粋
});
export type SearchResult = z.infer<typeof searchResultSchema>;

export const tagCountSchema = z.object({
  tag: z.string(),
  count: z.number(),
});
export type TagCount = z.infer<typeof tagCountSchema>;

// APIエラー共通形式(設計03章3.1)
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
