import { z } from 'zod';
import { isMatchAll } from '../shared/glob';
import { extractPlaceholders } from '../shared/template';

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
  /** 目标位于 iframe 时，从顶层到目标 frame 的选择器链 */
  frame: z.array(z.string()).optional(),
});

export type Locator = z.infer<typeof locatorSchema>;

/** 条件：waitFor / assert / if / repeat / handoff 共用 */
export type Condition =
  | {
      kind: 'element';
      target: Locator;
      visible: boolean;
      text?: string | undefined;
      textMatch?: string | undefined;
      /** 输入框已填满：有 maxlength 时长度达到它，否则只要非空（用于等用户输完验证码） */
      filled?: boolean | undefined;
      /** 输入框内容至少这么多字符（验证码位数与输入框的 maxlength 不一致时用它） */
      minLength?: number | undefined;
    }
  | { kind: 'url'; pattern: string }
  | { kind: 'not'; condition: Condition }
  | { kind: 'all'; conditions: Condition[] }
  | { kind: 'any'; conditions: Condition[] };

export const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('element'),
      target: locatorSchema,
      visible: z.boolean().default(true),
      text: z.string().optional(),
      textMatch: z.string().optional(),
      filled: z.boolean().optional(),
      minLength: z.number().int().positive().optional(),
    }),
    z.object({ kind: z.literal('url'), pattern: z.string().min(1) }),
    z.object({ kind: z.literal('not'), condition: conditionSchema }),
    z.object({ kind: z.literal('all'), conditions: z.array(conditionSchema).min(1) }),
    z.object({ kind: z.literal('any'), conditions: z.array(conditionSchema).min(1) }),
  ]),
);

/** 文本模板，支持 {{profile.x}} / {{secret.x}} / {{var.x}}，仅在本地解析 */
const template = z.string();

const baseShape = {
  id: z.string().min(1),
  note: z.string().optional(),
  timeoutMs: z.number().int().positive().default(15_000),
  retries: z.number().int().min(0).default(0),
  /** 失败时是否跳过而不是中断整条规则 */
  optional: z.boolean().default(false),
};
const baseSchema = z.object(baseShape);
type StepBase = z.infer<typeof baseSchema>;

const leafStepSchema = z.discriminatedUnion('type', [
  z.object({
    ...baseShape,
    type: z.literal('open'),
    url: template,
    newTab: z.boolean().default(false),
    /** 已经停在同一页面（网站与路径相同）时默认不再打开；为 true 时总是重新打开 */
    force: z.boolean().default(false),
  }),
  z.object({ ...baseShape, type: z.literal('click'), target: locatorSchema }),
  z.object({
    ...baseShape,
    type: z.literal('fill'),
    target: locatorSchema,
    value: template,
    clear: z.boolean().default(true),
  }),
  z.object({ ...baseShape, type: z.literal('select'), target: locatorSchema, value: template }),
  z.object({ ...baseShape, type: z.literal('check'), target: locatorSchema, checked: z.boolean() }),
  z.object({
    ...baseShape,
    type: z.literal('press'),
    key: z.string().min(1),
    target: locatorSchema.optional(),
  }),
  z.object({
    ...baseShape,
    type: z.literal('waitFor'),
    until: z.enum(['condition', 'navigation', 'newTab', 'idle', 'delay']),
    condition: conditionSchema.optional(),
    urlPattern: z.string().optional(),
    delayMs: z.number().int().positive().optional(),
  }),
  z.object({ ...baseShape, type: z.literal('switchTab'), urlPattern: z.string().min(1) }),
  /** 交还给用户：人机验证、选择预约时间等必须人工完成的环节 */
  z.object({
    ...baseShape,
    type: z.literal('handoff'),
    message: z.string(),
    resumeWhen: z.enum(['userConfirm', 'navigation', 'condition']).default('userConfirm'),
    until: conditionSchema.optional(),
    /** 为 true 表示到此结束，不再继续后续步骤 */
    final: z.boolean().default(false),
  }),
  z.object({ ...baseShape, type: z.literal('assert'), condition: conditionSchema }),
  z.object({
    ...baseShape,
    type: z.literal('extract'),
    target: locatorSchema,
    saveAs: z.string().min(1),
    /** 为空时读取文本 */
    attr: z.string().optional(),
  }),
]);

type LeafStep = z.infer<typeof leafStepSchema>;

export type IfStep = StepBase & {
  type: 'if';
  condition: Condition;
  then: Step[];
  else?: Step[] | undefined;
};

export type RepeatStep = StepBase & {
  type: 'repeat';
  steps: Step[];
  until: Condition;
  reload: boolean;
  intervalMs: number;
  jitterMs: number;
  maxAttempts: number;
  maxDurationMs?: number | undefined;
  onExhausted: 'fail' | 'handoff';
  notify: boolean;
  sound: boolean;
};

export type Step = LeafStep | IfStep | RepeatStep;

const ifStepSchema = z.object({
  ...baseShape,
  type: z.literal('if'),
  condition: conditionSchema,
  // biome-ignore lint/suspicious/noThenProperty: 规则格式中 if 的分支字段就叫 then
  then: z.array(z.lazy((): z.ZodType<Step> => stepSchema)).min(1),
  else: z.array(z.lazy((): z.ZodType<Step> => stepSchema)).optional(),
});

