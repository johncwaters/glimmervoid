import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_AGENT_ID, isKnownAgentId } from '../../session/adapters/index.ts';
import { providerRefusalOf } from '../../shared/agent-models-core.ts';
import { configIssueMessage, SHELL_AGENT_ID } from '../../shared/contracts/index.ts';
import { WargamesMatchSpec } from '../../shared/contracts/wargames.ts';
import type { SeatConfig, WargamesMatchSpec as WargamesMatchSpecType } from '../../shared/contracts/wargames.ts';
import { STATES } from '../../shared/states.ts';
import type { GlimmervoidConfig } from '../config-store.ts';
import type { ControlContext } from '../control/control-context.ts';
import { machineSkipsPermissionsByDefault } from '../session/core/session-registry-core.ts';
import type { WargamesRunner } from './wargames-runner.ts';

const SEAT_PROMPT_TIMEOUT_MS = 5 * 60 * 1000;
const SEAT_NUDGE_TIMEOUT_MS = 15_000;
const IDLE_NUDGE_STATES: ReadonlySet<string> = new Set([STATES.COMPLETE, STATES.IDLE]);

type WargamesStartResult = { ok: true; matchId: string; error: string | null } | { ok: false; error: string };
type WargamesStartPermissions = { dangerouslySkipPermissions: boolean; saneYolo: boolean };

export interface WargamesLauncher {
  start(candidate: unknown, permissions?: WargamesStartPermissions): Promise<WargamesStartResult>;
}

interface WargamesLauncherDeps {
  wargames: Pick<WargamesRunner, 'startMatch'> | null;
  sessions: ControlContext['sessions'];
  config: GlimmervoidConfig;
  createProjectSession: ControlContext['createProjectSession'];
  discardSession?: (sessionId: string) => Promise<unknown>;
  seatRootDir?: string;
}

function buildSeatPrompt(matchId: string, seat: SeatConfig, spec: WargamesMatchSpecType): string {
  return [
    `You are playing Wargames match "${spec.title}" (${matchId}) as seat ${seat.seatId} (${seat.label}).`,
    `Rules: 6 seats on a 37-hex radius-3 map, ${spec.maxTicks} ticks, ${spec.tickDeadlineSeconds}s per tick. First to 12 villages wins (or most villages at tick ${spec.maxTicks}).`,
    'Troops & costs: raider (12g/8o) beats envoy (25g/20o), envoy beats guard (8g/12o), guard beats raider. Envoys drain village loyalty from 100 to 0 to capture.',
    'Important mechanics: attacking armies always return home after battle (newly captured villages start at loyalty 25 with 0 garrison, so reinforce or train immediately). March to your own village to reinforce it. Outer ring hexes turn barren at tick 25.',
    'Diplomacy & tribes: max 2 messages/tick; attach signed (or modified) reports via attachedReport on send_message and verify others with verify_report. Contracts: resource escrow and collateral-backed NAP. Tribes (max 2 seats) use tribe_join / tribe_leave orders and share a tribe channel.',
    'Pacing: Act ONLY through your 10 Wargames MCP tools. When finished with talk or contracts, call get_state({ ready: true, wait_for_change: true }) to fast-advance and wait cleanly for the next phase without polling.',
    'Start immediately by calling get_state() to connect your seat, then loop through every phase until the match finishes.',
  ].join('\n');
}

function refusalOf(spec: WargamesMatchSpecType): string | null {
  const invalidSeat = spec.seats.find((seat) => seat.setup.agent === SHELL_AGENT_ID || !isKnownAgentId(seat.setup.agent));
  if (invalidSeat) return `"${invalidSeat.setup.agent}" cannot play Wargames: a seat must be a coding agent`;
  return providerRefusalOf(spec.seats.map((seat) => seat.setup));
}

export function createWargamesLauncher({
  wargames,
  sessions,
  config,
  createProjectSession,
  discardSession,
  seatRootDir = path.join(os.tmpdir(), 'glimmervoid-wargames-seats'),
}: WargamesLauncherDeps): WargamesLauncher {
  function nudgeIdleSeats(tick: number, phase: string, sessionIds: readonly string[]): void {
    for (const sessionId of sessionIds) {
      const session = sessions.get(sessionId);
      if (!session || session._destroyed || !IDLE_NUDGE_STATES.has(session.state)) continue;
      session.deliver(`Tick ${tick} (${phase} phase) started. Call get_state() to continue.`, {
        when: 'idle',
        submit: true,
        timeoutMs: SEAT_NUDGE_TIMEOUT_MS,
      });
    }
  }

  function cleanupMatchSessions(sessionIds: readonly string[]): void {
    for (const sessionId of sessionIds) {
      if (discardSession) {
        void discardSession(sessionId).catch(() => {});
        continue;
      }
      sessions.get(sessionId)?.destroy();
    }
  }

  async function start(candidate: unknown, permissions?: WargamesStartPermissions): Promise<WargamesStartResult> {
    if (!wargames) return { ok: false, error: 'Wargames is not running' };
    const parsed = WargamesMatchSpec.safeParse(candidate);
    if (!parsed.success) return { ok: false, error: configIssueMessage(parsed.error) };
    const spec = parsed.data;
    const refusal = refusalOf(spec);
    if (refusal) return { ok: false, error: refusal };
    const skipPermissions = permissions ? permissions.dangerouslySkipPermissions : machineSkipsPermissionsByDefault(config);
    const saneYolo = permissions ? permissions.saneYolo : !skipPermissions;
    return wargames.startMatch(spec, async (matchId, seat, bindSession) => {
      const seatDir = path.join(seatRootDir, matchId, seat.seatId);
      await fsp.mkdir(seatDir, { recursive: true });
      const agent = seat.setup.agent;
      const created = createProjectSession({
        name: `Wargames ${matchId.slice(-6)} - ${seat.seatId}`,
        path: seatDir,
        agent: agent === DEFAULT_AGENT_ID ? undefined : agent,
        dangerouslySkipPermissions: skipPermissions,
        saneYolo,
        requireExistingPath: true,
        runSettings: { agentSetup: seat.setup, agentHome: 'operator', attentionOwner: 'wargames' },
      });
      if (!created.ok) return { ok: false as const, error: created.error };
      bindSession(created.project.id);
      const session = sessions.get(created.project.id);
      if (!session) return { ok: false as const, error: `Seat session "${created.project.name}" did not load` };
      const delivered = session.deliver(buildSeatPrompt(matchId, seat, spec), {
        when: 'ready',
        submit: true,
        timeoutMs: SEAT_PROMPT_TIMEOUT_MS,
      });
      if (!delivered.ok) {
        session.destroy();
        return { ok: false as const, error: `Could not prompt seat ${seat.seatId} (${delivered.reason})` };
      }
      return { ok: true as const, sessionId: session.id };
    }, {
      onPhaseChanged: (_matchId, tick, phase, _status, sessionIds) => nudgeIdleSeats(tick, phase, sessionIds),
      onMatchEnded: (_matchId, sessionIds) => cleanupMatchSessions(sessionIds),
    });
  }

  return { start };
}
