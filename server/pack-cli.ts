import path from 'node:path';

import { DEFAULT_AGENT_ID, commandFor } from '../session/adapters/index.ts';
import { loadConfigFile, resolveConfigPath } from './config-store.ts';
import { renderMeterTrack, renderTable } from './core/ascii-figure-core.ts';
import { packVariantProjects } from './core/pack-core.ts';
import {
  buildPacks, defaultBuiltRoot, defaultSpecsDir, describePackSpec, listPackSpecs, readBuiltManifest,
} from './pack-builder.ts';
import { createPackDistiller } from './pack-distiller.ts';
import type { PackDistiller } from './pack-distiller.ts';
import { formatTimestamp, shortVersion } from './text-format.ts';

const USAGE = [
  'Usage: glimmervoid pack <command>',
  '',
  'Commands:',
  '  build [name]     Build one pack, or every spec when no name is given',
  '  list             Show every spec and the version currently built from it',
  '  distill [name]   Regenerate derived pack sources whose sources drifted',
  '                   --dry-run reports what would be distilled and spawns nothing',
].join('\n');

function variantProjects() {
  try {
    return packVariantProjects(loadConfigFile(resolveConfigPath(), { exitOnError: false }).config);
  } catch {
    return [];
  }
}

async function runBuild(name: string | null): Promise<number> {
  const reports = await buildPacks({ name, projects: variantProjects() });
  if (reports.length === 0) {
    console.log(`No pack specs in ${defaultSpecsDir()}.`);
    return 0;
  }
  const rows = reports.map((report) => {
    if (!report.ok) return [report.name, 'FAILED', '-', '-', '-'];
    const budget = report.budgetTokens;
    const tokensAgainstBudget = budget === null
      ? String(report.tokenEstimate)
      : `${renderMeterTrack(budget > 0 ? report.tokenEstimate / budget : 0, 12)} ${report.tokenEstimate}/${budget}`;
    return [report.name, 'ok', shortVersion(report.version), String(report.fileCount), tokensAgainstBudget];
  });
  console.log(renderTable({
    title: 'Pack build',
    headers: ['NAME', 'STATUS', 'VERSION', 'FILES', 'TOKENS / BUDGET'],
    rows,
    align: ['left', 'left', 'left', 'right', 'left'],
    terminalColumns: process.stdout.columns,
  }));
  const failedReports = reports.filter((report) => !report.ok);
  for (const report of failedReports) {
    for (const error of report.errors) console.error(`${report.name}: ${error}`);
  }
  const failed = failedReports.length;
  if (failed > 0) {
    console.error(`\n${failed} pack(s) failed to build. Nothing was written for those.`);
    return 1;
  }
  console.log(`\nBuilt into ${defaultBuiltRoot()}`);
  return 0;
}

async function runList(): Promise<number> {
  const specs = await listPackSpecs();
  const first = specs[0];
  if (specs.length === 0 || !first) {
    console.log(`No pack specs in ${defaultSpecsDir()}.`);
    return 0;
  }
  const rows: string[][] = [];
  for (const spec of specs) {
    const described = await describePackSpec(spec.specPath);
    const manifest = await readBuiltManifest(spec.name);
    const version = described.valid ? shortVersion(manifest ? manifest.version : null) : 'INVALID SPEC';
    rows.push([
      spec.name,
      String(described.sourceCount),
      String(described.budgetTokens === null ? '-' : described.budgetTokens),
      version,
      formatTimestamp(manifest ? manifest.builtAt : null),
    ]);
  }
  console.log(renderTable({
    title: 'Packs',
    headers: ['NAME', 'SOURCES', 'BUDGET', 'BUILT VERSION', 'BUILT AT'],
    rows,
    align: ['left', 'right', 'right', 'left', 'left'],
    terminalColumns: process.stdout.columns,
  }));
  console.log(`\nSpecs: ${path.dirname(first.specPath)}\nBuilt: ${defaultBuiltRoot()}`);
  return 0;
}

const DISTILL_STATUS_LABEL: Record<string, string | undefined> = {
  current: 'current',
  stale: 'STALE (dry run, nothing spawned)',
  distilled: 'distilled',
  error: 'ERROR',
};

async function runDistill(
  name: string | null,
  { dryRun }: { dryRun: boolean },
  makeDistiller: () => PackDistiller,
): Promise<number> {
  if (!dryRun) {
    const resolved = commandFor(DEFAULT_AGENT_ID);
    if (!resolved || !resolved.path) {
      console.error("Cannot distill: 'claude' is not resolvable on PATH. Install Claude Code, or use --dry-run.");
      return 1;
    }
  }

  const distiller = makeDistiller();
  const reports = await distiller.runOnce({ name, dryRun });
  await distiller.stop();

  if (reports.length === 0) {
    console.log(name ? `No distill entries in a spec named "${name}".` : 'No pack spec declares a distill entry.');
    return 0;
  }
  let failed = 0;
  for (const report of reports) {
    const label = DISTILL_STATUS_LABEL[report.status] || report.status;
    console.log(`${String(report.pack).padEnd(24)}${label}  ${report.output || ''}`.trimEnd());
    if (report.reason) console.log(`  ${report.reason}`);
    if (report.summary) console.log(`  ${report.summary}`);
    if (report.status === 'error') failed += 1;
  }
  if (failed > 0) {
    console.error(`\n${failed} distill entr(y/ies) failed. Nothing was accepted for those.`);
    return 1;
  }
  return 0;
}

async function runPackCli(
  args: string[],
  deps: { makeDistiller?: () => PackDistiller } = {},
): Promise<number> {
  const { makeDistiller = () => createPackDistiller({ enabled: true }) } = deps;
  const command = args[0];
  const rest = args.slice(1).filter((arg) => arg !== '--dry-run');
  if (command === 'build') return runBuild(rest[0] || null);
  if (command === 'list') return runList();
  if (command === 'distill') {
    return runDistill(rest[0] || null, { dryRun: args.includes('--dry-run') }, makeDistiller);
  }
  console.error(USAGE);
  return 1;
}

export { USAGE, runPackCli };
