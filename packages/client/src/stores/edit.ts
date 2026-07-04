import { create } from 'zustand';

// 編集セッションの状態(設計04章4.4)。use-editing-sessionが更新し、
// AppShellのステータスバー表示に利用する

export type EditMode = 'view' | 'edit';

interface EditState {
  mode: EditMode;
  dirty: boolean;
  lockedPath: string | null;
  lastDraftSavedAt: string | null;
  setMode: (mode: EditMode) => void;
  setDirty: (dirty: boolean) => void;
  setLockedPath: (path: string | null) => void;
  setLastDraftSavedAt: (at: string | null) => void;
}

export const useEditStore = create<EditState>((set) => ({
  mode: 'view',
  dirty: false,
  lockedPath: null,
  lastDraftSavedAt: null,
  setMode: (mode) => set({ mode }),
  setDirty: (dirty) => set({ dirty }),
  setLockedPath: (lockedPath) => set({ lockedPath }),
  setLastDraftSavedAt: (lastDraftSavedAt) => set({ lastDraftSavedAt }),
}));
