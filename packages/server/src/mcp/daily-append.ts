// append_to_daily_note(#288)および append_to_note(#309)用の本文差し込み処理。
// I/O を持たない純粋関数だけを置く

// 見出し行(最大 3 スペースまでのインデントを許す。4 スペース以上はコードブロック)。
// `#` の後ろは空白かタブ(または行末)が必要で、`#タグ` や `##メモ` は見出しではない
const ATX_LINE_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;
const FENCE_OPEN_RE = /^( {0,3})(`{3,}|~{3,})/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
// 先頭のリスト記号(`- ` `* ` `+ ` `1. ` `1) `)。先頭の空白と、続くタスク記法
// (`[ ] ` `[x] ` `[X] `)も含めて保持する
const LIST_MARKER_RE = /^([ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)/;

export interface FenceState {
  indent: string;
  char: string;
  len: number;
}

export function hhmm(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

// ATX 見出し行を { level, text } に分解する。text は前後の空白と閉じの `#` 群を除き、
// 連続する空白を 1 つにしたもの。見出し行でなければ null
function parseAtxHeading(line: string): { level: number; text: string } | null {
  const m = ATX_LINE_RE.exec(line);
  if (!m) return null;
  const text = (m[2] ?? '')
    .replace(/(?:^|[ \t]+)#+[ \t]*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return { level: m[1]!.length, text };
}

// ATX 見出し 1 行(`## メモ` など)として有効か。改行を含む値、`#` 無し、見出し文字列が空の値は不正
export function isValidHeading(heading: string): boolean {
  const trimmed = heading.trim();
  if (/[\r\n]/.test(trimmed)) return false;
  const parsed = parseAtxHeading(trimmed);
  return parsed !== null && parsed.text !== '';
}

// テキストを整形せず、CRLF→LF と末尾改行の除去だけ行う
export function normalizeEntryText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\n+$/, '');
}

// 差し込む 1 件分の文字列を作る。接頭辞は `HH:MM [source] `(source 省略時は `HH:MM `)。
// 1 行目がリスト記号で始まる場合は記号の直後に接頭辞を入れる(`- 14:30 [Claude Code] 作業完了`)
export function formatEntry(text: string, opts: { time: string; source?: string }): string {
  const normalized = normalizeEntryText(text);
  const prefix = opts.source ? `${opts.time} [${opts.source}] ` : `${opts.time} `;
  const marker = LIST_MARKER_RE.exec(normalized);
  if (marker) {
    return marker[1] + prefix + normalized.slice(marker[1].length);
  }
  return prefix + normalized;
}

// 行配列のコードフェンス状態を走査し、末尾時点でフェンスが開いていればその状態を返す
export function scanFences(lines: string[]): FenceState | null {
  let fence: FenceState | null = null;
  for (const line of lines) {
    if (fence) {
      const close = FENCE_CLOSE_RE.exec(line);
      if (close && close[1]![0] === fence.char && close[1]!.length >= fence.len) {
        fence = null;
      }
      continue;
    }
    const open = FENCE_OPEN_RE.exec(line);
    if (open) {
      // バッククォートのフェンスは info 文字列に ` を含められない(含むならフェンスではない)
      if (!(open[2]![0] === '`' && line.slice(open[0].length).includes('`'))) {
        fence = { indent: open[1]!, char: open[2]![0]!, len: open[2]!.length };
      }
    }
  }
  return fence;
}

// 開いたフェンスがあれば、閉じ行（インデント・文字・長さを一致させた文字列）を返す
export function openFenceCloser(lines: string[]): string | null {
  const fence = scanFences(lines);
  if (!fence) return null;
  return `${fence.indent}${fence.char.repeat(fence.len)}`;
}

