import path from 'node:path';
import { PR_FLOW_PLACEHOLDERS_BY_KIND } from '../../shared/contracts/pr-flows.ts';
import { packSkillNameOf } from '../../shared/contracts/pack.ts';
import type { PackOnDisk } from '../../shared/contracts/pack.ts';
import { expandPlaceholders, packApproval, packRuleErrors, prFlowsPacksOf, unknownPlaceholderMessage } from '../github/core/pr-flows-core.ts';
import { panelReferenceErrors, packSectionErrors, undeclaredSubscriptionErrors } from './core/pack-core.ts';
import { declaredPanels, readPackDir } from './pack-files.ts';


type PackEntryCheck = { kind: keyof typeof PR_FLOW_PLACEHOLDERS_BY_KIND; id: string; label: string; argv: string[]; repos: string[] | null; error: string | null };
type PackCheckReport = {
  packDir: string; name: string | null; isApproved: boolean; errors: string[]; missingRequires: string[]; entries: PackEntryCheck[]; rules: string[]; panels: string[]; themes: string[]; agent: string[];
};

function pageErrors(filesByPath: ReadonlyMap<string, Buffer>, header: { ui?: unknown } | undefined): string[] {
  return [...panelReferenceErrors(filesByPath), ...undeclaredSubscriptionErrors(filesByPath, header ? declaredPanels(header.ui) : [])];
}

function agentReportLines(pack: PackOnDisk): string[] {
  if (!pack.agent?.ok) return [];
  const { context, skills } = pack.agent.value;
  return [
    ...(context === undefined ? [] : [`agent context ${context}, named on every session's first prompt`]),
    ...skills.map((skillFolder) => `agent skill ${skillFolder}, /${pack.header.name}:${packSkillNameOf(skillFolder)} on Claude Code and ${pack.header.name}-${packSkillNameOf(skillFolder)} on Codex and Kimi Code`),
  ];
}

export async function checkPack(packDir: string, env: NodeJS.ProcessEnv, isApprovedFingerprint: (fingerprint: string) => boolean): Promise<PackCheckReport> {
  const read = await readPackDir(packDir, env);
  if (!read.ok) {
    const name = read.header ? `${read.header.name} v${read.header.version}` : null;
    return { packDir: path.resolve(packDir), name, isApproved: false, errors: [...read.errors, ...pageErrors(read.filesByPath ?? new Map(), read.header)], missingRequires: [], entries: [], rules: [], panels: [], themes: [], agent: [] };
  }
  const { pack } = read;
  const { prFlowsPacks, warnings: prFlowsErrors } = prFlowsPacksOf([pack]);
  const ui = pack.ui?.ok ? pack.ui.value : { panels: [], themes: [] };
  const report = {
    packDir: pack.dir, name: `${pack.header.name} v${pack.header.version}`, isApproved: isApprovedFingerprint(pack.fingerprint),
    errors: [...prFlowsErrors, ...packSectionErrors(pack), ...pageErrors(pack.filesByPath, pack.header)], missingRequires: pack.missingRequires, entries: [], rules: [],
    panels: ui.panels.map((panel) => `${panel.id} (${panel.label}) opens ${panel.entry}${panel.reads.length === 0 ? ', reads nothing' : `, reads ${panel.reads.join(', ')}`}${panel.acts.length === 0 ? '' : `, acts on ${panel.acts.join(', ')}`}`),
    themes: ui.themes.map((theme) => `${theme.id} (${theme.label}, ${theme.mode})`),
    agent: agentReportLines(pack),
  };
  const [prFlowsPack] = prFlowsPacks;
  if (!prFlowsPack) return report;
  const approval = packApproval(prFlowsPack);
  const entries = (approval.pack?.commands ?? []).map((command): PackEntryCheck => {
    const names = PR_FLOW_PLACEHOLDERS_BY_KIND[command.kind];
    const expanded = expandPlaceholders(command.command, Object.fromEntries(names.map((placeholderName) => [placeholderName, `{${placeholderName}}`])));
    const error = expanded.ok ? null : unknownPlaceholderMessage(command.kind, expanded.unknown);
    return { kind: command.kind, id: command.id, label: command.label, argv: command.command, repos: command.repos ?? null, error };
  });
  return { ...report, errors: [...report.errors, ...packRuleErrors(prFlowsPack.section, pack.header.name)], entries, rules: approval.pack?.rules ?? [] };
}

export function packCheckHasProblem(report: PackCheckReport): boolean {
  return report.errors.length > 0 || report.entries.some((entry) => entry.error !== null);
}

function reportHeading(report: PackCheckReport): string {
  const checked = report.name === null ? `Checked the pack at ${report.packDir}` : `Checked pack ${report.name} at ${report.packDir}`;
  if (packCheckHasProblem(report)) return `${checked}: fix the problems below, then check it again`;
  return `${checked}: no problems; ${report.isApproved ? 'it is approved' : 'once installed, it waits for the operator to approve it in Settings, Packs'}`;
}

function entryReach(entry: PackEntryCheck): string {
  if (entry.kind === 'action') return ', on the repositories of the rules that name it';
  if (entry.repos === null) return ', on every repository';
  return `, limited to ${entry.repos.join(', ')}`;
}

function entryLine(entry: PackEntryCheck): string {
  const heading = `${entry.kind} ${entry.id} (${entry.label}): `;
  if (entry.error !== null) return `${heading}invalid, ${entry.error}`;
  return `${heading}valid${entryReach(entry)}\n  would run ${JSON.stringify(entry.argv)}`;
}

export function packReportText(report: PackCheckReport): string {
  return [
    reportHeading(report),
    ...report.panels.map((panel) => `panel ${panel}`),
    ...report.themes.map((theme) => `theme ${theme}`),
    ...report.agent,
    ...report.entries.map(entryLine),
    ...report.rules.map((rule) => `rule ${rule}`),
    ...report.errors.map((error) => `error: ${error}`),
    ...report.missingRequires.map((missing) => `missing on this machine: ${missing}, so the pack stays off here until it has it; not a problem in the pack`),
  ].join('\n');
}
