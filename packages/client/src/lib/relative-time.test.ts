import { describe, expect, it } from 'vitest';
import { relativeTime } from './relative-time';

describe('relativeTime', () => {
  const now = new Date('2026-07-04T12:00:00+09:00');

  it('1分未満は「たった今」を返す', () => {
    expect(relativeTime('2026-07-04T11:59:30+09:00', now)).toBe('たった今');
  });

  it('1時間未満は分単位で返す', () => {
    expect(relativeTime('2026-07-04T11:30:00+09:00', now)).toBe('30分前');
  });

  it('24時間未満は時間単位で返す', () => {
    expect(relativeTime('2026-07-04T10:00:00+09:00', now)).toBe('2時間前');
  });

  it('30日未満は日単位で返す', () => {
    expect(relativeTime('2026-07-02T12:00:00+09:00', now)).toBe('2日前');
  });

  it('30日以上前は日付表示にフォールバックする', () => {
    expect(relativeTime('2026-01-01T00:00:00+09:00', now)).toBe(
      new Date('2026-01-01T00:00:00+09:00').toLocaleDateString('ja-JP'),
    );
  });
});
