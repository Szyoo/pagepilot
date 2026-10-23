import { z } from 'zod';
import { locatorSchema, stepSchema } from './rule';

export const PROTOCOL_VERSION = 1;
export const RULE_SCHEMA_VERSION = 1;

const envelope = { v: z.literal(PROTOCOL_VERSION), id: z.string().min(1) };

export const errorCodeSchema = z.enum([
  'TARGET_NOT_FOUND',
  'TIMEOUT',
  'ASSERT_FAILED',
  'NAVIGATION_FAILED',
  'PERMISSION_DENIED',
  'DATA_MISSING',
  'SECRET_ORIGIN_DENIED',
  'REPEAT_EXHAUSTED',
  'USER_ABORTED',
  'INTERNAL',
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

const stepReportSchema = z.object({
  stepId: z.string(),
  status: z.enum(['succeeded', 'failed', 'skipped', 'handedOff']),
  attempts: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
  errorCode: errorCodeSchema.optional(),
});
export type StepReport = z.infer<typeof stepReportSchema>;

export const captureElementSchema = z.object({
  tag: z.string(),
  role: z.string().optional(),
  name: z.string().optional(),
  text: z.string().optional(),
  attrs: z.record(z.string(), z.string()),
  locator: locatorSchema,
  /** 敏感字段只记录类型，不带值 */
  sensitive: z.boolean().default(false),
});
export type CaptureElement = z.infer<typeof captureElementSchema>;

/** 插件 -> 后台 */
export const uplinkSchema = z.discriminatedUnion('kind', [
  z.object({
    ...envelope,
    kind: z.literal('hello'),
    clientId: z.string(),
    extVersion: z.string(),
    ruleSchemaVersion: z.number().int(),
    lastSeq: z.number().int().nonnegative().optional(),
  }),
  z.object({ ...envelope, kind: z.literal('ack'), seq: z.number().int().nonnegative() }),
  z.object({ ...envelope, kind: z.literal('resync') }),
  z.object({ ...envelope, kind: z.literal('ping') }),
  z.object({ ...envelope, kind: z.literal('pong') }),
  z.object({
    ...envelope,
    kind: z.literal('capture'),
    pageUrl: z.string(),
    title: z.string(),
    capturedAt: z.number(),
    elements: z.array(captureElementSchema),
  }),
  z.object({
    ...envelope,
    kind: z.literal('recording'),
    recordingId: z.string(),
    startedAt: z.number(),
    steps: z.array(stepSchema),
  }),
  z.object({
    ...envelope,
    kind: z.literal('runReport'),
    runId: z.string(),
    ruleId: z.string(),
    ruleVersion: z.number(),
    trigger: z.enum(['manual', 'auto']),
    startedAt: z.number(),
    endedAt: z.number(),
    status: z.enum(['succeeded', 'failed', 'aborted', 'handedOff']),
    inputMode: z.enum(['trusted', 'synthetic']),
    steps: z.array(stepReportSchema),
  }),
]);

/** 规则在下行消息里先按原样接收，逐条用 ruleSchema 校验，坏规则只丢弃自己 */
const rawRule = z.record(z.string(), z.unknown());

/** 后台 -> 插件 */
export const downlinkSchema = z.discriminatedUnion('kind', [
  z.object({
    ...envelope,
    kind: z.literal('snapshot'),
    seq: z.number().int().nonnegative(),
    rules: z.array(rawRule),
  }),
  z.object({
    ...envelope,
    kind: z.literal('ruleUpsert'),
    seq: z.number().int().nonnegative(),
    rule: rawRule,
  }),
  z.object({
    ...envelope,
    kind: z.literal('ruleRemove'),
    seq: z.number().int().nonnegative(),
    ruleId: z.string(),
  }),
  z.object({ ...envelope, kind: z.literal('ping') }),
  z.object({ ...envelope, kind: z.literal('pong') }),
  z.object({
    ...envelope,
    kind: z.literal('error'),
    code: z.string(),
    message: z.string().optional(),
  }),
]);

export type Uplink = z.infer<typeof uplinkSchema>;
export type Downlink = z.infer<typeof downlinkSchema>;

/** 去掉信封后的上行消息，由发送方补全 v 与 id */
export type UplinkBody = Uplink extends infer U
  ? U extends Uplink
    ? Omit<U, 'v' | 'id'>
    : never
  : never;
