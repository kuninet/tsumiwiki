import { describe, expect, it } from 'vitest';
import { expandTemplateVariables, formatDate } from './template-vars';

const D = new Date(2026, 6, 5, 14, 30, 45); // 2026-07-05 (日) 14:30:45 local

describe('formatDate', () => {
  it('YYYY-MM-DD', () => {
    expect(formatDate(D, 'YYYY-MM-DD')).toBe('2026-07-05');
  });
  it('YY年MM月DD日(HH:mm)', () => {
    expect(formatDate(D, 'YY年MM月DD日(HH:mm)')).toBe('26年07月05日(14:30)');
  });
  it('カスタム区切り', () => {
    expect(formatDate(D, 'YYYY_MM_DD_HH-mm-ss')).toBe('2026_07_05_14-30-45');
  });

  describe('曜日トークン', () => {
    // 2026-07-05 は日曜日
    it('aaa は短い日本語曜日', () => {
      expect(formatDate(D, 'YYYY-MM-DD(aaa)')).toBe('2026-07-05(日)');
    });
    it('aa も aaa と同じく短い日本語曜日(ユーザーが慣れた記法)', () => {
      expect(formatDate(D, 'YYYY-MM-DD(aa)')).toBe('2026-07-05(日)');
    });
    it('aaaa は長い日本語曜日', () => {
      expect(formatDate(D, 'YYYY-MM-DD(aaaa)')).toBe('2026-07-05(日曜日)');
    });
    it('aaaa と aaa/aa が混在しても壊れない(長い順に置換される)', () => {
      // aaaa と aaa を同時に含むケース
      expect(formatDate(D, 'aaaa/aaa/aa')).toBe('日曜日/日/日');
    });
    it('dddd と ddd が混在しても壊れない(長い順に置換される)', () => {
      // ddd を先に食うと dddd が `Sund` になるリグレッションを防ぐ
      expect(formatDate(D, 'dddd/ddd')).toBe('Sunday/Sun');
    });
    it('ddd は短い英語曜日', () => {
      expect(formatDate(D, 'YYYY-MM-DD (ddd)')).toBe('2026-07-05 (Sun)');
    });
    it('dddd は長い英語曜日', () => {
      expect(formatDate(D, 'YYYY-MM-DD (dddd)')).toBe('2026-07-05 (Sunday)');
    });
    it('平日も正しくマップされる(水曜)', () => {
      const wed = new Date(2026, 6, 8); // 2026-07-08 は水曜日
      expect(formatDate(wed, 'YYYY-MM-DD(aaa)')).toBe('2026-07-08(水)');
      expect(formatDate(wed, 'YYYY-MM-DD(aaaa)')).toBe('2026-07-08(水曜日)');
      expect(formatDate(wed, 'ddd')).toBe('Wed');
    });
  });
});

describe('expandTemplateVariables', () => {
  const ctx = { date: D, title: '2026-07-05', user: '山田太郎' };

  it('基本の変数を展開する', () => {
    expect(
      expandTemplateVariables('# {{title}}\n\n作成者: {{user}}\n{{date}}\n', ctx),
    ).toBe('# 2026-07-05\n\n作成者: 山田太郎\n2026-07-05\n');
  });

  it('{{date:FMT}} でフォーマット指定', () => {
    expect(expandTemplateVariables('{{date:YYYY年MM月DD日}}', ctx)).toBe('2026年07月05日');
  });

  it('未知の変数はそのまま残す', () => {
    expect(expandTemplateVariables('前 {{unknown}} 後', ctx)).toBe('前 {{unknown}} 後');
  });

  it('{{cursor}} は既定でそのまま残す(クライアントの位置決めマーカー)', () => {
    expect(expandTemplateVariables('前 {{cursor}} 後', ctx)).toBe('前 {{cursor}} 後');
  });

  it('stripCursor で {{cursor}} を空文字に(ファイル名等)', () => {
    expect(expandTemplateVariables('前 {{cursor}} 後', ctx, { stripCursor: true })).toBe('前  後');
  });

  it('{{year}}/{{month}}/{{day}}/{{hour}}/{{minute}} 個別変数', () => {
    expect(
      expandTemplateVariables('{{year}}-{{month}}-{{day}} {{hour}}:{{minute}}', ctx),
    ).toBe('2026-07-05 14:30');
  });
});
