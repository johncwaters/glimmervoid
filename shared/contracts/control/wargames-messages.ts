import { z } from 'zod';
import { WargamesEvent, WargamesHistory, WargamesMatchId, WargamesMatchSummary } from '../wargames.ts';
import { loose, optionalError, requestId } from './control-fields.ts';

export const wargamesClientVariants = [
  loose('wargames-start', { spec: z.unknown(), requestId }),
  loose('wargames-abort', { matchId: WargamesMatchId, reason: z.string().max(400).optional(), requestId }),
  loose('wargames-watch', { matchId: WargamesMatchId, requestId }),
  loose('wargames-unwatch', { matchId: WargamesMatchId }),
] as const;

export const wargamesServerVariants = [
  loose('wargames-status', { matches: z.array(WargamesMatchSummary) }),
  loose('wargames-history', { history: WargamesHistory }),
  loose('wargames-events', { matchId: WargamesMatchId, events: z.array(WargamesEvent), reset: z.boolean() }),
  loose('wargames-start-result', { requestId, ok: z.boolean(), error: optionalError, matchId: WargamesMatchId.optional() }),
  loose('wargames-abort-result', { requestId, ok: z.boolean(), error: optionalError }),
  loose('wargames-watch-result', { requestId, ok: z.boolean(), error: optionalError, matchId: WargamesMatchId.optional() }),
] as const;
