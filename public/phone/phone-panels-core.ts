import type { PrimaryView } from '../view-registry-core.ts';

export type DesktopView<PanelElement> = Pick<PrimaryView<PanelElement>, 'view' | 'label' | 'glyph' | 'el' | 'hasOwnPhoneScreen'>;

export interface PhonePanel<PanelElement> {
  id: string;
  label: string;
  glyph: string;
  el: PanelElement;
}

export function phonePanelsFromDesktopViews<PanelElement>(desktopViews: readonly DesktopView<PanelElement>[]): PhonePanel<PanelElement>[] {
  return desktopViews
    .filter((desktopView) => !desktopView.hasOwnPhoneScreen)
    .map((desktopView) => {
      const label = desktopView.label.trim();
      return { id: desktopView.view, label, glyph: desktopView.glyph || label.charAt(0).toUpperCase(), el: desktopView.el };
    });
}
