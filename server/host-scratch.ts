import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import path from 'node:path';
import { glimmervoidHomeDir } from './config-store.ts';

export function hostScratchRoot(): string {
  return path.join(glimmervoidHomeDir(), 'scratch');
}

export async function makeHostScratchDirectory(prefix: string): Promise<string> {
  await mkdir(hostScratchRoot(), { recursive: true, mode: 0o700 });
  return mkdtemp(path.join(await realpath(hostScratchRoot()), prefix));
}
