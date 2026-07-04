import { create } from 'zustand';

// 編集セッションの状態(設計04章4.4・デザインhandoff components.md StatusBar仕様)。
// use-editing-session/DocViewが更新し、AppShellのステータスバー表示に利用する

export type EditMode = 'view' | 'edit';

interface EditState {
  mode: EditMode;
  dirty: boolean;
  lockedPath: string | null;
  lastDraftSavedAt: string | null;
  lockedByOtherName: string | null;
  saveError: boolean;
  setMode: (mode: EditMode) => void;
  setDirty: (dirty: boolean) => void;
  setLockedPath: (path: string | null) => void;
  setLastDraftSavedAt: (at: string | null) => void;
  setLockedByOtherName: (name: string | null) => void;
  setSaveError: (error: boolean) => void;
}

export const useEditStore = create<EditState>((set) => ({
  mode: 'view',
  dirty: false,
  lockedPath: null,
  lastDraftSavedAt: null,
  lockedByOtherName: null,
  saveError: false,
  setMode: (mode) => set({ mode }),
  setDirty: (dirty) => set({ dirty }),
  setLockedPath: (lockedPath) => set({ lockedPath }),
  setLastDraftSavedAt: (lastDraftSavedAt) => set({ lastDraftSavedAt }),
  setLockedByOtherName: (lockedByOtherName) => set({ lockedByOtherName }),
  setSaveError: (saveError) => set({ saveError }),
}));
