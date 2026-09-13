import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import sharp from 'sharp';
import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitService } from '../services/git-service.js';
import { main } from './resize-attachments.js';

// 既存添付の一括縮小CLI(issue #248)の検証。
// - dry-runが既定で何も変更しないこと(バイト列・mtime不変)
// - dry-runの出力に削減見込み・デコード失敗一覧が含まれること
// - --applyで縮小・単一コミット・attachment_index更新が行われること
// - デコード失敗ファイル(切り詰めJPEG)・アニメーション画像・再エンコードで肥大化する
//   画像がそれぞれ変更されずスキップ/報告されること
// - .trash/.git配下が走査対象外であること
// バイナリfixtureはコミットせず、image-resize.test.tsと同じ手法でテスト画像を生成する

async function makeJpeg(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 10, g: 20, b: 200 } } })
    .jpeg()
    .toBuffer();
}

// ---- テスト用APNGビルダー(image-resize.test.tsと同じ手法。アニメーション素通しの検証に使う) ----
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function crc32(buf: Buffer): number {
  let crc = ~0;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

function seqNumBuf(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}

function solidRawScanlines(width: number, height: number, rgb: [number, number, number]): Buffer {
  const rowBytes = 1 + width * 3;
  const raw = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowBytes;
    raw[rowStart] = 0; // フィルタタイプ: none
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * 3;
      raw[px] = rgb[0];
      raw[px + 1] = rgb[1];
      raw[px + 2] = rgb[2];
    }
  }
  return raw;
}

function fcTLData(seq: number, w: number, h: number): Buffer {
  const b = Buffer.alloc(26);
  b.writeUInt32BE(seq, 0);
  b.writeUInt32BE(w, 4);
  b.writeUInt32BE(h, 8);
  b.writeUInt32BE(0, 12); // x_offset
  b.writeUInt32BE(0, 16); // y_offset
  b.writeUInt16BE(1, 20); // delay_num
  b.writeUInt16BE(2, 22); // delay_den
  b[24] = 0; // dispose_op
  b[25] = 0; // blend_op
  return b;
}

// 2フレームの正規APNG(RGB・8bit・フィルタ無し)を生成する
function buildApng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor(RGB)
  ihdr[10] = 0; // compression method
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace method

  const acTL = Buffer.alloc(8);
  acTL.writeUInt32BE(2, 0); // num_frames
  acTL.writeUInt32BE(0, 4); // num_plays(0=無限)

  const frame1 = deflateSync(solidRawScanlines(width, height, [255, 0, 0]));
  const frame2 = deflateSync(solidRawScanlines(width, height, [0, 255, 0]));

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('acTL', acTL),
    pngChunk('fcTL', fcTLData(0, width, height)),
    pngChunk('IDAT', frame1),
    pngChunk('fcTL', fcTLData(1, width, height)),
    pngChunk('fdAT', Buffer.concat([seqNumBuf(2), frame2])),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

let lib: string;
let dbPath: string;
let cleanupDirs: string[];

beforeEach(async () => {
  lib = await mkdtemp(join(tmpdir(), 'tsumiwiki-resize-lib-'));
  const dataDir = await mkdtemp(join(tmpdir(), 'tsumiwiki-resize-data-'));
  dbPath = join(dataDir, 'app.db');
  cleanupDirs = [lib, dataDir];
  // 本番と同じ経路(GitService.init)でライブラリをGitリポジトリ化しておく
  await new GitService(lib).init();
});

