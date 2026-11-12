import fs from 'node:fs';
import path from 'node:path';
import { REVIEW_ACTION_TYPES } from '../../shared/contracts/reviews.ts';
import { PANEL_ACTION_MAX_BYTES, panelActionsJsonSchemaText } from '../../shared/pack-action-core.ts';
import { PACK_DATA_MAX_BYTES, PACK_STORE_MAX_DEPTH, packBridgeJsonSchemaText } from '../../shared/contracts/pack-bridge.ts';
import { PACK_FILE_NAME, PackHeader, packJsonSchemaText } from '../../shared/contracts/pack.ts';
import type { PackRow } from '../../shared/contracts/control/pack-messages.ts';
import { ATTENTION_NOTE_MAX_CHARS } from '../../shared/contracts/session.ts';
import type { AgentPacksRequest } from '../../shared/contracts/session.ts';
import { parseJsonOrNull } from '../core/json-core.ts';
import { checkPack, packCheckHasProblem, packReportText } from './pack-check.ts';
import { PACK_PANEL_CONTENT_POLICY, pendingPackNote } from './core/pack-core.ts';
import { PACKS_DIR_NAME } from './pack-files.ts';
import { installPack, removeInstalledPack } from './pack-install.ts';
import type { PackSources } from './pack-sources.ts';
import { packSourceOf } from './core/pack-sources-core.ts';

type PacksReadout = { text: string; hasProblem: boolean };
type PackAgentDeps = {
  homeDir: string;
  env: NodeJS.ProcessEnv;
  examplePacksDir: string;
  packRows: () => readonly PackRow[];
  isApproved: (fingerprint: string) => boolean;
  sources?: Pick<PackSources, 'add' | 'update'>;
};

async function exampleLines(examplePacksDir: string): Promise<string[]> {
  const entries = await fs.promises.readdir(examplePacksDir, { withFileTypes: true }).catch(() => []);
  const lines = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const manifestText = await fs.promises.readFile(path.join(examplePacksDir, entry.name, PACK_FILE_NAME), 'utf8').catch(() => '');
    const header = PackHeader.safeParse(parseJsonOrNull(manifestText));
    return `- ${path.join(examplePacksDir, entry.name)}${header.success && header.data.description ? `: ${header.data.description}` : ''}`;
  }));
  return lines.length === 0 ? ['(this install ships no example packs)'] : lines.sort();
}

