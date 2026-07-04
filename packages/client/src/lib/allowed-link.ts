// リンクとして許可するURLスキーム(FR-LINK-02)。
// javascript:等の実行系スキームはエディタのコマンド挿入経路でも拒否する
const ALLOWED_SCHEMES = ['http', 'https', 'mailto', 'file'];

export function isAllowedLinkUrl(url: string): boolean {
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(url.trim());
  if (!schemeMatch) return true; // 相対URL・スキームなしは許可
  return ALLOWED_SCHEMES.includes(schemeMatch[1].toLowerCase());
}
