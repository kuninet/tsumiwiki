import type katexType from 'katex';
import { escapeHtml } from '../markdown-it-types';

// KaTeX 本体の型定義を import (katex パッケージ同梱)
type KatexModule = typeof katexType;

let katexPromise: Promise<KatexModule> | null = null;

// KaTeX と CSS の遅延ロード(初期バンドルに入れない)
export function loadKatex(): Promise<KatexModule> {
  if (!katexPromise) {
    katexPromise = Promise.all([
      import('katex'),
      import('katex/dist/katex.min.css'),
    ])
      .then(([module]) => module.default ?? module)
      .catch((err) => {
        katexPromise = null; // M5: 失敗時はキャッシュを破棄して次回再試行可能にする
        throw err;
      });
  }
  return katexPromise;
}

export interface RenderResult {
  html: string;
  error?: string;
}

// 固定オプションでの KaTeX レンダリング
export async function renderKatex(
  latex: string,
  displayMode: boolean,
): Promise<RenderResult> {
  try {
    const katex = await loadKatex();
    // M6: throwOnError: true で直接パースエラーを捕捉し、HTMLエスケープ汚染のない生のメッセージを得る
    const html = katex.renderToString(latex, {
      displayMode,
      throwOnError: true,
      trust: false,
      strict: 'ignore',
      maxSize: 50,
      maxExpand: 1000,
      output: 'htmlAndMathml',
    });
    return { html };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (!displayMode) {
      // インライン表示でのパースエラー時フォールバック: 赤字で $latex$ を表示 (m1対応)
      return {
        html: `<span class="katex-error" style="color:#cc0000">$${escapeHtml(latex)}$</span>`,
        error: errorMsg,
      };
    }
    // ブロック表示: 生のエラーメッセージと空htmlを返し、NodeView側でエラー表示+ソース表示
    return {
      html: '',
      error: errorMsg,
    };
  }
}
