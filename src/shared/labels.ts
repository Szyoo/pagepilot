/** 后台与界面共用的人话文案 */

const ERROR_TEXT: Record<string, string> = {
  TARGET_NOT_FOUND: '找不到页面上的元素（页面可能改版了）',
  TIMEOUT: '等待超时',
  ASSERT_FAILED: '页面状态和预期不符',
  NAVIGATION_FAILED: '页面跳转失败',
  PERMISSION_DENIED: '缺少网站访问权限',
  DATA_MISSING: '缺少本地数据（去设置页的保险库补充）',
  SECRET_ORIGIN_DENIED: '这个凭据不允许在当前网站使用',
  REPEAT_EXHAUSTED: '反复尝试后条件仍未满足',
  USER_ABORTED: '已被中止',
  INTERNAL: '内部错误',
};

/** 错误码转成人话，未知的错误码原样返回 */
export function describeError(code: string): string {
  return ERROR_TEXT[code] ?? code;
}

const STEP_TYPE_TEXT: Record<string, string> = {
  open: '打开网页',
  click: '点击',
  fill: '填写',
  select: '选择',
  check: '勾选',
  press: '按键',
  waitFor: '等待',
  switchTab: '切换标签页',
  handoff: '交还',
  assert: '检查页面',
  extract: '读取内容',
  if: '条件判断',
  repeat: '反复执行',
};

/** 步骤类型转成人话，未知的类型原样返回 */
export function describeStepType(type: string): string {
  return STEP_TYPE_TEXT[type] ?? type;
}

/** 步骤的说明：优先用 note，没有时用类型的人话 */
export function stepLabel(step: { type: string; note?: string }): string {
  return step.note?.trim() || describeStepType(step.type);
}
