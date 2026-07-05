import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

// 外部変更のsync取り込み等に使うシステム名義のauthor(設計06章6.2)
export const SYSTEM_AUTHOR: GitAuthor = { name: SYSTEM_NAME, email: SYSTEM_EMAIL };

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

  // push専用インスタンス: 無応答リモート(ネットワーク障害等)で保存系の
  // キューを塞がないよう、出力停止60秒でプロセスを打ち切る
  private pushGitInstance: SimpleGit | null = null;
  private get pushGit(): SimpleGit {
    this.pushGitInstance ??= simpleGit({
      baseDir: this.libraryPath,
      timeout: { block: 60_000 },
    });
    return this.pushGitInstance;
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
      // .gitignoreの自動生成(設計06章6.7。既存があれば触らない)。
      // アトミック書き込みの一時ファイルがsyncコミットに巻き込まれるのも防ぐ
      const gitignorePath = join(this.libraryPath, '.gitignore');
      if (!existsSync(gitignorePath)) {
        writeFileSync(
          gitignorePath,
          [
            '.obsidian/',
            '.DS_Store',
            'Thumbs.db',
            '.tsumiwiki-tmp-*',
            // #86 fix-forward: ごみ箱の由来メタデータは削除者の実名を含むためgit履歴に載せない
            '.tsumiwiki-trash.json',
          ].join('\n') + '\n',
          'utf8',
        );
        await this.git.add(['.gitignore']);
        await this.commitStaged('add: .gitignore', SYSTEM_AUTHOR);
      } else {
        // #86 fix-forward: 既存の .gitignore に .tsumiwiki-trash.json が無ければ追記する
        // (既存ライブラリで新規trash操作前に確実に無視される状態にする)
        const current = readFileSync(gitignorePath, 'utf8');
        if (!/(^|\n)\.tsumiwiki-trash\.json(\s|$)/.test(current)) {
          const appended = current + (current.endsWith('\n') ? '' : '\n') + '.tsumiwiki-trash.json\n';
          writeFileSync(gitignorePath, appended, 'utf8');
          await this.git.add(['.gitignore']);
          await this.commitStaged(
            'chore: ignore .tsumiwiki-trash.json',
            SYSTEM_AUTHOR,
          );
        }
      }
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

  // 指定パスに触れた直近のコミット(--followしない。ごみ箱の由来特定用)
  async lastCommitFor(relPath: string): Promise<HistoryEntry | null> {
    const out = await this.git.raw([
      'log',
      '-1',
      '--pretty=format:%H%x09%an%x09%aI%x09%s',
      '--',
      relPath,
    ]);
    const line = out.split('\n').filter(Boolean)[0];
    if (!line) return null;
    const [rev, authorName, date, message] = line.split('\t');
    return { rev, authorName, date, message };
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

  // バックアップ先bareリポジトリへpushする(NFR-AVL-02 / 設計06章6.5)。
  // pushは索引・作業ツリーを変更しないため保存系キューとは分離し、
  // リモート無応答時も保存・シャットダウンをブロックしない
  async pushBackup(remoteUrl: string): Promise<void> {
    const remotes = await this.pushGit.getRemotes(true);
    const backup = remotes.find((r) => r.name === 'backup');
    if (!backup) {
      await this.pushGit.addRemote('backup', remoteUrl);
    } else if (backup.refs.push !== remoteUrl) {
      await this.pushGit.remote(['set-url', 'backup', remoteUrl]);
    }
    await this.pushGit.push('backup', 'main', { '--force-with-lease': null });
  }
}
