import { describe, expect, it } from 'vitest';
import { formatEntry, insertIntoSection, isValidHeading } from './daily-append.js';

describe('formatEntry', () => {
  it('接頭辞は HH:MM [source] の形で1行目の先頭に付く', () => {
    expect(formatEntry('作業完了', { time: '14:30', source: 'Claude Code' })).toBe(
      '14:30 [Claude Code] 作業完了',
    );
  });

  it('source 省略時は HH:MM だけが付く', () => {
    expect(formatEntry('作業完了', { time: '09:05' })).toBe('09:05 作業完了');
  });

  it('複数行 text は1行目だけに接頭辞が付き、2行目以降はそのまま', () => {
    expect(formatEntry('1行目\n  2行目\n\n4行目', { time: '10:00', source: 'A' })).toBe(
      '10:00 [A] 1行目\n  2行目\n\n4行目',
    );
  });

  it('末尾の改行は取り除き、CRLF は LF にする', () => {
    expect(formatEntry('a\r\nb\r\n\r\n', { time: '10:00' })).toBe('10:00 a\nb');
  });

  it('1行目がリスト記号で始まるときは記号の直後に接頭辞を入れる', () => {
    expect(formatEntry('- 作業完了', { time: '14:30', source: 'Claude Code' })).toBe(
      '- 14:30 [Claude Code] 作業完了',
    );
    expect(formatEntry('  * 入れ子', { time: '14:30' })).toBe('  * 14:30 入れ子');
    expect(formatEntry('+ 項目', { time: '14:30' })).toBe('+ 14:30 項目');
    expect(formatEntry('1. 手順\n2. 次', { time: '14:30' })).toBe('1. 14:30 手順\n2. 次');
  });

  it('タスク記法(- [ ] / - [x] / - [X])はチェックボックスの後ろに接頭辞を入れる', () => {
    expect(formatEntry('- [ ] todo', { time: '14:30', source: 'S' })).toBe('- [ ] 14:30 [S] todo');
    expect(formatEntry('- [x] done', { time: '14:30' })).toBe('- [x] 14:30 done');
    expect(formatEntry('* [X] done', { time: '14:30' })).toBe('* [X] 14:30 done');
    expect(formatEntry('1. [ ] 手順', { time: '14:30' })).toBe('1. [ ] 14:30 手順');
  });

  it('チェックボックスに見えないブラケットは記号の直後に入れる', () => {
    expect(formatEntry('- [リンク](u) 説明', { time: '14:30' })).toBe('- 14:30 [リンク](u) 説明');
  });

  it('記号の後に空白がない行はリストとみなさない', () => {
    expect(formatEntry('-5度', { time: '14:30' })).toBe('14:30 -5度');
  });
});

describe('isValidHeading', () => {
  it('ATX 見出し1行だけを許す', () => {
    expect(isValidHeading('## メモ')).toBe(true);
    expect(isValidHeading('  # タイトル ')).toBe(true);
    expect(isValidHeading('メモ')).toBe(false);
    expect(isValidHeading('##メモ')).toBe(false);
    expect(isValidHeading('## メモ\n本文')).toBe(false);
    expect(isValidHeading('####### 深すぎる')).toBe(false);
    expect(isValidHeading('##')).toBe(false);
    expect(isValidHeading('## ##')).toBe(false);
    expect(isValidHeading('## メモ ##')).toBe(true);
  });
});

