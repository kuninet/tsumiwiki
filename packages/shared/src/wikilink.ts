import type { DocSummary } from './index.js';

/**
 * wikilinkのパース結果メタデータ
 */
export interface WikilinkTargetMeta {
  /** 入力文字列(trim後) */
  raw: string;
  /** #見出しを除いた文書対象パス・タイトル(NFC正規化、先頭の./や/を除去) */
  target: string;
  /** 小文字化したtarget */
  targetKey: string;
  /** #以降の見出し・ブロックアンカー文字列(#なし) */
  anchor: string;
  /** 自文書内アンカーかどうか(targetが空でanchorが存在する場合にtrue) */
  isInternal: boolean;
}

/**
 * wikilinkのtarget文字列([[target]]または[[target|alias]]のtarget部)をパースする。
 */
export function parseWikilinkTarget(rawTarget: string): WikilinkTargetMeta {
  const raw = rawTarget.normalize('NFC').trim();

  // パイプ(|)が含まれている場合はパイプ前を取得
  const pipeIdx = raw.indexOf('|');
  const beforePipe = pipeIdx >= 0 ? raw.slice(0, pipeIdx).trim() : raw;

  // ハッシュ(#)が含まれている場合は文書部とアンカー部に分離
  const hashIdx = beforePipe.indexOf('#');
  let docPart: string;
  let anchor: string;
  if (hashIdx >= 0) {
    docPart = beforePipe.slice(0, hashIdx).trim();
    anchor = beforePipe.slice(hashIdx + 1).trim();
  } else {
    docPart = beforePipe;
    anchor = '';
  }

  // パスの正規化: バックスラッシュをスラッシュに変換、先頭の./や/を除去
  let target = docPart.replace(/\\/g, '/').replace(/^(\.\/|\/)+/, '');

  // 末尾の.mdがあれば除去して拡張子なしに統一
  if (target.endsWith('.md')) {
    target = target.slice(0, -3);
  }

  const targetKey = target.toLowerCase();
  const isInternal = target === '' && anchor !== '';

  return {
    raw,
    target,
    targetKey,
    anchor,
    isInternal,
  };
}

/**
 * 複数候補の中から最適な文書パスを選択する。
 * 1. 大文字小文字が完全一致する候補があれば優先
 * 2. それ以外、または同等ならpathのコード単位昇順
 */
function pickBestCandidate(
  candidates: readonly DocSummary[],
  isExactCase: (d: DocSummary) => boolean,
): string | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].path;

  // pathのコード単位昇順でソート (実行環境依存のlocaleCompareを排除)
  const sorted = [...candidates].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const exact = sorted.find(isExactCase);
  if (exact) return exact.path;
  return sorted[0].path;
}

/**
 * 高速解決用リゾルバを構築する
 */
export function buildWikilinkResolver(
  docs: readonly DocSummary[],
): (rawTarget: string) => string | null {
  // 事前インデックス構築
  const pathLowerMap = new Map<string, DocSummary[]>();
  const titleLowerMap = new Map<string, DocSummary[]>();
  const suffixMap = new Map<string, DocSummary[]>();
  const sortedDocs = [...docs].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  for (const doc of sortedDocs) {
    const pathLower = doc.path.toLowerCase();
    const existingPaths = pathLowerMap.get(pathLower);
    if (existingPaths) {
      existingPaths.push(doc);
    } else {
      pathLowerMap.set(pathLower, [doc]);
    }

    const titleLower = doc.title.toLowerCase();
    const existingTitles = titleLowerMap.get(titleLower);
    if (existingTitles) {
      existingTitles.push(doc);
    } else {
      titleLowerMap.set(titleLower, [doc]);
    }

    // 末尾一致検索用インデックス構築 (スラッシュ以降の各サフィックスを登録)
    let slashIdx = doc.path.indexOf('/');
    while (slashIdx !== -1) {
      const suffix = doc.path.slice(slashIdx).toLowerCase();
      const existingSuffixes = suffixMap.get(suffix);
      if (existingSuffixes) {
        existingSuffixes.push(doc);
      } else {
        suffixMap.set(suffix, [doc]);
      }
      slashIdx = doc.path.indexOf('/', slashIdx + 1);
    }
  }

  return (rawTarget: string): string | null => {
    if (!rawTarget) return null;
    const meta = parseWikilinkTarget(rawTarget);
    if (!meta.target) return null;

    const { target, targetKey } = meta;
    const expectedExactPath = `${target}.md`;
    const expectedLowerPath = `${targetKey}.md`;

    // 1. パス完全一致
    const pathCandidates = pathLowerMap.get(expectedLowerPath);
    if (pathCandidates && pathCandidates.length > 0) {
      return pickBestCandidate(pathCandidates, (d) => d.path === expectedExactPath);
    }

    // 2. タイトル一致
    const titleCandidates = titleLowerMap.get(targetKey);
    if (titleCandidates && titleCandidates.length > 0) {
      return pickBestCandidate(titleCandidates, (d) => d.title === target);
    }

    // 3. folder/title形式等の末尾一致 (suffixMapによるO(1)検索)
    const suffixExact = `/${target}.md`;
    const suffixLower = `/${targetKey}.md`;
    const suffixCandidates = suffixMap.get(suffixLower);
    if (suffixCandidates && suffixCandidates.length > 0) {
      return pickBestCandidate(suffixCandidates, (d) => d.path.endsWith(suffixExact));
    }

    return null;
  };
}

/**
 * Obsidian風の最短パス解決規則(FR-OBS-02・設計05章5.4)
 * ① パス完全一致(拡張子省略) ② タイトル一致 ③ folder/title形式の末尾一致
 * 大文字小文字の違いに対応し、同名複数時は辞書順で決定する。
 */
export function resolveWikilink(target: string, docs: readonly DocSummary[]): string | null {
  const resolver = buildWikilinkResolver(docs);
  return resolver(target);
}
