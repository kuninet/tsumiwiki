import { api } from './client';

// 自動保存の下書きAPI(設計04章4.4)。編集セッションから直接呼ぶ素の関数として提供する

export interface DraftEntry {
  content: string;
  updatedAt: string;
}

export function getDraft(path: string): Promise<{ draft: DraftEntry | null }> {
  return api('GET', `/api/drafts?path=${encodeURIComponent(path)}`);
}

export function saveDraft(path: string, content: string): Promise<{ ok: boolean }> {
  return api('PUT', '/api/drafts', { path, content });
}

export function deleteDraft(path: string): Promise<{ ok: boolean }> {
  return api('DELETE', `/api/drafts?path=${encodeURIComponent(path)}`);
}
