import {
  CHANGE_MAP_LIST_CAP,
  changeMapFactId,
  type CollisionFact,
  type SubsystemFact,
} from '../../shared/contracts/change-map.ts';

export function readAgentsTitle(markdown: string): string {
  const heading = markdown.match(/^# (.*)$/m);
  return heading?.[1].trim() ?? '';
}

export function computeSubsystems({ repoName, changedPaths, agentsDocs }: {
  repoName: string;
  changedPaths: string[];
  agentsDocs: { path: string; title: string }[];
}): SubsystemFact[] {
  const agentsDocsByDirectory = new Map<string, { path: string; title: string }>();
  for (const agentsDoc of agentsDocs) {
    const directory = agentsDoc.path === 'AGENTS.md' ? '' : agentsDoc.path.slice(0, -'/AGENTS.md'.length);
    agentsDocsByDirectory.set(directory, agentsDoc);
  }

  const pathsByAgentsPath = new Map<string, string[]>();
  for (const changedPath of changedPaths) {
    let directory = changedPath.slice(0, changedPath.lastIndexOf('/') + 1).replace(/\/$/, '');
    while (true) {
      const owner = agentsDocsByDirectory.get(directory);
      if (owner) {
        const ownedPaths = pathsByAgentsPath.get(owner.path) ?? [];
        ownedPaths.push(changedPath);
        pathsByAgentsPath.set(owner.path, ownedPaths);
        break;
      }
      if (!directory) break;
      const parentSeparator = directory.lastIndexOf('/');
      directory = parentSeparator < 0 ? '' : directory.slice(0, parentSeparator);
    }
  }

  return [...pathsByAgentsPath].map(([agentsPath, paths]) => {
    const directory = agentsPath === 'AGENTS.md' ? '' : agentsPath.slice(0, -'/AGENTS.md'.length);
    const title = agentsDocsByDirectory.get(directory)?.title || directory || repoName;
    return {
      factId: changeMapFactId('subsystem', repoName, agentsPath),
      agentsPath,
      title,
      paths: paths.sort(),
    };
  }).sort((left, right) => right.paths.length - left.paths.length || left.agentsPath.localeCompare(right.agentsPath));
}

export function computeCollisions({ repoName, changedPaths, otherSessions }: {
  repoName: string;
  changedPaths: string[];
  otherSessions: { id: string; name: string; changedPaths: string[] }[];
}): CollisionFact[] {
  const changedPathSet = new Set(changedPaths);
  const collisions: CollisionFact[] = [];
  for (const otherSession of otherSessions) {
    for (const path of new Set(otherSession.changedPaths)) {
      if (!changedPathSet.has(path)) continue;
      collisions.push({
        factId: changeMapFactId('collision', repoName, path, otherSession.id),
        path,
        otherSessionId: otherSession.id,
        otherSessionName: otherSession.name,
      });
    }
  }
  return collisions.sort((left, right) => left.path.localeCompare(right.path)
    || left.otherSessionName.localeCompare(right.otherSessionName)
    || left.otherSessionId.localeCompare(right.otherSessionId)).slice(0, CHANGE_MAP_LIST_CAP);
}
