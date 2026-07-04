import bcrypt from 'bcryptjs';
import type { CreateUserRequest, UpdateUserRequest, User } from '@tsumiwiki/shared';
import type { AppDatabase } from '../db/index.js';

// ユーザー管理(FR-AUTH-01〜04, FR-AUTH-07)
// パスワードはbcrypt(コスト10)でハッシュ化して保存する。

const BCRYPT_COST = 10;

// ユーザー不在時にも同等のハッシュ計算を行い、応答時間差による
// ユーザー名列挙を防ぐためのダミーハッシュ
const DUMMY_HASH = bcrypt.hashSync('tsumiwiki-dummy-password', BCRYPT_COST);

interface UserRow {
  id: number;
  username: string;
  display_name: string;
  password_hash: string;
  role: string;
  disabled: number;
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role === 'admin' ? 'admin' : 'user',
    disabled: row.disabled !== 0,
  };
}

export class DuplicateUsernameError extends Error {
  constructor(username: string) {
    super(`ユーザーID「${username}」は既に使われています`);
    this.name = 'DuplicateUsernameError';
  }
}

export class UserService {
  constructor(private readonly db: AppDatabase) {}

  create(input: CreateUserRequest): User {
    const now = new Date().toISOString();
    const hash = bcrypt.hashSync(input.password, BCRYPT_COST);
    try {
      const info = this.db
        .prepare(
          `INSERT INTO users (username, display_name, password_hash, role, disabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, 0, ?, ?)`,
        )
        .run(input.username, input.displayName, hash, input.role, now, now);
      return this.byId(Number(info.lastInsertRowid))!;
    } catch (e) {
      if ((e as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new DuplicateUsernameError(input.username);
      }
      throw e;
    }
  }

  list(): User[] {
    const rows = this.db.prepare('SELECT * FROM users ORDER BY id').all() as UserRow[];
    return rows.map(toUser);
  }

  byId(id: number): User | null {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    return row ? toUser(row) : null;
  }

  // ログイン検証。無効化ユーザーは認証失敗として扱う。
  // 不在・無効化時もハッシュ比較を実行し、処理時間を平準化する
  verifyLogin(username: string, password: string): User | null {
    const row = this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as
      | UserRow
      | undefined;
    if (!row || row.disabled !== 0) {
      bcrypt.compareSync(password, DUMMY_HASH);
      return null;
    }
    if (!bcrypt.compareSync(password, row.password_hash)) return null;
    return toUser(row);
  }

  // 有効な管理者の数(最後の管理者の無効化・降格を防ぐために使う)
  countActiveAdmins(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0")
      .get() as { n: number };
    return row.n;
  }

  update(id: number, patch: UpdateUserRequest): User | null {
    const current = this.byId(id);
    if (!current) return null;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE users SET
           display_name = COALESCE(?, display_name),
           role = COALESCE(?, role),
           disabled = COALESCE(?, disabled),
           password_hash = COALESCE(?, password_hash),
           updated_at = ?
         WHERE id = ?`,
      )
      .run(
        patch.displayName ?? null,
        patch.role ?? null,
        patch.disabled === undefined ? null : patch.disabled ? 1 : 0,
        patch.password === undefined ? null : bcrypt.hashSync(patch.password, BCRYPT_COST),
        now,
        id,
      );
    return this.byId(id);
  }

  // 本人によるパスワード変更(現パスワードの確認つき)
  changePassword(id: number, currentPassword: string, newPassword: string): boolean {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    if (!row) return false;
    if (!bcrypt.compareSync(currentPassword, row.password_hash)) return false;
    this.update(id, { password: newPassword });
    return true;
  }
}
