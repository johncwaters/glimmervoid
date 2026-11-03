import { observeHeaderHeight, queryTag } from '../dom-helpers.ts';
import { mountCelebrationTray } from '../merge-celebration.ts';
import { mountMuteButton } from '../mute-button.ts';
import { openAddSessionDialog } from '../session-actions.ts';
import { mountStreamerToggle } from '../streamer-mode.ts';
import { mountStreamerTextMask } from '../streamer-text-mask.ts';
import { createLineIcon, HELP_ICON_PATH, PLUS_ICON_PATH, SCREEN_ICON_PATH, TROPHY_ICON_PATH } from '../svg-dom.ts';
import { button, outlineIconButton } from '../ui/button.ts';
import { mountPowerMenu, powerMenu } from './power-menu.ts';
import { openSettings } from './view-tabs.ts';

const MUSIC_NOTE = String.fromCharCode(0x266a);

const celebrationsToggle = outlineIconButton({ label: 'Play queued merge celebrations', icon: createLineIcon(TROPHY_ICON_PATH, '1.6'), action: 'play-celebrations', states: ['idle', 'attention'] });

const btnAddSession = button({ variant: 'primary', label: 'Session', icon: createLineIcon(PLUS_ICON_PATH), action: 'add-session', onClick: openAddSessionDialog });
btnAddSession.id = 'btn-add-session-header';
btnAddSession.title = 'Add a new session';

const btnHelp = outlineIconButton({ label: 'Keyboard shortcuts and version', icon: createLineIcon(HELP_ICON_PATH, '1.6'), action: 'open-shortcuts-help', onClick: () => openSettings('browser-shortcuts'), states: ['idle'] }).element;

const muteToggle = outlineIconButton({ label: 'Mute alerts', icon: MUSIC_NOTE, action: 'toggle-mute', states: ['idle', 'off'] });
const btnMute = muteToggle.element;

const streamerToggle = outlineIconButton({ label: 'Streamer mode', icon: createLineIcon(SCREEN_ICON_PATH, '1.4'), action: 'toggle-streamer-mode', states: ['idle', 'pressed'] });
const btnStreamer = streamerToggle.element;

const headerStatusDismiss = button({ variant: 'secondary', size: 'small', label: 'Dismiss', action: 'dismiss-header-status' });
headerStatusDismiss.id = 'header-status-dismiss';

const celebrationTray = queryTag(document, '#celebration-tray', 'div');
celebrationTray.prepend(celebrationsToggle.element);
powerMenu.before(btnAddSession, btnHelp, btnMute, btnStreamer);
queryTag(document, '#header-status', 'p').append(headerStatusDismiss);

function mountHeaderControls() {
  mountMuteButton(muteToggle);
  mountStreamerToggle(streamerToggle);
  mountStreamerTextMask();
  mountPowerMenu();
  observeHeaderHeight(document.querySelector('.header'));
}

function mountHeaderTrays() {
  mountCelebrationTray(celebrationTray, celebrationsToggle, queryTag(document, '#celebration-tray-count', 'span'));
}

export { btnAddSession, btnHelp, btnMute, btnStreamer, mountHeaderControls, mountHeaderTrays };
