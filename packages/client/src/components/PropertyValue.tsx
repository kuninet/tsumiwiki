import type { PropertyEntry } from '../lib/frontmatter-display';
import { formatDateValue, formatJsonValue } from '../lib/frontmatter-display';

// プロパティ値の表示専用コンポーネント(#281)
export function PropertyValue({ entry }: { entry: PropertyEntry }) {
  const { value, kind } = entry;

  switch (kind) {
    case 'null':
      return (
        <span className="text-ink-faint" aria-label="値なし">
          —
        </span>
      );

    case 'empty':
      return <span className="text-ink-faint">(空)</span>;

    case 'boolean':
      return (
        <span>
          <span aria-hidden="true">{value ? '☑' : '☐'}</span> {String(value)}
        </span>
      );

    case 'number':
      return <span className="font-mono">{String(value)}</span>;

    case 'date':
      return (
        <time dateTime={String(value)} title={String(value)}>
          {formatDateValue(String(value), 'date')}
        </time>
      );

    case 'datetime':
      return (
        <time dateTime={String(value)} title={String(value)}>
          {formatDateValue(String(value), 'datetime')}
        </time>
      );

    case 'url':
      return (
        <>
          <a
            href={String(value)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="text-accent underline break-all"
          >
            {String(value)}
          </a>{' '}
          <span aria-hidden="true">↗</span>
        </>
      );

    case 'text': {
      const rawText = String(value);
      // 末尾改行を 1 つ除去(E14)
      const text = rawText.endsWith('\n') ? rawText.slice(0, -1) : rawText;
      return <span className="whitespace-pre-wrap">{text}</span>;
    }

    case 'list': {
      const list = Array.isArray(value) ? value : [];
      return (
        <ul className="flex flex-wrap gap-1">
          {list.map((item, idx) => (
            <li
              key={idx}
              className="rounded bg-panel-2 px-1.5 py-0.5 text-xs min-w-0 max-w-full break-all"
            >
              {String(item)}
            </li>
          ))}
        </ul>
      );
    }

    case 'object':
      return (
        <code className="font-mono text-xs break-all">
          {formatJsonValue(value)}
        </code>
      );

    default:
      return <span>{String(value)}</span>;
  }
}
