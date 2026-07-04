import { createInterface } from 'node:readline';
import { createUserRequestSchema } from '@tsumiwiki/shared';
import { loadConfig } from '../config.js';
import { openDatabase } from '../db/index.js';
import { DuplicateUsernameError, UserService } from '../services/user-service.js';

// 初期管理者ユーザーの作成CLI(FR-AUTH-06)
// 使い方: pnpm --filter @tsumiwiki/server create-admin -- --username admin --display-name 管理者
//         パスワードは対話入力(--password でも指定可能。CI等の非対話環境向け)

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      args[argv[i].slice(2)] = argv[i + 1] ?? '';
      i++;
    }
  }
  return args;
}

function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const rlAny = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    process.stdout.write(question);
    // 入力エコーを抑止(パスワードを画面に出さない)
    rlAny._writeToOutput = () => {};
    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const username = args.username;
  const displayName = args['display-name'] ?? username;
  if (!username) {
    console.error('使い方: create-admin --username <ID> [--display-name <表示名>] [--password <パスワード>]');
    process.exit(1);
  }
  let password = args.password;
  if (!password) {
    password = await askHidden(`${username} のパスワード: `);
  }
  if (!password) {
    console.error('パスワードが空です');
    process.exit(1);
  }

  // APIと同じバリデーションを通す(ユーザーID形式等)
  const parsed = createUserRequestSchema.safeParse({
    username,
    displayName,
    password,
    role: 'admin',
  });
  if (!parsed.success) {
    console.error(parsed.error.issues[0]?.message ?? '入力が不正です');
    process.exit(1);
  }

  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  const users = new UserService(db);
  try {
    const user = users.create(parsed.data);
    console.log(`管理者ユーザーを作成しました: ${user.username}(${user.displayName})`);
  } catch (e) {
    if (e instanceof DuplicateUsernameError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
}

main();
