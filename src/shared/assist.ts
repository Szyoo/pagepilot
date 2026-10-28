// 「请 AI 看看」：把运行中断的上下文整理成发给 AI 的第一条消息与系统提示。
// 只用规则自身的信息（名称、步骤类型与说明）、错误码、页面地址（只留 origin + path）与页面上可见的交互元素概要；
// 不包含任何输入框的值、本地数据（个人信息、凭据）与占位符解析结果。

import type { InspectElement } from './content-api';
import { describeError, describeStepType, stepLabel } from './labels';
import type { StuckView } from './rpc';

/** 失败步骤前后各取几步 */
export const ASSIST_NEARBY = 3;
/** 页面概要最多列出的元素个数与每个元素文字的长度（与内容脚本一致，这里再兜一次底） */
export const ASSIST_MAX_ELEMENTS = 120;
export const ASSIST_MAX_TEXT = 60;

export interface AssistContext {
  ruleName: string;
  stuck: Pick<StuckView, 'failedStepId' | 'failedIndex' | 'errorCode' | 'suggestedIndex' | 'steps'>;
  /** 运行所在标签页的地址；会去掉查询串与 hash */
  pageUrl?: string | undefined;
  /** 页面上可见的交互元素概要（capture.inspect）；取不到时省略 */
  elements?: InspectElement[] | undefined;
  /** 是否附了截图 */
  screenshot?: boolean;
}

/** 只保留 origin + path：查询串与 hash 里可能有令牌或个人信息；非 http(s) 地址不发 */
export function safePageUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.origin}${u.pathname}`;
  } catch {
    return null;
  }
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

function elementLine(el: InspectElement): string {
  const kind = el.role && el.role !== el.tag ? `${el.tag}（${el.role}）` : el.tag;
  if (el.sensitive) return `- ${kind}［敏感字段，内容已隐去］`;
  const text = el.text ? oneLine(el.text).slice(0, ASSIST_MAX_TEXT) : '';
  return text ? `- ${kind}「${text}」` : `- ${kind}`;
}

/** 第一条消息：规则、失败的步骤、附近的步骤、当前页面概要 */
export function buildAssistPrompt(ctx: AssistContext): string {
  const { stuck } = ctx;
  const failed = stuck.steps[stuck.failedIndex];
  const failedLabel = failed ? stepLabel(failed) : stuck.failedStepId;
  const failedType = failed ? describeStepType(failed.type) : '';
  const typeNote = failedType && failedType !== oneLine(failedLabel) ? `（${failedType}）` : '';
  const lines: string[] = [];

  lines.push(`PagePilot 运行规则「${oneLine(ctx.ruleName)}」时中断了，请帮我看看。`, '');

  lines.push('## 中断的位置');
  lines.push(`第 ${stuck.failedIndex + 1} 步「${oneLine(failedLabel)}」${typeNote}失败`);
  const human = describeError(stuck.errorCode);
  lines.push(`错误：${human}${human !== stuck.errorCode ? `（${stuck.errorCode}）` : ''}`);
  const total = stuck.steps.length;
  const suggested = stuck.steps[stuck.suggestedIndex];
  lines.push(
    suggested
      ? `PagePilot 根据当前页面判断，建议从第 ${stuck.suggestedIndex + 1} 步「${oneLine(stepLabel(suggested))}」继续`
      : 'PagePilot 根据当前页面判断，这一层的步骤已经完成，可以继续后面的步骤',
  );
  lines.push('');

  const from = Math.max(0, stuck.failedIndex - ASSIST_NEARBY);
  const to = Math.min(total - 1, stuck.failedIndex + ASSIST_NEARBY);
  lines.push(`## 附近的步骤（同一层共 ${total} 步，列出第 ${from + 1}～${to + 1} 步）`);
  for (let i = from; i <= to; i++) {
    const st = stuck.steps[i];
    if (!st) continue;
    const type = describeStepType(st.type);
    const label = oneLine(stepLabel(st));
    const desc = label === type ? type : `${label}（${type}）`;
    lines.push(`${i + 1}. ${desc}${i === stuck.failedIndex ? '  ← 失败' : ''}`);
  }
  lines.push('');

  lines.push('## 当前页面');
  const url = safePageUrl(ctx.pageUrl);
  lines.push(`地址：${url ?? '（取不到）'}`);
  if (ctx.elements && ctx.elements.length > 0) {
    const shown = ctx.elements.slice(0, ASSIST_MAX_ELEMENTS);
    lines.push(`可见的交互元素（列出 ${shown.length} 个，不含输入框里的内容）：`);
    for (const el of shown) lines.push(elementLine(el));
  } else {
    lines.push('可见的交互元素：（取不到或没有）');
  }
  if (ctx.screenshot) lines.push('', '附件是当前页面可见区域的截图。');

  return lines.join('\n');
}

/** 系统提示（只对第一条消息这一轮生效） */
export const ASSIST_INSTRUCTIONS = [
  '你在帮助一位使用 PagePilot 的用户。PagePilot 是一个 Chrome 网页自动化扩展：',
  '管理员在后台写好「规则」，规则由一串步骤组成（打开网页、点击、填写、选择、勾选、按键、等待、检查页面、读取内容、条件判断、反复执行等），',
  '扩展在用户的浏览器里按步骤自动操作网页。遇到验证码、需要用户自己确认的地方，规则会「交还」给用户，用户处理完再点「继续」。',
  '某一步失败时，运行会暂停并交还给用户，用户可以在页面上手动处理，再从下面四种方式里选一种接着运行：',
  '「继续」（从 PagePilot 建议的那一步继续）、「重试这一步」（重新执行失败的那一步）、「跳过这一步」（把失败的那一步记为跳过，从下一步继续）、「从第 K 步继续」（用户自己指定从哪一步开始）。',
  '',
  '用户会发给你：规则名称、失败的步骤与错误、同一层前后几步的说明、当前页面的地址（不含查询串）、页面上可见的交互元素概要，有时还有一张页面截图。',
  '出于隐私考虑，输入框里的内容、用户的本地数据与凭据都不会发给你。',
  '',
  '请用中文回答，简洁、具体：',
  '1. 分析中断的可能原因，例如：定位器失效或页面改版（找不到元素）、弹窗或遮罩挡住了目标、需要先登录或会话过期、出现了验证码、网络慢或页面还没加载完、页面跳到了意料之外的地址、页面状态与规则预期不符等。说明你的判断依据。',
  '2. 给出用户现在可以在页面上手动做的下一步。',
  '3. 明确建议选「继续」「重试这一步」「跳过这一步」「从第 K 步继续」中的哪一个（选最后一个时说明 K 是几），并说明理由。',
  '4. 如果问题在规则本身（例如页面改版导致定位器长期失效），最后说明如何修改规则：让管理员在 PagePilot 后台管理页的「规则」里打开这条规则，编辑规则 JSON 中对应步骤的 target（定位器）、等待条件或 timeoutMs；也可以在侧边栏「录制」页签重新录制这一段操作并上报，再在管理页的「录制」里由录制生成规则。',
  '',
  '只根据用户提供的信息作答，不要编造页面上没有出现的按钮、文字或地址；信息不够时直接说明，并告诉用户还需要看什么（例如勾选附上截图后重新分析）。',
  '你没有任何工具，也不能操作用户的浏览器。',
].join('\n');
