import { describe, expect, it } from 'vitest';
import {
  ASSIST_INSTRUCTIONS,
  type AssistContext,
  buildAssistPrompt,
  safePageUrl,
} from '../../../src/shared/assist';

const steps = [
  { index: 0, id: 's1', type: 'open', note: '打开预约页' },
  { index: 1, id: 's2', type: 'fill', note: '填写姓名 {{profile.name}}' },
  { index: 2, id: 's3', type: 'fill' },
  { index: 3, id: 's4', type: 'click', note: '点「下一步」' },
  { index: 4, id: 's5', type: 'click' },
  { index: 5, id: 's6', type: 'waitFor', note: '等待确认页' },
  { index: 6, id: 's7', type: 'assert', note: '检查完成提示' },
  { index: 7, id: 's8', type: 'extract', note: '读取预约号' },
  { index: 8, id: 's9', type: 'click', note: '最后一步-不应出现' },
];

const ctx = (over: Partial<AssistContext> = {}): AssistContext => ({
  ruleName: '测试预约',
  stuck: {
    failedStepId: 's5',
    failedIndex: 4,
    errorCode: 'TARGET_NOT_FOUND',
    suggestedIndex: 4,
    steps,
  },
  pageUrl: 'https://shop.example.com/booking/confirm?token=SECRET-QS#frag-SECRET',
  elements: [
    { tag: 'button', role: 'button', text: '确认预约', sensitive: false },
    { tag: 'input', role: 'textbox', sensitive: true },
  ],
  ...over,
});

describe('buildAssistPrompt', () => {
  it('包含规则名称、失败步骤（无 note 时用类型人话）、错误码与人话、建议的位置', () => {
    const p = buildAssistPrompt(ctx());
    expect(p).toContain('「测试预约」');
    expect(p).toContain('第 5 步「点击」失败');
    expect(p).toContain('找不到页面上的元素（页面可能改版了）（TARGET_NOT_FOUND）');
    expect(p).toContain('建议从第 5 步「点击」继续');
  });

  it('列出同一层前后各 3 步的说明与类型，超出范围的不列', () => {
    const p = buildAssistPrompt(ctx());
    expect(p).toContain('2. 填写姓名 {{profile.name}}（填写）');
    expect(p).toContain('3. 填写');
    expect(p).toContain('4. 点「下一步」（点击）');
    expect(p).toContain('5. 点击  ← 失败');
    expect(p).toContain('8. 读取预约号（读取内容）');
    expect(p).not.toContain('打开预约页');
    expect(p).not.toContain('最后一步-不应出现');
  });

  it('页面地址去掉查询串与 hash', () => {
    const p = buildAssistPrompt(ctx());
    expect(p).toContain('地址：https://shop.example.com/booking/confirm');
    expect(p).not.toContain('SECRET');
    expect(safePageUrl('chrome://settings/')).toBeNull();
    expect(safePageUrl('not a url')).toBeNull();
  });

  it('元素文字截断，敏感元素不带文字', () => {
    const p = buildAssistPrompt(
      ctx({
        elements: [
          { tag: 'a', role: 'link', text: '长'.repeat(100), sensitive: false },
          { tag: 'input', role: 'textbox', text: '不该出现', sensitive: true },
        ],
      }),
    );
    expect(p).toContain(`- a（link）「${'长'.repeat(60)}」`);
    expect(p).not.toContain('长'.repeat(61));
    expect(p).toContain('- input（textbox）［敏感字段，内容已隐去］');
    expect(p).not.toContain('不该出现');
  });

  it('只用规则与页面概要，不含占位符解析结果或输入值；取不到页面信息时照常生成', () => {
    // 上下文里没有任何本地数据字段，占位符保持原样
    const p = buildAssistPrompt(ctx({ pageUrl: undefined, elements: undefined }));
    expect(p).toContain('{{profile.name}}');
    expect(p).toContain('地址：（取不到）');
    expect(p).toContain('可见的交互元素：（取不到或没有）');
    expect(p).not.toContain('截图');
  });

  it('建议位置越过最后一步时说明这一层已完成；附截图时提示', () => {
    const p = buildAssistPrompt(
      ctx({ stuck: { ...ctx().stuck, suggestedIndex: steps.length }, screenshot: true }),
    );
    expect(p).toContain('这一层的步骤已经完成');
    expect(p).toContain('附件是当前页面可见区域的截图');
  });
});

describe('ASSIST_INSTRUCTIONS', () => {
  it('说明交还与四种继续方式，要求中文、不编造', () => {
    for (const s of [
      '交还',
      '继续',
      '重试这一步',
      '跳过这一步',
      '从第 K 步继续',
      '中文',
      '不要编造',
    ]) {
      expect(ASSIST_INSTRUCTIONS).toContain(s);
    }
    expect(ASSIST_INSTRUCTIONS.length).toBeLessThan(16000);
  });
});
