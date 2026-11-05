import path from 'node:path';

const CLAUDE_GLOBAL_CONFIG_FILE_NAME = '.claude.json';
const CLAUDE_LEGACY_CONFIG_FILE_NAME = '.config.json';

function listClaudeGlobalConfigPathCandidates(env: NodeJS.ProcessEnv, homeDir: string): readonly [legacyConfigPath: string, currentConfigPath: string] {
  const configuredDir = env.CLAUDE_CONFIG_DIR?.trim();
  const legacyConfigHome = (configuredDir || path.join(homeDir, '.claude')).normalize('NFC');
  return [path.join(legacyConfigHome, CLAUDE_LEGACY_CONFIG_FILE_NAME), path.join(configuredDir || homeDir, CLAUDE_GLOBAL_CONFIG_FILE_NAME)];
}

export { listClaudeGlobalConfigPathCandidates };
