import { resolvePathCommandMatches } from '../session/core/spawn-command.ts';
import { execSync } from './child-process-safe.ts';
import { requiredSandboxBinaries, sandboxBootWarning, sandboxDependencyReport, sandboxSpawnRefusal } from './core/sandbox-deps-core.ts';
import type { SandboxDependencyReport } from './core/sandbox-deps-core.ts';

type SandboxSpawnRefusal = () => string | null;

function probeSandboxDependencies({ platform = process.platform, exec = execSync }: { platform?: NodeJS.Platform; exec?: typeof execSync } = {}): SandboxDependencyReport {
  const binariesOnPath = new Set(requiredSandboxBinaries(platform).filter((binary) => resolvePathCommandMatches(binary, { platform, exec }).length > 0));
  return sandboxDependencyReport({ platform, binariesOnPath });
}

function checkSandboxDependencies({ probe = probeSandboxDependencies, log = console }: { probe?: () => SandboxDependencyReport; log?: Pick<Console, 'warn'> } = {}): SandboxSpawnRefusal {
  const report = probe();
  const warning = sandboxBootWarning(report);
  if (warning !== null) log.warn(warning);
  const refusal = sandboxSpawnRefusal(report);
  return () => refusal;
}

const allowSandboxedSpawn: SandboxSpawnRefusal = () => null;

export { allowSandboxedSpawn, checkSandboxDependencies, probeSandboxDependencies };
export type { SandboxSpawnRefusal };
