// バックリンク抜粋文の整形純関数(#267)

export interface BacklinkContextSegment {
  text: string;
  isLink: boolean;
}

/**
 * バックリンク抜粋文から [[...]] を解析し、生の二重括弧を取り除いて
 * リンク部分(isLink: true)と通常テキスト(isLink: false)のセグメント配列に分割する。
 * [[target|alias]] の場合は別名(alias)を表示テキストとする。
 */
export function formatBacklinkContext(context: string): BacklinkContextSegment[] {
  if (!context) return [];

  const segments: BacklinkContextSegment[] = [];
  const regex = /\[\[([^\]]+)\]\]/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(context)) !== null) {
    if (match.index > lastIndex) {
      segments.push({
        text: context.slice(lastIndex, match.index),
        isLink: false,
      });
    }

    const inner = match[1];
    const pipeIndex = inner.indexOf('|');
    let displayText: string;
    if (pipeIndex !== -1) {
      displayText = inner.slice(pipeIndex + 1).trim();
    } else {
      displayText = inner.trim();
    }

    segments.push({
      text: displayText,
      isLink: true,
    });

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < context.length) {
    segments.push({
      text: context.slice(lastIndex),
      isLink: false,
    });
  }

  return segments;
}

/**
 * プレーンテキストとして整形された文字列を返す。
 */
export function formatBacklinkContextText(context: string): string {
  return formatBacklinkContext(context)
    .map((s) => s.text)
    .join('');
}