// 本文末尾に entry を追記する(issue #309)。
// 末尾の空行のみ除去し(最後の内容行の行末スペースは保持)、フェンスが開いていれば閉じ行を補完し、
// リストどうしなら空行なし、それ以外は空行1行挟んで結合する。必ず末尾改行1つで終わる
export function appendToEnd(body: string, entry: string): string {
  const normBody = body.replace(/\r\n/g, '\n');
  const lines = normBody === '' ? [] : normBody.split('\n');

  // 末尾の空行だけを行単位で pop して除去（最後の内容行の行末スペースは残す）
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') {
    lines.pop();
  }

  const entryLines = entry.split('\n');

  if (lines.length === 0) {
    return `${entry}\n`;
  }

  const closer = openFenceCloser(lines);
  if (closer !== null) {
    lines.push(closer);
  }

  const lastLine = lines[lines.length - 1]!;
  const continuesList =
    closer === null &&
    LIST_MARKER_RE.test(entryLines[0]!) &&
    LIST_MARKER_RE.test(lastLine);

  if (continuesList) {
    lines.push(...entryLines);
  } else {
    lines.push('', ...entryLines);
  }

  return lines.join('\n') + '\n';
}

// 指定見出しの節の末尾に entry を差し込む。節は「次の、同じかそれより上のレベルの見出し」の
// 直前まで(コードフェンス内は見出しとみなさない)。見出しが無ければ末尾に見出しごと足す。
// フェンスが開いたまま節が終わる場合は閉じ行を補完する。結果は必ず改行 1 つで終わる
export function insertIntoSection(body: string, heading: string, entry: string): string {
  const headingLine = heading.trim();
  const target = parseAtxHeading(headingLine)!;
  const lines = body.replace(/\r\n/g, '\n').split('\n');

  // コードフェンス外の見出し行の位置を調べる
  let fence: FenceState | null = null;
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (fence) {
      const close = FENCE_CLOSE_RE.exec(line);
      if (close && close[1]![0] === fence.char && close[1]!.length >= fence.len) {
        fence = null;
      }
      continue;
    }
    const open = FENCE_OPEN_RE.exec(line);
    if (open) {
      // バッククォートのフェンスは info 文字列に ` を含められない(含むならフェンスではない)
      if (!(open[2]![0] === '`' && line.slice(open[0].length).includes('`'))) {
        fence = { indent: open[1]!, char: open[2]![0]!, len: open[2]!.length };
        continue;
      }
    }
    const h = parseAtxHeading(line);
    if (!h) continue;
    if (start === -1) {
      if (h.level === target.level && h.text === target.text) start = i;
    } else if (h.level <= target.level) {
      end = i;
      break;
    }
  }

  const entryLines = entry.split('\n');

  if (start === -1) {
    // 見出しなし分岐: 末尾の空行を行単位で除去し、開いたフェンスがあれば閉じる
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') {
      lines.pop();
    }
    if (lines.length === 0) {
      return `${headingLine}\n\n${entry}\n`;
    }
    const closer = openFenceCloser(lines);
    if (closer !== null) {
      lines.push(closer);
    }
    lines.push('', headingLine, '', ...entryLines);
    return lines.join('\n') + '\n';
  }

  let lastContent = -1;
  for (let i = end - 1; i > start; i--) {
    if (lines[i]!.trim() !== '') {
      lastContent = i;
      break;
    }
  }

  if (lastContent === -1) {
    // 見出しだけで中身がない節: 見出しの直後に空行を 1 行置いて entry を入れる。
    // 直後に別の見出しが詰まっている場合は、その前にも空行を置く
    const insert = ['', ...entryLines];
    if (start + 1 < lines.length && lines[start + 1]!.trim() !== '') insert.push('');
    lines.splice(start + 1, 0, ...insert);
  } else {
    // 節の末尾までに開いたままのフェンスがあれば閉じる
    const closer = openFenceCloser(lines.slice(0, lastContent + 1));
    if (closer !== null) {
      lines.splice(lastContent + 1, 0, closer);
      lastContent++;
    }

    // リスト項目どうしは空行を挟まず続け(同じリストになる)、それ以外は直前の行と
    // 段落が混ざらないよう空行を 1 行挟む
    const continuesList =
      closer === null &&
      LIST_MARKER_RE.test(entryLines[0]!) &&
      LIST_MARKER_RE.test(lines[lastContent]!);
    lines.splice(lastContent + 1, 0, ...(continuesList ? [] : ['']), ...entryLines);
  }
  return lines.join('\n').replace(/\n*$/, '\n');
}