export async function packGuideText({ homeDir, examplePacksDir }: Pick<PackAgentDeps, 'homeDir' | 'examplePacksDir'>, schemaLines: readonly string[]): Promise<string> {
  return [
    'Glimmervoid packs',
    '',
    `A pack is a folder holding a ${PACK_FILE_NAME} and the files it names, at most 1 MiB in all and without symlinks. Install one with the packs tool action install (glimmervoid packs install <folder>), which checks the folder and copies it into ${path.join(homeDir, PACKS_DIR_NAME)}; installing again replaces that copy. remove deletes only a copy install made.`,
    `Shared team packs: add <https URL of a git repository> clones it into ${path.join(homeDir, 'pack-sources')}, with git hooks and symlinks off; every folder in it holding a ${PACK_FILE_NAME} (at most two levels down) stays off until the operator enables it in Settings, Packs, which installs it, unapproved. update pulls every source, or the one whose URL you give, and reinstalls its enabled packs, which wait for approval again when any file changed.`,
    'Nothing in a pack runs or shows until the operator approves it in Settings, Packs, and any change to any file in it asks again. No tool action approves a pack: install it, then call request-approval with its name, which shows the operator what it adds and points them to Settings, Packs. status names its approval state, load errors and anything missing on this machine.',
    '',
    'Sections of pack.json, each checked on its own:',
    '- prFlows: commands My PRs runs on pull requests (prActions, sources, actions, rules).',
    '- ui.themes: color themes for the Theme picker; every chrome and state color is a #rrggbb hex.',
    '- ui.panels: HTML pages shown as dashboard tabs. A panel runs sandboxed in an opaque origin: no network, no cookies, no storage, no popups or navigation (a link in a panel opens nothing), no access to the dashboard page. Put every script, style, image and font in the pack and refer to it by a relative path; ES module scripts with relative imports, fonts, inline <script> and <style> all work. localStorage, sessionStorage and cookies throw a SecurityError; keep state in the pack store instead (below). Every panel file is served with this Content-Security-Policy:',
    `  ${PACK_PANEL_CONTENT_POLICY}`,
    '- launchers: buttons at the top of the add-session picker, each starting one session: label, project (an owner/name repository matched against the projects already on this machine, or an absolute folder path), agent (claude-code, codex or kimi), optional model and effort, and the first prompt, at most 4000 characters. The operator sees each prompt word for word before approving. A launcher whose project matches nothing here shows disabled with the reason. An optional schedule, a cron pattern of five fields in the operator timezone such as "0 9 * * 1-5", also starts the session on that schedule; a run is skipped while the last scheduled session of that launcher is still live, when its project matches nothing, or when packScheduledSessionsMax scheduled sessions are already live, and runs missed while Glimmervoid was down never catch up.',
    '- sessions: settings for every session the pack starts. dangerouslySkipPermissions (default false) starts them without permission prompts; saneYolo turns the risky-command catcher on or off for them, and follows the operator setting when absent.',
    '- agent: context and skills every Glimmervoid session gets once the pack is approved, in any project, on Claude Code, Codex and Kimi Code; never in team review, community or Radar sessions, or clean-home projects. context names a file in the pack that each session\'s first prompt points the agent at; skills lists skill folders in the pack, each holding a SKILL.md, which a session sees as /<pack>:<folder name> on Claude Code and <pack>-<folder name> on Codex and Kimi Code (a combined name over 64 characters reaches Claude Code only). Sessions read a copy of the approved files, so an edit reaches none until the operator approves it; a live session keeps the copy it started with.',
    '',
    'Panel bridge: list the topics a panel needs under its reads in pack.json; the operator sees them before approving. The panel posts {"v":1,"kind":"subscribe","topics":[...]} to window.parent and gets {"v":1,"kind":"hello","granted":[...]}: the subscribed topics that are also in reads, so a topic left out of reads never arrives. Then a {"v":1,"kind":"topic","topic":...,"data":...} message comes for each granted topic, right away and again whenever it changes. Accept messages only when event.source === window.parent. The descriptions in the bridge JSON Schema below give each field\'s units and meaning.',
    `Pack store: every panel of a pack shares one key/value store kept across reloads, browsers and pack updates, at most ${PACK_DATA_MAX_BYTES} bytes as JSON and deleted when the pack folder is removed. A {"v":1,"kind":"store","data":{...},"error":null} message arrives right after hello (an empty topics list in subscribe is fine for a panel that only stores), and again after each save. Save one key by posting {"v":1,"kind":"store-set","key":"sort","value":"newest"}; a value of null deletes the key, and a value nests at most ${PACK_STORE_MAX_DEPTH} levels deep. A save over the limit is refused: the store message then carries the unchanged data and an error naming the size.`,
    `Panel actions: a panel whose acts in pack.json lists reviews may do what the operator does in the Reviews tab, without asking again: post {"v":1,"kind":"action","id":"a1","request":{"type":"open-team-review-session","key":"Owner/repo#12"}} and get back {"v":1,"kind":"action-result","id":"a1","ok":true,"timedOut":false,"result":{...},"error":null}. request.type is one of ${REVIEW_ACTION_TYPES.join(', ')}, and the rest of request is that action's fields, as the panel action requests JSON Schema gives them, at most ${PANEL_ACTION_MAX_BYTES} bytes as JSON. Take keys from the item itself, since they are case sensitive: a team item's review.key is the key of team-review-action and open-team-review-session, and a mine item's pr.key is the prKey of the pr-flow actions, with pr.repo, pr.number and pr.headRefOid for merges and PR actions; a reviews item's own prKey is lowercase and matches none of them. timedOut true means no answer came within two minutes and the action may still run, so check the reviews topic before sending it again. ok is false with an error naming why when the panel lacks acts, the request fails the same schema the server uses, or the server refuses it; result carries the server reply whenever one came. The operator sees acts before approving, so list it only on a panel that needs it. packs preview checks each action the same way and sends nothing.`,
    `Session actions: a panel whose acts lists sessions may start a session with {"type":"pack-session-start","project":"owner/name or an absolute folder","agent":"claude-code","prompt":"..."} (optional model, effort and name; the result is add-session-result with the new sessionId) and type into a live session on this machine with {"type":"pack-session-send","id":"<session id from the sessions topic>","text":"..."}; the dashboard adds the pack and panel, and the pack sessions section sets their permission prompts like a launcher's. A pack where any panel reads reviews and any panel lists sessions gets a warning on the approval screen, since panels share one store and text other people wrote could steer what it starts. A pack with errors cannot be approved.`,
    'Provider status: list statuspage summary URLs (https only, such as https://www.githubstatus.com/api/v2/summary.json or https://status.claude.com/api/v2/summary.json) under status.urls in pack.json, and a panel reading the providers topic gets each page\'s open incidents. Glimmervoid reads each page at most once every five minutes and shares the read across packs; the operator sees the URLs before approving.',
    'Each example panel ships the same bridge.js; copy it beside your panel and load it before your own script. It defines window.glimmervoid.subscribe(topics, onTopic) (it calls onTopic("hello", granted) once, then onTopic(topic, data) per topic message), act(request) (it sends one panel action and resolves with its action-result), applyTheme(themeData) (pass it the theme topic data; it sets every color as a CSS custom property on the root, such as var(--bg) or var(--state-running)) and element(tag, className, text).',
    '',
    'Examples to copy and adapt:',
    ...await exampleLines(examplePacksDir),
    '',
    'Workflow: write the pack in any folder, run glimmervoid packs check <folder> (exits 1 and lists every problem, including files a page loads that are missing or remote), then glimmervoid packs preview <folder> to open its panels in a browser with sample data and its themes, without installing or approving anything. Then install it and call request-approval. The packs tool actions check, install, status, request-approval and remove do the same over MCP, and its preview action shows the panels with sample data as a live page card on your session board, loading from this machine.',
    '',
    ...schemaLines,
  ].join('\n');
}

