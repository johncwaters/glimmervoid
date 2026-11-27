import { z } from 'zod';
import { WargamesEvent, WargamesHistory, WargamesMatchId, WargamesMatchSummary, WargamesPhaseClock } from '../wargames.ts';
import { loose, looseCollection, optionalError, requestId } from './control-fields.ts';

export const wargamesClientVariants = [
  loose('wargames-start', { spec: z.unknown(), requestId }),
  loose('wargames-abort', { matchId: WargamesMatchId, reason: z.string().max(400).optional(), requestId }),
  loose('wargames-watch', { matchId: WargamesMatchId, requestId }),
  loose('wargames-unwatch', { matchId: WargamesMatchId }),
] as const;

export const wargamesServerVariants = [
  looseCollection('wargames-status', { matches: z.array(WargamesMatchSummary) }),
  looseCollection('wargames-history', { history: WargamesHistory }),
  looseCollection('wargames-events', { matchId: WargamesMatchId, events: z.array(WargamesEvent), reset: z.boolean(), phaseClock: WargamesPhaseClock.nullable() }),
  loose('wargames-start-result', { requestId, ok: z.boolean(), error: optionalError, matchId: WargamesMatchId.optional() }),
  loose('wargames-abort-result', { requestId, ok: z.boolean(), error: optionalError }),
  loose('wargames-watch-result', { requestId, ok: z.boolean(), error: optionalError, matchId: WargamesMatchId.optional() }),
] as const;
