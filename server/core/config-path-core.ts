import path from 'node:path';

type ConfigPathSource = 'env' | 'home' | 'none';

interface ConfigPathDecision {
  path: string | null;
  source: ConfigPathSource;
  homePath: string;
  envPath: string | null;
}

function glimmervoidHomeDir(homeDirectory: string, env: { GLIMMERVOID_HOME?: string }): string {
  if (env.GLIMMERVOID_HOME) return path.resolve(env.GLIMMERVOID_HOME);
  return path.join(homeDirectory, '.glimmervoid');
}

function isOperatorHomeUnderTest(homeDirectory: string, env: { GLIMMERVOID_HOME?: string; NODE_TEST_CONTEXT?: string }): boolean {
  if (!env.NODE_TEST_CONTEXT) return false;
  return glimmervoidHomeDir(homeDirectory, env) === glimmervoidHomeDir(homeDirectory, {});
}

function decideConfigPath(
  {
    env = {},
    homeDir,
  }: { env?: { GLIMMERVOID_CONFIG?: string }; homeDir: string },
  exists: (candidate: string) => boolean,
): ConfigPathDecision {
  const homePath = path.join(homeDir, 'config.json');
  if (env.GLIMMERVOID_CONFIG) {
    const envPath = path.resolve(env.GLIMMERVOID_CONFIG);
    if (exists(envPath)) return { path: envPath, source: 'env', homePath, envPath };
    return { path: null, source: 'env', homePath, envPath };
  }

  if (exists(homePath)) return { path: homePath, source: 'home', homePath, envPath: null };
  return { path: null, source: 'none', homePath, envPath: null };
}

export { decideConfigPath, glimmervoidHomeDir, isOperatorHomeUnderTest };