function rowLines(row: PackRow): string[] {
  return [
    `${row.name}${row.version === null ? '' : ` v${row.version}`}: ${row.state} at ${row.dir}`,
    ...row.panels.map((panel) => `  panel ${panel.id} (${panel.label})${panel.reads.length === 0 ? '' : `, reads ${panel.reads.join(', ')}`}${panel.acts.length === 0 ? '' : `, acts on ${panel.acts.join(', ')}`}`),
    ...row.themes.map((theme) => `  theme ${theme.id} (${theme.label}, ${theme.mode})`),
    ...row.launchers.map((launcher) => `  launcher ${launcher.id} (${launcher.label}), ${launcher.agent} in ${launcher.project}${launcher.schedule === null ? '' : `, on schedule ${launcher.schedule}`}`),
    ...row.statusUrls.map((url) => `  status page ${url}`),
    ...(row.agent?.context ? [`  agent context ${row.agent.context.path}`] : []),
    ...(row.agent?.skills ?? []).map((skill) => `  agent skill ${skill.name} (${skill.path})`),
    ...row.missingRequires.map((missing) => `  missing on this machine: ${missing}`),
    ...row.errors.map((error) => `  error: ${error}`),
  ];
}

function packGrantsText(row: PackRow): string {
  const prFlowCommandCount = row.prFlows?.pack?.commands.length ?? 0;
  const grants = [
    ...row.panels.map((panel) => `panel ${panel.label}${panel.reads.length === 0 ? '' : ` reading ${panel.reads.join(', ')}`}${panel.acts.length === 0 ? '' : ` acting on ${panel.acts.join(', ')}`}`),
    ...(row.themes.length === 0 ? [] : [`${row.themes.length} theme${row.themes.length === 1 ? '' : 's'}`]),
    ...row.launchers.map((launcher) => `launcher ${launcher.label} starting ${launcher.agent} in ${launcher.project}${launcher.schedule === null ? '' : ` on schedule ${launcher.schedule}`}`),
    ...(row.sessions?.dangerouslySkipPermissions ? ['sessions without permission prompts'] : []),
    ...(row.statusUrls.length === 0 ? [] : [`status pages ${row.statusUrls.join(', ')}`]),
    ...(row.agent?.context ? [`context ${row.agent.context.path} for every session`] : []),
    ...((row.agent?.skills.length ?? 0) === 0 ? [] : [`skills ${(row.agent?.skills ?? []).map((skill) => skill.name).join(', ')} for every session`]),
    ...(prFlowCommandCount === 0 ? [] : [`${prFlowCommandCount} My PRs command${prFlowCommandCount === 1 ? '' : 's'}`]),
  ];
  return grants.length === 0 ? 'it adds nothing yet' : `it adds ${grants.join('; ')}`;
}

function packApprovalNote(row: PackRow): string {
  const note = `${pendingPackNote(row)}${row.version === null ? '' : ` (v${row.version})`}: ${packGrantsText(row)}.`;
  const ellipsis = String.fromCharCode(0x2026);
  return note.length <= ATTENTION_NOTE_MAX_CHARS ? note : `${note.slice(0, ATTENTION_NOTE_MAX_CHARS - 1)}${ellipsis}`;
}

