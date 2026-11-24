import { pong } from '../beta/pong.ts';

export function ping(depth: number): number {
  return depth <= 0 ? 0 : pong(depth - 1);
}
