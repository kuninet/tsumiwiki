import { InvalidPathError } from '../lib/paths.js';
import {
  DocNotFoundError,
  DocConflictError,
  FrontmatterUpdateError,
} from '../services/doc-service.js';
import { DocLockedError } from '../services/lock-service.js';

// MCPツールの戻り値組み立て共通処理。
// SDKのCallToolResult.structuredContentはオブジェクト(record)必須で配列を直接渡すと
// バリデーションエラーになるため、配列は{ items: [...] }でラップする。
// content[0].textも同じ形に揃える(受け手によってcontentとstructuredContentの
// 形が食い違わないように)
export function toolResult(result: unknown) {
  const shaped = Array.isArray(result) ? { items: result } : (result as Record<string, unknown>);
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(shaped, null, 2) }],
    structuredContent: shaped,
  };
}

// 構造化されたエラーを isError で返す(呼び出し側が code で分岐できるようにする)
export function toolError(payload: Record<string, unknown>) {
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

// 編集ロック中(DocLockedError)を構造化エラーで返す。code が DOC_LOCKED
export function lockedError(e: DocLockedError) {
  return toolError({
    code: 'DOC_LOCKED',
    message: e.message,
    holder: { displayName: e.holder.displayName },
  });
}

// docService由来の主要な業務例外を構造化エラー(isError: true)に変換する
export function docError(e: unknown) {
  if (e instanceof InvalidPathError) {
    return toolError({ code: 'INVALID_PATH', message: e.userMessage ?? e.message });
  }
  if (e instanceof DocNotFoundError) {
    return toolError({ code: 'NOT_FOUND', message: e.message });
  }
  if (e instanceof DocConflictError) {
    return toolError({ code: 'CONFLICT', message: e.message });
  }
  if (e instanceof DocLockedError) {
    return lockedError(e);
  }
  if (e instanceof FrontmatterUpdateError) {
    return toolError({ code: 'FRONTMATTER_INVALID', message: e.message });
  }
  throw e;
}
