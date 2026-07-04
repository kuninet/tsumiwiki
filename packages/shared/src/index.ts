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
