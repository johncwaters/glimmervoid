import { observeHeaderHeight, queryTag } from '../dom-helpers.ts';
import { mountCelebrationTray } from '../merge-celebration.ts';
import { mountMuteButton } from '../mute-button.ts';
import { openAddSessionDialog } from '../session-actions.ts';
import { mountStreamerToggle } from '../streamer-mode.ts';
import { mountStreamerTextMask } from '../streamer-text-mask.ts';
import { mountPowerMenu } from './power-menu.ts';
import { openSettings } from './view-tabs.ts';

const btnMute = queryTag(document, '#btn-mute', 'button');
const btnStreamer = queryTag(document, '#btn-streamer', 'button');

function openShortcutsHelp() {
  openSettings('browser-shortcuts');
}

function mountHeaderControls() {
  queryTag(document, '#btn-add-session-header', 'button').addEventListener('click', openAddSessionDialog);
  mountMuteButton(btnMute);
  mountStreamerToggle(btnStreamer);
  mountStreamerTextMask();
  mountPowerMenu();
  observeHeaderHeight(document.querySelector('.header'));
}

function mountHeaderTrays() {
  mountCelebrationTray(
    queryTag(document, '#celebration-tray', 'div'),
    queryTag(document, '#btn-celebrations', 'button'),
    queryTag(document, '#celebration-tray-count', 'span'),
  );
  queryTag(document, '#btn-help', 'button').addEventListener('click', openShortcutsHelp);
}

export { btnMute, btnStreamer, mountHeaderControls, mountHeaderTrays };
