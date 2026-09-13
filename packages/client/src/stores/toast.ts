import { create } from 'zustand';

// トースト通知の状態(設計04章4.6・デザインhandoff components.md)。
// success/info/warning/error(=danger表示)の4種。error以外は3秒で自動消去、
// errorは手動クローズのみ(ユーザーが見逃さないよう)

export type ToastKind = 'success' | 'info' | 'warning' | 'error';

/** トースト内に出す操作ボタン(例: Service Workerの更新通知の「再読み込み」。#251)。
    actionを持つトーストは自動消去せず、ユーザーの操作かクローズを待つ */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastEntry {
  id: number;
  kind: ToastKind;
  message: string;
  action?: ToastAction;
}

interface ToastState {
  toast: ToastEntry | null;
  show: (kind: ToastKind, message: string, action?: ToastAction) => void;
  clear: () => void;
}

let nextToastId = 0;

export const useToastStore = create<ToastState>((set) => ({
  toast: null,
  show: (kind, message, action) => set({ toast: { id: ++nextToastId, kind, message, action } }),
  clear: () => set({ toast: null }),
}));
