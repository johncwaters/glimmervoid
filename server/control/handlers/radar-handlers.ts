import fs from 'node:fs';
import path from 'node:path';
import type { ClientMessageOf } from '../../../shared/contracts/index.ts';
import { errorCode, errorMessage, isMissingFileError } from '../../../shared/text.ts';
import type { ControlSocket } from '../../backend/backend-websockets.ts';
import type { ProjectEntry } from '../../config-store.ts';
import type { ControlHandlerDeps } from '../../control-handlers.ts';
import * as radarLaneCore from '../../radar/core/radar-lane-core.ts';
import { readPosthogReport } from '../../radar/radar-report.ts';
import type { ControlContext } from '../control-context.ts';
import { isExistingDirectory, replyTo } from '../control-context.ts';
import type { ControlHandlerGroup, ControlHandlerTable, InvalidReplyTable } from '../core/control-dispatch-core.ts';

function createRadarHandlers(context: ControlContext, deps: ControlHandlerDeps): ControlHandlerGroup {
  const { sessions, createProjectSession, captureOperatorAction } = context;
  const {
    config,
    getRadarStatus,
    posthogReportsDir = null,
    posthogSetIssueStatus = null,
    radarArchiveInvestigation = null,
    radarFixes = null,
  } = deps;

  async function handleGetRadarReport(msg: ClientMessageOf<'get-radar-report'>, ws: ControlSocket): Promise<void> {
    captureOperatorAction('radar', 'report');
    const result = await readPosthogReport(msg.issueId, { reportDir: posthogReportsDir || undefined });
    ws.send(JSON.stringify({
      type: 'radar-report',
      requestId: msg.requestId || null,
      ...result,
    }));
  }

  function findPosthogIssue(projectId: unknown, issueId: unknown) {
    const status = typeof getRadarStatus === 'function' ? getRadarStatus() : null;
    const projects = Array.isArray(status?.projects) ? status.projects : [];
    for (const project of projects) {
      if (String(project.projectId) !== String(projectId)) continue;
      const issues = Array.isArray(project.issues) ? project.issues : [];
      const issue = issues.find((row: { issueId?: unknown }) => String(row?.issueId) === String(issueId));
      if (issue) return { issue, projectName: project.name, host: project.host };
    }
    return null;
  }

  function listSiblingRepoDirs(): { name: string; path: string }[] {
    const entries: { name: string; path: string }[] = [];
    for (const parent of radarLaneCore.projectParentDirs(config.projects)) {
      try {
        for (const dirent of fs.readdirSync(parent, { withFileTypes: true })) {
          if (!dirent.isDirectory() || dirent.name.startsWith('.') || dirent.name === 'node_modules') continue;
          entries.push({ name: dirent.name, path: path.join(parent, dirent.name) });
        }
      } catch (err) {
        if (isMissingFileError(err)) continue;
        console.warn(`[control] posthog auto-create: cannot read ${parent}: ${errorCode(err) || errorMessage(err)}`);
      }
    }
    return entries;
  }

  function autoCreatePosthogProject(projectId: unknown, posthogProjectName: unknown): ProjectEntry | null {
    const projectMap = config.posthog?.projectMap;
    const mappedEntry = projectMap && typeof projectMap === 'object'
      ? (projectMap as Record<string, unknown>)[String(projectId)]
      : undefined;
    const mapped = String(mappedEntry ?? '').trim();
    const mappedDir = radarLaneCore.isAbsolutePathish(mapped) && isExistingDirectory(mapped) ? mapped : null;
    const match = mappedDir ? null : radarLaneCore.pickDirectoryForProjectName(posthogProjectName, listSiblingRepoDirs());
    const repoDir = mappedDir || (match && isExistingDirectory(match.path) ? match.path : null);
    if (!repoDir) return null;

    const resolvedPath = path.resolve(repoDir);
    const projectOnRepo = config.projects.find((project) => !project.repos && path.resolve(project.path) === resolvedPath);
    if (projectOnRepo) return projectOnRepo;
    const name = radarLaneCore.sanitizeSessionName(path.basename(resolvedPath))
      || radarLaneCore.sanitizeSessionName(posthogProjectName);
    if (!name) return null;
    const created = createProjectSession({ name, path: resolvedPath, agent: undefined });
    if (!created.ok) return null;
    console.log(`[control] posthog-open-session auto-created session: ${created.project.name} (${resolvedPath})`);
    return created.project;
  }

  function handleRadarOpenSession(msg: ClientMessageOf<'radar-open-session'>, ws: ControlSocket): void {
    const reply = (payload: Record<string, unknown>) => replyTo(ws, msg, 'radar-open-session-result', { ok: false, error: null, ...payload });
    const ref = radarLaneCore.validateIssueRef(msg);
    if (!ref.ok) { reply({ error: ref.error }); return; }
    captureOperatorAction('radar', 'open-session');
    const found = findPosthogIssue(ref.projectId, ref.issueId);
    if (!found) { reply({ error: 'That issue is not in the latest PostHog poll' }); return; }
    const project = radarLaneCore.resolveIssueProject(config.posthog, config.projects, ref.projectId)
      || autoCreatePosthogProject(ref.projectId, found.projectName);
    if (!project) {
      reply({ error: 'No Glimmervoid session is mapped to this PostHog project (set posthog.projectMap)' });
      return;
    }
    const sess = project.id ? sessions.get(project.id) : undefined;
    if (!sess) { reply({ error: `Session "${project.name}" is not loaded` }); return; }
    const prompt = radarLaneCore.buildIssueSessionPrompt({
      issue: found.issue,
      projectName: found.projectName,
      host: found.host,
      url: found.issue.url,
    });
    const res = sess.pasteTextWhenReady(prompt);
    if (!res.ok) { reply({ error: `Could not write to "${sess.name}" (${res.reason})` }); return; }
    sess.noteOperatorDraft();
    reply({ ok: true, sessionId: sess.id, sessionName: sess.name, pending: res.deferred === true });
    console.log(`[control] posthog-open-session: issue=${ref.issueId} -> session=${sess.name}`);
  }

  async function handleRadarIssueAction(msg: ClientMessageOf<'radar-issue-action'>, ws: ControlSocket): Promise<void> {
    const reply = (payload: Record<string, unknown>) => replyTo(ws, msg, 'radar-issue-action-result', { ok: false, error: null, ...payload });
    const ref = radarLaneCore.validateIssueRef(msg);
    if (!ref.ok) { reply({ error: ref.error }); return; }
    const found = findPosthogIssue(ref.projectId, ref.issueId);
    if (!found) { reply({ error: 'That issue is not in the latest PostHog poll' }); return; }
    const decision = radarLaneCore.decideIssueAction(msg.action);
    if (!decision.ok) { reply({ error: decision.error }); return; }
    captureOperatorAction('radar', decision.status === 'resolved' ? 'resolve' : 'suppress');
    if (!posthogSetIssueStatus) { reply({ error: 'PostHog monitoring is not running' }); return; }
    const res = await posthogSetIssueStatus({
      projectId: ref.projectId, issueId: ref.issueId, action: String(msg.action),
    });
    reply({ ok: res.ok === true, error: res.error || null, status: res.status || null });
  }

  async function handleRadarArchiveInvestigation(msg: ClientMessageOf<'radar-archive-investigation'>, ws: ControlSocket): Promise<void> {
    const reply = (payload: Record<string, unknown>) => replyTo(ws, msg, 'radar-archive-investigation-result', { ok: false, error: null, ...payload });
    const ref = radarLaneCore.validateInvestigationId(msg.id);
    if (!ref.ok) { reply({ error: ref.error }); return; }
    captureOperatorAction('radar', 'archive-investigation');
    if (!radarArchiveInvestigation) { reply({ error: 'PostHog monitoring is not running' }); return; }
    const res = await radarArchiveInvestigation({ id: ref.id });
    reply({ ok: res.ok === true, error: res.error || null });
  }

  async function handleRadarApproveFix(msg: ClientMessageOf<'radar-approve-fix'>, ws: ControlSocket): Promise<void> {
    const reply = (payload: Record<string, unknown>) => replyTo(ws, msg, 'radar-approve-fix-result', { ok: false, error: null, ...payload });
    const ref = radarLaneCore.validateInvestigationId(msg.id);
    if (!ref.ok) { reply({ error: ref.error }); return; }
    captureOperatorAction('radar', 'approve-fix');
    if (!radarFixes) { reply({ error: 'PostHog monitoring is not running' }); return; }
    const pending = radarFixes.pendingFixFor(ref.id);
    if (!pending) { reply({ error: 'That investigation has no fix waiting for approval' }); return; }
    const created = createProjectSession({
      name: `Radar fix ${radarLaneCore.sanitizeSessionName(pending.record.projectName)} #${pending.record.issueId}`,
      path: pending.fix.repoPath,
      baseBranch: pending.fix.branch,
      requireExistingPath: true,
    });
    if (!created.ok) { reply({ error: created.error }); return; }
    const session = sessions.get(created.project.id);
    if (!session) { reply({ error: `Session "${created.project.name}" is not loaded` }); return; }
    const pasted = session.pasteTextWhenReady(radarLaneCore.approvedFixSessionPrompt(pending));
    if (!pasted.ok) { reply({ error: `Could not write to "${session.name}" (${pasted.reason})` }); return; }
    const settled = await radarFixes.settlePendingFix(ref.id, { releaseBranch: false });
    if (!settled.ok) console.warn(`[control] radar-approve-fix: ${settled.error}`);
    reply({ ok: true, sessionId: session.id, sessionName: session.name });
    console.log(`[control] radar-approve-fix: investigation=${ref.id} -> session=${session.name}`);
  }

  async function handleRadarDismissFix(msg: ClientMessageOf<'radar-dismiss-fix'>, ws: ControlSocket): Promise<void> {
    const reply = (payload: Record<string, unknown>) => replyTo(ws, msg, 'radar-dismiss-fix-result', { ok: false, error: null, ...payload });
    const ref = radarLaneCore.validateInvestigationId(msg.id);
    if (!ref.ok) { reply({ error: ref.error }); return; }
    captureOperatorAction('radar', 'dismiss-fix');
    if (!radarFixes) { reply({ error: 'PostHog monitoring is not running' }); return; }
    const res = await radarFixes.settlePendingFix(ref.id, { releaseBranch: true });
    reply({ ok: res.ok === true, error: res.error || null });
  }

  function connectFrames(): readonly unknown[] {
    const radarStatus = typeof getRadarStatus === 'function' ? getRadarStatus() : null;
    return radarStatus ? [radarStatus] : [];
  }

  const handlers = {
    'get-radar-report': handleGetRadarReport,
    'radar-open-session': handleRadarOpenSession,
    'radar-issue-action': handleRadarIssueAction,
    'radar-archive-investigation': handleRadarArchiveInvestigation,
    'radar-approve-fix': handleRadarApproveFix,
    'radar-dismiss-fix': handleRadarDismissFix,
  } satisfies ControlHandlerTable;

  const invalidReplies = {
    'get-radar-report': (_msg, requestId, message) => ({ type: 'radar-report', requestId, ok: false, found: false, issueId: null, error: message }),
    'radar-open-session': (_msg, requestId, message) => ({ type: 'radar-open-session-result', requestId, ok: false, error: message }),
    'radar-issue-action': (_msg, requestId, message) => ({ type: 'radar-issue-action-result', requestId, ok: false, error: message }),
    'radar-archive-investigation': (_msg, requestId, message) => ({ type: 'radar-archive-investigation-result', requestId, ok: false, error: message }),
    'radar-approve-fix': (_msg, requestId, message) => ({ type: 'radar-approve-fix-result', requestId, ok: false, error: message }),
    'radar-dismiss-fix': (_msg, requestId, message) => ({ type: 'radar-dismiss-fix-result', requestId, ok: false, error: message }),
  } satisfies InvalidReplyTable;

  return { handlers, invalidReplies, connectFrames };
}

export { createRadarHandlers };
