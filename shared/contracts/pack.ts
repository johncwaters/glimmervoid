import { Cron } from 'croner';
import { z } from 'zod';
import { ThemePalette } from './theme-palette.ts';
import { LaunchAgent, LaunchEffort, LaunchModel, LaunchPrompt, LauncherLabel, LauncherProject } from './pack-launch.ts';
import { PackBridgeTopic, PackName, PackPanelAct, SESSIONS_ACT_GRANT_TEXT } from './pack-bridge.ts';
import { REVIEW_ACTIONS_GRANT_TEXT } from './reviews.ts';
import { PackPrFlowRule, PrFlowItemAction, PrFlowPackRequires, PrFlowPrAction, PrFlowSourceCommand, RepoScope, prFlowRulesJsonSchema } from './pr-flows.ts';

const PACK_SCHEMA_URL = 'https://glimmervoid.dev/schema/pack.v1.json';
export const PACK_FILE_NAME = 'pack.json';

export const PackHeader = z.strictObject({
  $schema: z.string().optional(),
  name: PackName.describe('Unique among installed packs; a second pack with the same name is refused. Theme and panel ids are scoped to it, so they never clash with another pack'),
  version: z.number().int().positive().describe('Your release number, shown to the operator beside the pack; raise it with each change. Approval follows the files, not this number: any changed file asks again'),
  description: z.string().max(500).optional(),
  requires: PrFlowPackRequires.default({ env: [], programs: [] }),
  prFlows: z.unknown().optional(),
  ui: z.unknown().optional(),
  launchers: z.unknown().optional(),
  sessions: z.unknown().optional(),
  status: z.unknown().optional(),
});
export type PackHeader = z.infer<typeof PackHeader>;

export const PackPrFlows = z.strictObject({
  repos: RepoScope.describe('The default owner/name repositories, matched case-insensitively, for every prAction, source and rule of this pack that lists no repos of its own; an entry\'s own repos narrow this default to the repositories both list; every repository when absent'),
  prActions: z.array(PrFlowPrAction).default([]).describe('Buttons on a pull request; the command prints {"outcome":"done|started|refused|failed","message":"..."}, and one that prints started reports later with glimmervoid pr-action report'),
  sources: z.array(PrFlowSourceCommand).default([]).describe('Commands run on each pull request that print {"findings":[{"path","lineStart","lineEnd","priority","body","url"}],"status":[{"label","state"}]}, at most 200 findings and 4 status lines'),
  actions: z.array(PrFlowItemAction).default([]).describe('Commands rules run on one review item with run:<id>; they print {"outcome":"done|started|refused|failed","message":"..."} and are limited to repositories only through the rules that name them'),
  rules: z.array(PackPrFlowRule).default([]).describe('Run after your own config.json rules; the first rule that matches an item decides it'),
}).superRefine((section, context) => {
  for (const kind of ['prActions', 'sources', 'actions'] as const) {
    const seenIds = new Set<string>();
    section[kind].forEach((command, index) => {
      if (seenIds.has(command.id)) context.addIssue({ code: 'custom', path: [kind, index, 'id'], message: `the id '${command.id}' is already used in ${kind}` });
      seenIds.add(command.id);
    });
  }
});
export type PackPrFlows = z.infer<typeof PackPrFlows>;

const PackItemId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, { error: 'an id is lowercase letters, digits and dashes, at most 40 characters' });

const PackFilePath = z.string().regex(/^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._/-]{1,200}$/, { error: 'a pack file path is relative, inside the pack, and uses letters, digits, dot, dash, underscore and slash' });

export const PackPanel = z.strictObject({
  id: PackItemId,
  label: z.string().trim().min(1).max(24),
  entry: PackFilePath.refine((filePath) => filePath.endsWith('.html'), { error: 'a panel entry is an .html file' }).describe('The HTML page the panel opens, relative to the pack folder'),
  icon: PackFilePath.refine((filePath) => filePath.endsWith('.svg'), { error: 'a panel icon is an .svg file' }).optional(),
  reads: z.array(PackBridgeTopic).default([]).describe('The bridge topics this panel may receive; the operator sees them before approving, and a subscribe for any other topic is ignored'),
  acts: z.array(PackPanelAct).default([]).describe(`What this panel may do as the operator, without asking again: reviews lets it ${REVIEW_ACTIONS_GRANT_TEXT}; sessions lets it ${SESSIONS_ACT_GRANT_TEXT}, using the pack sessions settings; the operator sees it before approving`),
});

