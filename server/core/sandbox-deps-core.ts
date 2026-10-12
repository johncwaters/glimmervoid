const LINUX_SANDBOX_BINARIES: readonly string[] = Object.freeze(['bwrap', 'socat', 'rg']);
const NO_SANDBOX_BINARIES: readonly string[] = Object.freeze([]);

const SANDBOX_INSTALL_HINT = 'Install bubblewrap, socat and ripgrep, for example: sudo apt install bubblewrap socat ripgrep';

const SANDBOXED_WORK = 'sandboxed sessions and factory checks';

interface SandboxDependencyReport {
  platform: NodeJS.Platform;
  requiredBinaries: readonly string[];
  missingBinaries: readonly string[];
  installHint: string | null;
}

function requiredSandboxBinaries(platform: NodeJS.Platform): readonly string[] {
  return platform === 'linux' ? LINUX_SANDBOX_BINARIES : NO_SANDBOX_BINARIES;
}

function sandboxDependencyReport({ platform, binariesOnPath }: { platform: NodeJS.Platform; binariesOnPath: ReadonlySet<string> }): SandboxDependencyReport {
  const requiredBinaries = requiredSandboxBinaries(platform);
  const missingBinaries = requiredBinaries.filter((binary) => !binariesOnPath.has(binary));
  return { platform, requiredBinaries, missingBinaries, installHint: missingBinaries.length > 0 ? SANDBOX_INSTALL_HINT : null };
}

function namesList(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

function missingBinariesPhrase(report: SandboxDependencyReport): string {
  return `${namesList(report.missingBinaries)} ${report.missingBinaries.length === 1 ? 'is' : 'are'} not on PATH`;
}

function sandboxSpawnRefusal(report: SandboxDependencyReport): string | null {
  if (report.missingBinaries.length === 0) return null;
  return `not started: the sandbox needs ${namesList(report.requiredBinaries)}, and ${missingBinariesPhrase(report)}. ${report.installHint}`;
}

function sandboxBootWarning(report: SandboxDependencyReport): string | null {
  if (report.missingBinaries.length === 0) return null;
  return `[sandbox] ${missingBinariesPhrase(report)}, so ${SANDBOXED_WORK} will refuse to start. ${report.installHint}`;
}

function sandboxDoctorRows(report: SandboxDependencyReport): [string, string][] {
  if (report.requiredBinaries.length === 0) return [['sandbox', `nothing to check on ${report.platform}`]];
  const binaryRows: [string, string][] = report.requiredBinaries.map((binary) => [binary, report.missingBinaries.includes(binary) ? 'MISSING' : 'found']);
  if (report.installHint === null) return binaryRows;
  return [...binaryRows, ['hint', report.installHint]];
}

function sandboxInstallNotice(report: SandboxDependencyReport): string | null {
  if (report.installHint === null) return null;
  return `glimmervoid: ${missingBinariesPhrase(report)}; ${SANDBOXED_WORK} need ${namesList(report.requiredBinaries)}. ${report.installHint}`;
}

export {
  SANDBOX_INSTALL_HINT,
  requiredSandboxBinaries,
  sandboxBootWarning,
  sandboxDependencyReport,
  sandboxDoctorRows,
  sandboxInstallNotice,
  sandboxSpawnRefusal,
};
export type { SandboxDependencyReport };
