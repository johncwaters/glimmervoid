import { z } from 'zod';
import { RaceId, RaceRecord } from '../race.ts';
import { requestId, loose, optionalError } from './control-fields.ts';

export const raceClientVariants = [
  loose('race-start', { spec: z.unknown(), requestId }),
] as const;

export const raceServerVariants = [
  loose('race-status', { races: z.array(RaceRecord) }),
  loose('race-start-result', { requestId, ok: z.boolean(), error: optionalError, raceId: RaceId.optional() }),
] as const;
