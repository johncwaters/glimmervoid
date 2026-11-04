import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../session/sessions.ts';
import { UNREACHABLE_PID } from './helpers/fake-pty.ts';

function dataDrivenPty(writes: string[]) {
  let emitOutput: (data: string) => void = () => {};
  const pty = {
    pid: UNREACHABLE_PID,
    onData(listener: (data: string) => void) { emitOutput = listener; },
    onExit() {},
    write(data: string) { writes.push(data); },
    resize() {},
    kill() {},
  };
  return { pty, emitOutput: (data: string) => emitOutput(data) };
}

test('a codex startup color probe split across PTY chunks gets one foreground and one background reply from the server', async () => {
  const writes: string[] = [];
  const { pty, emitOutput } = dataDrivenPty(writes);
  const session = new Session({
    id: 'codex-color-probe', name: 'codex-color-probe', path: process.cwd(), agent: 'codex',
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: () => pty,
    getTerminalColors: () => ({ background: '#F7F5FA', foreground: '#1a1625' }),
  });
  try {
    await session.start();
    writes.length = 0;
    emitOutput('\x1b[c\x1b[6n\x1b]10;?\x1b\\\x1b]1');
    emitOutput('1;?\x1b');
    emitOutput('\\\x1b]0;codex\x07');
  } finally {
    session.destroy();
  }
  assert.deepEqual(writes, ['\x1b]10;rgb:1a1a/1616/2525\x1b\\', '\x1b]11;rgb:f7f7/f5f5/fafa\x1b\\']);
});
