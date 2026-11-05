import fs from 'node:fs';
import path from 'node:path';
import { REVIEW_ACTION_TYPES } from '../../shared/contracts/reviews.ts';
import { PANEL_ACTION_MAX_BYTES, panelActionsJsonSchemaText } from '../../shared/pack-action-core.ts';
import { PACK_DATA_MAX_BYTES, PACK_STORE_MAX_DEPTH, packBridgeJsonSchemaText } from '../../shared/contracts/pack-bridge.ts';
import { PACK_FILE_NAME, PackHeader, packJsonSchemaText } from '../../shared/contracts/pack.ts';
import type { PackRow } from '../../shared/contracts/control/pack-messages.ts';
import type { AgentPacksRequest } from '../../shared/contracts/session.ts';
import { parseJsonOrNull } from '../core/json-core.ts';
import { checkPack, packCheckHasProblem, packReportText } from './pack-check.ts';
import { PACK_PANEL_CONTENT_POLICY } from './core/pack-core.ts';
import { PACKS_DIR_NAME } from './pack-files.ts';

type PacksReadout = { text: string; hasProblem: boolean };
type PackAgentDeps = {
  homeDir: string;
  env: NodeJS.ProcessEnv;
  examplePacksDir: string;
  packRows: () => readonly PackRow[];
  isApproved: (fingerprint: string) => boolean;
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
    `A pack is a folder holding a ${PACK_FILE_NAME} and the files it names, at most 1 MiB in all and without symlinks. Install one by placing its folder under ${path.join(homeDir, PACKS_DIR_NAME)}, or by listing its path under "packs" in Glimmervoid's config.json.`,
    'Nothing in a pack runs or shows until the operator approves it in Settings, Packs, and any change to any file in it asks again. Never approve a pack for the operator; check it, then tell them it waits for approval.',
    '',
    'Sections of pack.json, each checked on its own:',
    '- prFlows: commands My PRs runs on pull requests (prActions, sources, actions, rules).',
    '- ui.themes: color themes for the Theme picker; every chrome and state color is a #rrggbb hex.',
    '- ui.panels: HTML pages shown as dashboard tabs. A panel runs sandboxed in an opaque origin: no network, no cookies, no storage, no popups or navigation (a link in a panel opens nothing), no access to the dashboard page. Put every script, style, image and font in the pack and refer to it by a relative path; ES module scripts with relative imports, fonts, inline <script> and <style> all work. localStorage, sessionStorage and cookies throw a SecurityError; keep state in the pack store instead (below). Every panel file is served with this Content-Security-Policy:',
    `  ${PACK_PANEL_CONTENT_POLICY}`,
    '',
    'Panel bridge: list the topics a panel needs under its reads in pack.json; the operator sees them before approving. The panel posts {"v":1,"kind":"subscribe","topics":[...]} to window.parent and gets {"v":1,"kind":"hello","granted":[...]}: the subscribed topics that are also in reads, so a topic left out of reads never arrives. Then a {"v":1,"kind":"topic","topic":...,"data":...} message comes for each granted topic, right away and again whenever it changes. Accept messages only when event.source === window.parent. The descriptions in the bridge JSON Schema below give each field\'s units and meaning.',
    `Pack store: every panel of a pack shares one key/value store kept across reloads, browsers and pack updates, at most ${PACK_DATA_MAX_BYTES} bytes as JSON and deleted when the pack folder is removed. A {"v":1,"kind":"store","data":{...},"error":null} message arrives right after hello (an empty topics list in subscribe is fine for a panel that only stores), and again after each save. Save one key by posting {"v":1,"kind":"store-set","key":"sort","value":"newest"}; a value of null deletes the key, and a value nests at most ${PACK_STORE_MAX_DEPTH} levels deep. A save over the limit is refused: the store message then carries the unchanged data and an error naming the size.`,
    `Panel actions: a panel whose acts in pack.json lists reviews may do what the operator does in the Reviews tab, without asking again: post {"v":1,"kind":"action","id":"a1","request":{"type":"open-team-review-session","key":"Owner/repo#12"}} and get back {"v":1,"kind":"action-result","id":"a1","ok":true,"timedOut":false,"result":{...},"error":null}. request.type is one of ${REVIEW_ACTION_TYPES.join(', ')}, and the rest of request is that action's fields, as the panel action requests JSON Schema gives them, at most ${PANEL_ACTION_MAX_BYTES} bytes as JSON. Take keys from the item itself, since they are case sensitive: a team item's review.key is the key of team-review-action and open-team-review-session, and a mine item's pr.key is the prKey of the pr-flow actions, with pr.repo, pr.number and pr.headRefOid for merges and PR actions; a reviews item's own prKey is lowercase and matches none of them. timedOut true means no answer came within two minutes and the action may still run, so check the reviews topic before sending it again. ok is false with an error naming why when the panel lacks acts, the request fails the same schema the server uses, or the server refuses it; result carries the server reply whenever one came. The operator sees acts before approving, so list it only on a panel that needs it. packs preview checks each action the same way and sends nothing.`,
    'Each example panel ships the same bridge.js; copy it beside your panel and load it before your own script. It defines window.glimmervoid.subscribe(topics, onTopic) (it calls onTopic("hello", granted) once, then onTopic(topic, data) per topic message), act(request) (it sends one panel action and resolves with its action-result), applyTheme(themeData) (pass it the theme topic data; it sets every color as a CSS custom property on the root, such as var(--bg) or var(--state-running)) and element(tag, className, text).',
    '',
    'Examples to copy and adapt:',
    ...await exampleLines(examplePacksDir),
    '',
    'Workflow: write the pack in any folder, run glimmervoid packs check <folder> (exits 1 and lists every problem, including files a page loads that are missing or remote), then glimmervoid packs preview <folder> to open its panels in a browser with sample data and its themes, without installing or approving anything. Then install it and tell the operator it waits for approval. The packs tool with action check runs the same check.',
    '',
    ...schemaLines,
  ].join('\n');
}

function rowLines(row: PackRow): string[] {
  return [
    `${row.name}${row.version === null ? '' : ` v${row.version}`}: ${row.state} at ${row.dir}`,
    ...row.panels.map((panel) => `  panel ${panel.id} (${panel.label})${panel.reads.length === 0 ? '' : `, reads ${panel.reads.join(', ')}`}${panel.acts.length === 0 ? '' : `, acts on ${panel.acts.join(', ')}`}`),
    ...row.themes.map((theme) => `  theme ${theme.id} (${theme.label}, ${theme.mode})`),
    ...row.missingRequires.map((missing) => `  missing on this machine: ${missing}`),
    ...row.errors.map((error) => `  error: ${error}`),
  ];
}

export async function readPacksForAgent(request: AgentPacksRequest, deps: PackAgentDeps): Promise<PacksReadout> {
  if (request.command === 'guide') return { text: await packGuideText(deps, [`${PACK_FILE_NAME} JSON Schema:`, packJsonSchemaText(), 'Panel bridge messages JSON Schema:', packBridgeJsonSchemaText(), 'Panel action requests JSON Schema, by request.type:', panelActionsJsonSchemaText()]), hasProblem: false };
  if (request.command === 'list') {
    const rows = deps.packRows();
    return { text: rows.length === 0 ? `No packs are installed; ${path.join(deps.homeDir, PACKS_DIR_NAME)} holds none and config.json lists none.` : rows.flatMap(rowLines).join('\n'), hasProblem: rows.some((row) => row.errors.length > 0) };
  }
  const report = await checkPack(request.path ?? '', deps.env, deps.isApproved);
  return { text: packReportText(report), hasProblem: packCheckHasProblem(report) };
}
