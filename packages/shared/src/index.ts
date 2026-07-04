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

// APIエラー共通形式(設計03章3.1)
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
