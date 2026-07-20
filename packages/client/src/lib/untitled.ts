// #153: 「無題」タイトルの自動採番。フォルダ内で既に使われているタイトルを避けて
// 「無題」→「無題(1)」→「無題(2)」...と番号を進める。
// 引数の existingTitles は該当フォルダ内で使われている title(拡張子なし)。

export const UNTITLED_BASE = '無題';

export function pickUniqueUntitledTitle(existingTitles: readonly string[]): string {
  const taken = new Set(existingTitles);
  if (!taken.has(UNTITLED_BASE)) return UNTITLED_BASE;
  for (let i = 1; i < 1000; i++) {
    const candidate = `${UNTITLED_BASE}(${i})`;
    if (!taken.has(candidate)) return candidate;
  }
  // 1000 個超はさすがに諦めて timestamp サフィックス
  return `${UNTITLED_BASE}(${Date.now()})`;
}
