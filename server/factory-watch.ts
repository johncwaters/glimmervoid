import type { Config } from '../shared/contracts/config.ts';
import { errorMessage } from './core/text-core.ts';
import { FactoryHogQLResponse, FactoryIssue, FactoryIssueQueryRow } from '../shared/contracts/factory.ts';
import type { FactoryLaneState, FactoryProjectState, FactoryWorkerEvent } from '../shared/contracts/factory.ts';
import { attributeIssues, buildIssuesSinceQuery, watchesDue } from './core/factory-core.ts';
import { extractRows } from './posthog-api.ts';
import type { PosthogResponse } from './posthog-api.ts';

export interface FactoryWatchDeps {
  config: Pick<Config, 'factory' | 'projects' | 'posthog'>;
  readLaneState: (projectId: string) => Promise<FactoryLaneState>;
  writeLaneState: (projectId: string, state: FactoryLaneState) => Promise<void>;
  serializeProject: <T>(projectId: string, operation: () => Promise<T>) => Promise<T>;
  ensureLedger: (projectId: string, projectPath: string) => Promise<{ cwd: string }>;
  runCoherence: (request: { cwd: string; args: string[] }) => Promise<string>;
  commitAndLand: (projectId: string, projectPath: string, message: string, options?: { onCommitted?: () => Promise<void> }) => Promise<void>;
  runHogQL: (projectId: number, query: string) => Promise<PosthogResponse>;
  notifyOrchestrator: (projectId: string, event: FactoryWorkerEvent) => void;
  notify: (projectName: string, message: string) => void;
  onChanged?: () => void;
  now?: () => number;
  log?: Pick<Console, 'warn'>;
}

