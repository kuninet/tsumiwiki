import { describe, expect, it } from 'vitest';
import { embedSrcCandidates, resolveImageSrc } from './resolve-embed-src';

describe('embedSrcCandidates', () => {
  it('文書と同じフォルダ・ルート・attachments/の順で候補を返す(パスセグメントはURLエンコードされる)', () => {
    expect(embedSrcCandidates('a.png', 'フォルダ')).toEqual([
      `/api/files/${encodeURIComponent('フォルダ')}/a.png`,
      '/api/files/a.png',
      '/api/files/attachments/a.png',
    ]);
  });

  it('文書がルート直下の場合、同フォルダ候補とルート候補が重複しない', () => {
    expect(embedSrcCandidates('a.png', '')).toEqual(['/api/files/a.png', '/api/files/attachments/a.png']);
  });

  it('絶対URLはそのまま1候補のみ返す', () => {
    expect(embedSrcCandidates('https://example.com/a.png', 'フォルダ')).toEqual([
      'https://example.com/a.png',
    ]);
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

  it('絶対URL(http/https)はそのまま返す', () => {
    expect(resolveImageSrc('https://example.com/a.png', 'フォルダ')).toBe('https://example.com/a.png');
  });

  it('data URLはそのまま返す', () => {
    expect(resolveImageSrc('data:image/png;base64,AAAA', 'フォルダ')).toBe('data:image/png;base64,AAAA');
  });
});
