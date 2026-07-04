import { forwardRef, type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSearch } from '../api/search';
import { docUrl } from '../lib/doc-path';
import { useEditStore } from '../stores/edit';

// ヘッダー検索(SC-04・設計04章)。入力は300msデバウンスしてから検索する

const DEBOUNCE_MS = 300;
const MIN_RECOMMENDED_LENGTH = 3; // trigramトークナイザの特性上、これ未満はヒットしないことがある
const UNSAVED_NAVIGATION_WARNING = '未保存の変更があります。移動しますか?';

export const SearchBox = forwardRef<HTMLInputElement>(function SearchBox(_props, forwardedRef) {
  const [input, setInput] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(input), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [input]);

  const trimmed = debounced.trim();
  const { data: results } = useSearch(trimmed);

  useEffect(() => {
    setActiveIndex(-1);
  }, [results]);

  useEffect(() => {
    function handleOutsideClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    window.addEventListener('mousedown', handleOutsideClick);
    return () => window.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  function handleSelect(path: string) {
    if (useEditStore.getState().dirty && !window.confirm(UNSAVED_NAVIGATION_WARNING)) {
      return;
    }
    navigate(docUrl(path));
    setOpen(false);
    setInput('');
    setDebounced('');
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (!results || results.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % results.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + results.length) % results.length);
    } else if (e.key === 'Enter') {
      if (activeIndex >= 0 && activeIndex < results.length) {
        handleSelect(results[activeIndex].path);
      }
    }
  }

  const showHint = trimmed.length > 0 && trimmed.length < MIN_RECOMMENDED_LENGTH;
  const showNoResults = trimmed.length >= MIN_RECOMMENDED_LENGTH && results && results.length === 0;

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

      {open && trimmed.length > 0 && (
        <div className="absolute left-0 top-full z-[40] mt-1 w-96 rounded-lg border border-line bg-panel shadow-lg">
          {showHint && <p className="px-3 py-2 text-xs text-ink-faint">3文字以上を推奨します</p>}
          {showNoResults && <p className="px-3 py-2 text-sm text-ink-faint">見つかりませんでした</p>}
          {results && results.length > 0 && (
            <ul>
              {results.map((r, i) => (
                <li key={r.path}>
                  <button
                    type="button"
                    onClick={() => handleSelect(r.path)}
                    className={`block w-full px-3 py-2 text-left ${
                      i === activeIndex ? 'bg-active' : 'hover:bg-hoverbg'
                    }`}
                  >
                    <div className="text-sm text-ink">{r.title}</div>
                    {/*
                      snippetはサーバー側でHTMLエスケープ済み+<mark>ハイライトのみを許可した契約
                      (packages/shared/src/index.ts の searchResultSchema コメント参照)のため
                      dangerouslySetInnerHTMLで描画してよい
                    */}
                    <div
                      className="mt-0.5 truncate text-xs text-ink-faint"
                      dangerouslySetInnerHTML={{ __html: r.snippet }}
                    />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
});
