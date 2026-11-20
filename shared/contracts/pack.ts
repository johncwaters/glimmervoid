import { Cron } from 'croner';
import { z } from 'zod';
import { ThemePalette } from './theme-palette.ts';
import { LaunchAgent, LaunchEffort, LaunchModel, LaunchPrompt, LauncherLabel, LauncherProject } from './pack-launch.ts';
import { PackBridgeTopic, PackName, PackPanelAct, PackSourceSlug, SESSIONS_ACT_GRANT_TEXT } from './pack-bridge.ts';
import { REVIEW_ACTIONS_GRANT_TEXT } from './reviews.ts';
import { SKILL_NAME_PATTERN } from '../skill-frontmatter-core.ts';
import { isLoopbackHostname } from '../loopback-hosts.ts';
import { SecretName } from './secrets.ts';
import { PackPrFlowRule, PrFlowItemAction, PrFlowPackRequires, PrFlowPrAction, PrFlowSourceCommand, RepoScope, prFlowRulesJsonSchema } from './pr-flows.ts';

const PACK_SCHEMA_URL = 'https://glimmervoid.dev/schema/pack.v1.json';
export const PACK_FILE_NAME = 'pack.json';

const PackFilePath = z.string().regex(/^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._/-]{1,200}$/, { error: 'a pack file path is relative, inside the pack, and uses letters, digits, dot, dash, underscore and slash' });

