import { clock } from '../shared/clock.ts';
import { createLineStamper } from './core/log-stamp-core.ts';

function isoNow(): string {
  return new Date(clock.nowMs()).toISOString();
}

function stampStreamLines(target: NodeJS.WriteStream): void {
  const writeToTarget = target.write.bind(target);
  const stampLines = createLineStamper(isoNow);
  target.write = ((chunk: string | Uint8Array, ...rest: never[]) => writeToTarget(stampLines(chunk), ...rest)) as typeof target.write;
}

function stampProcessOutputLines(): void {
  stampStreamLines(process.stdout);
  stampStreamLines(process.stderr);
}

export { isoNow, stampProcessOutputLines };
