const LINUX_GUARDRAILS_BINARIES: readonly string[] = Object.freeze(['bwrap', 'socat', 'rg']);
const NO_GUARDRAILS_BINARIES: readonly string[] = Object.freeze([]);

const GUARDRAILS_INSTALL_HINT = 'Install bubblewrap, socat and ripgrep, for example: sudo apt install bubblewrap socat ripgrep';

const GUARDED_WORK = 'guarded sessions';

interface GuardrailsDependencyReport {
  platform: NodeJS.Platform;
  requiredBinaries: readonly string[];
  missingBinaries: readonly string[];
  installHint: string | null;
}

function requiredGuardrailsBinaries(platform: NodeJS.Platform): readonly string[] {
  return platform === 'linux' ? LINUX_GUARDRAILS_BINARIES : NO_GUARDRAILS_BINARIES;
}

function guardrailsDependencyReport({ platform, binariesOnPath }: { platform: NodeJS.Platform; binariesOnPath: ReadonlySet<string> }): GuardrailsDependencyReport {
  const requiredBinaries = requiredGuardrailsBinaries(platform);
  const missingBinaries = requiredBinaries.filter((binary) => !binariesOnPath.has(binary));
  return { platform, requiredBinaries, missingBinaries, installHint: missingBinaries.length > 0 ? GUARDRAILS_INSTALL_HINT : null };
}

function namesList(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

function missingBinariesPhrase(report: GuardrailsDependencyReport): string {
  return `${namesList(report.missingBinaries)} ${report.missingBinaries.length === 1 ? 'is' : 'are'} not on PATH`;
}

function guardrailsSpawnRefusal(report: GuardrailsDependencyReport): string | null {
  if (report.missingBinaries.length === 0) return null;
  return `not started: the guardrails need ${namesList(report.requiredBinaries)}, and ${missingBinariesPhrase(report)}. ${report.installHint}`;
}

function guardrailsBootWarning(report: GuardrailsDependencyReport): string | null {
  if (report.missingBinaries.length === 0) return null;
  return `[guardrails] ${missingBinariesPhrase(report)}, so ${GUARDED_WORK} will refuse to start. ${report.installHint}`;
}

function guardrailsDoctorRows(report: GuardrailsDependencyReport): [string, string][] {
  if (report.requiredBinaries.length === 0) return [['guardrails', `nothing to check on ${report.platform}`]];
  const binaryRows: [string, string][] = report.requiredBinaries.map((binary) => [binary, report.missingBinaries.includes(binary) ? 'MISSING' : 'found']);
  if (report.installHint === null) return binaryRows;
  return [...binaryRows, ['hint', report.installHint]];
}

function guardrailsInstallNotice(report: GuardrailsDependencyReport): string | null {
  if (report.installHint === null) return null;
  return `glimmervoid: ${missingBinariesPhrase(report)}; ${GUARDED_WORK} need ${namesList(report.requiredBinaries)}. ${report.installHint}`;
}

export { requiredGuardrailsBinaries, guardrailsBootWarning, guardrailsDependencyReport, guardrailsDoctorRows, guardrailsInstallNotice, guardrailsSpawnRefusal };
export type { GuardrailsDependencyReport };
