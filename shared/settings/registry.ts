import type { SettingsSetting, SettingsSection, SettingsGroup, SettingsRegistry } from './registry-fields.ts';
import { BROWSER_APPEARANCE, BROWSER_NOTIFICATIONS, BROWSER_SHORTCUTS } from './browser-sections.ts';
import { MACHINE_TELEGRAM, MACHINE_SESSIONS, MACHINE_SAFETY, MACHINE_UPDATES, MACHINE_USAGE, MACHINE_PRIVACY } from './machine-sections.ts';
import { LANES_POSTHOG, LANES_GITHUB_ACCESS, LANES_TEAM_REVIEW, LANES_WORKFLOWS, LANES_BENCHMARKS, LANES_COHERENCE, LANES_ISSUES, LANES_COMMUNITY } from './lanes-sections.ts';
import { FILE_ONLY_SETTINGS } from './file-only-settings.ts';

export type { SettingsEffect, SettingsChoicePresentation, SettingsSetting, SettingsSection, SettingsGroup, SettingsRegistry } from './registry-fields.ts';

export const FILE_ONLY_GROUPS: Readonly<Record<string, SettingsGroup>> = Object.freeze({
  'machine-terminal': { title: 'Terminal', description: 'Terminal behavior shared by dashboard clients.' },
  'machine-detection-sessions': { title: 'Detection and sessions', description: 'Config-file-only detection, timing, worktree and process settings.' },
});

const SECTIONS: readonly SettingsSection[] = Object.freeze([
  BROWSER_APPEARANCE,
  BROWSER_NOTIFICATIONS,
  MACHINE_TELEGRAM,
  MACHINE_SESSIONS,
  MACHINE_SAFETY,
  MACHINE_UPDATES,
  MACHINE_USAGE,
  LANES_POSTHOG,
  LANES_GITHUB_ACCESS,
  LANES_TEAM_REVIEW,
  LANES_WORKFLOWS,
  LANES_BENCHMARKS,
  LANES_COHERENCE,
  LANES_ISSUES,
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

export function settingsSectionsAvailableOn(sections: readonly SettingsSection[], isExperimentalBuild: boolean): readonly SettingsSection[] {
  if (isExperimentalBuild) return sections;
  return sections.flatMap((section) => {
    const availableSettings = section.settings.filter((setting) => !isExperimentalSetting(setting));
    if (availableSettings.length === 0 && section.settings.length > 0) return [];
    return [{ ...section, settings: availableSettings }];
  });
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
