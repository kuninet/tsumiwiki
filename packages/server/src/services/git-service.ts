import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';
import type { AllHistoryEntry } from '@tsumiwiki/shared';
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

  // ライブラリ全体の履歴(パス絞りなし。issue #66)。1コミットで複数ファイルが
  // 変わりうるのでpathsを配列で持つ。読み取り系はキューを通さない
  async historyAll(limit = 100): Promise<AllHistoryEntry[]> {
    const clamped = Math.min(1000, Math.max(1, Math.trunc(limit)));
    // まず hash 一覧だけを取り、コミットごとに git show でメタ+name-status を取得する。
    // 1コミット単位で境界が明確なので、-z 出力にマーカー文字列を仕込んで境界を作る
    // 方式(件名やパスに衝突しうる)を避けられる
    const hashesOut = await this.git.raw([
      'log',
      '--pretty=format:%H',
      '-n',
      String(clamped),
    ]);
    const hashes = hashesOut.split('\n').filter(Boolean);
    const entries = await Promise.all(hashes.map((h) => this.historyEntryForRev(h)));
    return entries.filter((e): e is AllHistoryEntry => e !== null);
  }

  private async historyEntryForRev(rev: string): Promise<AllHistoryEntry | null> {
    // 1コミット分を name-status -z で取る。--no-patch は --name-status と併用不可の
    // ため付けられず、末尾に diff 本体が付いてくるが、パーサー側で name-status 部
    // (status + path のペア列)だけを抽出して打ち切る
    const out = await this.git.raw([
      'show',
      '--name-status',
      '-z',
      '--format=%H%x09%an%x09%aI%x09%s',
      rev,
    ]);
    return this.parseSingleCommit(out);
  }

  // git show --name-status -z の1コミット分の出力をパースする。
  // -z 指定時のフォーマット部は「%H\t%an\t%aI\t%s\0\n」で終端し、その後 name-status の
  // 各エントリが NUL 区切りで並ぶ。リネーム/コピーは status\0旧\0新 の3トークン、
  // それ以外は status\0path の2トークン。末尾には diff 本文が続くが、status パターン
  // (A/M/D/R\d+/C\d+等)に一致しなくなった時点で打ち切る
  private parseSingleCommit(raw: string): AllHistoryEntry | null {
    if (!raw) return null;
    // フォーマット部の終端は NUL。NULまでを header とし、残りから先頭の改行を落とす
    const nulIdx = raw.indexOf('\0');
    const header = nulIdx === -1 ? raw : raw.slice(0, nulIdx);
    const rest = nulIdx === -1 ? '' : raw.slice(nulIdx + 1).replace(/^\n/, '');
    const [rev, authorName, date, message] = header.split('\t');
    if (!rev) return null;

    const tokens = rest.split('\0');
    const paths: string[] = [];
    // git の name-status で出る status コード(通常種のみ)
    const STATUS_RE = /^([AMDTUXB]|[RC]\d+)$/;
    for (let i = 0; i < tokens.length; ) {
      const status = tokens[i];
      if (!STATUS_RE.test(status)) break; // diff 本文に到達したら打ち切り
      if (status.startsWith('R') || status.startsWith('C')) {
        // リネーム/コピーは status\0旧パス\0新パス。new側パスのみ収録する
        const newPath = tokens[i + 2];
        if (newPath) paths.push(newPath);
        i += 3;
      } else {
        const p = tokens[i + 1];
        if (p) paths.push(p);
        i += 2;
      }
    }
    return { rev, authorName, date, message, paths };
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
