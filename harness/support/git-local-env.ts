import { execFileSync } from 'node:child_process';

export const FALLBACK_GIT_LOCAL_ENV_VARS: readonly string[] = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR',
];

let cachedGitLocalEnvVars: readonly string[] | null = null;

export function gitLocalEnvVars(): readonly string[] {
  if (cachedGitLocalEnvVars !== null) return cachedGitLocalEnvVars;
  try {
    const stdout = execFileSync('git', ['rev-parse', '--local-env-vars'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const parsed = stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
    cachedGitLocalEnvVars = parsed.length > 0 ? parsed : FALLBACK_GIT_LOCAL_ENV_VARS;
    return cachedGitLocalEnvVars;
  } catch {
    cachedGitLocalEnvVars = FALLBACK_GIT_LOCAL_ENV_VARS;
    return cachedGitLocalEnvVars;
  }
}

export function scrubGitLocalEnv(environment: NodeJS.ProcessEnv = process.env): void {
  for (const variableName of gitLocalEnvVars()) delete environment[variableName];
}

export function withoutGitLocalEnv(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const cleanedEnvironment: NodeJS.ProcessEnv = { ...environment };
  scrubGitLocalEnv(cleanedEnvironment);
  return cleanedEnvironment;
}

scrubGitLocalEnv(process.env);
