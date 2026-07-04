import type { LockInfo } from '@tsumiwiki/shared';
import { api } from './client';

// 編集ロックAPI(設計04章4.4)。呼び出し側(use-editing-session)で状態遷移を制御するため
// 素の関数として提供する(TanStack Queryのmutationは使わない)

export function acquireLock(path: string): Promise<{ lock: LockInfo }> {
  return api('POST', '/api/locks', { path });
}

export function refreshLock(path: string): Promise<{ ok: boolean }> {
  return api('PUT', '/api/locks/refresh', { path });
}

export function releaseLock(path: string): Promise<{ ok: boolean }> {
  return api('DELETE', `/api/locks?path=${encodeURIComponent(path)}`);
}
