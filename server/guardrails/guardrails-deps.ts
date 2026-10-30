import { resolvePathCommandMatches } from '../../session/core/spawn-command.ts';
import { execSync } from '../child-process-safe.ts';
import { requiredGuardrailsBinaries, guardrailsDependencyReport } from './core/guardrails-deps-core.ts';
import type { GuardrailsDependencyReport } from './core/guardrails-deps-core.ts';

function probeGuardrailsDependencies({ platform = process.platform, exec = execSync }: { platform?: NodeJS.Platform; exec?: typeof execSync } = {}): GuardrailsDependencyReport {
  const binariesOnPath = new Set(requiredGuardrailsBinaries(platform).filter((binary) => resolvePathCommandMatches(binary, { platform, exec }).length > 0));
  return guardrailsDependencyReport({ platform, binariesOnPath });
}

export { probeGuardrailsDependencies };