export const PackHeader = z.strictObject({
  $schema: z.string().optional().describe(`Set it to ${PACK_SCHEMA_URL} so an editor completes and checks the file; Glimmervoid ignores it`),
  name: PackName.describe('Unique among installed packs; a second pack with the same name is refused. Theme and panel ids are scoped to it, so they never clash with another pack'),
  version: z.number().int().positive().describe('Your release number, shown to the operator beside the pack; raise it with each change. Approval follows the files, not this number: any changed file asks again'),
  description: z.string().max(500).optional().describe('One or two sentences shown on the pack card in the Packs tab and in the packs guide'),
  preview: PackFilePath.refine((filePath) => /\.(png|webp)$/.test(filePath), { error: 'a pack preview is a .png or .webp file' }).optional().describe('An image of what the pack adds, shown on its card in the Packs tab before it is approved. Glimmervoid releases after 0.58.4 read it; older ones refuse a manifest that sets it'),
  requires: PrFlowPackRequires.default({ env: [], programs: [] }).describe('What this machine needs for the pack; while anything is missing the pack stays off here and its card says what, without counting as a problem in the pack'),
  prFlows: z.unknown().optional(),
  ui: z.unknown().optional(),
  launchers: z.unknown().optional(),
  sessions: z.unknown().optional(),
  status: z.unknown().optional(),
  agent: z.unknown().optional(),
  mcp: z.unknown().optional(),
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

const PackItemId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, { error: 'an id is lowercase letters, digits and dashes, at most 40 characters' }).describe('Unique within its list in this pack, and scoped to the pack name so it never clashes with another pack');


export const PackPanel = z.strictObject({
  id: PackItemId,
  label: z.string().trim().min(1).max(24).describe('The tab name of the panel in the dashboard'),
  entry: PackFilePath.refine((filePath) => filePath.endsWith('.html'), { error: 'a panel entry is an .html file' }).describe('The HTML page the panel opens, relative to the pack folder'),
  icon: PackFilePath.refine((filePath) => filePath.endsWith('.svg'), { error: 'a panel icon is an .svg file' }).optional().describe('An .svg file in the pack shown beside the panel label'),
  reads: z.array(PackBridgeTopic).default([]).describe('The bridge topics this panel may receive; the operator sees them before approving, and a subscribe for any other topic is ignored'),
  acts: z.array(PackPanelAct).default([]).describe(`What this panel may do as the operator, without asking again: reviews lets it ${REVIEW_ACTIONS_GRANT_TEXT}; sessions lets it ${SESSIONS_ACT_GRANT_TEXT}, using the pack sessions settings; the operator sees it before approving`),
});

export const PackUi = z.strictObject({
  themes: z.array(ThemePalette.extend({ id: PackItemId })).max(8).default([]).describe('Color themes added to the Theme picker'),
  panels: z.array(PackPanel).max(8).default([]).describe('HTML pages shown as dashboard tabs, each sandboxed with no network and talking to the dashboard only through the panel bridge'),
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
    .describe('A cron pattern of five fields in the operator timezone; the launcher also starts its session on this schedule, skipping a run while its last scheduled session is still live, and catching up runs missed while Glimmervoid was down only with catchUp'),
  catchUp: z.boolean().optional().describe('With a schedule, start one run at once when a scheduled run fell while Glimmervoid was down or the host slept; off skips missed runs'),
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

const PACK_AGENT_SKILLS_MAX = 32;

export function packSkillNameOf(skillFolder: string): string {
  return skillFolder.split('/').at(-1) ?? '';
}

const PackSkillFolder = PackFilePath.refine((skillFolder) => SKILL_NAME_PATTERN.test(packSkillNameOf(skillFolder)), { error: 'a skill folder name is lowercase letters, digits and dashes, at most 64 characters' });

export const PackAgent = z.strictObject({
  context: PackFilePath.optional().describe('A file in the pack that every session\'s first prompt names, so the agent reads it when the task touches what it covers; the operator reads it word for word before approving'),
  skills: z.array(PackSkillFolder).max(PACK_AGENT_SKILLS_MAX).default([]).describe('Skill folders in the pack, each holding a SKILL.md; every session gets them, as /<pack>:<folder name> on Claude Code and <pack>-<folder name> on Codex and Kimi Code'),
}).superRefine((section, context) => {
  const seenNames = new Set<string>();
  section.skills.forEach((skillFolder, index) => {
    const skillName = packSkillNameOf(skillFolder);
    if (seenNames.has(skillName)) context.addIssue({ code: 'custom', path: ['skills', index], message: `the skill name '${skillName}' is already used in skills` });
    seenNames.add(skillName);
  });
});
export type PackAgent = z.infer<typeof PackAgent>;

export const PackLauncherRuns = z.strictObject({
  sessionIdByRun: z.record(z.string().min(1), z.string().min(1)).default({}),
  lastFiredAtByRun: z.record(z.string().min(1), z.number().int().nonnegative()).default({}),
});
export const GLIMMERVOID_MCP_SERVER_NAME = 'glimmervoid';

function isHttpsOrLoopbackHttp(url: string): boolean {
  const parsed = URL.parse(url);
  if (parsed === null) return false;
  return parsed.protocol === 'https:' || (parsed.protocol === 'http:' && isLoopbackHostname(parsed.hostname));
}

const PACK_MCP_URL_PATTERN = '^(https://|http://(127\\.0\\.0\\.1|localhost|\\[::1\\])([:/?#]|$))[^${}]*$';

export const PackMcpServer = z.strictObject({
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, { error: 'a server name is lowercase letters, digits, dash and underscore, at most 40 characters' })
    .refine((name) => name !== GLIMMERVOID_MCP_SERVER_NAME, { error: `the server name '${GLIMMERVOID_MCP_SERVER_NAME}' is glimmervoid's own` })
    .meta({ not: { const: GLIMMERVOID_MCP_SERVER_NAME }, description: 'The name every agent lists the server under; a server the operator registered under the same name gives way to this one in glimmervoid sessions' }),
  url: z.url().refine(isHttpsOrLoopbackHttp, { error: 'a server url is https, or http on 127.0.0.1, ::1 or localhost' })
    .refine((url) => !/[${}]/.test(url), { error: 'a server url holds no $, { or }, since agents expand ${VAR} and {env:VAR} in it' })
    .meta({ pattern: PACK_MCP_URL_PATTERN, description: 'The streamable HTTP MCP endpoint; with no secret the agent signs in through its own MCP OAuth login' }),
  secret: SecretName.optional()
    .describe('A bearer token sent to this server: glimmervoid reads the name from the vault at session start once the operator allows it for the project, and passes it by environment variable, never argv; while it is denied or cannot be read, a Gemini CLI or Kimi Code session fails its sign-in and any other session leaves the server out'),
});
export type PackMcpServer = z.infer<typeof PackMcpServer>;
export type PackMcpLaunch = { servers: PackMcpServer[]; env: Record<string, string> };
export type PackMcpLaunchHold = PackMcpLaunch | { held: Promise<PackMcpLaunch> };

export const PackMcp = z.strictObject({
  servers: z.array(PackMcpServer).min(1).max(8).describe('MCP servers every locally launched glimmervoid session gets once the operator approves the pack'),
}).superRefine((section, context) => {
  const seenNames = new Set<string>();
  section.servers.forEach((server, index) => {
    if (seenNames.has(server.name)) context.addIssue({ code: 'custom', path: ['servers', index, 'name'], message: `the name '${server.name}' is already used in servers` });
    seenNames.add(server.name);
  });
});
export type PackMcp = z.infer<typeof PackMcp>;

export const PacksState = z.strictObject({ approvedFingerprints: z.array(z.string().min(1)).default([]) });
export type PacksState = z.infer<typeof PacksState>;

export const PacksInstalled = z.strictObject({ fingerprintsByName: z.record(z.string().min(1), z.string().min(1)).default({}) });
export type PacksInstalled = z.infer<typeof PacksInstalled>;

export const PackSourcesFile = z.strictObject({
  sources: z.array(z.strictObject({
    url: z.string().min(1), slug: PackSourceSlug, enabledPacks: z.array(PackName),
    installedFingerprintsByName: z.record(PackName, z.string()).optional().describe('The fingerprint of the copy this source last installed, per enabled pack; a following source leaves a pack alone once another install replaces that copy'),
  })).default([]),
});
export type PackSourcesFile = z.infer<typeof PackSourcesFile>;

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
  agent: PackSection<PackAgent> | null;
  mcp: PackSection<PackMcp> | null;
  missingRequires: string[];
  previewDataUrl: string | null;
};

const PackManifestForSchema = PackHeader.extend({
  prFlows: PackPrFlows.optional().describe('PR flows this pack adds; one invalid entry skips the whole section'), ui: PackUi.optional().describe('Themes and panels this pack adds to the dashboard'),
  launchers: PackLaunchers.optional().describe('Buttons in the Add session picker, each starting a session with its own prompt'),
  sessions: PackSessions.optional().describe('Permission settings for every session this pack starts'),
  status: PackStatus.optional().describe('Status pages its panels read through the providers topic'),
  agent: PackAgent.optional().describe('Context and skills every session\'s agent gets once the operator approves the pack'),
  mcp: PackMcp.optional().describe('MCP servers every session gets once the pack is approved. Glimmervoid releases after 0.62.8 read it; older ones refuse a manifest that sets it'),
});

export function packJsonSchemaText(): string {
  return `${JSON.stringify({ $id: PACK_SCHEMA_URL, title: 'Glimmervoid pack', ...prFlowRulesJsonSchema(PackManifestForSchema) }, null, 2)}\n`;
}
