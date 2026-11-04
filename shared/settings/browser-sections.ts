import { FLYING_ANIMALS_DEFAULTS, FLYING_ANIMALS_DURATION_RANGE, FLYING_ANIMALS_GAP_RANGE, FLYING_ANIMALS_SCALE_RANGE } from '../settings-ranges.ts';
import { BROWSER_NOW, BROWSER_ADVANCED, SECONDS, MULTIPLIER } from './registry-fields.ts';
import type { SettingsSection } from './registry-fields.ts';

export const BROWSER_APPEARANCE: SettingsSection = {
  id: 'browser-appearance',
  level: 'browser',
  title: 'Appearance',
  description: 'How this browser draws the dashboard.',
  legacyIds: ['browser-flying-animals', 'animals', 'flying-animals'],
  settings: [
    {
      id: 'theme', path: 'pref:themeId', title: 'Theme',
      description: 'Color scheme for the dashboard.',
      control: 'select', optionsFrom: 'themes', keywords: ['color', 'palette'], defaultValue: 'phyrexian', ...BROWSER_NOW,
    },
    {
      id: 'phone-arrow-pad', path: 'pref:phoneArrowPad', title: 'Swipe arrow pad on phone',
      description: 'Swap the phone arrow keys for one pad you swipe on.',
      control: 'toggle', keywords: ['experimental', 'mobile', 'keys', 'arrows', 'swipe', 'gesture'], defaultValue: false, ...BROWSER_NOW,
    },
    {
      id: 'flying-animals', path: 'pref:flyingAnimalsEnabled', title: 'Flying animals',
      description: 'Show animated animals flying across the dashboard.',
      control: 'toggle', keywords: ['animation', 'motion', 'animals'], defaultValue: false, ...BROWSER_NOW,
    },
    {
      id: 'animals-min-gap', path: 'pref:flyingAnimalsMinGapSeconds', title: 'Time between flights: minimum',
      description: 'Shortest pause between flights.', control: 'number', integer: false, step: 0.1,
      range: FLYING_ANIMALS_GAP_RANGE, unit: SECONDS, maximumSettingId: 'animals-max-gap', keywords: ['animals', 'frequency'], defaultValue: FLYING_ANIMALS_DEFAULTS.flyingAnimalsMinGapSeconds, ...BROWSER_ADVANCED,
    },
    {
      id: 'animals-max-gap', path: 'pref:flyingAnimalsMaxGapSeconds', title: 'Time between flights: maximum',
      description: 'Longest pause between flights.', control: 'number', integer: false, step: 0.1,
      range: FLYING_ANIMALS_GAP_RANGE, unit: SECONDS, keywords: ['animals', 'frequency'], defaultValue: FLYING_ANIMALS_DEFAULTS.flyingAnimalsMaxGapSeconds, ...BROWSER_ADVANCED,
    },
    {
      id: 'animals-min-duration', path: 'pref:flyingAnimalsMinDurationSeconds', title: 'Flight duration: minimum',
      description: 'Shortest flight, for faster animals.', control: 'number', integer: false, step: 0.1,
      range: FLYING_ANIMALS_DURATION_RANGE, unit: SECONDS, maximumSettingId: 'animals-max-duration', keywords: ['animals', 'speed'], defaultValue: FLYING_ANIMALS_DEFAULTS.flyingAnimalsMinDurationSeconds, ...BROWSER_ADVANCED,
    },
    {
      id: 'animals-max-duration', path: 'pref:flyingAnimalsMaxDurationSeconds', title: 'Flight duration: maximum',
      description: 'Longest flight, for slower animals.', control: 'number', integer: false, step: 0.1,
      range: FLYING_ANIMALS_DURATION_RANGE, unit: SECONDS, keywords: ['animals', 'speed'], defaultValue: FLYING_ANIMALS_DEFAULTS.flyingAnimalsMaxDurationSeconds, ...BROWSER_ADVANCED,
    },
    {
      id: 'animals-scale', path: 'pref:flyingAnimalsScale', title: 'Size multiplier',
      description: 'Scale applied on top of the viewport size.', control: 'number', integer: false, step: 0.1,
      range: FLYING_ANIMALS_SCALE_RANGE, unit: MULTIPLIER, keywords: ['animals', 'size'], defaultValue: FLYING_ANIMALS_DEFAULTS.flyingAnimalsScale, ...BROWSER_ADVANCED,
    },
    {
      id: 'animals-on-phone', path: 'pref:flyingAnimalsOnPhone', title: 'Show on phone layout',
      description: 'Allow flights on the phone layout.', control: 'toggle',
      keywords: ['animals', 'mobile'], defaultValue: FLYING_ANIMALS_DEFAULTS.flyingAnimalsOnPhone, ...BROWSER_ADVANCED,
    },
  ],
};

export const BROWSER_NOTIFICATIONS: SettingsSection = {
  id: 'browser-notifications',
  level: 'browser',
  title: 'Notifications',
  description: 'How sessions get your attention.',
  settings: [
    {
      id: 'alert-sounds-enabled', path: 'pref:soundEnabled', title: 'Alert sounds',
      legacyIds: [{ sectionId: 'browser-appearance', settingId: 'alert-sounds-enabled' }],
      description: 'Play a sound when a session needs you, like the note button in the header.',
      control: 'toggle', keywords: ['audio', 'mute', 'sound', 'notification'], defaultValue: true, ...BROWSER_NOW,
    },
    {
      id: 'alert-sound', path: 'pref:soundId', title: 'Alert sound',
      legacyIds: [{ sectionId: 'browser-appearance', settingId: 'alert-sound' }],
      description: 'Sound played when a session needs you, including files you add to ~/.glimmervoid/sounds/.',
      control: 'select', optionsFrom: 'sounds', keywords: ['audio', 'notification', 'custom'], defaultValue: 'chime', ...BROWSER_NOW,
    },
    {
      id: 'desktop-notifications', path: 'pref:notificationsEnabled', title: 'Desktop notifications',
      legacyIds: [{ sectionId: 'browser-appearance', settingId: 'desktop-notifications' }],
      description: 'Notify you when a session needs you and the dashboard is in the background.',
      control: 'toggle', keywords: ['browser', 'attention'], defaultValue: true, ...BROWSER_NOW,
    },
  ],
};

export const BROWSER_SHORTCUTS: SettingsSection = {
  id: 'browser-shortcuts',
  level: 'browser',
  title: 'Shortcuts',
  description: 'Keyboard shortcuts.',
  legacyIds: ['shortcuts'],
  settings: [
    {
      id: 'next-attention-key', path: 'pref:nextAttentionKeyCode', title: 'Jump to the next session needing you',
      description: 'Key held with Cmd on a Mac, or Alt elsewhere, to jump to the next session that needs you.',
      control: 'shortcut-key', keywords: ['shortcut', 'keyboard', 'hotkey', 'jump', 'next', 'attention'], defaultValue: 'KeyJ', ...BROWSER_NOW,
    },
  ],
};
