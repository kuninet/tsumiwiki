import type { DocSummary } from '@tsumiwiki/shared';

// Obsidian風の最短パス解決規則(FR-OBS-02・設計05章5.4)
// ①パス完全一致(拡張子省略) ②タイトル一致(複数なら最初) ③folder/title形式の末尾一致
export function resolveWikilink(target: string, docs: DocSummary[]): string | null {
  const t = target.trim();
  if (!t) return null;

  const exact = docs.find((d) => d.path === `${t}.md`);
  if (exact) return exact.path;

  const byTitle = docs.find((d) => d.title === t);
  if (byTitle) return byTitle.path;

  const suffix = `/${t}.md`;
  const bySuffix = docs.find((d) => d.path.endsWith(suffix));
  if (bySuffix) return bySuffix.path;

  return null;
}
