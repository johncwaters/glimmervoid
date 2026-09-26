import fs from 'node:fs';
import path from 'node:path';

import { SETTINGS_MAP } from '../public/settings-map.ts';
import type { SettingsSection, SettingsSetting } from '../public/settings-map.ts';
import { DEFAULT_CONFIG } from '../server/config-store.ts';
import { DEFAULT_MILL_METRICS_HOLDOUT_PERCENT, DEFAULT_MILL_METRICS_RETAIN_DAYS } from '../server/core/mill-metrics-core.ts';
import { Config, HIDDEN_CONFIG_KEYS } from '../shared/contracts/config.ts';

interface EnvironmentVariable {
  name: string;
  audience: 'operator' | 'internal';
  description: string;
}

export const CONFIGURATION_DOC_PATH = path.join(import.meta.dirname, '..', 'docs', 'configuration.md');

export const ENVIRONMENT_VARIABLES: readonly EnvironmentVariable[] = Object.freeze([
  { name: 'GLIMMERVOID_HOME', audience: 'operator', description: 'Directory holding `config.json` and all machine state (pairings, packs, memory, recordings). Defaults to `~/.glimmervoid`.' },
  { name: 'GLIMMERVOID_CONFIG', audience: 'operator', description: 'Path to the config file, winning over `GLIMMERVOID_HOME`. The file must exist or the server exits with `Config file not found`. `--config <path>` sets it.' },
  { name: 'GLIMMERVOID_PORT', audience: 'operator', description: 'Local dashboard port, overriding `port` in `config.json`. `--port <number>` sets it. The Visions relay also reads it to find the server.' },
  { name: 'GLIMMERVOID_HOST', audience: 'operator', description: 'Bind address for both listeners. Defaults to `127.0.0.1`; any non-loopback value is refused unless `GLIMMERVOID_INSECURE_BIND=1`.' },
  { name: 'GLIMMERVOID_INSECURE_BIND', audience: 'operator', description: 'Set to `1` to allow a non-loopback `GLIMMERVOID_HOST`. The local listener has no authentication, so this exposes full control of the machine to anyone who can reach the port.' },
  { name: 'GLIMMERVOID_POSTHOG_API_KEY', audience: 'operator', description: 'Supplies `posthog.apiKey`, overriding the stored value. It is stripped from every write, so a dashboard save never persists it.' },
  { name: 'GLIMMERVOID_TELEGRAM_BOT_TOKEN', audience: 'operator', description: 'Supplies `telegram.botToken`, overriding the stored value. It is stripped from every write, so a dashboard save never persists it.' },
  { name: 'GLIMMERVOID_DEBUG_SPAWN', audience: 'operator', description: 'Any non-empty value logs which executable each agent command resolved to at spawn.' },
  { name: 'GLIMMERVOID_RTK_PATH', audience: 'internal', description: 'Set by Glimmervoid in the rtk hook relay environment to name the rtk binary. Not an operator setting.' },
  { name: 'GLIMMERVOID_HOOK_URL', audience: 'internal', description: 'Set by Glimmervoid in each session environment as the hook relay target. Not an operator setting.' },
  { name: 'GLIMMERVOID_AGENT_URL', audience: 'internal', description: 'Set by Glimmervoid in each session environment when `agentApi.enabled` is on; `glimmervoid spawn`, `attention` and `board` read it. Not an operator setting.' },
]);

export const UNLISTED_KEY_NOTES: Readonly<Record<string, string>> = Object.freeze({
  projects: 'Projects shown in the dashboard, added from the Add Session dialog. Each entry has `path` (required), optional `name`, `repos` (two or more member repositories for a workspace session), `agent` (an agent id, see `customAgents`) and `codexBypassHookTrust` (file-only, default off).',
  remote: 'Opt-in remote listener: `enabled`, `port` (required when enabled, must differ from the local port), `publicHost` and `allowedOrigins`. See [Remote access](../README.md#remote-access).',
  hooks: 'Operator-defined hooks per project, managed from the dashboard Hooks panel.',
  worktreeSyncOnStart: 'Fetch origin and fast-forward the local integration branch before a session starts its worktree.',
  planReview: 'Hold Claude Code plan approvals (`ExitPlanMode`) so the plan can be read and approved from the dashboard or phone (`planReview.enabled`).',
  millMetrics: 'Context mill measurement: `retainDays` bounds retained history, `holdoutPercent` is the share of spawns delivered no packs, as a comparison arm.',
});

const BROWSER_LEVEL = 'browser';