export const PackUi = z.strictObject({
  themes: z.array(ThemePalette.extend({ id: PackItemId })).max(8).default([]),
  panels: z.array(PackPanel).max(8).default([]),
}).superRefine((section, context) => {
  for (const kind of ['themes', 'panels'] as const) {
    const seenIds = new Set<string>();
    section[kind].forEach((item, index) => {
      if (seenIds.has(item.id)) context.addIssue({ code: 'custom', path: [kind, index, 'id'], message: `the id '${item.id}' is already used in ${kind}` });
      seenIds.add(item.id);
    });
  }
});
export type PackUi = z.infer<typeof PackUi>;

const CRON_FIELD_COUNT = 5;

function isFiveFieldCron(pattern: string): boolean {
  if (pattern.split(/\s+/).length !== CRON_FIELD_COUNT) return false;
  try {
    new Cron(pattern);
    return true;
  } catch {
    return false;
  }
}

export const PackLauncher = z.strictObject({
  id: PackItemId,
  label: LauncherLabel.describe('The button text, also the name of the session it starts'),
  project: LauncherProject.describe('owner/name: the first configured project whose origin is that GitHub repository; or an absolute path of a folder on this machine. A launcher whose project matches nothing shows disabled'),
  agent: LaunchAgent, model: LaunchModel, effort: LaunchEffort, prompt: LaunchPrompt,
  schedule: z.string().trim().max(100).refine(isFiveFieldCron, { error: 'a launcher schedule is a cron pattern of five fields such as "0 9 * * 1-5"' }).optional()
    .describe('A cron pattern of five fields in the operator timezone; the launcher also starts its session on this schedule, skipping a run while its last scheduled session is still live, and never catching up runs missed while Glimmervoid was down'),
});
export type PackLauncher = z.infer<typeof PackLauncher>;

export const PackLaunchers = z.array(PackLauncher).max(16).superRefine((launchers, context) => {
  const seenIds = new Set<string>();
  launchers.forEach((launcher, index) => {
    if (seenIds.has(launcher.id)) context.addIssue({ code: 'custom', path: [index, 'id'], message: `the id '${launcher.id}' is already used in launchers` });
    seenIds.add(launcher.id);
  });
});

export const PackSessions = z.strictObject({
  dangerouslySkipPermissions: z.boolean().default(false).describe('Sessions this pack starts skip the agent\'s permission prompts; the operator sees it before approving'),
  saneYolo: z.boolean().optional().describe('With dangerouslySkipPermissions, also catch risky commands with Sane YOLO; absent follows the operator\'s default'),
});
export type PackSessions = z.infer<typeof PackSessions>;

const PACK_STATUS_URLS_MAX = 8;

export const PackStatus = z.strictObject({
  urls: z.array(z.url({ protocol: /^https$/, error: 'a status URL is an https URL' }).max(2048)).max(PACK_STATUS_URLS_MAX).superRefine((urls, context) => {
    if (new Set(urls).size !== urls.length) context.addIssue({ code: 'custom', message: 'a status URL is listed twice' });
  }).describe('Statuspage summary URLs, such as https://www.githubstatus.com/api/v2/summary.json; the providers topic carries their open incidents'),
});
export type PackStatus = z.infer<typeof PackStatus>;

export const PackLauncherRuns = z.strictObject({ sessionIdByRun: z.record(z.string().min(1), z.string().min(1)).default({}) });

export const PacksState = z.strictObject({ approvedFingerprints: z.array(z.string().min(1)).default([]) });
export type PacksState = z.infer<typeof PacksState>;

export const PacksInstalled = z.strictObject({ fingerprintsByName: z.record(z.string().min(1), z.string().min(1)).default({}) });
export type PacksInstalled = z.infer<typeof PacksInstalled>;

export type PackSection<Value> = { ok: true; value: Value } | { ok: false; errors: string[] };

export type PackOnDisk = {
  dir: string;
  header: PackHeader;
  fingerprint: string;
  filesByPath: ReadonlyMap<string, Buffer>;
  prFlows: PackSection<PackPrFlows> | null;
  ui: PackSection<PackUi> | null;
  launchers: PackSection<PackLauncher[]> | null;
  sessions: PackSection<PackSessions> | null;
  status: PackSection<PackStatus> | null;
  missingRequires: string[];
};

const PackManifestForSchema = PackHeader.extend({
  prFlows: PackPrFlows.optional().describe('PR flows this pack adds; one invalid entry skips the whole section'), ui: PackUi.optional(),
  launchers: PackLaunchers.optional().describe('Buttons in the Add session picker, each starting a session with its own prompt'),
  sessions: PackSessions.optional().describe('Permission settings for every session this pack starts'),
  status: PackStatus.optional().describe('Status pages its panels read through the providers topic'),
});

export function packJsonSchemaText(): string {
  return `${JSON.stringify({ $id: PACK_SCHEMA_URL, title: 'Glimmervoid pack', ...prFlowRulesJsonSchema(PackManifestForSchema) }, null, 2)}\n`;
}
