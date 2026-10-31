import type { PrimaryView } from '../view-registry-core.ts';

type DesktopView<PanelElement> = Pick<PrimaryView<PanelElement>, 'view' | 'label' | 'iconPath' | 'el' | 'hasOwnPhoneScreen' | 'isPhoneNavScreen'>;

export interface PhonePanel<PanelElement> {
  id: string;
  label: string;
  iconPath: string;
  isNavScreen: boolean;
  el: PanelElement;
}

export function phonePanelsFromDesktopViews<PanelElement>(desktopViews: readonly DesktopView<PanelElement>[]): PhonePanel<PanelElement>[] {
  return desktopViews
    .filter((desktopView) => !desktopView.hasOwnPhoneScreen)
    .map((desktopView) => ({
      id: desktopView.view,
      label: desktopView.label.trim(),
      iconPath: desktopView.iconPath,
      isNavScreen: desktopView.isPhoneNavScreen === true,
      el: desktopView.el,
    }));
}
