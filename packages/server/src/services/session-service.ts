import { randomBytes } from 'node:crypto';
import type { AppDatabase } from '../db/index.js';

// セッション管理(FR-AUTH-05)。
// セッションIDはCookie(httpOnly)に格納し、SQLiteでTTL管理する。
// スライディング方式: 残り時間が半分を切ったらアクセス時に延長する。

export interface Session {
  id: string;
  userId: number;
  expiresAt: string;
  // このアクセスでTTLを延長した場合true(Cookieの有効期限も更新するための通知)
  extended?: boolean;
}

interface SessionRow {
  id: string;
  user_id: number;
  expires_at: string;
}

export class SessionService {
  constructor(
    private readonly db: AppDatabase,
    private readonly ttlMinutes: number,
  ) {}

  private expiryFromNow(): string {
    return new Date(Date.now() + this.ttlMinutes * 60_000).toISOString();
  }

  create(userId: number): Session {
    const id = randomBytes(32).toString('hex');
    const now = new Date().toISOString();
    const expiresAt = this.expiryFromNow();
    this.db
      .prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(id, userId, now, expiresAt);
    return { id, userId, expiresAt };
  }

  // 有効なセッションを取得。期限切れはnull。残りTTLが半分未満なら延長する
  get(id: string): Session | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
      | SessionRow
      | undefined;
    if (!row) return null;
    const now = Date.now();
    const expires = Date.parse(row.expires_at);
    if (expires <= now) {
      this.destroy(id);
      return null;
    }
    let expiresAt = row.expires_at;
    let extended = false;
    if (expires - now < (this.ttlMinutes * 60_000) / 2) {
      expiresAt = this.expiryFromNow();
      this.db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(expiresAt, id);
      extended = true;
    }
    return { id: row.id, userId: row.user_id, expiresAt, extended };
  }

  destroy(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  // 指定ユーザーのセッションを失効させる(パスワード変更・無効化・降格時)。
  // exceptIdを指定すると、そのセッション(本人の現行セッション)だけ残す
  destroyByUser(userId: number, exceptId?: string): void {
    if (exceptId) {
      this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(userId, exceptId);
    } else {
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    }
  }

  // 期限切れセッションの掃除(ログイン時に呼ぶ)
  cleanup(): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString());
  }
}
