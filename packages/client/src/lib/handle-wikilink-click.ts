import { parseWikilinkTarget, type DocSummary } from '@tsumiwiki/shared';
import { docUrl } from './doc-path';
import { resolveWikilink } from './resolve-wikilink';

// #96: 本文と差分表示で共通の wikilink クリック処理。
// DocView 本体・履歴パネル(HistoryPanel > DiffView) のどちらから呼ばれても
// 同じ resolveWikilink → docUrl → navigate の流れになるように純関数として切り出す。
//
// 履歴パネルは DocView 本体のクリックコンテナと兄弟なので、
// DocView の onClick には冒頭のクリックが伝播しない。DiffView 側でこのヘルパを
// 直接呼ぶための共通ロジックとして使う。
//
// 戻り値: wikilink クリックとして「処理した」かどうか(true なら呼び出し側は他の
// 分岐に進まない)。closest で span[data-type="wikilink"] を辿るので、
// span の子要素(alias テキストノード等)をクリックしても拾える。

type Navigate = (to: string) => void;
type ShowToast = (
  kind: 'success' | 'info' | 'warning' | 'error',
  message: string,
) => void;

export function handleWikilinkClick(
  target: EventTarget | null,
  docs: DocSummary[],
  navigate: Navigate,
  showToast: ShowToast,
  onUnresolved?: (wikilinkTarget: string) => void,
): boolean {
  if (!(target instanceof Element)) return false;
  const wikilinkEl = target.closest('span[data-type="wikilink"]');
  if (!wikilinkEl) return false;

  const wikilinkTarget = wikilinkEl.getAttribute('data-target') ?? '';
  const resolved = resolveWikilink(wikilinkTarget, docs);
  if (resolved) {
    navigate(docUrl(resolved));
  } else {
    const meta = parseWikilinkTarget(wikilinkTarget);
    // 自文書内リンク([[#見出し]])や target が空の場合は新規作成ダイアログを開かず従来どおりトースト表示
    if (!meta.isInternal && meta.target && onUnresolved) {
      onUnresolved(wikilinkTarget);
    } else {
      showToast('error', 'リンク先が見つかりません');
    }
  }
  return true;
}
