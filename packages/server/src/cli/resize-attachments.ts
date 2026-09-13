import { randomBytes } from 'node:crypto';
import { readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import type { Logger } from 'pino';
import sharp from 'sharp';
import { loadConfig } from '../config.js';
import { openDatabase } from '../db/index.js';
import {
  RESIZABLE_IMAGE_EXTENSIONS,
  isAnimatedPng,
  resizeAttachmentImage,
} from '../lib/image-resize.js';
import { isProtectedPath } from '../lib/paths.js';
import { GitService } from '../services/git-service.js';
import { IndexerService } from '../services/indexer-service.js';

// 既存添付の一括縮小CLI(issue #248)。保存時リサイズ(issue #247)と完全に同じ判定・変換
// ロジックを`resizeAttachmentImage`からそのまま呼び、既にライブラリに入っている添付
// (アップロード当時は保存時縮小の対象外だった分)を一括で縮小する。
// 使い方:
//   pnpm --filter @tsumiwiki/server resize-attachments                    (dry-run。既定。何も書き換えない)
//   pnpm --filter @tsumiwiki/server resize-attachments -- --apply         (実際に書き換えて1コミットにまとめる)
//   pnpm --filter @tsumiwiki/server resize-attachments -- --apply --yes   (確認プロンプトを省略。非対話環境向け)
//   pnpm --filter @tsumiwiki/server resize-attachments -- --max-edge 1600 (長辺上限を明示指定。省略時はATTACHMENT_MAX_EDGE_PXの設定値)

interface CliArgs {
  apply: boolean;
  yes: boolean;
  maxEdgePx?: number;
}

function parseArgs(rawArgv: string[]): CliArgs {
  // `pnpm --filter <pkg> resize-attachments -- --apply` のように呼ぶと、pnpmが
  // セパレータの`--`自体を子プロセスのargvにそのまま渡してくる(reindex.ts等の既存CLIの
  // 使い方コメントもこの形を想定している)。意味を持たないトークンなので読み飛ばす
  const argv = rawArgv.filter((a) => a !== '--');
  let apply = false;
  let yes = false;
  let maxEdgePx: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') {
      apply = true;
    } else if (a === '--yes') {
      yes = true;
    } else if (a === '--max-edge') {
      const raw = argv[++i];
      const n = Number(raw);
      if (raw === undefined || !Number.isInteger(n) || n < 0) {
        throw new Error(`--max-edge には0以上の整数を指定してください: ${raw ?? '(未指定)'}`);
      }
      maxEdgePx = n;
    } else {
      throw new Error(`不明な引数です: ${a}`);
    }
  }
  return { apply, yes, maxEdgePx };
}

// 走査で見つかった1ファイル。relPathはNFC正規化済み(表示・分類・Gitコミットの
// パス指定に使う。core.precomposeunicode=trueによりGit側はNFDの実ファイルとも
// 正しく対応付く)。absPathは正規化前のentry.nameから組み立てた実ディスク上のパス
// (Windows/Linux等の正規化非依存でないファイルシステムでは、NFC化した名前で
// fs.readFile/writeFile等を直接呼ぶとENOENTになりうるため、実ファイルI/Oには必ず
// こちらを使う。indexer-service.tsのwalk()と同じ扱い)
interface WalkedTarget {
  relPath: string;
  absPath: string;
}

// ライブラリ配下を再帰走査し、縮小対象拡張子(RESIZABLE_IMAGE_EXTENSIONS)のファイル
// 一覧を返す。除外ルールはIndexerService.walk()(indexer-service.ts)と揃える
// (isProtectedPathをimportして使い、二重に持たない)
async function collectTargets(libraryPath: string): Promise<WalkedTarget[]> {
  const results: WalkedTarget[] = [];
  async function walk(relDir: string, absDirReal: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(absDirReal, { withFileTypes: true });
    } catch {
      // 走査中に消えた等。スキップして継続
      return;
    }
    for (const entry of entries) {
      const name = entry.name.normalize('NFC');
      const rel = relDir ? `${relDir}/${name}` : name;
      const absReal = path.join(absDirReal, entry.name); // 正規化前の実名で実パスを組む
      // 設定系ドットフォルダ(.git/.obsidian等)と.trashは索引と同様に対象外とする
      if (isProtectedPath(rel) || name === '.trash') continue;
      if (entry.isDirectory()) {
        await walk(rel, absReal);
      } else if (entry.isFile()) {
        const ext = path.extname(name).toLowerCase();
        if (RESIZABLE_IMAGE_EXTENSIONS.has(ext)) {
          results.push({ relPath: rel, absPath: absReal });
        }
      }
    }
  }
  await walk('', libraryPath);
  return results;
}

