import { describe, expect, it } from 'vitest';
import {
  embedSrc,
  imageFallbackSrc,
  isImageFile,
  isPdfFile,
  parseEmbedTarget,
  resolveImageSrc,
} from './resolve-embed-src';

describe('parseEmbedTarget', () => {
  it('サイズ指定の無いtargetはfileのみを返す', () => {
    expect(parseEmbedTarget('a.png')).toEqual({ file: 'a.png' });
  });

  it('|幅 のとき幅だけをwidthに反映する', () => {
    expect(parseEmbedTarget('a.png|300')).toEqual({ file: 'a.png', width: 300 });
  });

  it('|幅x高さ のとき両方をwidth/heightに反映する', () => {
    expect(parseEmbedTarget('a.png|300x200')).toEqual({ file: 'a.png', width: 300, height: 200 });
  });

  it('#anchorはfileから除去してanchorに保持する(画像側の解決には使わない)', () => {
    expect(parseEmbedTarget('a.png#見出し')).toEqual({ file: 'a.png', anchor: '見出し' });
  });

  it('|別名(サイズ形式でない)は無視してfileのみ返す', () => {
    expect(parseEmbedTarget('a.png|別名')).toEqual({ file: 'a.png' });
  });

  it('#anchorと|幅x高さを同時に指定した場合も両方正しく解釈する', () => {
    expect(parseEmbedTarget('a.png#見出し|300x200')).toEqual({
      file: 'a.png',
      width: 300,
      height: 200,
      anchor: '見出し',
    });
  });

  it('|が複数ある場合(サイズ形式でない)はサイズを無視してfileのみ返す', () => {
    expect(parseEmbedTarget('a.png|300|x')).toEqual({ file: 'a.png' });
  });

  it('全角数字の|幅はサイズ形式と認めず無視する', () => {
    expect(parseEmbedTarget('a.png|３００')).toEqual({ file: 'a.png' });
  });

  it('PDFの#pageアンカーをanchorに保持する(#204)', () => {
    expect(parseEmbedTarget('doc.pdf#page=3')).toEqual({ file: 'doc.pdf', anchor: 'page=3' });
  });

  it('#pageアンカーと|幅x高さを同時に指定した場合も両方保持する', () => {
    expect(parseEmbedTarget('doc.pdf#page=3|800x600')).toEqual({
      file: 'doc.pdf',
      anchor: 'page=3',
      width: 800,
      height: 600,
    });
  });
});

describe('embedSrc', () => {
  it('/api/embed?target=&from=にエンコードして解決する(日本語パスを含む)', () => {
    expect(embedSrc('画像.png', 'フォルダ/文書.md')).toBe(
      `/api/embed?target=${encodeURIComponent('画像.png')}&from=${encodeURIComponent('フォルダ/文書.md')}`,
    );
  });

  it('絶対URL(http/https/data)はそのまま返す', () => {
    expect(embedSrc('https://example.com/a.png', 'フォルダ/文書.md')).toBe(
      'https://example.com/a.png',
    );
    expect(embedSrc('data:image/png;base64,AAAA', 'フォルダ/文書.md')).toBe(
      'data:image/png;base64,AAAA',
    );
  });

  it('options.anchor指定時はURL末尾に#<anchor>を付ける(#204)', () => {
    expect(embedSrc('doc.pdf', 'notes/x.md', { anchor: 'page=3' })).toBe(
      `/api/embed?target=${encodeURIComponent('doc.pdf')}&from=${encodeURIComponent('notes/x.md')}#page=3`,
    );
  });

  it('anchor未指定時は従来どおり#を付けない', () => {
    expect(embedSrc('doc.pdf', 'notes/x.md', {})).toBe(
      `/api/embed?target=${encodeURIComponent('doc.pdf')}&from=${encodeURIComponent('notes/x.md')}`,
    );
  });
});

