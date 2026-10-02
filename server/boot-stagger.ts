import { bootStaggerDelayMs } from './core/boot-stagger-core.ts';

export function bootStaggerDelay(): number {
  return bootStaggerDelayMs(process.uptime() * 1000, Math.random());
}