export function createFactoryWatch({ config, readLaneState, writeLaneState, serializeProject, ensureLedger, runCoherence,
  commitAndLand, runHogQL, notifyOrchestrator, notify, onChanged = () => {}, now = Date.now, log = console }: FactoryWatchDeps) {
  const notesByProject = new Map<string, string>();
  let stopped = false;

  async function tick(project: FactoryProjectState): Promise<FactoryProjectState> {
    if (stopped || config.factory?.enabled !== true) return project;
    return serializeProject(project.projectId, async () => {
      const state = await readLaneState(project.projectId);
      const watches = state.watch ?? [];
      if (watches.length === 0) return { ...project, watches, note: notesByProject.get(project.projectId) ?? null };
      const projectPath = config.projects.find((candidate) => candidate.id === project.projectId)?.path;
      if (!projectPath) return project;
      const mapping = config.factory?.watchProjects?.find((candidate) => candidate.project === project.projectId);
      const apiKey = config.posthog?.apiKey;
      const unwatchedReason = !mapping ? 'no PostHog project was mapped' : typeof apiKey !== 'string' || !apiKey ? 'no PostHog API key was available' : null;
      let note: string | null = unwatchedReason ? `Watch: ${unwatchedReason}; windows elapse without error tracking` : null;
      let isQueryFailed = false;
      let issues: FactoryIssue[] = [];
      if (mapping && !unwatchedReason) {
        try {
          const sinceIso = watches.reduce((earliest, watch) => watch.mergedAt < earliest ? watch.mergedAt : earliest, watches[0].mergedAt);
          const response = await runHogQL(mapping.posthogProjectId, buildIssuesSinceQuery(sinceIso));
          if (!response.ok) throw new Error(response.error);
          const hogQLResponse = FactoryHogQLResponse.safeParse(response.body);
          if (!hogQLResponse.success) throw new Error('PostHog returned a HogQL response without a results array');
          const rows = extractRows(hogQLResponse.data);
          if (rows.length !== hogQLResponse.data.results.length) throw new Error('PostHog returned HogQL rows that could not be read');
          issues = rows.map((raw) => {
            const row = FactoryIssueQueryRow.parse(raw);
            return FactoryIssue.parse({ issueId: row.issueId, firstSeenMs: Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(row.firstSeen) ? row.firstSeen : `${row.firstSeen}Z`), framePaths: row.framePaths });
          });
        } catch (error) {
          isQueryFailed = true;
          note = `Watch: ${errorMessage(error)}; windows carry forward until a query succeeds`;
        }
      }
      if (note) log.warn(`[factory] ${project.projectId}: ${note}`);
      if (stopped || config.factory?.enabled !== true) return project;
      if (note) notesByProject.set(project.projectId, note);
      if (!note) notesByProject.delete(project.projectId);
      const discovered = attributeIssues({ watches, issues });
      const breachedWatches = watches.map((watch) => {
        const issuesById = new Map((watch.breaches ?? []).map((issue) => [issue.issueId, issue]));
        for (const breach of discovered) {
          if (breach.watch.workId !== watch.workId || issuesById.has(breach.issue.issueId)) continue;
          issuesById.set(breach.issue.issueId, breach.issue);
        }
        return { ...watch, breaches: [...issuesById.values()] };
      });
      const breaches = breachedWatches.flatMap((watch) => watch.breaches.map((issue) => ({ watch, issue })));
      if (discovered.length > 0) await writeLaneState(project.projectId, { ...state, watch: breachedWatches });
      const breachedIds = new Set(breaches.map(({ watch }) => watch.workId));
      const unbreachedWatches = watches.filter((watch) => !breachedIds.has(watch.workId));
      const due = watchesDue(unbreachedWatches, now(), (config.factory?.watchWindowMinutes ?? 30) * 60_000);
      const stillOpen = isQueryFailed ? unbreachedWatches : due.stillOpen;
      const elapsed = isQueryFailed ? [] : due.elapsed;
      if (breaches.length === 0 && elapsed.length === 0) return { ...project, watches, note };
      const verifications = elapsed.map((watch) => unwatchedReason
        ? { watch, id: `unwatched-${watch.workId}`, evidence: `Watch window elapsed after ${watch.mergedSha} merged at ${watch.mergedAt}, but ${unwatchedReason}, so no errors were observed` }
        : { watch, id: `watch-${watch.workId}`, evidence: `Clean watch window after ${watch.mergedSha} merged at ${watch.mergedAt}` });
      const ledger = await ensureLedger(project.projectId, projectPath);
      const filedBreachKeys = new Set((await readLaneState(project.projectId)).filedBreaches ?? []);
      for (const { watch, issue } of breaches) {
        if (filedBreachKeys.has(breachKeyOf(watch.workId, issue.issueId))) continue;
        await runCoherence({ cwd: ledger.cwd, args: ['defect', `Factory breach on ${watch.workId}: issue ${issue.issueId}`,
          '--evidence', `Issue first seen at ${new Date(issue.firstSeenMs).toISOString()} after merge ${watch.mergedSha}; frames ${JSON.stringify(issue.framePaths)}`,
          '--session', 'glimmervoid-factory'] });
      }
      for (const { watch, id, evidence } of verifications) {
        await runCoherence({ cwd: ledger.cwd, args: ['consequence', 'add', `verification:${id}`, 'verifies', `work:${watch.workId}`,
          '--evidence', evidence, '--session', 'glimmervoid-factory', '--json'] });
      }
      const markBreachesFiled = async () => {
        const committedState = await readLaneState(project.projectId);
        const committedKeys = breaches.map(({ watch, issue }) => breachKeyOf(watch.workId, issue.issueId));
        await writeLaneState(project.projectId, { ...committedState, filedBreaches: [...new Set([...(committedState.filedBreaches ?? []), ...committedKeys])] });
      };
      await commitAndLand(project.projectId, projectPath, `factory: watch ${project.projectId}`, { onCommitted: markBreachesFiled });
      const landedState = await readLaneState(project.projectId);
      const trustedVerificationsById = new Map((landedState.trustedVerifications ?? []).map((verification) => [verification.id, verification]));
      for (const { watch, id } of verifications) trustedVerificationsById.set(id, { id, sha: watch.mergedSha });
      const openWorkIds = new Set(stillOpen.map((watch) => watch.workId));
      await writeLaneState(project.projectId, { ...landedState, watch: stillOpen, trustedVerifications: [...trustedVerificationsById.values()],
        filedBreaches: (landedState.filedBreaches ?? []).filter((breachKey) => openWorkIds.has(breachKey.slice(0, breachKey.indexOf(':')))) });
      onChanged();
      for (const workId of breachedIds) {
        for (const issueId of new Set(breaches.filter(({ watch }) => watch.workId === workId).map(({ issue }) => issue.issueId))) {
          const message = `[factory] breach on ${workId}: issue ${issueId}`;
          notifyOrchestrator(project.projectId, { workId, event: 'breach', detail: `issue ${issueId}` });
          notify(project.projectName, message);
        }
      }
      for (const watch of elapsed) notifyOrchestrator(project.projectId, { workId: watch.workId, event: unwatchedReason ? 'verified unwatched' : 'verified' });
      return { ...project, watches: stillOpen, note,
        unverifiedCompletedWork: project.unverifiedCompletedWork.filter((workId) => !elapsed.some((watch) => watch.workId === workId)) };
    });
  }

  return { tick, stop: () => { stopped = true; } };
}

function breachKeyOf(workId: string, issueId: string): string {
  return `${workId}:${issueId}`;
}
