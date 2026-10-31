import { configIssueMessage } from '../../../shared/contracts/index.ts';
import type { ClientMessageOf } from '../../../shared/contracts/index.ts';
import { CommunityActionRequest } from '../../../shared/contracts/community.ts';
import type { CommunityActionResult } from '../../../shared/contracts/community.ts';
import type { ControlSocket } from '../../backend/backend-websockets.ts';
import type { ControlHandlerDeps } from '../../control-handlers.ts';
import * as radarLaneCore from '../../radar/core/radar-lane-core.ts';
import type { ControlContext } from '../control-context.ts';
import { replyTo } from '../control-context.ts';
import type { ControlHandlerGroup, ControlHandlerTable, InvalidReplyTable } from '../core/control-dispatch-core.ts';

function createCommunityHandlers(context: ControlContext, deps: ControlHandlerDeps): ControlHandlerGroup {
  const { sessions, createProjectSession, captureOperatorAction } = context;
  const { config, getCommunityStatus = null, community = null } = deps;

  async function handleCommunityAction(msg: ClientMessageOf<'community-action'>, ws: ControlSocket): Promise<void> {
    const reply = (outcome: Omit<CommunityActionResult, 'key'>) => replyTo(ws, msg, 'community-action-result', { key: msg.key, ...outcome });
    const parsed = CommunityActionRequest.safeParse(msg);
    if (!parsed.success) { reply({ ok: false, error: configIssueMessage(parsed.error) }); return; }
    captureOperatorAction('community', parsed.data.action);
    if (!community) { reply({ ok: false, error: 'The community lane is not running' }); return; }
    reply(await community.submitAction(parsed.data));
  }

  function handleOpenCommunitySession(msg: ClientMessageOf<'open-community-session'>, ws: ControlSocket): void {
    const reply = (payload: Record<string, unknown>) => replyTo(ws, msg, 'open-community-session-result', { ok: false, error: null, key: msg.key, ...payload });
    captureOperatorAction('community', 'open-session');
    if (!community) { reply({ error: 'The community lane is not running' }); return; }
    const seeded = community.sessionPromptFor(msg.key);
    if (!seeded.ok) { reply({ error: seeded.error }); return; }
    const project = config.projects.find((candidate) => candidate.id === msg.projectId && !candidate.repos);
    if (!project) { reply({ error: 'Pick a single-repository session to start from' }); return; }
    const created = createProjectSession({
      name: radarLaneCore.sanitizeSessionName(`Community ${seeded.title}`) ?? 'Community question',
      path: project.path,
      agent: project.agent,
      dangerouslySkipPermissions: false,
    });
    if (!created.ok) { reply({ error: created.error }); return; }
    const session = sessions.get(created.project.id);
    if (!session) { reply({ error: `Session "${created.project.name}" is not loaded` }); return; }
    const pasted = session.pasteTextWhenReady(seeded.prompt);
    if (!pasted.ok) { reply({ error: `Could not write to "${session.name}" (${pasted.reason})` }); return; }
    reply({ ok: true, sessionId: session.id, sessionName: session.name, pending: pasted.deferred === true });
    console.log(`[control] open-community-session: item=${msg.key} -> session=${session.name}`);
  }

  function connectFrames(): readonly unknown[] {
    const communityStatus = getCommunityStatus?.() ?? null;
    return communityStatus ? [communityStatus] : [];
  }

  const handlers = {
    'community-action': handleCommunityAction,
    'open-community-session': handleOpenCommunitySession,
  } satisfies ControlHandlerTable;

  const invalidReplies = {
    'community-action': (msg, requestId, message) => ({ type: 'community-action-result', requestId, key: typeof msg?.key === 'string' ? msg.key : '', ok: false, error: message }),
    'open-community-session': (_msg, requestId, message) => ({ type: 'open-community-session-result', requestId, ok: false, error: message }),
  } satisfies InvalidReplyTable;

  return { handlers, invalidReplies, connectFrames };
}

export { createCommunityHandlers };
