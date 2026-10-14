const RUNTIME_TERMINAL_FILTER = '(regex #"^/dev/ttys")';
const RUNTIME_TERMINAL_FILTER_COUNT = 2;
const TERMINAL_PATH_SHAPE = /^\/dev\/ttys\d+$/;

type TerminalConfinement = { ok: true; argv: string[] } | { ok: false; reason: string };

function confineToOwnTerminal(argv: readonly string[], ownTerminalPath: string): TerminalConfinement {
  if (!TERMINAL_PATH_SHAPE.test(ownTerminalPath)) return { ok: false, reason: `${ownTerminalPath} is not a pseudo-terminal the sandbox can be confined to` };
  const filterCount = argv.reduce((count, word) => count + word.split(RUNTIME_TERMINAL_FILTER).length - 1, 0);
  if (filterCount !== RUNTIME_TERMINAL_FILTER_COUNT) {
    return { ok: false, reason: `the sandbox runtime emitted ${filterCount} terminal rules instead of ${RUNTIME_TERMINAL_FILTER_COUNT}, so they cannot be confined to one terminal` };
  }
  const ownTerminalFilter = `(literal "${ownTerminalPath}")`;
  return { ok: true, argv: argv.map((word) => word.replaceAll(RUNTIME_TERMINAL_FILTER, ownTerminalFilter)) };
}

export { confineToOwnTerminal };
