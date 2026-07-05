import { describe, expect, it } from 'vitest';
import { saveBadge } from './save-badge';

describe('saveBadge', () => {
  it('dirtyでなければ「保存済み」を返す', () => {
    expect(saveBadge(false, null)).toEqual({ label: '保存済み', className: 'text-success' });
  });

  it('dirtyかつ自動保存済みがなければ「未保存の変更」を返す', () => {
    expect(saveBadge(true, null)).toEqual({ label: '未保存の変更', className: 'text-warning' });
  });

  it('dirtyかつ自動保存済みがあれば「自動保存済み」を返す', () => {
    expect(saveBadge(true, '2026-07-01T00:00:00+09:00')).toEqual({
      label: '自動保存済み',
      className: 'text-ink-faint',
    });
  });
});
