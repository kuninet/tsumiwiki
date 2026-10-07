import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useRightPanelContentVisible } from '../hooks/use-right-panel';
import { useUIStore } from '../stores/ui';
import { type RightPanelTab, useUserSettingsStore } from '../stores/user-settings';

// #271: 右パネルへのポータル描画コンポーネント
// スロットが存在し、右パネルが表示対象かつ指定タブが選択されているときのみ描画する。
export interface RightPanelPortalProps {
  tab: RightPanelTab;
  children: ReactNode;
}

export function RightPanelPortal({ tab, children }: RightPanelPortalProps) {
  const slot = useUIStore((s) => s.rightPanelSlot);
  const visible = useRightPanelContentVisible();
  const currentTab = useUserSettingsStore((s) => s.rightPanelTab);

  if (!slot || !visible || currentTab !== tab) {
    return null;
  }

  return createPortal(
    <div
      data-testid={`right-panel-content-${tab}`}
      className="h-full flex flex-col min-h-0"
      onMouseDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    slot,
  );
}
