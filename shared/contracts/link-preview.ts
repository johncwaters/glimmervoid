import { z } from 'zod';

export const LinkPreview = z.object({
  title: z.string().optional(),
  iconDataUrl: z.string().startsWith('data:image/').optional(),
});

export type LinkPreview = z.infer<typeof LinkPreview>;
