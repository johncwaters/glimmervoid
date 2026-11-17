import path from 'node:path';

type LockfileConflict = { path: string; regenerateCommand: string };
type ClassifiedConflicts = { lockfiles: LockfileConflict[]; others: string[] };

const REGENERATE_COMMAND_BY_LOCKFILE_NAME: ReadonlyMap<string, string> = new Map([
  ['package-lock.json', 'npm install'],
  ['npm-shrinkwrap.json', 'npm install'],
  ['pnpm-lock.yaml', 'pnpm install'],
  ['yarn.lock', 'yarn install'],
  ['bun.lock', 'bun install'],
  ['bun.lockb', 'bun install'],
  ['deno.lock', 'deno install (on Deno 1, deno cache with the entry module)'],
  ['Cargo.lock', 'cargo update --workspace'],
  ['go.sum', 'go mod tidy'],
  ['poetry.lock', 'poetry lock (on Poetry 1, poetry lock --no-update)'],
  ['uv.lock', 'uv lock'],
  ['Gemfile.lock', 'bundle lock'],
  ['composer.lock', 'composer update naming each package this branch added or changed in composer.json (a bare composer update upgrades every package)'],
  ['mix.lock', 'mix deps.get'],
  ['flake.lock', 'nix flake lock'],
]);

function classifyConflicts(conflictPaths: readonly string[]): ClassifiedConflicts {
  const lockfiles: LockfileConflict[] = [];
  const others: string[] = [];
  for (const conflictPath of conflictPaths) {
    const regenerateCommand = REGENERATE_COMMAND_BY_LOCKFILE_NAME.get(path.posix.basename(conflictPath.replaceAll('\\', '/')));
    if (regenerateCommand === undefined) {
      others.push(conflictPath);
      continue;
    }
    lockfiles.push({ path: conflictPath, regenerateCommand });
  }
  return { lockfiles, others };
}

export { classifyConflicts };
