import { create } from 'zustand';

// トースト通知の状態(設計04章4.6・デザインhandoff components.md)。
// success/info/warning/error(=danger表示)の4種。error以外は3秒で自動消去、
// errorは手動クローズのみ(ユーザーが見逃さないよう)

export type ToastKind = 'success' | 'info' | 'warning' | 'error';

interface ToastEntry {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastState {
  toast: ToastEntry | null;
  show: (kind: ToastKind, message: string) => void;
  clear: () => void;
}

let nextToastId = 0;

export const useToastStore = create<ToastState>((set) => ({
  toast: null,
  show: (kind, message) => set({ toast: { id: ++nextToastId, kind, message } }),
  clear: () => set({ toast: null }),
}));
