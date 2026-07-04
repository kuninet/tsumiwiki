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

// APIエラー共通形式(設計03章3.1)
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
