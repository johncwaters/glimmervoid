const RUNTIME_TERMINAL_FILTER = '(regex #"^/dev/ttys")';
const RUNTIME_TERMINAL_FILTER_COUNT = 2;
const RUNTIME_TASK_PORT_RULE = '(allow mach-priv-task-port (target same-sandbox))';
const MACH_REGISTER_RULE = '(allow mach-register)';
const TERMINAL_PATH_SHAPE = /^\/dev\/ttys\d+$/;

type ProfileRewrite = { ok: true; argv: string[] } | { ok: false; reason: string };

function replaceRuntimeFragment(argv: readonly string[], runtimeFragment: string, expectedCount: number, replacement: string): ProfileRewrite {
  const fragmentCount = argv.reduce((count, word) => count + word.split(runtimeFragment).length - 1, 0);
  if (fragmentCount !== expectedCount) {
    return { ok: false, reason: `the sandbox runtime emitted ${runtimeFragment} ${fragmentCount} times instead of ${expectedCount}, so the guardrails cannot amend its profile` };
  }
  return { ok: true, argv: argv.map((word) => word.replaceAll(runtimeFragment, replacement)) };
}

function confineToOwnTerminal(argv: readonly string[], ownTerminalPath: string): ProfileRewrite {
  if (!TERMINAL_PATH_SHAPE.test(ownTerminalPath)) return { ok: false, reason: `${ownTerminalPath} is not a pseudo-terminal the guardrails can be confined to` };
  return replaceRuntimeFragment(argv, RUNTIME_TERMINAL_FILTER, RUNTIME_TERMINAL_FILTER_COUNT, `(literal "${ownTerminalPath}")`);
}

function addMachRegisterRule(argv: readonly string[]): ProfileRewrite {
  return replaceRuntimeFragment(argv, RUNTIME_TASK_PORT_RULE, 1, `${RUNTIME_TASK_PORT_RULE}\n${MACH_REGISTER_RULE}`);
}

export { addMachRegisterRule, confineToOwnTerminal };
export type { ProfileRewrite };