afterEach(async () => {
  for (const dir of cleanupDirs) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function envFor(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    LIBRARY_PATH: lib,
    DB_PATH: dbPath,
    ...overrides,
  };
}

// console.logの出力を収集する(main()の日本語サマリー出力を検証するため)
function captureLogs(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  return { logs, restore: () => spy.mockRestore() };
}

describe('resize-attachments CLI', () => {
  it('dry-runが既定で、ファイルが一切変更されない(バイト列・mtimeが実行前後で不変)', async () => {
    const src = await sharp({
      create: { width: 4000, height: 2000, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .png()
      .toBuffer();
    const target = join(lib, 'big.png');
    await writeFile(target, src);
    const before = await stat(target);

    const { logs, restore } = captureLogs();
    await main([], envFor({ ATTACHMENT_MAX_EDGE_PX: '1000' }));
    restore();

    const after = await stat(target);
    const afterData = await readFile(target);
    expect(afterData.equals(src)).toBe(true);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(logs.some((l) => l.includes('dry-run'))).toBe(true);
  });

  it('dry-runの出力に削減見込み(件数・MB・削減率)が含まれる', async () => {
    const src = await sharp({
      create: { width: 4000, height: 2000, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .jpeg()
      .toBuffer();
    await writeFile(join(lib, 'big.jpg'), src);

    const { logs, restore } = captureLogs();
    await main([], envFor({ ATTACHMENT_MAX_EDGE_PX: '1000' }));
    restore();

    const summaryLine = logs.find((l) => l.startsWith('縮小対象:'));
    expect(summaryLine).toBeDefined();
    expect(summaryLine).toMatch(/縮小対象: 1件/);
    expect(summaryLine).toMatch(/MB/);
    expect(summaryLine).toMatch(/削減率 [\d.]+%/);
  });

  it('--applyで長辺が上限以下になり、アスペクト比が保たれる', async () => {
    const width = 4000;
    const height = 2000;
    const src = await sharp({
      create: { width, height, channels: 3, background: { r: 50, g: 60, b: 70 } },
    })
      .jpeg()
      .toBuffer();
    const target = join(lib, 'photo.jpg');
    await writeFile(target, src);

    const { restore } = captureLogs();
    await main(['--apply', '--yes'], envFor({ ATTACHMENT_MAX_EDGE_PX: '1000' }));
    restore();

    const after = await readFile(target);
    const meta = await sharp(after).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(1000);
    expect(meta.width! / meta.height!).toBeCloseTo(width / height, 1);
  });

  it('上限以下のPNGは--apply後もバイト列が変化しない', async () => {
    const src = await sharp({
      create: { width: 800, height: 600, channels: 3, background: { r: 9, g: 9, b: 9 } },
    })
      .png()
      .toBuffer();
    const target = join(lib, 'small.png');
    await writeFile(target, src);

    const { restore } = captureLogs();
    await main(['--apply', '--yes'], envFor({ ATTACHMENT_MAX_EDGE_PX: '2048' }));
    restore();

    const after = await readFile(target);
    expect(after.equals(src)).toBe(true);
  });

  it('切り詰められたJPEGはデコード失敗として一覧に出て、--apply後も変更されない', async () => {
    const full = await makeJpeg(4000, 3000);
    const truncated = full.subarray(0, Math.floor(full.length * 0.5));
    const target = join(lib, 'broken.jpg');
    await writeFile(target, truncated);

    const { logs, restore } = captureLogs();
    await main([], envFor({ ATTACHMENT_MAX_EDGE_PX: '1000' }));
    restore();

    expect(logs.some((l) => l.includes('デコードに失敗したファイル: 1件'))).toBe(true);
    expect(logs.some((l) => l.includes('broken.jpg'))).toBe(true);

    const { restore: restore2 } = captureLogs();
    await main(['--apply', '--yes'], envFor({ ATTACHMENT_MAX_EDGE_PX: '1000' }));
    restore2();

    const after = await readFile(target);
    expect(after.equals(truncated)).toBe(true);
  });

  it('アニメーション画像(APNG)は上限超過でも--apply後に変更されない', async () => {
    const apng = buildApng(2000, 2000);
    const target = join(lib, 'anim.png');
    await writeFile(target, apng);

    const { restore } = captureLogs();
    await main(['--apply', '--yes'], envFor({ ATTACHMENT_MAX_EDGE_PX: '500' }));
    restore();

    const after = await readFile(target);
    expect(after.equals(apng)).toBe(true);
  });

  it('.trash配下と.git配下のファイルは走査対象外', async () => {
    await mkdir(join(lib, '.trash'), { recursive: true });
    const img = await sharp({
      create: { width: 100, height: 100, channels: 3, background: { r: 1, g: 1, b: 1 } },
    })
      .png()
      .toBuffer();
    await writeFile(join(lib, '.trash', 'x.png'), img);
    await writeFile(join(lib, '.git', 'not-really-a-ref.png'), img);

    const { logs, restore } = captureLogs();
    await main([], envFor());
    restore();

    expect(logs.some((l) => l.startsWith('走査したファイル数: 0件'))).toBe(true);
  });

  it('再エンコード結果が原本以上になる画像はスキップ内訳に計上され、変更されない', async () => {
    const width = 3000;
    const height = 1500;
    const raw = Buffer.alloc(width * height * 3);
    for (let i = 0; i < raw.length; i += 3) {
      const v = (i / 3) % 4;
      raw[i] = v * 60;
      raw[i + 1] = v * 60;
      raw[i + 2] = v * 60;
    }
    const src = await sharp(raw, { raw: { width, height, channels: 3 } })
      .png({ palette: true, colors: 4 })
      .toBuffer();
    const target = join(lib, 'palette.png');
    await writeFile(target, src);

    const { logs, restore } = captureLogs();
    await main([], envFor({ ATTACHMENT_MAX_EDGE_PX: '2048' }));
    restore();

    expect(logs.some((l) => l.includes('再エンコード結果が原本以上で棄却: 1件'))).toBe(true);

    const { restore: restore2 } = captureLogs();
    await main(['--apply', '--yes'], envFor({ ATTACHMENT_MAX_EDGE_PX: '2048' }));
    restore2();

    const after = await readFile(target);
    expect(after.equals(src)).toBe(true);
  });

  it('--apply後、Gitコミットが1つだけ作られ、無関係な未コミット差分は巻き込まれない', async () => {
    // 本CLIは「サービスを停止してから実行」を推奨しているため、watcher/syncがまだ
    // 拾っていない外部編集(文書の保存途中・未追跡ファイル等)が作業ツリーに残っている
    // 状態こそが想定運用。commitAll(git add -A)だとこれを巻き込んでしまうため、
    // 実際に書き込んだファイルだけがコミットに含まれることを検証する(Opusレビュー指摘)
    const git = simpleGit({ baseDir: lib });

    // 既にGit管理下にある文書を用意し、コミット後に未コミットで編集する
    const notePath = join(lib, 'note.md');
    await writeFile(notePath, '# 既存文書\n');
    await git.add(['note.md']);
    await git.commit('add: note.md');
    await writeFile(notePath, '# 既存文書(編集中の下書き)\n');

    // 未追跡の無関係なファイルも置いておく
    await writeFile(join(lib, '無関係な新規.md'), '# 無関係\n');

    const beforeLog = await git.log();

    const src = await sharp({
      create: { width: 4000, height: 2000, channels: 3, background: { r: 5, g: 6, b: 7 } },
    })
      .jpeg()
      .toBuffer();
    await writeFile(join(lib, 'photo.jpg'), src);

    const { restore } = captureLogs();
    await main(['--apply', '--yes'], envFor({ ATTACHMENT_MAX_EDGE_PX: '1000' }));
    restore();

    const afterLog = await git.log();
    expect(afterLog.total - beforeLog.total).toBe(1);
    expect(afterLog.latest?.message).toContain('issue #248');

    // コミットに含まれるのは縮小したphoto.jpgだけ
    const changedFiles = (await git.raw(['show', '--name-only', '--format=', 'HEAD']))
      .split('\n')
      .filter(Boolean);
    expect(changedFiles).toEqual(['photo.jpg']);

    // note.mdの未コミット編集・無関係な新規.mdの未追跡状態はそのまま残る
    const status = await git.status();
    expect(status.modified).toContain('note.md');
    expect(status.not_added).toContain('無関係な新規.md');
  });
});
