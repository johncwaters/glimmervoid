import fs from 'node:fs';
import path from 'node:path';

import { clock } from '../../shared/clock.ts';
import { REPO_ROOT_BRANCH_TITLE } from '../../shared/board-branch-core.ts';
import type { StudioRepo } from '../../shared/contracts/studio-repos.ts';
import { branchParentIdOf } from '../../shared/parent-link.ts';
import { errorMessage } from '../../shared/text.ts';
import { DEFAULT_AGENT_ID } from '../../session/adapters/index.ts';
import { buildAcpAgentTable } from '../../session/core/acp-agents-core.ts';
import { validResumeSessionId } from '../../session/core/auto-resume.ts';
import { decideSessionDriver, formatUsableAcpAgents, isStudioProject } from '../../session/core/session-driver-core.ts';
import { ABORT_CONFIG_SAVE, generateProjectId } from '../config-store.ts';
import type { GlimmervoidConfig, ProjectEntry } from '../config-store.ts';
import { repoBoxIdOfUnscopedBox, rootBoxIdOf } from '../core/codemap-graph-core.ts';
import { ORCHESTRATOR_NAME, ORCHESTRATOR_RUN_SETTINGS } from '../core/studio-main-core.ts';
import { appendTraceNoticeSync } from '../trace/trace-record-store.ts';
import { newStudioRepoKey, readStudioReposFile, unusedRepoNameOf } from './studio-repos-store.ts';

interface StudioMoveInput {
  projects: readonly ProjectEntry[];
  studioHome: string;
  listedRepos: readonly StudioRepo[];
  newProjectId: () => string;
  newRepoKey: () => string;
  nowMs: number;
}

interface StudioMove {
  projects: ProjectEntry[];
  repos: StudioRepo[];
  movedMainNames: string[];
}

function isUnmarkedStudioMain(project: ProjectEntry): boolean {
  return project.isStudioMain === true && project.studioRole !== ORCHESTRATOR_RUN_SETTINGS.studioRole;
}

function branchAgentOfMain(main: ProjectEntry): StudioRepo['branchAgent'] {
  if (!main.agent) return null;
  const setup = main.agentSetup ? { agent: main.agentSetup.agent, ...(main.agentSetup.provider ? { provider: main.agentSetup.provider } : {}), model: main.agentSetup.model, options: main.agentSetup.options } : null;
  return { agentId: main.agent, accountId: main.accountId ?? null, setup };
}

function reposWithMains(listedRepos: readonly StudioRepo[], mains: readonly ProjectEntry[], newRepoKey: () => string, nowMs: number): StudioRepo[] {
  const repos = [...listedRepos];
  for (const main of mains) {
    if (repos.some((listed) => listed.repoDir === main.path)) continue;
    repos.push({ repoKey: newRepoKey(), repoName: unusedRepoNameOf(repos, main.path), repoDir: main.path, branchAgent: branchAgentOfMain(main), addedAtMs: nowMs });
  }
  return repos;
}

function studioMoveOf({ projects, studioHome, listedRepos, newProjectId, newRepoKey, nowMs }: StudioMoveInput): StudioMove | null {
  const unmarkedMains = projects.filter(isUnmarkedStudioMain);
  const perRepoMains = unmarkedMains.filter((project) => project.path !== studioHome);
  const [firstMain] = perRepoMains;
  if (!firstMain) return unmarkedMains.length === 0 ? null : { projects: projects.map((project) => (isUnmarkedStudioMain(project) ? { ...project, ...ORCHESTRATOR_RUN_SETTINGS } : project)), repos: [...listedRepos], movedMainNames: [] };
  const repos = reposWithMains(listedRepos, perRepoMains, newRepoKey, nowMs);
  const repoOfMainId = new Map(perRepoMains.flatMap((main) => {
    const repo = repos.find((listed) => listed.repoDir === main.path);
    return main.id && repo ? [[main.id, repo] as const] : [];
  }));
  const keptOrchestrator = projects.find((project) => project.isStudioMain === true && !perRepoMains.includes(project));
  const orchestrator: ProjectEntry = keptOrchestrator ?? {
    id: newProjectId(),
    name: ORCHESTRATOR_NAME,
    path: studioHome,
    ...ORCHESTRATOR_RUN_SETTINGS,
    ...(firstMain.agent ? { agent: firstMain.agent } : {}),
    ...(firstMain.accountId ? { accountId: firstMain.accountId } : {}),
    ...(typeof firstMain.dangerouslySkipPermissions === 'boolean' ? { dangerouslySkipPermissions: firstMain.dangerouslySkipPermissions } : {}),
    ...(firstMain.saneYolo ? { saneYolo: true } : {}),
  };
  const orchestratorId = orchestrator.id;
  if (!orchestratorId) return null;
  const movedProjects = projects.map((project): ProjectEntry => {
    const ownRepo = project.id ? repoOfMainId.get(project.id) : undefined;
    if (project === keptOrchestrator) return { ...project, ...ORCHESTRATOR_RUN_SETTINGS };
    if (perRepoMains.includes(project) && ownRepo) {
      const { isStudioMain: _wasMain, ...formerMain } = project;
      return { ...formerMain, parent: { sessionId: orchestratorId, box: { id: rootBoxIdOf(ownRepo.repoKey), title: REPO_ROOT_BRANCH_TITLE, repoName: ownRepo.repoName } } };
    }
    const mainRepo = repoOfMainId.get(branchParentIdOf(project.parent) ?? '');
    const box = project.parent?.box;
    if (!mainRepo || !box) return project;
    return { ...project, parent: { sessionId: orchestratorId, box: { id: box.title === REPO_ROOT_BRANCH_TITLE ? rootBoxIdOf(mainRepo.repoKey) : repoBoxIdOfUnscopedBox(mainRepo.repoKey, box), title: box.title, repoName: mainRepo.repoName } } };
  });
  return { projects: keptOrchestrator ? movedProjects : [...movedProjects, orchestrator], repos, movedMainNames: perRepoMains.map((main) => main.name ?? main.path) };
}

