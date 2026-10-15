import type { ProjectConfig } from '../../../shared/contracts/config.ts';
import { DEFAULT_WIDENABLE_SCOPES } from './factory-profile-core.ts';

export type FactorySetupProposal = {
  checks: string[];
  focusedTestCommandCandidates: string[];
  widenableScopes: string[];
};

export type FactorySetupResult = { ok: true; profile: NonNullable<ProjectConfig['factoryProfile']> } | { ok: false; reason: string };

export type FactorySetupCheckProof = { command: string; status: 'ran' | 'could-not-run'; pass: boolean; output: string };

const PACKAGE_MANAGERS = [
  { lockfiles: ['npm-shrinkwrap.json', 'package-lock.json'], prefix: 'npm run', test: 'npm test' },
  { lockfiles: ['pnpm-lock.yaml'], prefix: 'pnpm run', test: 'pnpm run test' },
  { lockfiles: ['yarn.lock'], prefix: 'yarn', test: 'yarn test' },
  { lockfiles: ['bun.lockb', 'bun.lock'], prefix: 'bun run', test: 'bun run test' },
];

const FOCUSED_RUNNERS = [
  { dependency: 'vitest', command: 'npx vitest run' },
  { dependency: 'jest', command: 'npx jest' },
  { dependency: 'mocha', command: 'npx mocha' },
];

export function detectFactorySetup({ scripts, lockfiles, dependencies, globalChecks }: {
  scripts: Record<string, unknown> | null;
  lockfiles: readonly string[];
  dependencies: readonly string[];
  globalChecks?: readonly string[];
}): FactorySetupProposal {
  const packageManager = PACKAGE_MANAGERS.find((manager) => manager.lockfiles.some((lockfile) => lockfiles.includes(lockfile))) ?? PACKAGE_MANAGERS[0];
  const hasScript = (name: string) => typeof scripts?.[name] === 'string' && String(scripts[name]).trim().length > 0;
  const checks = globalChecks === undefined
    ? ['typecheck', 'lint', 'test'].filter(hasScript).map((name) => name === 'test' ? packageManager.test : `${packageManager.prefix} ${name}`)
    : [...globalChecks];
  return {
    checks,
    focusedTestCommandCandidates: [
      ...(hasScript('test:files') ? [`${packageManager.prefix} test:files`] : []),
      ...FOCUSED_RUNNERS.filter((runner) => dependencies.includes(runner.dependency)).map((runner) => runner.command),
    ],
    widenableScopes: [...DEFAULT_WIDENABLE_SCOPES],
  };
}

const TEST_RESULT_LINE = /^[ \t]*(?:not )?ok \d+\b|^# tests \d+\b/m;
const SHELL_NOT_FOUND_LINE = /^(?:\/[^\s:]*\/)?(?:sh|bash|dash|ash|zsh)(?:: (?:line )?\d+)?: [^\n]*?: (?:command )?not found/m;
const LAUNCH_FAILURE_LINE = /(?:^|\n)(?:Error: )?(?:spawn[^\n]*\b(?:ENOENT|EACCES|EPERM|failed|error)\b|(?:npm (?:error|ERR!) )?missing script:|(?:error )?(?:script|command)[^\n]*(?:not found|does not exist|not recognized)|Check command contains shell syntax or is empty)/im;

export function classifyFactorySetupCheck(check: { command: string; pass: boolean; output: string }): FactorySetupCheckProof {
  const hasLaunchFailure = !check.pass && !TEST_RESULT_LINE.test(check.output)
    && (SHELL_NOT_FOUND_LINE.test(check.output) || LAUNCH_FAILURE_LINE.test(check.output));
  return { ...check, status: hasLaunchFailure ? 'could-not-run' : 'ran' };
}

export function decideFactorySetupProof(proposal: FactorySetupProposal, fullChecks: readonly FactorySetupCheckProof[], focusedChecks: readonly { command: string; pass: boolean }[]): FactorySetupResult {
  const checks = [...new Set(proposal.checks)].filter((command) => fullChecks.some((check) => check.command === command && check.status === 'ran'));
  if (checks.length === 0) {
    const failures = fullChecks.map((check) => `${check.command}: ${check.output}`).join('\n');
    return { ok: false, reason: `Factory setup could not run any full checks.${failures ? `\n${failures}` : ' No check commands were detected.'}` };
  }
  const focusedTestCommand = proposal.focusedTestCommandCandidates.find((command) => focusedChecks.some((check) => check.command === command && check.pass));
  return { ok: true, profile: {
    checks,
    widenableScopes: [...proposal.widenableScopes],
    ...(focusedTestCommand ? { focusedTestCommand } : {}),
  } };
}