function packStatusText(row: PackRow): string {
  const stateLine = {
    approved: 'Approved: it is in use.',
    pending: 'Pending: it waits for the operator to approve it in Settings, Packs; request-approval asks them.',
    invalid: 'Invalid: fix the errors below and install it again.',
  }[row.state];
  return [...rowLines(row), stateLine].join('\n');
}

function rowNamed(name: string, deps: PackAgentDeps): PackRow | null {
  return deps.packRows().find((row) => row.name === name) ?? null;
}

function notFound(name: string): PacksReadout {
  return { text: `No pack named '${name}' is loaded here; packs list names those that are. A pack installed a moment ago shows within a second.`, hasProblem: true };
}

async function installForAgent(sourceDir: string, deps: PackAgentDeps): Promise<PacksReadout> {
  const outcome = await installPack(sourceDir, deps);
  if (!outcome.ok) return { text: outcome.error, hasProblem: true };
  const verb = outcome.hasReplaced ? 'Replaced' : 'Installed';
  return { text: `${verb} ${outcome.name} at ${outcome.dir}. It waits for the operator to approve it in Settings, Packs; call request-approval with name ${outcome.name} to ask them.`, hasProblem: false };
}

function requestApprovalFor(name: string, deps: PackAgentDeps): PacksReadout {
  const row = rowNamed(name, deps);
  if (!row) return notFound(name);
  if (row.state === 'approved') return { text: `${name} is already approved.`, hasProblem: true };
  if (row.state === 'invalid') return { text: `${name} cannot be approved until its errors are fixed:\n${row.errors.join('\n')}`, hasProblem: true };
  return { text: packApprovalNote(row), hasProblem: false };
}

async function removeForAgent(name: string, deps: PackAgentDeps): Promise<PacksReadout> {
  const outcome = await removeInstalledPack(name, deps.homeDir, deps.env);
  return outcome.ok ? { text: `Removed ${name} from ${outcome.dir}.`, hasProblem: false } : { text: outcome.error, hasProblem: true };
}

async function checkForAgent(packDir: string, deps: PackAgentDeps): Promise<PacksReadout> {
  const report = await checkPack(packDir, deps.env, deps.isApproved);
  return { text: packReportText(report), hasProblem: packCheckHasProblem(report) };
}

async function changeSourceForAgent(request: AgentPacksRequest, { sources }: PackAgentDeps): Promise<PacksReadout> {
  if (!sources) return { text: 'Pack sources are not running here', hasProblem: true };
  const target = request.url === undefined ? null : packSourceOf(request.url);
  if (target !== null && !target.ok) return { text: target.error, hasProblem: true };
  const outcome = request.command === 'add' ? await sources.add(request.url ?? '') : await sources.update(target?.slug ?? null);
  return outcome.ok ? { text: outcome.text, hasProblem: false } : { text: outcome.error, hasProblem: true };
}

export async function readPacksForAgent(request: AgentPacksRequest, deps: PackAgentDeps): Promise<PacksReadout> {
  switch (request.command) {
    case 'guide':
      return { text: await packGuideText(deps, [`${PACK_FILE_NAME} JSON Schema:`, packJsonSchemaText(), 'Panel bridge messages JSON Schema:', packBridgeJsonSchemaText(), 'Panel action requests JSON Schema, by request.type:', panelActionsJsonSchemaText()]), hasProblem: false };
    case 'list': {
      const rows = deps.packRows();
      return { text: rows.length === 0 ? `No packs are installed; ${path.join(deps.homeDir, PACKS_DIR_NAME)} holds none and config.json lists none.` : rows.flatMap(rowLines).join('\n'), hasProblem: rows.some((row) => row.errors.length > 0) };
    }
    case 'check':
    case 'preview':
      return checkForAgent(request.path ?? '', deps);
    case 'install':
      return installForAgent(request.path ?? '', deps);
    case 'status': {
      const row = rowNamed(request.name ?? '', deps);
      return row ? { text: packStatusText(row), hasProblem: row.errors.length > 0 } : notFound(request.name ?? '');
    }
    case 'request-approval':
      return requestApprovalFor(request.name ?? '', deps);
    case 'remove':
      return removeForAgent(request.name ?? '', deps);
    case 'add':
    case 'update':
      return changeSourceForAgent(request, deps);
  }
}
