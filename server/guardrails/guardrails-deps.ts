import { resolvePathCommandMatches } from '../../session/core/spawn-command.ts';
import { execSync } from '../child-process-safe.ts';
import { requiredGuardrailsBinaries, guardrailsBootWarning, guardrailsDependencyReport, guardrailsSpawnRefusal } from './core/guardrails-deps-core.ts';
import type { GuardrailsDependencyReport } from './core/guardrails-deps-core.ts';

type GuardrailsSpawnRefusal = () => string | null;

function probeGuardrailsDependencies({ platform = process.platform, exec = execSync }: { platform?: NodeJS.Platform; exec?: typeof execSync } = {}): GuardrailsDependencyReport {
  const binariesOnPath = new Set(requiredGuardrailsBinaries(platform).filter((binary) => resolvePathCommandMatches(binary, { platform, exec }).length > 0));
  return guardrailsDependencyReport({ platform, binariesOnPath });
}

function checkGuardrailsDependencies({ probe = probeGuardrailsDependencies, log = console }: { probe?: () => GuardrailsDependencyReport; log?: Pick<Console, 'warn'> } = {}): GuardrailsSpawnRefusal {
  const report = probe();
  const warning = guardrailsBootWarning(report);
  if (warning !== null) log.warn(warning);
  const refusal = guardrailsSpawnRefusal(report);
  return () => refusal;
}

const allowGuardedSpawn: GuardrailsSpawnRefusal = () => null;

export { allowGuardedSpawn, checkGuardrailsDependencies, probeGuardrailsDependencies };
export type { GuardrailsSpawnRefusal };
