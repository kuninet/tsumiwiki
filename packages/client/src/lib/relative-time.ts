// 履歴パネルの相対時刻表示(デザインhandoff components.md HistoryPanel仕様)。
// 「2時間前」等の簡易表示。絶対時刻はtitle属性で別途表示する

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export function relativeTime(iso: string, now: Date = new Date()): string {
  const diffMs = now.getTime() - new Date(iso).getTime();
  if (diffMs < MINUTE_MS) return 'たった今';
  if (diffMs < HOUR_MS) return `${Math.floor(diffMs / MINUTE_MS)}分前`;
  if (diffMs < DAY_MS) return `${Math.floor(diffMs / HOUR_MS)}時間前`;
  const days = Math.floor(diffMs / DAY_MS);
  if (days < 30) return `${days}日前`;
  return new Date(iso).toLocaleDateString('ja-JP');
}
