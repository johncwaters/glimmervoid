import { observeHeaderHeight, queryTag } from '../dom-helpers.ts';
import { mountCelebrationTray } from '../merge-celebration.ts';
import { mountMuteButton } from '../mute-button.ts';
import { openAddSessionDialog } from '../session-actions.ts';
import { mountStreamerToggle } from '../streamer-mode.ts';
import { mountStreamerTextMask } from '../streamer-text-mask.ts';
import { createLineIcon, HELP_ICON_PATH, PLUS_ICON_PATH, SCREEN_ICON_PATH, TROPHY_ICON_PATH } from '../svg-dom.ts';
import { button } from '../ui/button.ts';
import { createPressable } from '../ui/pressable.ts';
import { mountPowerMenu, powerMenu } from './power-menu.ts';
import { openSettings } from './view-tabs.ts';

const MUSIC_NOTE = String.fromCharCode(0x266a);

function headerToggle(className: string, id: string, label: string) {
  const toggle = createPressable(className);
  toggle.id = id;
  toggle.title = label;
  toggle.setAttribute('aria-label', label);
  toggle.setAttribute('aria-pressed', 'false');
  return toggle;
}

const btnCelebrations = button({ variant: 'icon', label: 'Play queued merge celebrations', icon: createLineIcon(TROPHY_ICON_PATH, '1.6'), action: 'play-celebrations' });

const btnAddSession = button({ variant: 'primary', label: 'Session', icon: createLineIcon(PLUS_ICON_PATH), action: 'add-session', onClick: openAddSessionDialog });
btnAddSession.id = 'btn-add-session-header';
btnAddSession.title = 'Add a new session';

const btnHelp = button({ variant: 'icon', label: 'Keyboard shortcuts and version', icon: createLineIcon(HELP_ICON_PATH, '1.6'), action: 'open-shortcuts-help', onClick: () => openSettings('browser-shortcuts') });

const btnMute = headerToggle('btn-mute', 'btn-mute', 'Mute alerts');
btnMute.textContent = MUSIC_NOTE;

const btnStreamer = headerToggle('btn-streamer', 'btn-streamer', 'Streamer mode');
btnStreamer.append(createLineIcon(SCREEN_ICON_PATH, '1.4'));

const headerStatusDismiss = button({ variant: 'secondary', size: 'small', label: 'Dismiss', action: 'dismiss-header-status' });
headerStatusDismiss.id = 'header-status-dismiss';

const celebrationTray = queryTag(document, '#celebration-tray', 'div');
celebrationTray.prepend(btnCelebrations);
powerMenu.before(btnAddSession, btnHelp, btnMute, btnStreamer);
queryTag(document, '#header-status', 'p').append(headerStatusDismiss);

function mountHeaderControls() {
  mountMuteButton(btnMute);
  mountStreamerToggle(btnStreamer);
  mountStreamerTextMask();
  mountPowerMenu();
  observeHeaderHeight(document.querySelector('.header'));
}

function mountHeaderTrays() {
  mountCelebrationTray(celebrationTray, btnCelebrations, queryTag(document, '#celebration-tray-count', 'span'));
}

export { btnAddSession, btnHelp, btnMute, btnStreamer, mountHeaderControls, mountHeaderTrays };
