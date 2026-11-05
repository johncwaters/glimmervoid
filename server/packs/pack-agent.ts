import fs from 'node:fs';
import path from 'node:path';
import { packBridgeJsonSchemaText } from '../../shared/contracts/pack-bridge.ts';
import { PACK_FILE_NAME, PackHeader, packJsonSchemaText } from '../../shared/contracts/pack.ts';
import type { PackRow } from '../../shared/contracts/control/pack-messages.ts';
import type { AgentPacksRequest } from '../../shared/contracts/session.ts';
import { parseJsonOrNull } from '../core/json-core.ts';
import { checkPack, packCheckHasProblem, packReportText } from './pack-check.ts';
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

async function guideText({ homeDir, examplePacksDir }: PackAgentDeps): Promise<string> {
  return [
    'Glimmervoid packs',
    '',
    `A pack is a folder holding a ${PACK_FILE_NAME} and the files it names, at most 1 MiB in all and without symlinks. Install one by placing its folder under ${path.join(homeDir, PACKS_DIR_NAME)}, or by listing its path under "packs" in Glimmervoid's config.json.`,
    'Nothing in a pack runs or shows until the operator approves it in Settings, Packs, and any change to any file in it asks again. Never approve a pack for the operator; check it, then tell them it waits for approval.',
    '',
    'Sections of pack.json, each checked on its own:',
    '- prFlows: commands My PRs runs on pull requests (prActions, sources, actions, rules).',
    '- ui.themes: color themes for the Theme picker; every chrome and state color is a #rrggbb hex.',
    '- ui.panels: HTML pages shown as dashboard tabs. A panel runs sandboxed in an opaque origin: no network (connect-src none), no cookies, no storage, no popups or navigation (a link in a panel opens nothing), no access to the dashboard page. Put every script, style and image in the pack, or inline.',
    '',
    'Panel bridge: a panel lists the topics it reads under reads, then posts {"v":1,"kind":"subscribe","topics":[...]} to window.parent. It receives {"v":1,"kind":"hello","granted":[...]} with the topics it was granted, then {"v":1,"kind":"topic","topic":...,"data":...} for each one now and whenever it changes. Accept messages only when event.source === window.parent. Restyle from the theme topic, whose colors are CSS custom properties such as --bg and --text.',
    '',
    'Examples to copy and adapt:',
    ...await exampleLines(examplePacksDir),
    '',
    'Check a pack folder before handing it over: glimmervoid packs check <folder>, or the packs tool with action check.',
    '',
    `${PACK_FILE_NAME} JSON Schema:`,
    packJsonSchemaText(),
    'Panel bridge messages JSON Schema:',
    packBridgeJsonSchemaText(),
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
  if (request.command === 'guide') return { text: await guideText(deps), hasProblem: false };
  if (request.command === 'list') {
    const rows = deps.packRows();
    return { text: rows.length === 0 ? `No packs are installed; ${path.join(deps.homeDir, PACKS_DIR_NAME)} holds none and config.json lists none.` : rows.flatMap(rowLines).join('\n'), hasProblem: rows.some((row) => row.errors.length > 0) };
  }
  const report = await checkPack(request.path ?? '', deps.env, deps.isApproved);
  return { text: packReportText(report), hasProblem: packCheckHasProblem(report) };
}