interface StudioMigrationDeps {
  config: GlimmervoidConfig;
  configStore: { save(mutate: (savedConfig: GlimmervoidConfig) => unknown): GlimmervoidConfig | null };
  studioHome: string;
  studioReposFilePath: string;
  newRepoKey?: () => string;
  logger: Pick<Console, 'log' | 'warn'>;
}

function readJsonFile(filePath: string): unknown {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJsonFileAtOnce(filePath: string, content: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const stagedPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(stagedPath, `${JSON.stringify(content, null, 2)}\n`);
  fs.renameSync(stagedPath, filePath);
}

function moveStudioToOneOrchestrator({ config, configStore, studioHome, studioReposFilePath, newRepoKey = newStudioRepoKey, logger }: StudioMigrationDeps): void {
  if (!config.projects.some(isUnmarkedStudioMain)) return;
  try {
    const { file, listedRepos, unreadEntries } = readStudioReposFile(readJsonFile(studioReposFilePath));
    const planned = studioMoveOf({ projects: config.projects, studioHome, listedRepos, newProjectId: generateProjectId, newRepoKey, nowMs: clock.nowMs() });
    if (!planned) return;
    const hasMovedMains = planned.movedMainNames.length > 0;
    if (hasMovedMains) {
      writeJsonFileAtOnce(studioReposFilePath, { ...file, repos: [...planned.repos, ...unreadEntries] });
      fs.mkdirSync(studioHome, { recursive: true });
    }
    const movedProjectsOf = (projects: ProjectEntry[]) => studioMoveOf({ projects, studioHome, listedRepos: planned.repos, newProjectId: generateProjectId, newRepoKey, nowMs: clock.nowMs() })?.projects ?? projects;
    const saved = configStore.save((savedConfig) => {
      savedConfig.projects = movedProjectsOf(savedConfig.projects);
    });
    config.projects = saved ? saved.projects : movedProjectsOf(config.projects);
    if (hasMovedMains) logger.log(`[studio] moved ${planned.movedMainNames.length} repo main session(s) under the one Orchestrator as repo root branches: ${planned.movedMainNames.join(', ')}`);
  } catch (error) {
    logger.warn(`[studio] the repo main sessions were not moved under the Orchestrator, and move at the next start: ${errorMessage(error)}`);
  }
}

interface StudioAcpBlockedNotice {
  sessionId: string;
  agentId: string;
  text: string;
}

interface StudioAcpMigrationPlan {
  projects: ProjectEntry[];
  migratedCount: number;
  blockedNotices: StudioAcpBlockedNotice[];
}

interface StudioAcpMigrationDeps {
  config: GlimmervoidConfig;
  configStore: { save(mutate: (savedConfig: GlimmervoidConfig) => unknown): GlimmervoidConfig | null };
  tracesDir: string;
  logger: Pick<Console, 'log' | 'warn'>;
}

function blockedStudioNoticeText(agentId: string, acpAgents: unknown, isOrchestrator: boolean): string {
  const table = buildAcpAgentTable(acpAgents ?? []);
  const usableSuffix = table.ok ? ` (${formatUsableAcpAgents(table.entries)})` : '';
  if (isOrchestrator) {
    return `Studio runs agents over ACP, and "${agentId}" has no ACP row, so the Orchestrator was left stopped. Pick an agent Studio can run${usableSuffix} from the Orchestrator card, or add an ACP row for "${agentId}" in settings.`;
  }
  return `Studio runs agents over ACP, and "${agentId}" has no ACP row, so this session was left stopped. Pick an agent Studio can run${usableSuffix} by closing this session and opening a new one, or add an ACP row for "${agentId}" in settings.`;
}

function planStudioAcpMigration(
  projects: readonly ProjectEntry[],
  acpAgents: unknown,
  notedSessionIds?: ReadonlySet<string>,
): StudioAcpMigrationPlan | null {
  let hasChanges = false;
  let migratedCount = 0;
  const blockedNotices: StudioAcpBlockedNotice[] = [];
  const nextProjects = projects.map((project): ProjectEntry => {
    if (!isStudioProject(project)) return project;
    const agentId = typeof project.agent === 'string' && project.agent.trim() !== '' ? project.agent.trim() : DEFAULT_AGENT_ID;
    const decision = decideSessionDriver({ isStudio: true, agentId, acpAgents });
    if (decision.ok) {
      if (project.driverKind === 'acp' && project.acpMigrationBlockedNoted !== true) return project;
      hasChanges = true;
      const wasAlreadyAcp = project.driverKind === 'acp';
      if (!wasAlreadyAcp) migratedCount += 1;
      const { acpMigrationBlockedNoted: _clearedBlocked, ...rest } = project;
      const hasResumeId = !wasAlreadyAcp && validResumeSessionId(project.resumeSessionId) !== null;
      return {
        ...rest,
        driverKind: 'acp',
        ...(hasResumeId ? { acpMigrationFreshFallback: true } : {}),
      };
    }
    const needsStateCleanup = project.driverKind !== undefined || project.wasActive === true || project.wasWorking === true;
    const needsNotice = project.acpMigrationBlockedNoted !== true;
    const isNotedNow = project.id !== undefined && (notedSessionIds === undefined || notedSessionIds.has(project.id));
    if (!needsStateCleanup && (!needsNotice || !isNotedNow)) return project;
    hasChanges = true;
    const { driverKind: _removedDriver, ...rest } = project;
    if (needsNotice && project.id) {
      blockedNotices.push({
        sessionId: project.id,
        agentId,
        text: blockedStudioNoticeText(agentId, acpAgents, project.isStudioMain === true),
      });
    }
    return {
      ...rest,
      wasActive: false,
      wasWorking: false,
      ...(needsNotice && isNotedNow ? { acpMigrationBlockedNoted: true } : {}),
    };
  });
  if (!hasChanges) return null;
  return { projects: nextProjects, migratedCount, blockedNotices };
}

function writeBlockedTraceNotices(tracesDir: string, notices: readonly StudioAcpBlockedNotice[], logger: Pick<Console, 'warn'>): Set<string> {
  const notedSessionIds = new Set<string>();
  const nowMs = clock.nowMs();
  for (const notice of notices) {
    try {
      const wrote = appendTraceNoticeSync({
        traceDirectory: tracesDir,
        sessionId: notice.sessionId,
        vendorSessionId: 'studio-migration',
        text: notice.text,
        ts: nowMs,
      });
      if (wrote) notedSessionIds.add(notice.sessionId);
    } catch (error) {
      logger.warn(`[studio] could not write Studio migration notice for ${notice.sessionId}: ${errorMessage(error)}`);
    }
  }
  return notedSessionIds;
}

function migrateStudioToAcp({ config, configStore, tracesDir, logger }: StudioAcpMigrationDeps): void {
  const initialPlan = planStudioAcpMigration(config.projects, config.acpAgents);
  if (!initialPlan) return;
  try {
    const notedSessionIds = writeBlockedTraceNotices(tracesDir, initialPlan.blockedNotices, logger);
    let appliedPlan: StudioAcpMigrationPlan | null = null;
    const saved = configStore.save((savedConfig) => {
      const freshPlan = planStudioAcpMigration(savedConfig.projects, savedConfig.acpAgents, notedSessionIds);
      appliedPlan = freshPlan;
      if (!freshPlan) return ABORT_CONFIG_SAVE;
      savedConfig.projects = freshPlan.projects;
      return undefined;
    });
    if (!appliedPlan) return;
    if (!saved) {
      logger.warn('[studio] Studio sessions were not migrated onto ACP because config.json could not be saved, and retry at the next start');
      return;
    }
    config.projects = saved.projects;
    const plan: StudioAcpMigrationPlan = appliedPlan;
    if (plan.migratedCount > 0) {
      logger.log(`[studio] migrated ${plan.migratedCount} Studio session(s) onto ACP`);
    }
    const notedBlocked = plan.blockedNotices.filter((item) => notedSessionIds.has(item.sessionId));
    if (notedBlocked.length > 0) {
      logger.warn(`[studio] left ${notedBlocked.length} Studio session(s) stopped because their agent has no ACP row: ${notedBlocked.map((item) => item.agentId).join(', ')}`);
    }
  } catch (error) {
    logger.warn(`[studio] Studio sessions were not migrated onto ACP, and retry at the next start: ${errorMessage(error)}`);
  }
}

export { migrateStudioToAcp, moveStudioToOneOrchestrator };
