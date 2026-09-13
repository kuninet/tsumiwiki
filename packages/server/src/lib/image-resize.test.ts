import { deflateSync } from 'node:zlib';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { resizeAttachmentImage, stripJpegExifSegments } from './image-resize.js';

// resizeAttachmentImageは issue #248(既存添付の一括縮小CLI)からも直接呼ばれる想定の
// 純粋関数のため、ルート経由のHTTPテスト(attachments.test.ts)とは別にここで単体検証する

async function makeJpeg(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 10, g: 20, b: 200 } } })
    .jpeg()
    .toBuffer();
}

// テスト用: JPEGバッファ内のSOSマーカー(0xFFDA)の位置を探す。合成画像はスキャンが
// 1本のみのため、この単純な走査で十分(圧縮データ以降が完全一致することの検証に使う)
function indexOfSos(buf: Buffer): number {
  for (let i = 2; i < buf.length - 1; i++) {
    if (buf[i] === 0xff && buf[i + 1] === 0xda) return i;
  }
  throw new Error('SOSマーカーが見つかりません(テストヘルパー)');
}

// テスト用: JPEGが高圧縮率になりにくい擬似乱数ピクセルを決定的に生成する
// (Math.random()だとテストがフレーキーになるため、単純な乗算ハッシュで代用)
function noiseRaw(width: number, height: number): Buffer {
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i++) {
    raw[i] = (i * 2654435761) % 256;
  }
  return raw;
}

// ---- テスト用APNGビルダー(重大B回帰テスト用) ----
// 正規のAPNG(acTL + fcTL + IDAT + fcTL + fdAT)を最小構成で組み立てる。
// PNG/APNG仕様に沿ったチャンク列とCRC32を自前で生成する(sharpはAPNGの書き出しに
// 対応していないため)

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