const repeatStepSchema = z.object({
  ...baseShape,
  type: z.literal('repeat'),
  steps: z.array(z.lazy((): z.ZodType<Step> => stepSchema)).min(1),
  until: conditionSchema,
  reload: z.boolean().default(false),
  intervalMs: z.number().int().positive().default(5000),
  jitterMs: z.number().int().min(0).default(0),
  maxAttempts: z.number().int().positive().default(100),
  maxDurationMs: z.number().int().positive().optional(),
  onExhausted: z.enum(['fail', 'handoff']).default('fail'),
  notify: z.boolean().default(true),
  /** 提示音默认关闭；还需要用户在设置页打开声音开关才会播放 */
  sound: z.boolean().default(false),
});

export const stepSchema: z.ZodType<Step> = z.lazy(() =>
  z.union([leafStepSchema, ifStepSchema, repeatStepSchema]),
);

export const MAX_NESTING = 3;

export const ruleSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    /** 单调递增，用于增量同步与回滚 */
    version: z.number().int().nonnegative(),
    enabled: z.boolean().default(true),
    /** auto：打开匹配页面时自动运行，需用户在扩展中逐条开启 */
    trigger: z.enum(['manual', 'auto']).default('manual'),
    inputMode: z.enum(['auto', 'trusted', 'synthetic']).default('auto'),
    match: z.object({
      /** 匹配 URL 的 glob 列表，不允许匹配全部网站 */
      urls: z.array(z.string().min(1)).min(1),
      exclude: z.array(z.string().min(1)).default([]),
    }),
    /** 声明规则需要的本地数据，使用前由用户在设置页填写 */
    requires: z
      .object({
        profile: z.array(z.string()).default([]),
        secret: z.array(z.string()).default([]),
      })
      .default({ profile: [], secret: [] }),
    /** 登录状态判断与登录流程 */
    login: z.object({ loggedIn: conditionSchema, steps: z.array(stepSchema).min(1) }).optional(),
    steps: z.array(stepSchema).min(1),
  })
  .superRefine((rule, ctx) => {
    const issue = (message: string, path: (string | number)[] = []) =>
      ctx.addIssue({ code: 'custom', message, path });

    for (const [i, u] of rule.match.urls.entries()) {
      if (isMatchAll(u)) issue('match.urls 不允许匹配全部网站', ['match', 'urls', i]);
    }

    const ids = new Set<string>();
    const need = { profile: new Set<string>(), secret: new Set<string>() };

    const visit = (steps: Step[], depth: number, path: (string | number)[]) => {
      for (const [i, step] of steps.entries()) {
        const at = [...path, i];
        if (ids.has(step.id)) issue(`步骤 id 重复：${step.id}`, [...at, 'id']);
        ids.add(step.id);
        checkStep(step, at);
        if (step.type === 'if' || step.type === 'repeat') {
          if (depth + 1 > MAX_NESTING) issue(`嵌套超过 ${MAX_NESTING} 层`, at);
          if (step.type === 'if') {
            visit(step.then, depth + 1, [...at, 'then']);
            if (step.else) visit(step.else, depth + 1, [...at, 'else']);
          } else {
            visit(step.steps, depth + 1, [...at, 'steps']);
          }
        }
      }
    };

    const checkStep = (step: Step, at: (string | number)[]) => {
      for (const { text, field } of stringsOf(step)) {
        for (const ph of extractPlaceholders(text)) {
          if (ph.scope === 'var') continue;
          if (ph.scope === 'secret' && !(step.type === 'fill' && field === 'value')) {
            issue('{{secret.x}} 只能出现在 fill 步骤的 value 中', [...at, field]);
          }
          need[ph.scope].add(ph.key);
        }
      }
      if (step.type === 'waitFor') {
        if (step.until === 'condition' && !step.condition)
          issue('waitFor(condition) 需要 condition', at);
        if (step.until === 'delay' && !step.delayMs) issue('waitFor(delay) 需要 delayMs', at);
      }
      if (step.type === 'handoff' && step.resumeWhen === 'condition' && !step.until) {
        issue('handoff(condition) 需要 until', at);
      }
    };

    if (rule.login) visit(rule.login.steps, 0, ['login', 'steps']);
    visit(rule.steps, 0, ['steps']);

    for (const key of need.profile) {
      if (!rule.requires.profile.includes(key)) issue(`requires.profile 缺少 ${key}`, ['requires']);
    }
    for (const key of need.secret) {
      if (!rule.requires.secret.includes(key)) issue(`requires.secret 缺少 ${key}`, ['requires']);
    }
  });

export type Rule = z.infer<typeof ruleSchema>;

/** 步骤自身的全部字符串字段（不含嵌套的子步骤），field 为顶层字段名 */
function stringsOf(step: Step): { text: string; field: string }[] {
  const out: { text: string; field: string }[] = [];
  const walk = (v: unknown, field: string) => {
    if (typeof v === 'string') out.push({ text: v, field });
    else if (Array.isArray(v)) for (const x of v) walk(x, field);
    else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x, field);
  };
  for (const [key, value] of Object.entries(step)) {
    if (key === 'then' || key === 'else' || key === 'steps') continue;
    walk(value, key);
  }
  return out;
}

/** 规则中所有步骤（含嵌套与登录步骤），按出现顺序 */
export function flattenSteps(rule: Pick<Rule, 'steps' | 'login'>): Step[] {
  const out: Step[] = [];
  const walk = (steps: Step[]) => {
    for (const s of steps) {
      out.push(s);
      if (s.type === 'if') {
        walk(s.then);
        if (s.else) walk(s.else);
      } else if (s.type === 'repeat') walk(s.steps);
    }
  };
  if (rule.login) walk(rule.login.steps);
  walk(rule.steps);
  return out;
}
