const CLIPBOARD_ACTION = 'clipboard';

export const UPLOAD_ACTION = 'upload';

const ARROW_PAD_STEP_PX = 24;

export interface MobileKey {
  id: string;
  label: string;
  bytes: string | null;
  action?: string;
  isArrow?: boolean;
  title: string;
}

export const MOBILE_KEYS: readonly Readonly<MobileKey>[] = Object.freeze([
  Object.freeze({ id: 'esc', label: 'Esc', bytes: '\x1b', title: 'Send Escape' }),
  Object.freeze({ id: 'tab', label: 'Tab', bytes: '\x09', title: 'Send Tab' }),
  Object.freeze({ id: 'left', label: String.fromCharCode(0x2190), bytes: '\x1b[D', isArrow: true, title: 'Arrow left' }),
  Object.freeze({ id: 'up', label: String.fromCharCode(0x2191), bytes: '\x1b[A', isArrow: true, title: 'Arrow up' }),
  Object.freeze({ id: 'down', label: String.fromCharCode(0x2193), bytes: '\x1b[B', isArrow: true, title: 'Arrow down' }),
  Object.freeze({ id: 'right', label: String.fromCharCode(0x2192), bytes: '\x1b[C', isArrow: true, title: 'Arrow right' }),
  Object.freeze({ id: 'paste', label: 'Paste', bytes: null, action: CLIPBOARD_ACTION, title: 'Paste from the clipboard' }),
  Object.freeze({ id: 'attach', label: 'Attach', bytes: null, action: UPLOAD_ACTION, title: 'Upload a photo or file to this session' }),
]);

export function mobileKeyBytes(id: string) {
  const key = MOBILE_KEYS.find((k) => k.id === id);
  if (!key) return null;
  return key.bytes;
}

export function isClipboardKey(key: Pick<MobileKey, 'action'> | null | undefined) {
  return !!key && key.action === CLIPBOARD_ACTION;
}

export function isUploadKey(key: Pick<MobileKey, 'action'> | null | undefined) {
  return !!key && key.action === UPLOAD_ACTION;
}

function arrowKeyIdForDrag(deltaX: number, deltaY: number, stepPx: number = ARROW_PAD_STEP_PX): string | null {
  const isHorizontal = Math.abs(deltaX) >= Math.abs(deltaY);
  const distance = isHorizontal ? deltaX : deltaY;
  if (Math.abs(distance) < stepPx) return null;
  if (isHorizontal) return distance > 0 ? 'right' : 'left';
  return distance > 0 ? 'down' : 'up';
}

export function arrowStepsForDrag(deltaX: number, deltaY: number, stepPx: number = ARROW_PAD_STEP_PX) {
  const arrowKeyId = arrowKeyIdForDrag(deltaX, deltaY, stepPx);
  if (!arrowKeyId) return null;
  const isHorizontal = arrowKeyId === 'left' || arrowKeyId === 'right';
  const distance = isHorizontal ? deltaX : deltaY;
  const stepCount = Math.floor(Math.abs(distance) / stepPx);
  const consumedPx = Math.sign(distance) * stepCount * stepPx;
  return {
    arrowKeyId,
    stepCount,
    consumedX: isHorizontal ? consumedPx : deltaX,
    consumedY: isHorizontal ? deltaY : consumedPx,
  };
}
