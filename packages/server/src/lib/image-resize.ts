import sharp from 'sharp';
import type { Logger } from 'pino';

// 添付画像の保存時縮小(issue #247)。ルート(routes/attachments.ts)からアップロード時に、
// CLI(issue #248で追加予定の既存添付一括縮小)から既存ファイルの再処理時に、
// それぞれ同じ判定・変換ロジックを呼べるよう独立した純粋関数として切り出す。
// (ファイルI/Oやdocの索引更新など呼び出し側の事情は一切持たない)

type ResizeLogger = Pick<Logger, 'warn' | 'info'>;

// 縮小対象の拡張子(画像のみ。PDFは対象外)。SVGはベクタのため、GIFはアニメーションが
// 壊れるため対象外(issue #247要件)
export const RESIZABLE_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
]);

export interface ImageResizeResult {
  data: Buffer;
  // 入力から変化したか(縮小・向き補正の再エンコード・EXIF除去のいずれかを行った場合true)。
  // falseなら`data`は入力と同一(バイト列不変)
  changed: boolean;
}

const JPEG_SOI = 0xd8;
const JPEG_SOS = 0xda;
const JPEG_APP1_EXIF = 0xe1;
const JPEG_APP13_IPTC = 0xed;
// 長さフィールドを持たないマーカー(SOI/EOI/TEM/RSTn)
const JPEG_MARKERS_WITHOUT_LENGTH = new Set([
  0xd8, 0xd9, 0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7,
]);
// 実際のJPEGのマーカー数はせいぜい数十個。ゼロ長COMセグメント等を敷き詰めた敵対的
// 入力でkept配列(=subarrayの集合。Buffer.concat時に入力の数十倍のheapを消費しうる)が
// 際限なく膨らむのを防ぐ上限(issue #247レビュー: 中A相当の指摘対応)
const JPEG_MAX_SEGMENTS = 1024;

// JPEGのAPP1(EXIF)・APP13(IPTC/Photoshop)セグメントだけをバイト走査で除去する。
// SOS(圧縮データの開始)より後ろは一切パースせず末尾までそのまま複製するため、
// 圧縮データ(画質)は1バイトも変化しない(issue #247レビュー: 重大2相当の指摘対応)。
// マーカー構造を解釈できない場合は例外を投げる(呼び出し元がcatchし原本へフォールバックする)
export function stripJpegExifSegments(buffer: Buffer): Buffer {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== JPEG_SOI) {
    throw new Error('JPEGのSOIマーカーが見つかりません');
  }
  const kept: Buffer[] = [buffer.subarray(0, 2)];
  let offset = 2;
  let segmentCount = 0;
  for (;;) {
    if (++segmentCount > JPEG_MAX_SEGMENTS) {
      throw new Error('JPEGのセグメント数が多すぎます');
    }
    if (offset >= buffer.length || buffer[offset] !== 0xff) {
      throw new Error('JPEGのマーカー構造を解釈できません');
    }
    // マーカー前の0xFF連続(フィルバイト)を読み飛ばして実際のマーカー種別を得る
    const markerStart = offset;
    let markerPos = offset + 1;
    while (markerPos < buffer.length && buffer[markerPos] === 0xff) markerPos++;
    if (markerPos >= buffer.length) {
      throw new Error('JPEGのマーカー種別を読み取れません');
    }
    const marker = buffer[markerPos];
    offset = markerPos + 1;

    if (marker === JPEG_SOS) {
      // SOS以降(ヘッダ+圧縮データ+末尾)は解釈せずそのまま複製して終了
      kept.push(buffer.subarray(markerStart));
      break;
    }
    if (JPEG_MARKERS_WITHOUT_LENGTH.has(marker)) {
      kept.push(buffer.subarray(markerStart, offset));
      continue;
    }
    if (offset + 2 > buffer.length) {
      throw new Error('JPEGのセグメント長を読み取れません');
    }
    const length = buffer.readUInt16BE(offset);
    const segmentEnd = offset + length;
    if (length < 2 || segmentEnd > buffer.length) {
      throw new Error('JPEGのセグメント長が不正です');
    }
    if (marker !== JPEG_APP1_EXIF && marker !== JPEG_APP13_IPTC) {
      kept.push(buffer.subarray(markerStart, segmentEnd));
    }
    offset = segmentEnd;
  }
  return Buffer.concat(kept);
}

