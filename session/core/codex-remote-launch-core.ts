export const CODEX_REMOTE_TOKEN_ENV = 'GLIMMERVOID_CODEX_REMOTE_TOKEN';

const CONFIG_FLAG = '-c';
const APP_SERVER_REFUSED_FLAGS: ReadonlySet<string> = new Set(['--dangerously-bypass-hook-trust']);

interface CodexRemoteLaunch {
  appServerConfigArgs: string[];
  tuiArgs: string[];
}

export function splitCodexRemoteLaunch(launchArgs: readonly string[]): CodexRemoteLaunch {
  const appServerConfigArgs: string[] = [];
  const tuiArgs: string[] = [];
  for (let index = 0; index < launchArgs.length; index += 1) {
    const launchArg = launchArgs[index];
    if (APP_SERVER_REFUSED_FLAGS.has(launchArg)) continue;
    const configValue = launchArgs[index + 1];
    if (launchArg === CONFIG_FLAG && configValue !== undefined) {
      appServerConfigArgs.push(CONFIG_FLAG, configValue);
      index += 1;
      continue;
    }
    tuiArgs.push(launchArg);
  }
  return { appServerConfigArgs, tuiArgs };
}

export function remoteTuiArgs(remoteUrl: string, tuiArgs: readonly string[]): string[] {
  return ['--remote', remoteUrl, '--remote-auth-token-env', CODEX_REMOTE_TOKEN_ENV, ...tuiArgs];
}