describe('insertIntoSection', () => {
  const E = '14:30 追記';

  it('中身のある節の最後の行の直後に入る(リスト項目どうしは空行を挟まない)', () => {
    const body = '# 日誌\n\n## メモ\n\n- 既存1\n- 既存2\n';
    expect(insertIntoSection(body, '## メモ', '- 14:30 追記')).toBe(
      '# 日誌\n\n## メモ\n\n- 既存1\n- 既存2\n- 14:30 追記\n',
    );
  });

  it('段落の entry は直前の行と空行で区切る(直前のリスト項目や段落にくっつけない)', () => {
    expect(insertIntoSection('## メモ\n\n- 既存\n', '## メモ', E)).toBe(
      '## メモ\n\n- 既存\n\n14:30 追記\n',
    );
    expect(insertIntoSection('## メモ\n\n既存の段落\n', '## メモ', E)).toBe(
      '## メモ\n\n既存の段落\n\n14:30 追記\n',
    );
  });

  it('リスト項目の entry でも直前が段落なら空行で区切る', () => {
    expect(insertIntoSection('## メモ\n\n既存の段落\n', '## メモ', '- 14:30 追記')).toBe(
      '## メモ\n\n既存の段落\n\n- 14:30 追記\n',
    );
  });

  it('タスク項目・番号付き項目もリストとして続ける', () => {
    expect(insertIntoSection('## メモ\n\n- [ ] a\n', '## メモ', '- [x] 14:30 b')).toBe(
      '## メモ\n\n- [ ] a\n- [x] 14:30 b\n',
    );
    expect(insertIntoSection('## メモ\n\n1. a\n', '## メモ', '2. 14:30 b')).toBe(
      '## メモ\n\n1. a\n2. 14:30 b\n',
    );
  });

  it('連続して段落の entry を追記すると、それぞれ別の段落になる', () => {
    const first = insertIntoSection('## メモ\n', '## メモ', '14:30 1件目');
    expect(insertIntoSection(first, '## メモ', '14:45 2件目')).toBe(
      '## メモ\n\n14:30 1件目\n\n14:45 2件目\n',
    );
  });

  it('後ろに別の見出しがあるときは節の末尾の空行を entry の後ろに残す', () => {
    const body = '## メモ\n\n既存\n\n## 次\n\n内容\n';
    expect(insertIntoSection(body, '## メモ', E)).toBe(
      '## メモ\n\n既存\n\n14:30 追記\n\n## 次\n\n内容\n',
    );
  });

  it('下位見出し(###)は節に含まれ、その末尾に入る', () => {
    const body = '## メモ\n\n既存\n\n### 小節\n\n小節の内容\n\n## 次\n';
    expect(insertIntoSection(body, '## メモ', E)).toBe(
      '## メモ\n\n既存\n\n### 小節\n\n小節の内容\n\n14:30 追記\n\n## 次\n',
    );
  });

  it('上位見出し(#)で節が終わる', () => {
    const body = '## メモ\n\n既存\n\n# 別章\n';
    expect(insertIntoSection(body, '## メモ', E)).toBe('## メモ\n\n既存\n\n14:30 追記\n\n# 別章\n');
  });

  it('見出しだけで中身がない節は見出しの直後に空行を置いて入る', () => {
    expect(insertIntoSection('## メモ\n', '## メモ', E)).toBe('## メモ\n\n14:30 追記\n');
    expect(insertIntoSection('## メモ\n\n## 次\n', '## メモ', E)).toBe(
      '## メモ\n\n14:30 追記\n\n## 次\n',
    );
  });

  it('見出しの直後に別の見出しが詰まっている場合は entry の後ろにも空行を置く', () => {
    expect(insertIntoSection('## メモ\n## 次\n', '## メモ', E)).toBe(
      '## メモ\n\n14:30 追記\n\n## 次\n',
    );
  });

  it('見出しがないときは末尾の空白行を詰めて見出しごと足す', () => {
    const body = '---\ndate: 2026-07-05\n---\n\n# 日誌\n\n';
    expect(insertIntoSection(body, '## メモ', E)).toBe(
      '---\ndate: 2026-07-05\n---\n\n# 日誌\n\n## メモ\n\n14:30 追記\n',
    );
  });

  it('body が空なら見出しと entry だけになる', () => {
    expect(insertIntoSection('', '## メモ', E)).toBe('## メモ\n\n14:30 追記\n');
    expect(insertIntoSection('\n\n', '## メモ', E)).toBe('## メモ\n\n14:30 追記\n');
  });

  it('コードフェンス内の見出しは無視する', () => {
    const body = '```md\n## メモ\n```\n';
    expect(insertIntoSection(body, '## メモ', E)).toBe(
      '```md\n## メモ\n```\n\n## メモ\n\n14:30 追記\n',
    );
    const tilde = '## メモ\n\n~~~\n# コード内\n~~~\n\n## 次\n';
    expect(insertIntoSection(tilde, '## メモ', E)).toBe(
      '## メモ\n\n~~~\n# コード内\n~~~\n\n14:30 追記\n\n## 次\n',
    );
  });

  it('見出しの一致は前後の空白を除いた完全一致で、複数あれば最初を使う', () => {
    const body = '## メモ書き\n\n## メモ  \n\na\n\n## メモ\n\nb\n';
    expect(insertIntoSection(body, '## メモ', E)).toBe(
      '## メモ書き\n\n## メモ  \n\na\n\n14:30 追記\n\n## メモ\n\nb\n',
    );
  });

  it('複数行 entry をそのまま差し込む', () => {
    expect(insertIntoSection('## メモ\n\na\n', '## メモ', '10:00 1行目\n2行目')).toBe(
      '## メモ\n\na\n\n10:00 1行目\n2行目\n',
    );
  });

  it('既存の行は書き換えず、結果は改行1つで終わる', () => {
    const body = '## メモ\n\n- a\n\n\n';
    const out = insertIntoSection(body, '## メモ', E);
    expect(out).toBe('## メモ\n\n- a\n\n14:30 追記\n');
    expect(out.endsWith('\n\n')).toBe(false);
  });

  it('CRLF の body は LF に揃えて処理する', () => {
    expect(insertIntoSection('## メモ\r\n\r\na\r\n', '## メモ', E)).toBe('## メモ\n\na\n\n14:30 追記\n');
  });

  it('閉じの # 付き・タブ区切り・連続空白の見出しも同じ見出しとして一致する', () => {
    expect(insertIntoSection('## メモ ##\n\na\n', '## メモ', '- x')).toBe('## メモ ##\n\na\n\n- x\n');
    expect(insertIntoSection('##\tメモ\n\n- a\n', '## メモ', '- x')).toBe('##\tメモ\n\n- a\n- x\n');
    expect(insertIntoSection('##   メモ   \n\n- a\n', '## メモ', '- x')).toBe('##   メモ   \n\n- a\n- x\n');
    expect(insertIntoSection('## メモ\n\n- a\n', '##  メモ ##', '- x')).toBe('## メモ\n\n- a\n- x\n');
  });

  it('見出しの # の数が違えば別の見出し', () => {
    expect(insertIntoSection('### メモ\n\na\n', '## メモ', '- x')).toBe(
      '### メモ\n\na\n\n## メモ\n\n- x\n',
    );
  });

  it('4スペース以上のインデントはコードブロックで、見出しとみなさない', () => {
    const body = '    ## メモ\n\n## 次\n';
    expect(insertIntoSection(body, '## メモ', '- x')).toBe(
      '    ## メモ\n\n## 次\n\n## メモ\n\n- x\n',
    );
    // 節の終わりの判定でも、4スペースの見出し風の行は無視する
    const inSection = '## メモ\n\n- a\n    # コード\n';
    expect(insertIntoSection(inSection, '## メモ', '- x')).toBe(
      '## メモ\n\n- a\n    # コード\n\n- x\n',
    );
  });

  it('3スペースまでのインデントは見出しとして扱う', () => {
    expect(insertIntoSection('   ## メモ\n\n- a\n', '## メモ', '- x')).toBe(
      '   ## メモ\n\n- a\n- x\n',
    );
  });

  it('#タグ のように # の後ろに空白がない行は見出しではない', () => {
    expect(insertIntoSection('## メモ\n\n- a\n#タグ\n', '## メモ', '- x')).toBe(
      '## メモ\n\n- a\n#タグ\n\n- x\n',
    );
  });
});
