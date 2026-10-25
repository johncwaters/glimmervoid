import { captureSiteEvent } from './analytics.ts';
import type { CopyOutcome, InstallLocation } from './analytics.ts';
import { copyText, hasTextSelectedIn } from './dom.ts';
import { detectInstallPlatform, INSTALL_PLATFORMS, installPlatformView } from './install-platform.ts';
import type { InstallPlatform } from './install-platform.ts';

const INSTALL_LOCATION_BY_ROOT_ID: Readonly<Record<string, InstallLocation>> = { 'hero-install': 'hero', install: 'install' };

function isInstallPlatform(value: string | undefined): value is InstallPlatform {
  return INSTALL_PLATFORMS.some((platform) => platform === value);
}

function userAgentDataPlatform(): string | null {
  const userAgentData: unknown = Reflect.get(navigator, 'userAgentData');
  if (typeof userAgentData !== 'object' || userAgentData === null) return null;
  const platform: unknown = Reflect.get(userAgentData, 'platform');
  return typeof platform === 'string' ? platform : null;
}

function selectContents(element: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

export function wireCopyControl(copyControl: HTMLElement, copySource: HTMLElement, copyStatus: HTMLElement, textToCopy: () => HTMLElement | null, onCopyOutcome?: (outcome: CopyOutcome) => void): void {
  const copyCurrentText = () => {
    const shownText = textToCopy();
    if (!shownText) return;
    void copyText(shownText.textContent ?? '').then((isCopied) => {
      onCopyOutcome?.(isCopied ? 'copied' : 'selected');
      if (isCopied) {
        copyStatus.textContent = 'Copied';
        return;
      }
      selectContents(shownText);
      copyStatus.textContent = 'Selected';
    });
  };
  copyControl.addEventListener('click', copyCurrentText);
  copySource.addEventListener('click', () => {
    if (hasTextSelectedIn(copySource)) return;
    copyCurrentText();
  });
}

export function wireInstallPicker(root: HTMLElement): void {
  const installCommand = root.querySelector<HTMLElement>('[data-install-command]');
  const copyControl = root.querySelector<HTMLElement>('[data-copy-install]');
  const copyStatus = root.querySelector<HTMLElement>('[data-copy-status]');
  const platformSwitch = root.querySelector<HTMLElement>('[data-platform-switch]');
  if (!installCommand || !copyControl || !copyStatus) return;
  const location: InstallLocation | undefined = INSTALL_LOCATION_BY_ROOT_ID[root.id];
  let shownPlatform: InstallPlatform = 'macos';
  const showInstallPlatform = (platform: InstallPlatform) => {
    shownPlatform = platform;
    const view = installPlatformView(platform);
    for (const command of root.querySelectorAll<HTMLElement>('[data-install-for]')) command.hidden = command.dataset.installFor !== view.visibleCommand;
    for (const button of platformSwitch?.querySelectorAll<HTMLButtonElement>('[data-platform]') ?? []) button.setAttribute('aria-pressed', String(button.dataset.platform === view.pressedPlatform));
    copyStatus.textContent = '';
  };
  const captureCopy = (outcome: CopyOutcome) => {
    if (location) captureSiteEvent({ event: 'install_command_copied', properties: { platform: shownPlatform, location, outcome } });
  };
  wireCopyControl(copyControl, installCommand, copyStatus, () => installCommand.querySelector<HTMLElement>('[data-install-for]:not([hidden])'), captureCopy);
  for (const platformNote of root.querySelectorAll<HTMLElement>('[data-install-platform-note]')) platformNote.hidden = true;
  const detected = detectInstallPlatform({ userAgentDataPlatform: userAgentDataPlatform(), userAgent: navigator.userAgent });
  showInstallPlatform(detected ?? 'macos');
  if (!platformSwitch) return;
  platformSwitch.hidden = false;
  platformSwitch.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-platform]') : null;
    if (!button || !isInstallPlatform(button.dataset.platform)) return;
    showInstallPlatform(button.dataset.platform);
    if (location) captureSiteEvent({ event: 'install_platform_picked', properties: { platform: button.dataset.platform, detected_platform: detected ?? 'unknown', location } });
  });
}
