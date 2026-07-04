import { create } from 'zustand';

// 簡易トースト通知の状態(設計04章4.6)。成功/エラーの2種、3秒で自動消去する

export type ToastKind = 'success' | 'error';

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
