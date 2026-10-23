import { z } from 'zod';

/** 元素定位：多种策略按顺序回退，提升页面改版后的存活率 */
export const locatorSchema = z.object({
  strategies: z
    .array(
      z.object({
        kind: z.enum(['css', 'aria', 'text', 'xpath', 'testid']),
        value: z.string().min(1),
      }),
    )
    .min(1),
  /** 目标位于 iframe 时的层级选择器 */
  frame: z.array(z.string()).optional(),
});

/** 文本模板，支持 {{profile.x}} / {{secret.x}} / {{var.x}}，仅在本地解析 */
const template = z.string();

const base = {
  id: z.string().min(1),
  note: z.string().optional(),
  timeoutMs: z.number().int().positive().default(15_000),
  retries: z.number().int().min(0).default(0),
  /** 失败时是否跳过而不是中断整条规则 */
  optional: z.boolean().default(false),
};

export const stepSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('open'), url: template, newTab: z.boolean().default(false) }),
  z.object({ ...base, type: z.literal('click'), target: locatorSchema }),
  z.object({ ...base, type: z.literal('fill'), target: locatorSchema, value: template }),
  z.object({ ...base, type: z.literal('select'), target: locatorSchema, value: template }),
  z.object({ ...base, type: z.literal('check'), target: locatorSchema, checked: z.boolean() }),
  z.object({
    ...base,
    type: z.literal('press'),
    key: z.string(),
    target: locatorSchema.optional(),
  }),
  z.object({
    ...base,
    type: z.literal('waitFor'),
    until: z.enum(['element', 'navigation', 'newTab', 'idle', 'delay']),
    target: locatorSchema.optional(),
    urlPattern: z.string().optional(),
    delayMs: z.number().int().positive().optional(),
  }),
  z.object({ ...base, type: z.literal('switchTab'), urlPattern: z.string() }),
  /** 交还给用户：验证码、选择预约时间等必须人工完成的环节 */
  z.object({
    ...base,
    type: z.literal('handoff'),
    message: z.string(),
    resumeWhen: z.enum(['userConfirm', 'navigation', 'element']).default('userConfirm'),
    target: locatorSchema.optional(),
    /** 为空表示到此结束，不再继续后续步骤 */
    final: z.boolean().default(false),
  }),
  z.object({
    ...base,
    type: z.literal('assert'),
    target: locatorSchema,
    text: z.string().optional(),
  }),
  z.object({ ...base, type: z.literal('extract'), target: locatorSchema, saveAs: z.string() }),
]);

export const ruleSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  /** 单调递增，用于增量同步与回滚 */
  version: z.number().int().nonnegative(),
  enabled: z.boolean().default(true),
  match: z.object({
    /** 匹配 URL 的 glob 列表 */
    urls: z.array(z.string()).min(1),
  }),
  /** 声明规则需要的本地数据，使用前由用户在设置页填写 */
  requires: z
    .object({
      profile: z.array(z.string()).default([]),
      secret: z.array(z.string()).default([]),
    })
    .default({ profile: [], secret: [] }),
  steps: z.array(stepSchema).min(1),
});

export type Locator = z.infer<typeof locatorSchema>;
export type Step = z.infer<typeof stepSchema>;
export type Rule = z.infer<typeof ruleSchema>;
