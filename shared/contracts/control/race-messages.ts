import { z } from 'zod';
import { RaceId, RaceRecord } from '../race.ts';
import { requestId, loose, optionalError } from './control-fields.ts';

export const raceClientVariants = [
  loose('race-start', { spec: z.unknown(), requestId }),
  loose('race-judge', { raceId: RaceId, requestId }),
  loose('race-diff', { raceId: RaceId, contestantId: RaceId, requestId }),
] as const;

export const raceServerVariants = [
  loose('race-status', { races: z.array(RaceRecord) }),
  loose('race-start-result', { requestId, ok: z.boolean(), error: optionalError, raceId: RaceId.optional() }),
  loose('race-judge-result', { requestId, ok: z.boolean(), error: optionalError }),
  loose('race-diff-result', { requestId, ok: z.boolean(), error: optionalError, diff: z.string().optional() }),
] as const;
