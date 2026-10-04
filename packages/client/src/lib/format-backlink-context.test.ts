import { describe, expect, it } from 'vitest';
import {
  formatBacklinkContext,
  formatBacklinkContextText,
} from './format-backlink-context';

describe('formatBacklinkContext', () => {
  it('空文字列の場合は空配列を返す', () => {
    expect(formatBacklinkContext('')).toEqual([]);
  });

  it('リンクを含まないテキストはそのままisLink: falseで返す', () => {
    expect(formatBacklinkContext('通常のテキストです')).toEqual([
      { text: '通常のテキストです', isLink: false },
    ]);
  });

  it('[[target]] を解析して二重括弧を取り除き、isLink: trueのセグメントを作成する', () => {
    expect(formatBacklinkContext('前文 [[話題]] 後文')).toEqual([
      { text: '前文 ', isLink: false },
      { text: '話題', isLink: true },
      { text: ' 後文', isLink: false },
    ]);
  });

  it('[[target|alias]] の場合、aliasを表示テキストとする', () => {
    expect(formatBacklinkContext('詳細は [[ドキュメント|仕様書]] を参照')).toEqual([
      { text: '詳細は ', isLink: false },
      { text: '仕様書', isLink: true },
      { text: ' を参照', isLink: false },
    ]);
  });

  it('複数リンクを正しく解析する', () => {
    expect(formatBacklinkContext('[[A]] と [[B|別名B]]')).toEqual([
      { text: 'A', isLink: true },
      { text: ' と ', isLink: false },
      { text: '別名B', isLink: true },
    ]);
  });
});

describe('formatBacklinkContextText', () => {
  it('生の二重括弧を取り除いたプレーンテキストを返す', () => {
    expect(formatBacklinkContextText('前文 [[話題]] と [[Target|別名]] 後文')).toBe(
      '前文 話題 と 別名 後文',
    );
  });
});
