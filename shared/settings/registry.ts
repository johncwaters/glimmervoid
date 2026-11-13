import type { SettingsSetting, SettingsSection, SettingsGroup, SettingsRegistry } from './registry-fields.ts';
import { BROWSER_APPEARANCE, BROWSER_NOTIFICATIONS, BROWSER_SHORTCUTS } from './browser-sections.ts';
import { MACHINE_TELEGRAM, MACHINE_SESSIONS, MACHINE_ACCOUNTS, MACHINE_SAFETY, MACHINE_VAULT, MACHINE_UPDATES, MACHINE_SERVER, MACHINE_USAGE, MACHINE_PRIVACY } from './machine-sections.ts';
import { LANES_POSTHOG, LANES_TEAM_REVIEW, LANES_MY_PRS, LANES_COHERENCE, LANES_COMMUNITY } from './lanes-sections.ts';
import { FILE_ONLY_SETTINGS } from './file-only-settings.ts';

export type { SettingsEffect, SettingsChoicePresentation, SettingsSetting, SettingsSection, SettingsGroup, SettingsRegistry } from './registry-fields.ts';

export const FILE_ONLY_GROUPS: Readonly<Record<string, SettingsGroup>> = Object.freeze({
  'machine-terminal': { title: 'Terminal', description: 'Terminal behavior shared by dashboard clients.' },
  'machine-detection-sessions': { title: 'Detection and sessions', description: 'Config-file-only detection, timing, worktree and process settings.' },
  'machine-packs': { title: 'Packs', description: 'Packs other people share, each waiting for your approval before anything in it runs.' },
  'lanes-question-manager': { title: 'Question manager', description: 'Rules that answer a session question in the sessions you switch the question manager on for.' },
});

const SECTIONS: readonly SettingsSection[] = Object.freeze([
  BROWSER_APPEARANCE,
  BROWSER_NOTIFICATIONS,
  MACHINE_TELEGRAM,
  MACHINE_SESSIONS,
  MACHINE_ACCOUNTS,
  MACHINE_SAFETY,
  MACHINE_VAULT,
  MACHINE_UPDATES,
 
  MACHINE_SERVER,
  MACHINE_USAGE,
  LANES_POSTHOG,
  LANES_TEAM_REVIEW,
  LANES_MY_PRS,
  LANES_COHERENCE,
  LANES_COMMUNITY,
  MACHINE_PRIVACY,
  BROWSER_SHORTCUTS,
]);

export const SETTINGS_REGISTRY: SettingsRegistry = Object.freeze({ sections: SECTIONS, fileOnly: FILE_ONLY_SETTINGS });

const EXPERIMENTAL_KEYWORD = 'experimental';

export function isExperimentalSetting(setting: Pick<SettingsSetting, 'keywords'>): boolean {
  return setting.keywords.includes(EXPERIMENTAL_KEYWORD);
}

export function isExperimentalSection(section: Pick<SettingsSection, 'settings'>): boolean {
  const enableSetting = section.settings[0];
  return enableSetting !== undefined && isExperimentalSetting(enableSetting);
}

export const SETTINGS_SECTION_ALIASES: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(
  SECTIONS.flatMap((section) => (section.legacyIds ?? []).map((legacyId) => [legacyId, section.id])),
));

export const SETTINGS_MOVED_SETTINGS: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze(
  SECTIONS.reduce<Record<string, Record<string, string>>>((moved, section) => {
    for (const setting of section.settings) {
      for (const legacy of setting.legacyIds ?? []) {
        moved[legacy.sectionId] = { ...moved[legacy.sectionId], [legacy.settingId]: section.id };
      }
    }
    return moved;
  }, {}),
);
