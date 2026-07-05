import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSearch } from '../api/search';
import { docUrl } from '../lib/doc-path';
import { confirmNavigationIfDirty } from '../lib/navigation-guard';
import { sanitizeSnippet } from '../lib/sanitize-snippet';

// ヘッダー検索(SC-04・設計04章)。入力は300msデバウンスしてから検索する

const DEBOUNCE_MS = 300;
const MIN_RECOMMENDED_LENGTH = 3; // trigramトークナイザの特性上、これ未満はヒットしないことがある

export function SearchBox() {
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
    if (!confirmNavigationIfDirty()) {
      return;
    }
    navigate(docUrl(path));
    setOpen(false);
    setInput('');
    setDebounced('');
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    // IME変換中のEnter/矢印は候補操作に使わない(FR-EDIT-05。変換確定の誤遷移防止)
    if (e.nativeEvent.isComposing) return;
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
    <div ref={containerRef} className="relative">
      <input
        type="text"
        placeholder="検索"
        value={input}
        onChange={(e) => {
          setInput(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        className="w-64 rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-800"
      />

      {open && trimmed.length > 0 && (
        <div className="absolute left-0 top-full z-50 mt-1 w-96 rounded border border-gray-200 bg-white shadow-lg">
          {showHint && <p className="px-3 py-2 text-xs text-gray-400">3文字以上を推奨します</p>}
          {showNoResults && <p className="px-3 py-2 text-sm text-gray-400">見つかりませんでした</p>}
          {results && results.length > 0 && (
            <ul>
              {results.map((r, i) => (
                <li key={r.path}>
                  <button
                    type="button"
                    onClick={() => handleSelect(r.path)}
                    className={`block w-full px-3 py-2 text-left ${
                      i === activeIndex ? 'bg-blue-50' : 'hover:bg-gray-100'
                    }`}
                  >
                    <div className="text-sm text-gray-800">{r.title}</div>
                    {/*
                      snippetはサーバー側でHTMLエスケープ済み+<mark>ハイライトのみを許可した契約
                      (packages/shared/src/index.ts の searchResultSchema コメント参照)のため
                      dangerouslySetInnerHTMLで描画してよい
                    */}
                    <div
                      className="mt-0.5 truncate text-xs text-gray-500"
                      dangerouslySetInnerHTML={{ __html: sanitizeSnippet(r.snippet) }}
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
}
