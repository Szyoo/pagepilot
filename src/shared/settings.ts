import { z } from 'zod';

export const settingsSchema = z.object({
  backendUrl: z.string().url().optional(),
  token: z.string().optional(),
  /** 实时通道优先级 */
  transport: z.enum(['websocket', 'sse', 'poll']).default('websocket'),
  pollIntervalSec: z.number().int().positive().default(60),
});

export type Settings = z.infer<typeof settingsSchema>;
