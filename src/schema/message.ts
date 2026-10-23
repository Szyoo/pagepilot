import { z } from 'zod';
import { locatorSchema, ruleSchema, stepSchema } from './rule';

/** 插件 -> 后台 */
export const uplinkSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('capture'),
    pageUrl: z.string(),
    title: z.string(),
    capturedAt: z.number(),
    elements: z.array(
      z.object({
        tag: z.string(),
        text: z.string().optional(),
        attrs: z.record(z.string(), z.string()),
        locator: locatorSchema,
        /** 敏感字段只记录类型，不带值 */
        sensitive: z.boolean().default(false),
      }),
    ),
  }),
  z.object({
    kind: z.literal('recording'),
    recordingId: z.string(),
    startedAt: z.number(),
    steps: z.array(stepSchema),
  }),
  z.object({
    kind: z.literal('runReport'),
    ruleId: z.string(),
    ruleVersion: z.number(),
    ok: z.boolean(),
    failedStepId: z.string().optional(),
    error: z.string().optional(),
  }),
]);

/** 后台 -> 插件 */
export const downlinkSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ruleUpsert'), rule: ruleSchema }),
  z.object({ kind: z.literal('ruleRemove'), ruleId: z.string() }),
  z.object({
    kind: z.literal('snapshot'),
    rules: z.array(ruleSchema),
  }),
]);

export type Uplink = z.infer<typeof uplinkSchema>;
export type Downlink = z.infer<typeof downlinkSchema>;
