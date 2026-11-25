import crypto from 'node:crypto';
import path from 'node:path';

import { clock } from '../../shared/clock.ts';
import { createJsonStateStore } from '../json-file.ts';
import { STUDIO_REPO_NAME_MAX, StudioBranchAgent, StudioRepo, StudioReposFile } from '../../shared/contracts/studio-repos.ts';

const REPO_KEY_HEX_LENGTH = 8;

type StudioReposStore = {
  repos(): Promise<readonly StudioRepo[]>;
  addRepo(repoDir: string): Promise<StudioRepo>;
  removeRepo(repoKey: string): Promise<void>;
  setBranchAgent(repoKey: string, branchAgent: StudioBranchAgent): Promise<StudioRepo | null>;
};

function readStudioReposFile(raw: unknown): { file: StudioReposFile; listedRepos: StudioRepo[]; unreadEntries: unknown[] } {
  const file = StudioReposFile.safeParse(raw).data ?? { repos: [] };
  const parsedEntries = file.repos.map((entry) => ({ entry, parsed: StudioRepo.safeParse(entry) }));
  return {
    file,
    listedRepos: parsedEntries.flatMap(({ parsed }) => (parsed.success ? [parsed.data] : [])),
    unreadEntries: parsedEntries.flatMap(({ entry, parsed }) => (parsed.success ? [] : [entry])),
  };
}

function unusedRepoNameOf(current: readonly StudioRepo[], repoDir: string): string {
  const folderName = path.basename(repoDir) || 'repo';
  const takenNames = new Set(current.map((listed) => listed.repoName.toLowerCase()));
  const nameOf = (copyNumber: number) => {
    const copySuffix = copyNumber === 1 ? '' : `-${copyNumber}`;
    return `${folderName.slice(0, STUDIO_REPO_NAME_MAX - copySuffix.length)}${copySuffix}`;
  };
  let copyNumber = 1;
  while (takenNames.has(nameOf(copyNumber).toLowerCase())) copyNumber += 1;
  return nameOf(copyNumber);
}

function newStudioRepoKey(): string {
  return crypto.randomBytes(REPO_KEY_HEX_LENGTH / 2).toString('hex');
}

function createStudioReposStore({ filePath, logger, nowMs = clock.nowMs, newRepoKey = newStudioRepoKey }: { filePath: string | null; logger: Pick<Console, 'warn'>; nowMs?: () => number; newRepoKey?: () => string }): StudioReposStore {
  let listedRepos: readonly StudioRepo[] = [];
  let unreadEntries: readonly unknown[] = [];
  let loadedFile: StudioReposFile = { repos: [] };
  let lastChange: Promise<unknown> = Promise.resolve();
  const store = createJsonStateStore<StudioReposFile>({
    name: 'studio repos',
    filePath,
    parse: (raw) => StudioReposFile.safeParse(raw).data ?? null,
    adopt: (adoptedFile) => {
      const read = readStudioReposFile(adoptedFile);
      loadedFile = read.file;
      listedRepos = read.listedRepos;
      unreadEntries = read.unreadEntries;
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
      const added: StudioRepo = { repoKey: unusedRepoKey(current), repoName: unusedRepoNameOf(current, repoDir), repoDir, branchAgent: null, addedAtMs: nowMs() };
      return { nextRepos: [...current, added], changed: added };
    });
  }

  function removeRepo(repoKey: string): Promise<void> {
    return change((current) => ({ nextRepos: current.some((listed) => listed.repoKey === repoKey) ? current.filter((listed) => listed.repoKey !== repoKey) : current, changed: undefined }));
  }

  function setBranchAgent(repoKey: string, pickedBranchAgent: StudioBranchAgent): Promise<StudioRepo | null> {
    return change((current) => {
      const branchAgent = StudioBranchAgent.parse(pickedBranchAgent);
      const listed = current.find((candidate) => candidate.repoKey === repoKey);
      if (!listed) return { nextRepos: current, changed: null };
      const changedRepo: StudioRepo = { ...listed, branchAgent };
      return { nextRepos: current.map((candidate) => (candidate === listed ? changedRepo : candidate)), changed: changedRepo };
    });
  }

  return { repos, addRepo, removeRepo, setBranchAgent };
}

export { createStudioReposStore, newStudioRepoKey, readStudioReposFile, unusedRepoNameOf };
export type { StudioReposStore };
