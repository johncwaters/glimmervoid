import { z } from 'zod';

export const PackBridgeTopic = z.enum(['sessions', 'focus', 'theme', 'my-prs', 'usage', 'attention', 'team-reviews']);
export type PackBridgeTopic = z.infer<typeof PackBridgeTopic>;
