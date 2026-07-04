import { forwardRef, type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useRecentDocs, useSearch } from '../api/search';
import { useTags } from '../api/tags';
import { docUrl } from '../lib/doc-path';
import { confirmNavigationIfDirty } from '../lib/navigation-guard';
import { sanitizeSnippet } from '../lib/sanitize-snippet';
import { useUIStore } from '../stores/ui';

// ヘッダー検索・SearchDropdown(SC-04・デザインhandoff components.md)。
// クエリが空のときは「最近開いた文書」、入力中は「検索結果」→「タグ」の3セクション構成。
// 入力は300msデバウンスしてからuseSearchを呼ぶ

const DEBOUNCE_MS = 300;
const MIN_RECOMMENDED_LENGTH = 3; // trigramトークナイザの特性上、これ未満はヒットしないことがある
const MAX_TAG_SUGGESTIONS = 8;

type NavItem = { kind: 'doc'; path: string } | { kind: 'tag'; tag: string };

export const SearchBox = forwardRef<HTMLInputElement>(function SearchBox(_props, forwardedRef) {
  const [input, setInput] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const setSidebarTab = useUIStore((s) => s.setSidebarTab);
  const toggleTag = useUIStore((s) => s.toggleTag);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(input), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [input]);

  const trimmed = debounced.trim();
  const isEmptyQuery = trimmed.length === 0;

  const { data: recentDocs } = useRecentDocs();
  const { data: results } = useSearch(trimmed);
  const { data: tags } = useTags();

  const matchingTags = isEmptyQuery
    ? []
    : (tags ?? [])
        .filter((t) => t.tag.toLowerCase().startsWith(trimmed.toLowerCase()))
        .slice(0, MAX_TAG_SUGGESTIONS);

  const navItems: NavItem[] = isEmptyQuery
    ? (recentDocs ?? []).map((d): NavItem => ({ kind: 'doc', path: d.path }))
    : [
        ...(results ?? []).map((r): NavItem => ({ kind: 'doc', path: r.path })),
        ...matchingTags.map((t): NavItem => ({ kind: 'tag', tag: t.tag })),
      ];

  useEffect(() => {
    setActiveIndex(-1);
  }, [isEmptyQuery, results, recentDocs, tags]);

  useEffect(() => {
    function handleOutsideClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    window.addEventListener('mousedown', handleOutsideClick);
    return () => window.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  function closeAndReset() {
    setOpen(false);
    setInput('');
    setDebounced('');
  }

  function handleSelectDoc(path: string) {
    if (!confirmNavigationIfDirty()) {
      return;
    }
    navigate(docUrl(path));
    closeAndReset();
  }

  function handleSelectTag(tag: string) {
    setSidebarTab('tag');
    toggleTag(tag);
    closeAndReset();
  }

  function handleSelectItem(item: NavItem) {
    if (item.kind === 'doc') {
      handleSelectDoc(item.path);
    } else {
      handleSelectTag(item.tag);
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (navItems.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % navItems.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + navItems.length) % navItems.length);
    } else if (e.key === 'Enter') {
      if (activeIndex >= 0 && activeIndex < navItems.length) {
        handleSelectItem(navItems[activeIndex]);
      }
    }
  }

  const showHint = !isEmptyQuery && trimmed.length < MIN_RECOMMENDED_LENGTH;
  const showNoResults =
    !isEmptyQuery &&
    trimmed.length >= MIN_RECOMMENDED_LENGTH &&
    results &&
    results.length === 0 &&
    matchingTags.length === 0;

  return (
    <div ref={containerRef} className="relative w-full max-w-[420px]">
      <div className="flex items-center gap-2 rounded border border-line bg-panel-2 px-3 py-1.5">
        <span className="text-ink-faint" aria-hidden="true">
          🔍
        </span>
        <input
          ref={forwardedRef}
          type="text"
          placeholder="検索"
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          className="w-full bg-transparent text-sm text-ink placeholder:text-ink-faint focus:outline-none"
        />
        <span className="flex-shrink-0 rounded border border-line px-1.5 py-0.5 font-mono text-xs text-ink-faint">
          Ctrl K
        </span>
      </div>

      {open && (
        <div className="absolute left-0 top-full z-[40] mt-1 w-[520px] rounded-lg border border-line bg-panel shadow-lg">
          {isEmptyQuery && (
            <div className="py-1">
              <p className="px-3 pb-1 pt-2 text-xs font-medium text-ink-faint">最近開いた文書</p>
              {(recentDocs ?? []).length === 0 && (
                <p className="px-3 py-2 text-sm text-ink-faint">文書がありません</p>
              )}
              <ul>
                {(recentDocs ?? []).map((doc, i) => (
                  <li key={doc.path}>
                    <button
                      type="button"
                      onClick={() => handleSelectDoc(doc.path)}
                      className={`block w-full px-3 py-2 text-left ${
                        i === activeIndex ? 'bg-active' : 'hover:bg-hoverbg'
                      }`}
                    >
                      <div className="text-sm text-ink">{doc.title}</div>
                      <div className="text-xs text-ink-faint">{doc.folder || '(ルート)'}</div>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {!isEmptyQuery && (
            <>
              {showHint && <p className="px-3 py-2 text-xs text-ink-faint">3文字以上を推奨します</p>}
              {showNoResults && <p className="px-3 py-2 text-sm text-ink-faint">見つかりませんでした</p>}

              {results && results.length > 0 && (
                <div className="py-1">
                  <p className="px-3 pb-1 pt-2 text-xs font-medium text-ink-faint">検索結果</p>
                  <ul>
                    {results.map((r, i) => (
                      <li key={r.path}>
                        <button
                          type="button"
                          onClick={() => handleSelectDoc(r.path)}
                          className={`block w-full px-3 py-2 text-left ${
                            i === activeIndex ? 'bg-active' : 'hover:bg-hoverbg'
                          }`}
                        >
                          <div className="text-sm text-ink">{r.title}</div>
                          {/*
                            snippetはサーバー側でHTMLエスケープ済み+<mark>ハイライトのみを許可した契約
                            (packages/shared/src/index.ts の searchResultSchema コメント参照)。
                            クライアント側でも<mark>以外を除去して二重に防御する
                          */}
                          <div
                            className="mt-0.5 truncate text-xs text-ink-faint"
                            dangerouslySetInnerHTML={{ __html: sanitizeSnippet(r.snippet) }}
                          />
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {matchingTags.length > 0 && (
                <div className="border-t border-line py-1">
                  <p className="px-3 pb-1 pt-2 text-xs font-medium text-ink-faint">タグ</p>
                  <ul className="flex flex-wrap gap-1.5 px-3 pb-2">
                    {matchingTags.map((t, i) => {
                      const idx = (results ?? []).length + i;
                      const isActive = idx === activeIndex;
                      return (
                        <li key={t.tag}>
                          <button
                            type="button"
                            onClick={() => handleSelectTag(t.tag)}
                            className={`rounded-full border px-2.5 py-1 text-sm ${
                              isActive
                                ? 'border-accent-border bg-accent-soft text-accent'
                                : 'border-line bg-panel-2 text-ink-soft hover:bg-hoverbg'
                            }`}
                          >
                            <span>{`#${t.tag}`}</span> <span className="text-ink-faint">{t.count}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
});