// WebPのFourCCチャンクを辿り、ロスレス(VP8L)かどうかを判定する。sharpのmetadata()は
// ロスレスかどうかを返さないため、RIFFコンテナを直接読む。呼び出し元で既にアニメーション
// (ANIM/ANMF)は素通し済みのため、ここでは単一フレームの静止画のみを想定する。
// 判定できない場合は安全側(false=ロッシー扱い)にする
function isLosslessWebp(buffer: Buffer): boolean {
  if (
    buffer.length < 20 ||
    buffer.toString('ascii', 0, 4) !== 'RIFF' ||
    buffer.toString('ascii', 8, 12) !== 'WEBP'
  ) {
    return false;
  }
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const fourCC = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (fourCC === 'VP8L') return true;
    if (fourCC === 'VP8 ') return false;
    offset += 8 + chunkSize + (chunkSize % 2); // チャンクは偶数バイト境界にパディングされる
  }
  return false;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// PNGがAPNG(アニメーションPNG)かどうかを判定する。libvipsのPNGローダーはpage/pagesを
// 報告しない(pages()を返すのはgif/webp/tiff/heif/pdf系のみ)ため、metadata().pagesでは
// APNGを検出できない(issue #247レビュー: 重大B相当の指摘対応)。APNG仕様上、`acTL`
// チャンクは最初の`IDAT`より必ず前に置かれるため、それをバイト走査で確認する
function isAnimatedPng(buffer: Buffer): boolean {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return false;
  }
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (type === 'acTL') return true;
    if (type === 'IDAT') return false;
    offset += 12 + length; // 長さ(4) + 型(4) + データ(length) + CRC(4)
  }
  return false;
}

// 再エンコード結果を採用するか最終判定する。
// - EXIFもOrientationも無い「純粋なサイズ削減目的」の再エンコードでは、出力が原本以上の
//   サイズになったら意味が無いので原本をそのまま採用する(issue #247レビュー: 軽微1相当)
// - EXIF除去・向き補正が目的の再エンコード(EXIFが有る、またはOrientationが1でない)は、
//   プライバシー保護・表示破壊防止が目的でありサイズ削減が目的ではないため、
//   出力サイズに関わらず必ず採用する。ここでサイズだけを基準に原本へフォールバックすると
//   EXIF(GPS等)が残ったまま保存されてしまう(issue #247レビュー: 重大A相当の指摘対応)
function finalizeResult(
  original: Buffer,
  candidate: Buffer,
  logger: ResizeLogger | undefined,
  metadata: sharp.Metadata,
): ImageResizeResult {
  const isPureSizeReduction = !metadata.exif && (metadata.orientation ?? 1) === 1;
  if (isPureSizeReduction && candidate.length >= original.length) {
    return { data: original, changed: false };
  }
  logger?.info(
    {
      beforeBytes: original.length,
      afterBytes: candidate.length,
      width: metadata.width,
      height: metadata.height,
    },
    '添付画像を縮小しました',
  );
  return { data: candidate, changed: true };
}