// resizeAttachmentImageのlogger引数(Pick<Logger,'warn'|'info'>)を満たす疑似logger。
// warnが呼ばれた=内部でデコード等の例外を捕捉して原本にフォールバックしたことを意味する
// (image-resize.ts内でwarnを呼ぶ経路は例外catchの1箇所のみ)。これを使うことで、
// resizeAttachmentImageの判定・変換ロジックを再実装せずにデコード失敗を検出できる
function makeFailureLogger(onFail: () => void): Pick<Logger, 'warn' | 'info'> {
  return {
    warn: ((..._args: unknown[]) => {
      onFail();
    }) as Logger['warn'],
    info: (() => {}) as Logger['info'],
  };
}

// 変更されなかったファイルの理由(dry-run表示用の分類。resizeAttachmentImage自体は
// この分類を返さないため、既に正常デコードできたことが確定しているファイルに限り、
// metadata()を再取得して事実だけから分類する。縮小可否の判定ロジックは再実装しない)
type SkipReason = 'under-limit' | 'animated' | 'rejected-larger' | 'disabled';

const SKIP_REASON_LABEL: Record<SkipReason, string> = {
  'under-limit': '長辺が上限以下',
  animated: 'アニメーション',
  'rejected-larger': '再エンコード結果が原本以上で棄却',
  disabled: '対象外(長辺上限が無効)',
};

async function classifySkipReason(data: Buffer, maxEdgePx: number): Promise<SkipReason> {
  if (maxEdgePx <= 0) {
    return 'disabled';
  }
  const metadata = await sharp(data).metadata();
  if ((metadata.pages ?? 1) > 1) {
    return 'animated';
  }
  if (metadata.format === 'png' && isAnimatedPng(data)) {
    return 'animated';
  }
  const { width, height } = metadata;
  if (width && height && Math.max(width, height) > maxEdgePx) {
    return 'rejected-larger';
  }
  return 'under-limit';
}

interface FileAnalysis {
  relPath: string; // 表示・Gitコミットパス指定用(NFC正規化済み)
  absPath: string; // 実ファイルI/O用(正規化前の実名から組み立て)
  originalSize: number;
  newSize: number;
  changed: boolean;
  finalData?: Buffer; // changed===trueのときのみ、書き込むべきバイト列
  decodeFailed: boolean;
  skipReason?: SkipReason; // changed===false && !decodeFailedのときのみ
}

interface FailedFile {
  relPath: string;
}

async function analyzeFile(target: WalkedTarget, maxEdgePx: number): Promise<FileAnalysis> {
  const { relPath, absPath } = target;
  const data = await readFile(absPath);
  const ext = path.extname(relPath).toLowerCase();

  let decodeFailed = false;
  const logger = makeFailureLogger(() => {
    decodeFailed = true;
  });
  const result = await resizeAttachmentImage(data, ext, maxEdgePx, logger);

  if (decodeFailed) {
    return {
      relPath,
      absPath,
      originalSize: data.length,
      newSize: data.length,
      changed: false,
      decodeFailed: true,
    };
  }
  if (result.changed) {
    return {
      relPath,
      absPath,
      originalSize: data.length,
      newSize: result.data.length,
      changed: true,
      finalData: result.data,
      decodeFailed: false,
    };
  }

  const skipReason = await classifySkipReason(data, maxEdgePx);
  return {
    relPath,
    absPath,
    originalSize: data.length,
    newSize: data.length,
    changed: false,
    decodeFailed: false,
    skipReason,
  };
}

function formatMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(2);
}

function printSummary(analyses: FileAnalysis[], readFailures: FailedFile[]): void {
  console.log(`走査したファイル数: ${analyses.length + readFailures.length}件`);

  const changed = analyses.filter((a) => a.changed);
  const decodeFailed = analyses.filter((a) => a.decodeFailed);
  const skipped = analyses.filter((a) => !a.changed && !a.decodeFailed);

  const originalTotal = changed.reduce((sum, a) => sum + a.originalSize, 0);
  const newTotal = changed.reduce((sum, a) => sum + a.newSize, 0);
  const reductionRate = originalTotal > 0 ? ((originalTotal - newTotal) / originalTotal) * 100 : 0;

  console.log(
    `縮小対象: ${changed.length}件` +
      ` (現在の合計 ${formatMb(originalTotal)}MB → 縮小後想定 ${formatMb(newTotal)}MB, 削減率 ${reductionRate.toFixed(1)}%)`,
  );

  console.log('変更なし内訳:');
  for (const reason of ['under-limit', 'animated', 'rejected-larger', 'disabled'] as const) {
    const count = skipped.filter((a) => a.skipReason === reason).length;
    console.log(`  ${SKIP_REASON_LABEL[reason]}: ${count}件`);
  }

  console.log(`デコードに失敗したファイル: ${decodeFailed.length}件`);
  for (const a of decodeFailed) {
    console.log(`  - ${a.relPath}`);
  }

  if (readFailures.length > 0) {
    console.log(`読み込みに失敗したファイル: ${readFailures.length}件`);
    for (const f of readFailures) {
      console.log(`  - ${f.relPath}`);
    }
  }
}

