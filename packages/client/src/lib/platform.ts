// 各所のショートカット判定(TabBar / use-new-doc-shortcut / wikilink-suggestion 等)で
// 重複していたMac判定を共通化(#195)
export function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPod|iPhone|iPad/.test(navigator.platform);
}