// 画像を長辺上限に収まるよう縮小する。
// - 対象外拡張子・上限0(無効)の場合は何もせず入力をそのまま返す
// - アニメーション画像は1フレーム目だけの静止画に潰れてしまうため、GIFと同様に常に
//   素通しする(issue #247レビュー: 重大1相当の指摘対応)。WebP/TIFF等は`metadata.pages`
//   で判定できるが、libvipsのPNGローダーはpagesを報告しないため、APNGは`acTL`チャンクの
//   有無をバイト走査で別途判定する(issue #247レビュー: 重大B相当の指摘対応)
// - 長辺が上限以下の場合、PNG/WebPは再エンコードせずそのまま返す(劣化・肥大を避ける)。
//   JPEGはOrientationが無ければEXIF/IPTCだけをバイト除去し、Orientationがあれば
//   向きを適用する再エンコードのみ行う(縮小はしない)
// - 長辺が上限を超える場合のみ、アスペクト比を保ったまま縮小し、EXIFを落とす。
//   Orientationは除去前に画像へ適用してから落とすため、見た目の向きは変わらない
// - 失敗時は例外を投げず、ログに warn を残して入力をそのまま返す
//   (縮小に失敗してもアップロード自体は成功させる、という呼び出し側の要件を満たすため)
export async function resizeAttachmentImage(
  data: Buffer,
  ext: string,
  maxEdgePx: number,
  logger?: ResizeLogger,
): Promise<ImageResizeResult> {
  const normalizedExt = ext.toLowerCase();
  if (maxEdgePx <= 0 || !RESIZABLE_IMAGE_EXTENSIONS.has(normalizedExt)) {
    return { data, changed: false };
  }
  try {
    // failOnは既定(warning)のまま使う。'none'にすると壊れた画像でも警告だけで
    // デコードを続行してしまい、欠損部が別内容(灰色埋め等)の画像として保存されて
    // しまう(issue #247レビュー: 中1相当の指摘対応)。読めない画像は例外にして
    // catch側で原本にフォールバックさせる
    const image = sharp(data);
    const metadata = await image.metadata();

    if ((metadata.pages ?? 1) > 1) {
      // アニメーション画像(WebP/TIFF等)は素通し。長辺判定より必ず手前に置く
      // (animatedオプション無しでもpagesはフレーム数を正しく返すが、そもそも
      // アニメーションを縮小対象にしてはいけないため、高さの解釈に関わらずここで弾く)
      return { data, changed: false };
    }
    if (metadata.format === 'png' && isAnimatedPng(data)) {
      // APNGはmetadata.pagesに現れない(libvipsのPNGローダーの制約)ため、
      // acTLチャンクの有無を別途バイト走査で確認して素通しする
      return { data, changed: false };
    }

    const { width, height } = metadata;
    if (!width || !height) {
      return { data, changed: false };
    }

    const orientation = metadata.orientation ?? 1;
    const exceedsLimit = Math.max(width, height) > maxEdgePx;

    if (!exceedsLimit) {
      if (metadata.format !== 'jpeg') {
        // PNG/WebPは上限以下なら常に素通し(バイト列不変)。GPS等の位置情報を持つ
        // 実例が無いための割り切り。将来HEIC等を受け入れる場合はこの前提が崩れるため、
        // 対応拡張子を広げる際は見直すこと
        return { data, changed: false };
      }
      if (orientation === 1) {
        // 向き情報が無い(または補正不要)ので再エンコードせず、EXIF/IPTCの
        // セグメントだけをバイト走査で落とす。圧縮データ(SOS以降)は変化しない
        const stripped = stripJpegExifSegments(data);
        return finalizeResult(data, stripped, logger, metadata);
      }
      // Orientationが2〜8: 表示向きを補正するには再エンコードが避けられない
      // (issue #247レビュー: 重大2相当の指摘対応)。縮小はしない(上限以下のため)
      const output = await image
        .rotate()
        .keepIccProfile()
        // 品質は既定(80)のまま。写真用途で視覚劣化がほぼ無く、サイズ削減効果との
        // バランスが良い実用値のため、あえて設定化はしない
        .jpeg()
        .toBuffer();
      return finalizeResult(data, output, logger, metadata);
    }

    // 長辺が上限超過: 縮小して保存する。再エンコードするためEXIFも同時に落ちる
    let pipeline = image.rotate().keepIccProfile().resize({
      width: maxEdgePx,
      height: maxEdgePx,
      fit: 'inside',
      // ここに来る時点で長辺超過(exceedsLimit)を確認済みのため拡大は起こり得ないが、
      // 縮小方向のみに限定する二重の防御として付けておく
      withoutEnlargement: true,
    });
    // 出力形式は拡張子ではなく実体(metadata.format)で選ぶ(issue #247レビュー: 中4相当の
    // 指摘対応)。例: 中身がJPEGなのに.png名で保存されたファイルをPNG化して膨張させない
    if (metadata.format === 'png') {
      pipeline = pipeline.png();
    } else if (metadata.format === 'webp') {
      // ロスレスWebPをロッシー(既定quality 80)で再エンコードするとサイズが増える
      // ことがあるため、入力がロスレスならロスレスのまま出力する
      pipeline = pipeline.webp({ lossless: isLosslessWebp(data) });
    } else {
      pipeline = pipeline.jpeg();
    }
    const output = await pipeline.toBuffer();
    return finalizeResult(data, output, logger, metadata);
  } catch (e) {
    logger?.warn({ err: e }, '添付画像の縮小に失敗しました。原本をそのまま保存します');
    return { data, changed: false };
  }
}
