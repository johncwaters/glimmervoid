import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Config, ProjectConfig } from '../../../shared/contracts/config.ts';

interface FactoryRepo {
  id: string;
  name: string;
  path: string;
  factoryProfile: ProjectConfig['factoryProfile'];
}

export function factoryRepoId(repoPath: string): string {
  const resolvedPath = path.resolve(repoPath);
  const slug = path.basename(resolvedPath).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'repo';
  return `${slug}-${createHash('sha256').update(resolvedPath).digest('hex').slice(0, 10)}`;
}

export function listFactoryRepos(config: Partial<Pick<Config, 'projects'>>): FactoryRepo[] {
  const reposById = new Map<string, FactoryRepo>();
  for (const session of config.projects ?? []) {
    if (!session.path || session.repos) continue;
    const id = factoryRepoId(session.path);
    const known = reposById.get(id);
    if (known) {
      known.factoryProfile ??= session.factoryProfile;
      continue;
    }
    const resolvedPath = path.resolve(session.path);
    reposById.set(id, { id, name: path.basename(resolvedPath), path: resolvedPath, factoryProfile: session.factoryProfile });
  }
  return [...reposById.values()];
}

export function findFactoryRepo(config: Partial<Pick<Config, 'projects'>>, projectId: string): FactoryRepo | undefined {
  return listFactoryRepos(config).find((repo) => repo.id === projectId);
}

export function findFactoryRepoByPath(config: Partial<Pick<Config, 'projects'>>, repoPath: string): FactoryRepo | undefined {
  return findFactoryRepo(config, factoryRepoId(repoPath));
}

export function findFactoryProjectPath(config: Partial<Pick<Config, 'projects'>>, projectId: string): string | undefined {
  return findFactoryRepo(config, projectId)?.path;
}

export function saveFactoryProfileOnRepo(sessions: Pick<ProjectConfig, 'path' | 'factoryProfile'>[] | undefined, repoPath: string, profile: NonNullable<ProjectConfig['factoryProfile']>): void {
  const sessionsOfRepo = (sessions ?? []).filter((session) => path.resolve(session.path) === path.resolve(repoPath));
  if (sessionsOfRepo.length === 0) throw new Error('Factory setup project is no longer configured');
  for (const session of sessionsOfRepo) session.factoryProfile = profile;
}
