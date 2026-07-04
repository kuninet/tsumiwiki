import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';
import { SerialQueue } from './serial-queue';

// ライブラリのGit連携(設計06章)。
// - 書き込み系(init/commit/push)はSerialQueueで直列化する
// - コミットauthorは操作ユーザー、committerは固定のシステム名義

export interface GitAuthor {
  name: string;
  email: string;
}

export interface HistoryEntry {
  rev: string;
  authorName: string;
  date: string;
  message: string;
}

const SYSTEM_NAME = 'TsumiWiki';
const SYSTEM_EMAIL = 'system@tsumiwiki.local';

export class GitService {
  private gitInstance: SimpleGit | null = null;
  private readonly queue = new SerialQueue();

  constructor(private readonly libraryPath: string) {}

  // simple-gitは存在しないbaseDirで即例外を投げるため、
  // 初回利用時(init後)に遅延生成する。
  // committerはinit()で設定するリポジトリローカルのuser.name/user.email
  // (=システム名義)が使われる。authorはコミット時に--authorで指定する。
  private get git(): SimpleGit {
    this.gitInstance ??= simpleGit({ baseDir: this.libraryPath });
    return this.gitInstance;
  }

  // ライブラリをGitリポジトリとして初期化する(設計06章6.1)。
  // 既存リポジトリ(Obsidianヴォルトを既にGit管理している場合等)はそのまま使う。
  async init(): Promise<void> {
    await this.queue.run(async () => {
      mkdirSync(this.libraryPath, { recursive: true });
      if (!existsSync(join(this.libraryPath, '.git'))) {
        await this.git.init(['--initial-branch=main']);
      }
      await this.git.addConfig('core.autocrlf', 'false');
      await this.git.addConfig('core.quotepath', 'false');
      await this.git.addConfig('core.precomposeunicode', 'true');
      await this.git.addConfig('user.name', SYSTEM_NAME);
      await this.git.addConfig('user.email', SYSTEM_EMAIL);
    });
  }

  // 指定パスの変更をコミットする(保存・作成・添付追加等。設計06章6.2)
  async commit(paths: string[], message: string, author: GitAuthor): Promise<void> {
    await this.queue.run(async () => {
      await this.git.add(paths);
      await this.commitStaged(message, author);
    });
  }

  // 全変更をコミットする(リネーム・外部変更のsync取り込み等)
  async commitAll(message: string, author: GitAuthor): Promise<void> {
    await this.queue.run(async () => {
      await this.git.add(['-A']);
      await this.commitStaged(message, author);
    });
  }

  // ステージ済みの変更をコミットする。差分ゼロ(同一内容の上書き保存等)は
  // エラーにせず何もしない
  private async commitStaged(message: string, author: GitAuthor): Promise<void> {
    const staged = await this.git.raw(['diff', '--cached', '--name-only']);
    if (!staged.trim()) return;
    await this.git.commit(message, undefined, {
      '--author': `${author.name} <${author.email}>`,
    });
  }

  // 文書の履歴一覧(リネーム追跡込み。FR-HIST-02)。読み取り系はキューを通さない。
  async history(relPath: string): Promise<HistoryEntry[]> {
    const out = await this.git.raw([
      'log',
      '--follow',
      '--pretty=format:%H%x09%an%x09%aI%x09%s',
      '--',
      relPath,
    ]);
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [rev, authorName, date, message] = line.split('\t');
        return { rev, authorName, date, message };
      });
  }

  // 過去版の内容(FR-HIST-03)
  async contentAt(rev: string, relPath: string): Promise<string> {
    return this.git.show([`${rev}:${relPath}`]);
  }

  // 2版間の差分(unified形式。FR-HIST-03)
  async diff(revA: string, revB: string, relPath: string): Promise<string> {
    return this.git.diff([revA, revB, '--', relPath]);
  }

  // 未コミットの外部変更があるか(FR-DOC-08 / 設計06章6.4)
  async hasExternalChanges(): Promise<boolean> {
    const status = await this.git.status();
    return !status.isClean();
  }

  // バックアップ先bareリポジトリへpushする(NFR-AVL-02 / 設計06章6.5)
  async pushBackup(remoteUrl: string): Promise<void> {
    await this.queue.run(async () => {
      const remotes = await this.git.getRemotes(true);
      const backup = remotes.find((r) => r.name === 'backup');
      if (!backup) {
        await this.git.addRemote('backup', remoteUrl);
      } else if (backup.refs.push !== remoteUrl) {
        await this.git.remote(['set-url', 'backup', remoteUrl]);
      }
      await this.git.push('backup', 'main', { '--force-with-lease': null });
    });
  }
}
