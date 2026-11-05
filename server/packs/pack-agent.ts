import fs from 'node:fs';
import path from 'node:path';
import { packBridgeJsonSchemaText } from '../../shared/contracts/pack-bridge.ts';
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
    '- ui.panels: HTML pages shown as dashboard tabs. A panel runs sandboxed in an opaque origin: no network, no cookies, no storage, no popups or navigation (a link in a panel opens nothing), no access to the dashboard page. Put every script, style, image and font in the pack; inline <script> and <style> work too. Every panel file is served with this Content-Security-Policy:',
    `  ${PACK_PANEL_CONTENT_POLICY}`,
    '',
    'Panel bridge: list the topics a panel needs under its reads in pack.json; the operator sees them before approving. The panel posts {"v":1,"kind":"subscribe","topics":[...]} to window.parent and gets {"v":1,"kind":"hello","granted":[...]}: the subscribed topics that are also in reads, so a topic left out of reads never arrives. Then a {"v":1,"kind":"topic","topic":...,"data":...} message comes for each granted topic, right away and again whenever it changes. Accept messages only when event.source === window.parent. The descriptions in the bridge JSON Schema below give each field\'s units and meaning.',
    'Each example panel ships the same bridge.js; copy it beside your panel and load it before your own script. It defines window.glimmervoid.subscribe(topics, onTopic) (it calls onTopic("hello", granted) once, then onTopic(topic, data) per topic message), applyTheme(themeData) (pass it the theme topic data; it sets every color as a CSS custom property on the root, such as var(--bg) or var(--state-running)) and element(tag, className, text).',
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
    ...row.panels.map((panel) => `  panel ${panel.id} (${panel.label})${panel.reads.length === 0 ? '' : `, reads ${panel.reads.join(', ')}`}`),
    ...row.themes.map((theme) => `  theme ${theme.id} (${theme.label}, ${theme.mode})`),
    ...row.missingRequires.map((missing) => `  missing on this machine: ${missing}`),
    ...row.errors.map((error) => `  error: ${error}`),
  ];
}

export async function readPacksForAgent(request: AgentPacksRequest, deps: PackAgentDeps): Promise<PacksReadout> {
  if (request.command === 'guide') return { text: await packGuideText(deps, [`${PACK_FILE_NAME} JSON Schema:`, packJsonSchemaText(), 'Panel bridge messages JSON Schema:', packBridgeJsonSchemaText()]), hasProblem: false };
  if (request.command === 'list') {
    const rows = deps.packRows();
    return { text: rows.length === 0 ? `No packs are installed; ${path.join(deps.homeDir, PACKS_DIR_NAME)} holds none and config.json lists none.` : rows.flatMap(rowLines).join('\n'), hasProblem: rows.some((row) => row.errors.length > 0) };
  }
  const report = await checkPack(request.path ?? '', deps.env, deps.isApproved);
  return { text: packReportText(report), hasProblem: packCheckHasProblem(report) };
}
