import path from 'node:path';
import { expandPlaceholders, packApproval, prFlowsPacksOf, unknownActionWarnings } from '../github/core/pr-flows-core.ts';
import { panelReferenceErrors, uiSectionErrors, undeclaredSubscriptionErrors } from './core/pack-core.ts';
import { declaredPanelReads, readPackDir } from './pack-files.ts';

const SOURCE_PLACEHOLDERS = ['prUrl', 'repo', 'number', 'head'];
const ACTION_PLACEHOLDERS = [...SOURCE_PLACEHOLDERS, 'itemPath', 'itemLine'];
export const PR_FLOW_PLACEHOLDERS_BY_KIND = { source: SOURCE_PLACEHOLDERS, action: ACTION_PLACEHOLDERS, 'pr-action': [...SOURCE_PLACEHOLDERS, 'headRef', 'baseRef'] } as const;

type PackEntryCheck = { kind: keyof typeof PR_FLOW_PLACEHOLDERS_BY_KIND; id: string; label: string; argv: string[]; error: string | null };
type PackCheckReport = {
  packDir: string; name: string | null; isApproved: boolean; errors: string[]; missingRequires: string[]; entries: PackEntryCheck[]; rules: string[]; panels: string[]; themes: string[];
};

function pageErrors(filesByPath: ReadonlyMap<string, Buffer>, header: { ui?: unknown } | undefined): string[] {
  const declaredReads = header ? declaredPanelReads(header.ui) : null;
  return [...panelReferenceErrors(filesByPath), ...(declaredReads ? undeclaredSubscriptionErrors(filesByPath, declaredReads) : [])];
}

export async function checkPack(packDir: string, env: NodeJS.ProcessEnv, isApprovedFingerprint: (fingerprint: string) => boolean): Promise<PackCheckReport> {
  const read = await readPackDir(packDir, env);
  if (!read.ok) {
    const name = read.header ? `${read.header.name} v${read.header.version}` : null;
    return { packDir: path.resolve(packDir), name, isApproved: false, errors: [...read.errors, ...pageErrors(read.filesByPath ?? new Map(), read.header)], missingRequires: [], entries: [], rules: [], panels: [], themes: [] };
  }
  const { pack } = read;
  const { prFlowsPacks, warnings: prFlowsErrors } = prFlowsPacksOf([pack]);
  const ui = pack.ui?.ok ? pack.ui.value : { panels: [], themes: [] };
  const report = {
    packDir: pack.dir, name: `${pack.header.name} v${pack.header.version}`, isApproved: isApprovedFingerprint(pack.fingerprint),
    errors: [...prFlowsErrors, ...uiSectionErrors(pack), ...pageErrors(pack.filesByPath, pack.header)], missingRequires: pack.missingRequires, entries: [], rules: [],
    panels: ui.panels.map((panel) => `${panel.id} (${panel.label}) opens ${panel.entry}${panel.reads.length === 0 ? ', reads nothing' : `, reads ${panel.reads.join(', ')}`}`),
    themes: ui.themes.map((theme) => `${theme.id} (${theme.label}, ${theme.mode})`),
  };
  const [prFlowsPack] = prFlowsPacks;
  if (!prFlowsPack) return report;
  const approval = packApproval(prFlowsPack);
  const entries = (approval.pack?.commands ?? []).map((command): PackEntryCheck => {
    const names = PR_FLOW_PLACEHOLDERS_BY_KIND[command.kind];
    const expanded = expandPlaceholders(command.command, Object.fromEntries(names.map((placeholderName) => [placeholderName, `{${placeholderName}}`])));
    const error = expanded.ok ? null : `{${expanded.unknown}} is not a placeholder here; use {packDir}, ${names.map((placeholderName) => `{${placeholderName}}`).join(', ')}`;
    return { kind: command.kind, id: command.id, label: command.label, argv: command.command, error };
  });
  const { section } = prFlowsPack;
  return { ...report, errors: [...report.errors, ...unknownActionWarnings(section.rules, new Set(section.actions.map((action) => action.id)))], entries, rules: approval.pack?.rules ?? [] };
}

export function packCheckHasProblem(report: PackCheckReport): boolean {
  return report.errors.length > 0 || report.missingRequires.length > 0 || report.entries.some((entry) => entry.error !== null);
}

function reportHeading(report: PackCheckReport): string {
  const checked = report.name === null ? `Checked the pack at ${report.packDir}` : `Checked pack ${report.name} at ${report.packDir}`;
  if (packCheckHasProblem(report)) return `${checked}: fix the problems below, then check it again`;
  return `${checked}: no problems; ${report.isApproved ? 'it is approved' : 'once installed, it waits for the operator to approve it in Settings, Packs'}`;
}

export function packReportText(report: PackCheckReport): string {
  return [
    reportHeading(report),
    ...report.panels.map((panel) => `panel ${panel}`),
    ...report.themes.map((theme) => `theme ${theme}`),
    ...report.entries.map((entry) => `${entry.kind} ${entry.id} (${entry.label}): ${entry.error === null ? `valid\n  would run ${JSON.stringify(entry.argv)}` : `invalid, ${entry.error}`}`),
    ...report.rules.map((rule) => `rule ${rule}`),
    ...report.errors.map((error) => `error: ${error}`),
    ...report.missingRequires.map((missing) => `missing on this machine: ${missing}, so the pack stays off here`),
  ].join('\n');
}
