import fs from 'node:fs';
import path from 'node:path';
import { errorMessage } from '../../shared/text.ts';
import { isRepositoryProject, launcherAddSession, resolveLauncherProject } from './core/launcher-core.ts';
import type { ProjectOrigin } from './core/launcher-core.ts';
import type { createPackStore } from './pack-store.ts';

type PackStore = ReturnType<typeof createPackStore>;
type LaunchRequest = ReturnType<typeof launcherAddSession>;
type LaunchOutcome = { ok: true; request: LaunchRequest } | { ok: false; error: string };

export function createPackLaunchers({ packStore, projectPaths, originUrl, operatorSaneYolo, onResolved, log }: {
  packStore: PackStore;
  projectPaths: () => readonly string[];
  originUrl: (projectPath: string) => Promise<string | null>;
  operatorSaneYolo: () => boolean;
  onResolved: () => void;
  log: { warn: (message: string) => void };
}) {
  let projectOrigins: readonly ProjectOrigin[] = [];
  let existingFolders: ReadonlySet<string> = new Set();
  let refreshes: Promise<void> = Promise.resolve();

  const resolve = (project: string) => resolveLauncherProject(project, projectOrigins, existingFolders);

  async function existingFoldersOf(projects: readonly string[]): Promise<Set<string>> {
    const folders = projects.filter((project) => !isRepositoryProject(project));
    const found = await Promise.all(folders.map((folder) => fs.promises.stat(folder).then((stats) => stats.isDirectory(), () => false)));
    return new Set(folders.filter((_folder, index) => found[index]));
  }

  async function originOfRepository(projectPath: string): Promise<string | null> {
    const hasGitFolder = await fs.promises.stat(path.join(projectPath, '.git')).then(() => true, () => false);
    return hasGitFolder ? originUrl(projectPath).catch(() => null) : null;
  }

  async function refreshNow(): Promise<void> {
    const projects = packStore.launcherProjectsInUse();
    const needsOrigins = projects.some(isRepositoryProject);
    const paths = needsOrigins ? [...new Set(projectPaths())] : [];
    const origins = await Promise.all(paths.map((projectPath) => originOfRepository(projectPath)));
    projectOrigins = paths.map((projectPath, index) => ({ path: path.resolve(projectPath), originUrl: origins[index] ?? null }));
    existingFolders = await existingFoldersOf(projects);
    packStore.setLauncherResolver(resolve);
    onResolved();
  }

  function refresh(): Promise<void> {
    refreshes = refreshes.then(refreshNow).catch((error: unknown) => log.warn(`[packs] could not match launcher projects: ${errorMessage(error)}`));
    return refreshes;
  }

  async function resolveFresh(project: string) {
    const cached = resolve(project);
    if (cached.ok) return cached;
    await refresh();
    return resolve(project);
  }

  async function launchRequest(packName: string, launcherId: string, sessionNames: readonly string[]): Promise<LaunchOutcome> {
    const approved = packStore.launcherInUse(packName, launcherId);
    if (!approved) return { ok: false, error: `No approved launcher ${launcherId} in pack ${packName}` };
    const resolution = await resolveFresh(approved.launcher.project);
    if (!resolution.ok) return { ok: false, error: `${approved.launcher.label} cannot start: ${resolution.reason}` };
    return {
      ok: true,
      request: launcherAddSession({ launcher: approved.launcher, sessions: approved.sessions, projectPath: resolution.path, sessionNames, operatorSaneYolo: operatorSaneYolo() }),
    };
  }

  return { refresh, launchRequest };
}

export type PackLaunchers = ReturnType<typeof createPackLaunchers>;
