import { useTabsStore, type LeafPane } from '../stores/tabs';
import { DocTab } from './DocTab';
import { DropZoneOverlay } from './DropZoneOverlay';
import { TabBar } from './TabBar';

// Phase B2: 1つの leaf ペインを描画するコンポーネント。
// - 上端に TabBar(paneId 指定)
// - コンテンツ領域にこのペインの全 DocTab を常時マウント、非アクティブは hidden
// - ドラッグ中は DropZoneOverlay を重ねてドロップ受付
//
// ペイン内クリック(mousedown)で自身のペインを activePane に切り替える。
// これにより、複数ペインが並んでも URL / StatusBar は「最後に触ったペイン」を反映する

interface Props {
  pane: LeafPane;
}

export function PaneView({ pane }: Props) {
  const activePaneId = useTabsStore((s) => s.activePaneId);
  const setActivePane = useTabsStore((s) => s.setActivePane);
  const isActivePane = pane.id === activePaneId;

  return (
    <div
      data-testid={`pane-${pane.id}`}
      data-active-pane={isActivePane}
      className="flex h-full min-h-0 min-w-0 flex-col"
      onMouseDown={() => {
        if (!isActivePane) setActivePane(pane.id);
      }}
    >
      <TabBar paneId={pane.id} />
      <div className="relative min-h-0 flex-1">
        {pane.tabs.map((tab) => {
          // 「そのペインの active tab」なら表示。URL とは独立に、各ペインは自分の active を出す
          const visible = tab.path === pane.activeId;
          // useEditStore などグローバル state への書き込みは「表示中 かつ 活性ペイン」のときだけ
          const publishToStore = visible && isActivePane;
          return (
            <div
              key={tab.path}
              className={visible ? 'absolute inset-0 flex flex-col' : 'hidden'}
              data-testid={`pane-${pane.id}-doctab-${tab.path}`}
            >
              <DocTab path={tab.path} active={publishToStore} />
            </div>
          );
        })}
        <DropZoneOverlay paneId={pane.id} />
      </div>
    </div>
  );
}
