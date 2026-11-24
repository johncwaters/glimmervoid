import { ping } from '../alpha/ping.ts';

export function pong(depth: number): number {
  return depth <= 0 ? 1 : ping(depth - 1);
}