describe('isPdfFile / isImageFile', () => {
  it('.pdf(大文字小文字問わず)をPDFと判定する', () => {
    expect(isPdfFile('doc.pdf')).toBe(true);
    expect(isPdfFile('DOC.PDF')).toBe(true);
    expect(isPdfFile('folder/doc.pdf')).toBe(true);
  });

  it('画像拡張子はPDFと判定しない', () => {
    expect(isPdfFile('a.png')).toBe(false);
    expect(isPdfFile('no-extension')).toBe(false);
  });

  it('画像拡張子(png/jpg/jpeg/gif/svg/webp)を画像と判定する', () => {
    for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp']) {
      expect(isImageFile(`a.${ext}`)).toBe(true);
    }
  });

  it('PDF・未知拡張子は画像と判定しない', () => {
    expect(isImageFile('doc.pdf')).toBe(false);
    expect(isImageFile('a.txt')).toBe(false);
  });
});

describe('resolveImageSrc', () => {
  it('相対パスを文書フォルダ基準で/api/files/...に解決する(パスセグメントはURLエンコードされる)', () => {
    expect(resolveImageSrc('images/a.png', 'フォルダ')).toBe(
      `/api/files/${encodeURIComponent('フォルダ')}/images/a.png`,
    );
  });

  it('文書がルート直下の場合は相対パスをそのまま解決する', () => {
    expect(resolveImageSrc('images/a.png', '')).toBe('/api/files/images/a.png');
  });

  it('../で1階層上のフォルダへ正規化する', () => {
    expect(resolveImageSrc('../images/a.png', 'フォルダ/サブ')).toBe(
      `/api/files/${encodeURIComponent('フォルダ')}/images/a.png`,
    );
  });

  it('ルートより上へは出ない(余った../は無視する)', () => {
    expect(resolveImageSrc('../../a.png', 'フォルダ')).toBe('/api/files/a.png');
  });

  it('./は無視して正規化する', () => {
    expect(resolveImageSrc('./images/a.png', 'フォルダ')).toBe(
      `/api/files/${encodeURIComponent('フォルダ')}/images/a.png`,
    );
  });

  it('絶対URL(http/https)はそのまま返す', () => {
    expect(resolveImageSrc('https://example.com/a.png', 'フォルダ')).toBe(
      'https://example.com/a.png',
    );
  });

  it('data URLはそのまま返す', () => {
    expect(resolveImageSrc('data:image/png;base64,AAAA', 'フォルダ')).toBe(
      'data:image/png;base64,AAAA',
    );
  });
});

describe('imageFallbackSrc', () => {
  it('srcのファイル名部分だけをembedSrcで解決する', () => {
    expect(imageFallbackSrc('images/a.png', 'フォルダ/文書.md')).toBe(
      `/api/embed?target=${encodeURIComponent('a.png')}&from=${encodeURIComponent('フォルダ/文書.md')}`,
    );
  });

  it('ファイル名のみのsrcもそのまま解決する', () => {
    expect(imageFallbackSrc('a.png', '文書.md')).toBe(
      `/api/embed?target=${encodeURIComponent('a.png')}&from=${encodeURIComponent('文書.md')}`,
    );
  });

  it('絶対URLはnullを返す(フォールバックしない)', () => {
    expect(imageFallbackSrc('https://example.com/a.png', '文書.md')).toBeNull();
    expect(imageFallbackSrc('data:image/png;base64,AAAA', '文書.md')).toBeNull();
  });

  it('末尾が/でファイル名が空の場合はnullを返す', () => {
    expect(imageFallbackSrc('dir/', '文書.md')).toBeNull();
  });

  it('クエリ文字列を除去してファイル名だけをembedSrcで解決する', () => {
    expect(imageFallbackSrc('a.png?v=1', '文書.md')).toBe(
      `/api/embed?target=${encodeURIComponent('a.png')}&from=${encodeURIComponent('文書.md')}`,
    );
  });
});
