const VIEWS_WITH_THEIR_OWN_PHONE_SCREEN: ReadonlySet<string> = new Set(['focus', 'calm']);

export interface DesktopView<PanelElement> {
  view: string;
  label: string;
  glyph?: string | null;
  el: PanelElement;
}

export interface PhonePanel<PanelElement> {
  id: string;
  label: string;
  glyph: string;
  el: PanelElement;
}

export function phonePanelsFromDesktopViews<PanelElement>(desktopViews: readonly DesktopView<PanelElement>[]): PhonePanel<PanelElement>[] {
  return desktopViews
    .filter((desktopView) => !VIEWS_WITH_THEIR_OWN_PHONE_SCREEN.has(desktopView.view))
    .map((desktopView) => {
      const label = desktopView.label.trim();
      return { id: desktopView.view, label, glyph: desktopView.glyph || label.charAt(0).toUpperCase(), el: desktopView.el };
    });
}
