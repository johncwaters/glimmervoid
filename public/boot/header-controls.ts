import { observeHeaderHeight, queryTag } from '../dom-helpers.ts';
import { mountCelebrationTray } from '../merge-celebration.ts';
import { mountMuteButton } from '../mute-button.ts';
import { openAddSessionDialog } from '../session-actions.ts';
import { mountStreamerTextMask } from '../streamer-text-mask.ts';
import { createLineIcon, HELP_ICON_PATH, MUSIC_NOTE_ICON_PATH, PLUS_ICON_PATH, TROPHY_ICON_PATH } from '../svg-dom.ts';
import { button, outlineIconButton } from '../ui/button.ts';
import { openSettings } from './view-tabs.ts';

const celebrationsToggle = outlineIconButton({ label: 'Play queued merge celebrations', icon: createLineIcon(TROPHY_ICON_PATH, '1.6'), action: 'play-celebrations', states: ['idle', 'attention'] });

const btnAddSession = button({ variant: 'primary', label: 'Session', icon: createLineIcon(PLUS_ICON_PATH), action: 'add-session', onClick: openAddSessionDialog });
btnAddSession.id = 'btn-add-session-header';

const btnHelp = outlineIconButton({ label: 'Keyboard shortcuts and version', icon: createLineIcon(HELP_ICON_PATH, '1.6'), action: 'open-shortcuts-help', onClick: () => openSettings('browser-shortcuts'), states: ['idle'] }).element;

const muteToggle = outlineIconButton({ label: 'Mute alerts', icon: createLineIcon(MUSIC_NOTE_ICON_PATH, '1.6'), action: 'toggle-mute', states: ['idle', 'off'] });
const btnMute = muteToggle.element;

const celebrationTray = queryTag(document, '#celebration-tray', 'div');
celebrationTray.prepend(celebrationsToggle.element);
queryTag(document, '.header-right', 'div').append(btnAddSession, btnHelp, btnMute);

function mountHeaderControls() {
  mountMuteButton(muteToggle);
  mountStreamerTextMask();
  observeHeaderHeight(document.querySelector('.header'));
}

function mountHeaderTrays() {
  mountCelebrationTray(celebrationTray, celebrationsToggle, queryTag(document, '#celebration-tray-count', 'span'));
}

export { btnAddSession, btnHelp, btnMute, mountHeaderControls, mountHeaderTrays };
