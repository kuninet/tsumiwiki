// tiptap-markdownのparse.setup()に渡されるmarkdown-itインスタンスを
// 構造的型付けで扱うための最小限の型定義。
// (markdown-it本体の型を持ち込むと依存が増えるため、使用メンバーのみ定義)

export interface TokenLike {
  type: string;
  tag: string;
  nesting: number;
  content: string;
  meta: Record<string, string | null> | null;
  map?: [number, number] | null;
  block?: boolean;
}

export interface InlineStateLike {
  src: string;
  pos: number;
  posMax: number;
  push(type: string, tag: string, nesting: number): TokenLike;
}

export type InlineRuleFn = (state: InlineStateLike, silent: boolean) => boolean;

export interface BlockStateLike {
  src: string;
  bMarks: number[];
  eMarks: number[];
  tShift: number[];
  sCount: number[];
  blkIndent: number;
  line: number;
  lineMax: number;
  push(type: string, tag: string, nesting: number): TokenLike;
  getLines(begin: number, end: number, indent: number, keepLastLF: boolean): string;
}

export type BlockRuleFn = (
  state: BlockStateLike,
  startLine: number,
  endLine: number,
  silent: boolean,
) => boolean;

export type RenderRuleFn = (tokens: TokenLike[], idx: number) => string;

export interface MarkdownItLike {
  inline: {
    ruler: {
      before(beforeName: string, ruleName: string, fn: InlineRuleFn): void;
    };
  };
  block: {
    ruler: {
      before(
        beforeName: string,
        ruleName: string,
        fn: BlockRuleFn,
        options?: { alt?: string[] },
      ): void;
    };
  };
  renderer: {
    rules: Record<string, RenderRuleFn | undefined>;
  };
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