// アトミック書き込み: 同一ディレクトリの一時ファイルに書いてからrename
// (doc-service.tsのprivateメソッドと同じ方式。privateなのでCLI側に同等実装を置く)
async function writeAtomic(absPath: string, content: Buffer): Promise<void> {
  const tmp = path.join(path.dirname(absPath), `.tsumiwiki-tmp-${randomBytes(6).toString('hex')}`);
  await writeFile(tmp, content);
  await rename(tmp, absPath);
}

function askConfirm(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function confirmOrThrow(yes: boolean): Promise<void> {
  if (yes) return;
  const answer = await askConfirm('続行しますか？ [y/N]: ');
  const normalized = answer.trim().toLowerCase();
  if (normalized !== 'y' && normalized !== 'yes') {
    throw new Error('確認が得られなかったため中断しました');
  }
}

export async function main(
  argv: string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const args = parseArgs(argv);
  const config = loadConfig(env);
  const maxEdgePx = args.maxEdgePx ?? config.attachmentMaxEdgePx;

  const targets = await collectTargets(config.libraryPath);

  const analyses: FileAnalysis[] = [];
  const readFailures: FailedFile[] = [];
  for (const target of targets) {
    try {
      analyses.push(await analyzeFile(target, maxEdgePx));
    } catch {
      // ファイル読み込み自体の失敗(パーミッション等)。デコード失敗とは区別して報告する
      readFailures.push({ relPath: target.relPath });
    }
  }

  printSummary(analyses, readFailures);

  if (!args.apply) {
    console.log(
      'dry-runのため変更は行っていません(実際に書き換えるには --apply を指定してください)',
    );
    return;
  }

  const toWrite = analyses.filter((a) => a.changed);
  if (toWrite.length === 0) {
    console.log('縮小対象がないため、書き込み・コミットは行いません。');
    return;
  }

  console.log('');
  console.log(
    '警告: --apply を実行すると、対象ファイルの原本は縮小版に置き換わります(バックアップ推奨)。',
  );
  console.log('  Git履歴には縮小前のblobが残るため、`git show <コミット>:<パス>` で取り出せます。');
  console.log(
    '  library-watcher / sync-service が稼働中だと変更を個別に検知してコミットしてしまい、' +
      '1コミットにまとまりません。TsumiWikiサービスを停止してから実行することを強く推奨します。',
  );
  await confirmOrThrow(args.yes);

  const writeFailures: FailedFile[] = [];
  const writtenPaths: string[] = [];
  let writtenCount = 0;
  let savedBytes = 0;
  for (const a of toWrite) {
    try {
      await writeAtomic(a.absPath, a.finalData!);
      writtenPaths.push(a.relPath);
      writtenCount++;
      savedBytes += a.originalSize - a.newSize;
    } catch {
      writeFailures.push({ relPath: a.relPath });
    }
  }

  let committed = false;
  if (writtenCount > 0) {
    const git = new GitService(config.libraryPath);
    // 未初期化ライブラリ(サーバー未起動のまま本CLIだけ実行された場合)でも安全に動くよう
    // init()を呼ぶ。既存リポジトリに対しては何もしない(no-op)
    await git.init();
    // commitAll(git add -A)は使わない。本CLIは「サービスを停止してから実行」を前提とし、
    // watcher/syncがまだ拾っていない無関係な外部編集(文書の保存途中・未追跡ファイル等)が
    // 作業ツリーに残っている状態を正面から想定する必要があるため、実際に書き込んだパスだけを
    // 明示的に渡す(Opusレビュー指摘)。commit()もSerialQueue+commitStagedを内部で使うため、
    // 1コミットにまとまる性質は変わらない
    await git.commit(writtenPaths, `既存添付を一括縮小(${writtenCount}件, issue #248)`, {
      name: 'TsumiWiki CLI',
      email: 'noreply@localhost',
    });
    committed = true;

    // 縮小でmtime/sizeが変わるためattachment_indexを更新する
    const db = openDatabase(config.dbPath);
    try {
      const indexer = new IndexerService(db, config.libraryPath);
      await indexer.scanAll();
    } finally {
      db.close();
    }
  }

  console.log('');
  console.log(`変更した件数: ${writtenCount}件 (削減 ${formatMb(savedBytes)}MB)`);
  if (writeFailures.length > 0) {
    console.log(`書き込みに失敗したファイル: ${writeFailures.length}件`);
    for (const f of writeFailures) {
      console.log(`  - ${f.relPath}`);
    }
  }
  console.log(`コミット: ${committed ? '作成しました' : 'なし'}`);
}

// このファイルが直接実行された場合のみ起動する(テストからimportした場合は走らない)。
// 他のCLI(reindex.ts等)は末尾で即時実行しているが、本CLIはテストからmain()を直接
// 呼んで検証するため、この形にする。
// 比較はpathToFileURLで正規化する(相対パスで起動された場合、process.argv[1]が
// 相対パスのままになり単純な文字列結合では一致しないため)
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
