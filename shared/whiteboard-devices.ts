export const DEVICE_NAMES = ['phone', 'tablet', 'laptop', 'desktop', 'browser'] as const;
export const DEVICE_FITS = ['fill', 'fit'] as const;

export type DeviceName = typeof DEVICE_NAMES[number];
export type DeviceFit = typeof DEVICE_FITS[number];

interface DeviceSize {
  width: number;
  height: number;
}

interface DeviceBezel {
  side: number;
  top: number;
  bottom: number;
  radius: number;
  screenRadius: number;
}

interface DeviceBase {
  height: number;
  overhang: number;
}

interface DeviceSpec {
  label: string;
  screen: DeviceSize;
  bezel: DeviceBezel;
  toolbarHeight: number;
  base: DeviceBase | null;
  defaultBoxWidth: number;
}

export const PLACED_DEVICE: DeviceName = 'phone';

export const DEVICE_CATALOG: Readonly<Record<DeviceName, DeviceSpec>> = Object.freeze({
  phone: { label: 'Phone', screen: { width: 393, height: 852 }, bezel: { side: 14, top: 14, bottom: 14, radius: 54, screenRadius: 42 }, toolbarHeight: 0, base: null, defaultBoxWidth: 260 },
  tablet: { label: 'Tablet', screen: { width: 834, height: 1194 }, bezel: { side: 22, top: 22, bottom: 22, radius: 36, screenRadius: 18 }, toolbarHeight: 0, base: null, defaultBoxWidth: 360 },
  laptop: { label: 'Laptop', screen: { width: 1440, height: 900 }, bezel: { side: 24, top: 28, bottom: 24, radius: 18, screenRadius: 4 }, toolbarHeight: 0, base: { height: 28, overhang: 120 }, defaultBoxWidth: 520 },
  desktop: { label: 'Desktop', screen: { width: 1920, height: 1080 }, bezel: { side: 20, top: 20, bottom: 20, radius: 10, screenRadius: 2 }, toolbarHeight: 0, base: { height: 120, overhang: 0 }, defaultBoxWidth: 520 },
  browser: { label: 'Browser', screen: { width: 1440, height: 900 }, bezel: { side: 1, top: 1, bottom: 1, radius: 10, screenRadius: 0 }, toolbarHeight: 40, base: null, defaultBoxWidth: 520 },
} satisfies Record<DeviceName, DeviceSpec>);

export function deviceArtSizeOf(name: DeviceName): DeviceSize {
  const { screen, bezel, toolbarHeight, base } = DEVICE_CATALOG[name];
  return {
    width: screen.width + bezel.side * 2 + (base?.overhang ?? 0) * 2,
    height: bezel.top + toolbarHeight + screen.height + bezel.bottom + (base?.height ?? 0),
  };
}
