import { execFileSync } from '../child-process-safe.ts';
import { gitBootWarning, gitVersionReport } from './core/git-version-core.ts';
import type { GitVersionReport } from './core/git-version-core.ts';

function readGitVersionOutput(): string {
  return execFileSync('git', ['--version'], { encoding: 'utf8', timeout: 3000 });
}

function probeGitVersion({ readVersionOutput = readGitVersionOutput }: { readVersionOutput?: () => string } = {}): GitVersionReport {
  try {
    return gitVersionReport(readVersionOutput());
  } catch {
    return gitVersionReport(null);
  }
}

function warnWhenGitIsTooOld({ probe = probeGitVersion, log = console }: { probe?: () => GitVersionReport; log?: Pick<Console, 'warn'> } = {}): void {
  const warning = gitBootWarning(probe());
  if (warning !== null) log.warn(warning);
}

export { probeGitVersion, warnWhenGitIsTooOld };