function escapeCell(text: string): string {
  return text.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

const DOCUMENTED_DEFAULTS: Readonly<Record<string, unknown>> = Object.freeze({
  ...DEFAULT_CONFIG,
  millMetrics: { retainDays: DEFAULT_MILL_METRICS_RETAIN_DAYS, holdoutPercent: DEFAULT_MILL_METRICS_HOLDOUT_PERCENT },
});

function defaultAtPath(dottedPath: string): unknown {
  let cursor: unknown = DOCUMENTED_DEFAULTS;
  for (const segment of dottedPath.split('.')) {
    if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function formatDefault(value: unknown): string {
  if (value === undefined) return '';
  return `\`${escapeCell(JSON.stringify(value))}\``;
}

function resolvedDefault(setting: SettingsSetting): unknown {
  const serverDefault = defaultAtPath(setting.path);
  if (serverDefault !== undefined) return serverDefault;
  return setting.defaultValue;
}

function rootKeyOf(settingPath: string): string {
  return settingPath.split('.')[0];
}

function isFileOnly(setting: SettingsSetting): boolean {
  if (setting.fileOnly) return true;
  return HIDDEN_CONFIG_KEYS.includes(rootKeyOf(setting.path));
}

function isStatusDisplay(setting: SettingsSetting): boolean {
  return setting.control === 'readonly' && Boolean(setting.status) && !setting.fileOnly;
}

function configRowsOf(section: SettingsSection): SettingsSetting[] {
  const seenPaths = new Set<string>();
  const rows: SettingsSetting[] = [];
  for (const setting of section.settings) {
    if (isStatusDisplay(setting) || seenPaths.has(setting.path)) continue;
    seenPaths.add(setting.path);
    rows.push(setting);
  }
  return rows;
}

function settingRow(setting: SettingsSetting): string {
  const notes = [setting.description ?? '', isFileOnly(setting) ? '**File-only.**' : ''].filter(Boolean).join(' ');
  return `| \`${setting.path}\` | ${escapeCell(setting.title)} | ${formatDefault(resolvedDefault(setting))} | ${escapeCell(notes)} |`;
}

function sectionMarkdown(section: SettingsSection): string[] {
  const rows = configRowsOf(section);
  if (rows.length === 0) return [];
  const lines = [`### ${section.title}`, '', section.description ?? '', ''];
  if (section.id === 'lanes-posthog') {
    lines.push('The PostHog lane only starts when `posthog.host`, `posthog.apiKey`, `telegram.botToken` and `telegram.chatId` are all set: its alerts go to Telegram, so configure the Telegram section first.', '');
  }
  lines.push('| Key | Setting | Default | Notes |', '|-----|---------|---------|-------|');
  lines.push(...rows.map(settingRow), '');
  return lines;
}

function browserPreferencesMarkdown(sections: readonly SettingsSection[]): string[] {
  const rows = sections.filter((section) => section.level === BROWSER_LEVEL).flatMap(configRowsOf);
  return [
    '## Browser preferences',
    '',
    'Stored in each browser, not in `config.json`, so every device keeps its own.',
    '',
    '| Setting | Default | Notes |',
    '|---------|---------|-------|',
    ...rows.map((setting) => `| ${escapeCell(setting.title)} | ${formatDefault(setting.defaultValue)} | ${escapeCell(setting.description ?? '')} |`),
    '',
  ];
}

export function unlistedConfigKeys(sections: readonly SettingsSection[] = SETTINGS_MAP): string[] {
  const listedRoots = new Set(sections.flatMap((section) => section.settings.map((setting) => rootKeyOf(setting.path))));
  return Object.keys(Config.shape).filter((key) => !listedRoots.has(key));
}

function unlistedKeysMarkdown(sections: readonly SettingsSection[]): string[] {
  const rows = unlistedConfigKeys(sections).map((key) => `| \`${key}\` | ${formatDefault(defaultAtPath(key))} | ${escapeCell(UNLISTED_KEY_NOTES[key] ?? '')} |`);
  return [
    '## Keys outside the Settings view',
    '',
    'Edit these in `config.json` unless the note names another dashboard surface.',
    '',
    '| Key | Default | Notes |',
    '|-----|---------|-------|',
    ...rows,
    '',
  ];
}

function environmentMarkdown(): string[] {
  const rows = ENVIRONMENT_VARIABLES.map((variable) => `| \`${variable.name}\` | ${variable.audience} | ${escapeCell(variable.description)} |`);
  return [
    '## Environment variables',
    '',
    'Rows marked internal are set by Glimmervoid itself for its child processes; they are listed so nothing it reads is undocumented.',
    '',
    '| Variable | Audience | Effect |',
    '|----------|----------|--------|',
    ...rows,
    '',
  ];
}

export function renderConfigurationDoc(): string {
  const sections: readonly SettingsSection[] = SETTINGS_MAP;
  const configSections = sections.filter((section) => section.level !== BROWSER_LEVEL);
  const lines = [
    '# Configuration reference',
    '',
    'Generated by `npm run docs:config` from `public/settings-map.ts`, `shared/contracts/config.ts` and the defaults in `server/config-store.ts`. Do not edit it by hand: `tests/config-docs.test.ts` fails when it drifts from the code.',
    '',
    '## Where the config lives',
    '',
    'Glimmervoid reads `GLIMMERVOID_CONFIG` (or `--config <path>`) when set, and that file must exist. Otherwise it uses `config.json` under `GLIMMERVOID_HOME`, which defaults to `~/.glimmervoid`, and creates it with defaults on first run.',
    '',
    'Most settings are edited from the dashboard Settings view. Rows marked **File-only** are changed by editing `config.json`, which the server watches and reloads. A block key such as `posthog` accepts more nested keys than listed here; `shared/contracts/config.ts` is the full schema.',
    '',
    '## Settings',
    '',
    ...configSections.flatMap(sectionMarkdown),
    ...unlistedKeysMarkdown(sections),
    ...environmentMarkdown(),
    ...browserPreferencesMarkdown(sections),
  ];
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

if (process.argv[1] === import.meta.filename) {
  fs.writeFileSync(CONFIGURATION_DOC_PATH, renderConfigurationDoc(), 'utf8');
  console.log(`Wrote ${path.relative(process.cwd(), CONFIGURATION_DOC_PATH)}`);
}