describe('resizeAttachmentImage', () => {
  it('長辺が上限以下のPNGは何もせず同じバッファを返す', async () => {
    const src = await sharp({
      create: { width: 1024, height: 768, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .png()
      .toBuffer();
    const result = await resizeAttachmentImage(src, '.png', 2048);
    expect(result.changed).toBe(false);
    expect(result.data).toBe(src); // 参照も同一(再エンコードしていない)
  });

  it('長辺が上限以下でEXIF/Orientationを持たないJPEGは何もせず同じバッファを返す', async () => {
    const src = await makeJpeg(1024, 768);
    const result = await resizeAttachmentImage(src, '.jpg', 2048);
    expect(result.changed).toBe(false);
    expect(result.data).toBe(src);
  });

  it('長辺が上限以下でもGPS EXIF付きJPEG(Orientationなし)はEXIFだけ除去され、SOS以降の圧縮データは完全一致する', async () => {
    const src = await sharp({
      create: { width: 800, height: 600, channels: 3, background: { r: 7, g: 7, b: 7 } },
    })
      .jpeg()
      .withMetadata({ exif: { IFD3: { GPSLatitude: '35/1 0/1 0/1', GPSLatitudeRef: 'N' } } })
      .toBuffer();
    const before = await sharp(src).metadata();
    expect(before.exif).toBeTruthy();
    expect([1, undefined]).toContain(before.orientation); // 向き補正不要(1=正立 or 無指定)

    const result = await resizeAttachmentImage(src, '.jpg', 2048);
    expect(result.changed).toBe(true);
    const after = await sharp(result.data).metadata();
    expect(after.exif).toBeUndefined();
    expect(after.width).toBe(800);
    expect(after.height).toBe(600);

    const srcSos = indexOfSos(src);
    const outSos = indexOfSos(result.data);
    expect(result.data.subarray(outSos).equals(src.subarray(srcSos))).toBe(true);
  });

  it('長辺が上限以下でもGPS EXIF・Orientation付きJPEGは向きを適用してから再エンコードし、EXIFを落とす', async () => {
    const src = await sharp({
      create: { width: 800, height: 400, channels: 3, background: { r: 8, g: 8, b: 8 } },
    })
      .jpeg()
      .withMetadata({
        orientation: 6, // 90度回転が必要な向き
        exif: { IFD3: { GPSLatitude: '35/1 0/1 0/1', GPSLatitudeRef: 'N' } },
      })
      .toBuffer();
    const before = await sharp(src).metadata();
    expect(before.exif).toBeTruthy();
    expect(before.orientation).toBe(6);

    const result = await resizeAttachmentImage(src, '.jpg', 2048);
    expect(result.changed).toBe(true);
    const md = await sharp(result.data).metadata();
    expect(md.exif).toBeUndefined();
    expect(md.orientation).toBeUndefined();
    expect(md.width).toBe(400); // 800x400(横長)がorientation=6の適用で400x800(縦長)に補正される
    expect(md.height).toBe(800);
  });

  it('【重大A】低品質(quality50以下)でOrientation・GPS付きJPEGは、再エンコード結果が原本より大きくても採用してEXIFを落とす', async () => {
    // 乱数に近いピクセルデータをquality50でエンコードすると、既定quality(80)での
    // 再エンコード結果の方が大きくなる(実測で確認済み)。サイズだけを基準に原本へ
    // フォールバックすると、GPS付きの原本がそのまま残ってしまう
    const src = await sharp(noiseRaw(800, 400), { raw: { width: 800, height: 400, channels: 3 } })
      .jpeg({ quality: 50 })
      .withMetadata({
        orientation: 6,
        exif: { IFD3: { GPSLatitude: '35/1 0/1 0/1', GPSLatitudeRef: 'N' } },
      })
      .toBuffer();

    const result = await resizeAttachmentImage(src, '.jpg', 2048);
    expect(result.data.length).toBeGreaterThan(src.length); // 今回のケースでは肥大化する
    expect(result.changed).toBe(true); // それでも採用される(EXIF除去・向き補正が目的のため)
    const md = await sharp(result.data).metadata();
    expect(md.exif).toBeUndefined();
    expect(md.orientation).toBeUndefined();
    expect(md.width).toBe(400); // orientation=6の適用で800x400→400x800に補正される
    expect(md.height).toBe(800);
  });

  it('【重大A】GPS付きパレットPNGが上限超過なら、再エンコード結果が原本より大きくても縮小・EXIF除去を採用する', async () => {
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
      .withMetadata({ exif: { IFD3: { GPSLatitude: '35/1 0/1 0/1', GPSLatitudeRef: 'N' } } })
      .toBuffer();
    const before = await sharp(src).metadata();
    expect(before.exif).toBeTruthy();

    const result = await resizeAttachmentImage(src, '.png', 2048);
    expect(result.data.length).toBeGreaterThan(src.length); // パレット圧縮の効果が失われ肥大化する
    expect(result.changed).toBe(true); // それでも採用される(縮小・EXIF除去が目的のため)
    const md = await sharp(result.data).metadata();
    expect(md.exif).toBeUndefined();
    expect(Math.max(md.width ?? 0, md.height ?? 0)).toBeLessThanOrEqual(2048);
  });

  it('長辺が上限を超えると縮小し、アスペクト比を維持する', async () => {
    const src = await makeJpeg(4000, 3000);
    const result = await resizeAttachmentImage(src, '.jpg', 2048);
    expect(result.changed).toBe(true);
    const md = await sharp(result.data).metadata();
    expect(md.width).toBe(2048);
    expect(md.height).toBe(1536);
  });

  it('ICCプロファイルを持つ画像は縮小後もICCが残る(EXIFだけ落ちる)', async () => {
    const src = await sharp({
      create: { width: 4000, height: 3000, channels: 3, background: { r: 3, g: 4, b: 5 } },
    })
      .jpeg()
      .withMetadata({
        icc: 'p3',
        exif: { IFD3: { GPSLatitude: '35/1 0/1 0/1', GPSLatitudeRef: 'N' } },
      })
      .toBuffer();
    const before = await sharp(src).metadata();
    expect(before.icc).toBeTruthy();

    const result = await resizeAttachmentImage(src, '.jpg', 2048);
    const after = await sharp(result.data).metadata();
    expect(after.icc).toBeTruthy();
    expect(after.exif).toBeUndefined();
  });

  it('ロスレスWebPは縮小後もロスレス(VP8L)のまま。既定のロッシー変換だとサイズが増える', async () => {
    const src = await sharp({
      create: { width: 3000, height: 1500, channels: 3, background: { r: 5, g: 5, b: 5 } },
    })
      .webp({ lossless: true })
      .toBuffer();
    expect(src.subarray(12, 16).toString('ascii')).toBe('VP8L');

    const result = await resizeAttachmentImage(src, '.webp', 2048);
    expect(result.changed).toBe(true);
    expect(result.data.subarray(12, 16).toString('ascii')).toBe('VP8L');
    // ロッシー(既定quality)で再エンコードすると3000バイト超まで膨らむ内容だが、
    // ロスレスを引き継げていれば十分小さいまま
    expect(result.data.length).toBeLessThan(1000);
  });

  it('アニメーションWebP(pages>1)は素通しされる(長辺判定より優先)', async () => {
    const frame1 = await sharp({
      create: { width: 100, height: 60, channels: 3, background: { r: 255, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();
    const frame2 = await sharp({
      create: { width: 100, height: 60, channels: 3, background: { r: 0, g: 255, b: 0 } },
    })
      .png()
      .toBuffer();
    const animated = await sharp([frame1, frame2], { join: { animated: true } })
      .webp()
      .toBuffer();
    const md = await sharp(animated).metadata();
    expect(md.pages).toBe(2);

    // 上限を極端に小さくしても(100x60 > 10なので本来なら縮小対象)素通しされることを確認する
    // = アニメーション判定が長辺判定より先に効いていることの検証
    const result = await resizeAttachmentImage(animated, '.webp', 10);
    expect(result.changed).toBe(false);
    expect(result.data).toBe(animated);
  });

  it('中身がJPEGなのに拡張子が.pngのファイルは、PNG化せずJPEGのまま縮小される(実体を優先)', async () => {
    const src = await makeJpeg(4000, 3000);
    const before = await sharp(src).metadata();
    expect(before.format).toBe('jpeg');

    const result = await resizeAttachmentImage(src, '.png', 2048);
    expect(result.changed).toBe(true);
    const after = await sharp(result.data).metadata();
    expect(after.format).toBe('jpeg');
  });

  it('EXIF/Orientationが無い「純粋なサイズ削減目的」の場合のみ、再エンコード結果が原本以上のサイズなら原本を返す(肥大化防止)', async () => {
    // 少数色のパレットPNG(高圧縮・EXIF/Orientation無し)を用意する。上限超過により
    // 再エンコードされるとパレット圧縮の効果が失われ、原本よりかなり大きくなる典型例。
    // EXIFが無くOrientationも無いため、この場合だけは原本を優先してよい
    // (EXIF/Orientationが有る場合は上の【重大A】テストの通り、サイズに関わらず採用する)
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

    const result = await resizeAttachmentImage(src, '.png', 2048);
    expect(result.changed).toBe(false);
    expect(result.data).toBe(src);
  });

  it('縮小した場合はlogger.infoにbeforeBytes/afterBytes/width/heightを記録する', async () => {
    const src = await makeJpeg(4000, 3000);
    const info = vi.fn();
    const warn = vi.fn();
    const result = await resizeAttachmentImage(src, '.jpg', 2048, { info, warn });
    expect(result.changed).toBe(true);
    expect(info).toHaveBeenCalledTimes(1);
    const [fields, message] = info.mock.calls[0] as [Record<string, unknown>, string];
    expect(message).toContain('縮小');
    expect(fields.beforeBytes).toBe(src.length);
    expect(fields.afterBytes).toBe(result.data.length);
    expect(fields.width).toBe(4000);
    expect(fields.height).toBe(3000);
    expect(warn).not.toHaveBeenCalled();
  });

  it('変化がない場合はlogger.infoを呼ばない', async () => {
    const src = await makeJpeg(1024, 768);
    const info = vi.fn();
    const result = await resizeAttachmentImage(src, '.jpg', 2048, { info, warn: vi.fn() });
    expect(result.changed).toBe(false);
    expect(info).not.toHaveBeenCalled();
  });

  it('上限0は無効を意味し縮小しない', async () => {
    const src = await makeJpeg(4000, 3000);
    const result = await resizeAttachmentImage(src, '.jpg', 0);
    expect(result.changed).toBe(false);
    expect(result.data).toBe(src);
  });

  it('対象外拡張子(.svg / .gif)は縮小しない', async () => {
    const src = Buffer.from('dummy');
    const svg = await resizeAttachmentImage(src, '.svg', 2048);
    expect(svg.changed).toBe(false);
    const gif = await resizeAttachmentImage(src, '.gif', 2048);
    expect(gif.changed).toBe(false);
  });

  it('壊れた画像データは例外を投げず、changed:falseで原本を返す', async () => {
    const src = Buffer.from('これは画像ではない');
    const warn = vi.fn();
    const result = await resizeAttachmentImage(src, '.jpg', 2048, { warn, info: vi.fn() });
    expect(result.changed).toBe(false);
    expect(result.data).toBe(src);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('切り詰められた(末尾が壊れた)JPEGは縮小されず原本が保存される', async () => {
    const full = await makeJpeg(4000, 3000);
    const truncated = full.subarray(0, Math.floor(full.length * 0.5));
    const warn = vi.fn();
    const result = await resizeAttachmentImage(truncated, '.jpg', 2048, { warn, info: vi.fn() });
    expect(result.changed).toBe(false);
    expect(result.data).toBe(truncated);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('拡張子は大文字小文字を区別しない', async () => {
    const src = await makeJpeg(4000, 3000);
    const result = await resizeAttachmentImage(src, '.JPG', 2048);
    expect(result.changed).toBe(true);
  });

  it('【重大B】正規のAPNG(acTL+fcTL+IDAT+fcTL+fdAT)は、長辺が上限を超えていても素通しされる', async () => {
    const apng = buildApng(3000, 1500);
    const before = await sharp(apng).metadata();
    expect(before.format).toBe('png');
    expect(before.width).toBe(3000);
    expect(before.pages).toBeUndefined(); // libvipsのPNGローダーはpagesを報告しない

    const result = await resizeAttachmentImage(apng, '.png', 2048);
    expect(result.changed).toBe(false);
    expect(result.data).toBe(apng); // バイト列不変(参照も同一)
  });
});

describe('stripJpegExifSegments', () => {
  it('APP1(EXIF)・APP13(IPTC)だけを除去し、他のセグメントとSOS以降は保持する', async () => {
    const src = await sharp({
      create: { width: 100, height: 80, channels: 3, background: { r: 1, g: 1, b: 1 } },
    })
      .jpeg()
      .withMetadata({ icc: 'p3', exif: { IFD0: { Make: 'test' } } })
      .toBuffer();
    const stripped = stripJpegExifSegments(src);
    const md = await sharp(stripped).metadata();
    expect(md.exif).toBeUndefined();
    expect(md.icc).toBeTruthy(); // APP2(ICC)は対象外なので残る

    const srcSos = indexOfSos(src);
    const outSos = indexOfSos(stripped);
    expect(stripped.subarray(outSos).equals(src.subarray(srcSos))).toBe(true);
  });

  it('EXIFを持たないJPEGはバイト列が変化しない', async () => {
    const src = await makeJpeg(100, 80);
    const stripped = stripJpegExifSegments(src);
    expect(stripped.equals(src)).toBe(true);
  });

  it('SOIマーカーが無いデータは例外になる', () => {
    expect(() => stripJpegExifSegments(Buffer.from('not a jpeg'))).toThrow();
  });

  it('【中A】ゼロ長COMセグメントを大量に敷き詰めた敵対的な入力は例外になる(メモリ増幅を防ぐ)', () => {
    // FF FE 00 02 = COMマーカー(長さ2。ペイロード無し)。1024個を超える上限より
    // 十分多い数を敷き詰め、kept配列が際限なく膨らむ前に打ち切られることを確認する
    const segment = Buffer.from([0xff, 0xfe, 0x00, 0x02]);
    const segments = Buffer.concat(Array(2000).fill(segment));
    const adversarial = Buffer.concat([Buffer.from([0xff, 0xd8]), segments]);
    expect(() => stripJpegExifSegments(adversarial)).toThrow(/セグメント数/);
  });
});
