const LINUX_SANDBOX_BINARIES: readonly string[] = Object.freeze(['bwrap', 'socat']);
const NO_SANDBOX_BINARIES: readonly string[] = Object.freeze([]);

const SANDBOX_INSTALL_HINT = 'Install bubblewrap and socat, for example: sudo apt install bubblewrap socat';

const SANDBOXED_LANE_NAMES: readonly string[] = Object.freeze(['team review', 'Keep mergeable repairs', 'workflow sessions', 'benchmark runs']);

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

function missingBinariesPhrase(report: SandboxDependencyReport): string {
  return `${report.missingBinaries.join(' and ')} ${report.missingBinaries.length === 1 ? 'is' : 'are'} not on PATH`;
}

function sandboxSpawnRefusal(report: SandboxDependencyReport): string | null {
  if (report.missingBinaries.length === 0) return null;
  return `not started: the Claude Code sandbox needs ${report.requiredBinaries.join(' and ')}, and ${missingBinariesPhrase(report)}. ${report.installHint}`;
}

function sandboxBootWarning(report: SandboxDependencyReport): string | null {
  if (report.missingBinaries.length === 0) return null;
  return `[sandbox] ${missingBinariesPhrase(report)}, so ${SANDBOXED_LANE_NAMES.join(', ')} will refuse to start sandboxed sessions. ${report.installHint}`;
}

function sandboxDoctorRows(report: SandboxDependencyReport): [string, string][] {
  if (report.requiredBinaries.length === 0) return [['sandbox', `nothing to check on ${report.platform}`]];
  const binaryRows: [string, string][] = report.requiredBinaries.map((binary) => [binary, report.missingBinaries.includes(binary) ? 'MISSING' : 'found']);
  if (report.installHint === null) return binaryRows;
  return [...binaryRows, ['hint', report.installHint]];
}

function sandboxInstallNotice(report: SandboxDependencyReport): string | null {
  if (report.installHint === null) return null;
  return `glimmervoid: ${missingBinariesPhrase(report)}; team review, Keep mergeable, workflow sessions and benchmark runs need ${report.requiredBinaries.join(' and ')}. ${report.installHint}`;
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
