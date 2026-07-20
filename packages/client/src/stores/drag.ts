import { create } from 'zustand';

// Phase B2: タブドラッグ中の状態を共有する小さなストア。
// TabBar の onDragStart / onDragEnd で set し、各ペインの DropZoneOverlay が
// 表示可否を判定するのに使う。並べ替え用に「ドラッグ元のペイン ID」も持つと、
// 同ペイン内 D&D と別ペイン D&D を判別できる

interface DragState {
  draggingPath: string | null;
  sourcePaneId: string | null;
  start: (path: string, paneId: string) => void;
  end: () => void;
}

export const useDragStore = create<DragState>((set) => ({
  draggingPath: null,
  sourcePaneId: null,
  start: (path, paneId) => set({ draggingPath: path, sourcePaneId: paneId }),
  end: () => set({ draggingPath: null, sourcePaneId: null }),
}));
