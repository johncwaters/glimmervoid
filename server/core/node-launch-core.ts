import path from 'node:path';

const NODE_NOT_ON_PATH_NAME = 'glimmervoid-node-not-on-PATH';
const SHELL_KEYWORD_BY_COMMAND_FLAG = new Map([['-c', 'command'], ['/c', 'call']]);
const LEADING_NODE_PATTERN = /^("{0,2})node("?)(?= |$)/;

interface ProgramLaunch {
  file: string;
  args: readonly string[] | undefined;
}

function startsWithNode(command: string): boolean {
  return LEADING_NODE_PATTERN.test(command);
}

function commandWithShellResolvedNode(command: string, commandFlag: string): string {
  return `${SHELL_KEYWORD_BY_COMMAND_FLAG.get(commandFlag)} ${command}`;
}

function shellCommandIndexOf(args: readonly string[]): number {
  return args.findIndex((argument, index) => index > 0 && SHELL_KEYWORD_BY_COMMAND_FLAG.has(args[index - 1]) && startsWithNode(argument));
}

function environmentValue(env: NodeJS.ProcessEnv, name: string): string {
  const matchingKey = Object.keys(env).find((key) => key.toUpperCase() === name);
  if (matchingKey === undefined) return '';
  return env[matchingKey] ?? '';
}

function commandCandidatesOnPath(program: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const platformPath = platform === 'win32' ? path.win32 : path.posix;
  const executableExtensions = platform === 'win32' ? (environmentValue(env, 'PATHEXT') || '.EXE').split(';').filter(Boolean) : [''];
  const directories = environmentValue(env, 'PATH').split(platformPath.delimiter).filter(Boolean);
  return directories.flatMap((directory) => executableExtensions.map((extension) => platformPath.join(directory, `${program}${extension}`)));
}

function launchWithShellResolvedNode(launch: ProgramLaunch): ProgramLaunch {
  if (!launch.args) return launch;
  const launchArgs = launch.args;
  const commandIndex = shellCommandIndexOf(launchArgs);
  if (commandIndex === -1) return launch;
  const args = launchArgs.map((argument, index) => (index === commandIndex ? commandWithShellResolvedNode(argument, launchArgs[index - 1]) : argument));
  return { file: launch.file, args };
}

export { commandCandidatesOnPath, commandWithShellResolvedNode, launchWithShellResolvedNode, NODE_NOT_ON_PATH_NAME, startsWithNode };
export type { ProgramLaunch };
