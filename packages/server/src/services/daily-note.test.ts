import { describe, expect, it } from 'vitest';
import { parseLocalDate } from './daily-note.js';

describe('parseLocalDate', () => {
  it('YYYY-MM-DD をローカルTZの0:00の Date に変換する', () => {
    const d = parseLocalDate('2026-07-05');
    expect(d).not.toBeNull();
    expect(d!.getFullYear()).toBe(2026);
    expect(d!.getMonth()).toBe(6);
    expect(d!.getDate()).toBe(5);
    expect(d!.getHours()).toBe(0);
  });

  it('うるう日は実在する年だけ受け付ける', () => {
    expect(parseLocalDate('2028-02-29')).not.toBeNull();
    expect(parseLocalDate('2026-02-29')).toBeNull();
  });

  it('実在しない日付(月日のオーバーフロー)は null', () => {
    for (const bad of ['2026-02-30', '2026-13-01', '2026-00-10', '2026-04-31', '2026-01-00']) {
      expect(parseLocalDate(bad)).toBeNull();
    }
  });

  it('形式不正は null', () => {
    for (const bad of ['abc', '', '2026-7-5', '2026/07/05', '2026-07-05T00:00', ' 2026-07-05']) {
      expect(parseLocalDate(bad)).toBeNull();
    }
  });
});
