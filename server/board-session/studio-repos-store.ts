import crypto from 'node:crypto';
import path from 'node:path';

import { clock } from '../../shared/clock.ts';
import { createJsonStateStore } from '../json-file.ts';
import { StudioRepo, StudioReposFile } from '../../shared/contracts/studio-repos.ts';

const REPO_KEY_HEX_LENGTH = 8;

type StudioReposStore = {
  repos(): Promise<readonly StudioRepo[]>;
  addRepo(repoDir: string): Promise<StudioRepo>;
  removeRepo(repoKey: string): Promise<void>;
};

function createStudioReposStore({ filePath, logger, nowMs = clock.nowMs, newRepoKey = () => crypto.randomBytes(REPO_KEY_HEX_LENGTH / 2).toString('hex') }: { filePath: string | null; logger: Pick<Console, 'warn'>; nowMs?: () => number; newRepoKey?: () => string }): StudioReposStore {
  let listedRepos: readonly StudioRepo[] = [];
  let unreadEntries: readonly unknown[] = [];
  let loadedFile: StudioReposFile = { repos: [] };
  let lastChange: Promise<unknown> = Promise.resolve();
  const store = createJsonStateStore<StudioReposFile>({
    name: 'studio repos',
    filePath,
    parse: (raw) => StudioReposFile.safeParse(raw).data ?? null,
    adopt: (adoptedFile) => {
      loadedFile = adoptedFile ?? { repos: [] };
      const parsedEntries = loadedFile.repos.map((entry) => ({ entry, parsed: StudioRepo.safeParse(entry) }));
      listedRepos = parsedEntries.flatMap(({ parsed }) => (parsed.success ? [parsed.data] : []));
      unreadEntries = parsedEntries.flatMap(({ entry, parsed }) => (parsed.success ? [] : [entry]));
      if (unreadEntries.length > 0) logger.warn(`[studio-repos] ${unreadEntries.length} entries of studio-repos.json are not Studio repos this version reads; they are kept in the file and not shown`);
    },
    warn: (message, fields) => logger.warn(`[studio-repos] ${message} ${JSON.stringify(fields)}`),
  });

  function change<Changed>(apply: (current: readonly StudioRepo[]) => { nextRepos: readonly StudioRepo[]; changed: Changed }): Promise<Changed> {
    const changing = lastChange.then(async () => {
      await store.load();
      const { nextRepos, changed } = apply(listedRepos);
      if (nextRepos === listedRepos) return changed;
      const written: StudioReposFile = { ...loadedFile, repos: [...nextRepos, ...unreadEntries] };
      const isWritten = await store.write(written, () => `${JSON.stringify(written, null, 2)}\n`);
      if (!isWritten) throw new Error('studio-repos.json could not be written');
      listedRepos = nextRepos;
      return changed;
    });
    lastChange = changing.catch(() => undefined);
    return changing;
  }

  function unusedRepoName(current: readonly StudioRepo[], repoDir: string): string {
    const folderName = path.basename(repoDir) || 'repo';
    const takenNames = new Set(current.map((listed) => listed.repoName.toLowerCase()));
    const nameOf = (copyNumber: number) => (copyNumber === 1 ? folderName : `${folderName}-${copyNumber}`);
    let copyNumber = 1;
    while (takenNames.has(nameOf(copyNumber).toLowerCase())) copyNumber += 1;
    return nameOf(copyNumber);
  }

  function unusedRepoKey(current: readonly StudioRepo[]): string {
    const candidateKey = newRepoKey();
    return current.some((listed) => listed.repoKey === candidateKey) ? unusedRepoKey(current) : candidateKey;
  }

  async function repos(): Promise<readonly StudioRepo[]> {
    await store.load();
    return listedRepos;
  }

  function addRepo(repoDir: string): Promise<StudioRepo> {
    return change((current) => {
      const listed = current.find((candidate) => candidate.repoDir === repoDir);
      if (listed) return { nextRepos: current, changed: listed };
      const added: StudioRepo = { repoKey: unusedRepoKey(current), repoName: unusedRepoName(current, repoDir), repoDir, branchAgent: null, addedAtMs: nowMs() };
      return { nextRepos: [...current, added], changed: added };
    });
  }

  function removeRepo(repoKey: string): Promise<void> {
    return change((current) => ({ nextRepos: current.some((listed) => listed.repoKey === repoKey) ? current.filter((listed) => listed.repoKey !== repoKey) : current, changed: undefined }));
  }

  return { repos, addRepo, removeRepo };
}

export { createStudioReposStore };
