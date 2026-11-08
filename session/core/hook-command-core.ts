const SAFE_PATH_RE = /^[A-Za-z0-9_.:/\\ -]+$/;
const SAFE_EVENT_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

const SHELL_BARE_WORD_RE = /^[A-Za-z0-9_.:/-]+$/;

function toForwardSlashes(commandPath: string): string {
  return commandPath.replace(/\\/g, "/");
}

function buildHookCommand(launchPrefix: readonly string[], event: string, argvTail: readonly string[] = []): string | null {
  const rawEvent = String(event);
  if (launchPrefix.length === 0 || !launchPrefix.every((part) => SAFE_PATH_RE.test(part))) return null;
  if (!SAFE_EVENT_RE.test(rawEvent)) return null;
  if (argvTail.some((argument) => !/^[A-Za-z0-9_-]+$/.test(argument))) return null;
  const launchText = launchPrefix.map((part) => {
    const forwardSlashedPart = toForwardSlashes(part);
    return /\s/.test(forwardSlashedPart) ? `"${forwardSlashedPart}"` : forwardSlashedPart;
  }).join(" ");
  return `${launchText} ${rawEvent}${argvTail.length ? ` ${argvTail.join(" ")}` : ""}`;
}

function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function shellLaunchText(launchPrefix: readonly string[]): string {
  const [launcher = "", ...launchArguments] = launchPrefix.map(toForwardSlashes);
  const launcherText = SHELL_BARE_WORD_RE.test(launcher) ? launcher : shellQuote(launcher);
  return [launcherText, ...launchArguments.map(shellQuote)].join(" ");
}

export { buildHookCommand, shellLaunchText, shellQuote };
