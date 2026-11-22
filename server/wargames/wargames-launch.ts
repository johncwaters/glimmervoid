import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_AGENT_ID, isKnownAgentId } from '../../session/adapters/index.ts';
import { providerRefusalOf } from '../../shared/agent-models-core.ts';
import { configIssueMessage, SHELL_AGENT_ID } from '../../shared/contracts/index.ts';
import { WargamesMatchSpec } from '../../shared/contracts/wargames.ts';
import type { SeatConfig, WargamesMatchSpec as WargamesMatchSpecType } from '../../shared/contracts/wargames.ts';
import type { GlimmervoidConfig } from '../config-store.ts';
import type { ControlContext } from '../control/control-context.ts';
import { machineSkipsPermissionsByDefault } from '../session/core/session-registry-core.ts';
import type { WargamesRunner } from './wargames-runner.ts';

const SEAT_PROMPT_TIMEOUT_MS = 5 * 60 * 1000;

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
  seatRootDir?: string;
}

function buildSeatPrompt(matchId: string, seat: SeatConfig, spec: WargamesMatchSpecType): string {
  return [
    `You are playing Wargames match "${spec.title}" (${matchId}) as seat ${seat.seatId} (${seat.label}).`,
    'Rules: 6 seats on a 37-hex radius-3 map, 40 ticks, 60s per tick. First to 12 villages wins (or most villages at tick 40).',
    'Troops: raider beats envoy, envoy beats guard, guard beats raider. Envoys drain village loyalty from 100 to 0 to capture.',
    'Outer ring hexes turn barren at tick 25. Max 2 messages per tick. Contracts: resource escrow and collateral-backed NAP.',
    'Act ONLY through your Wargames MCP tools (get_state, get_reports, verify_report, read_messages, read_notes, send_message, propose_contract, accept_contract, submit_orders, write_note).',
    'Start immediately by calling get_state() to connect your seat, then loop through each phase until the match finishes.',
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
  seatRootDir = path.join(os.tmpdir(), 'glimmervoid-wargames-seats'),
}: WargamesLauncherDeps): WargamesLauncher {
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
        runSettings: { agentSetup: seat.setup, agentHome: 'operator' },
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
    });
  }

  return { start };
}
