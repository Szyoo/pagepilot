// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureElements } from '../../../src/core/capture';
import { resolve } from '../../../src/core/selector';
import { captureElementSchema } from '../../../src/schema/message';
import { html, mockLayout } from '../../helpers/dom';

beforeEach(() => {
  html('');
  mockLayout();
});
afterEach(() => vi.restoreAllMocks());

const byTag = (tag: string) => {
  const found = captureElements().find((e) => e.tag === tag);
  if (!found) throw new Error(`没有采集到 ${tag}`);
  return found;
};

describe('captureElements', () => {
  it('只采集可见的交互元素', () => {
    html(
      '<button id="a">可见</button><button id="b" style="display:none">隐藏</button><div>非交互</div>',
    );
    const els = captureElements();
    expect(els).toHaveLength(1);
    expect(els[0]?.attrs.id).toBe('a');
  });

  it('普通字段带角色、名称、文本与可用的 locator，且结果符合消息 schema', () => {
    html('<form><label for="u">用户名</label><input id="u" name="username" type="text"></form>');
    const input = byTag('input');
    expect(input).toMatchObject({ role: 'textbox', name: '用户名', sensitive: false });
    expect(captureElementSchema.safeParse(input).success).toBe(true);
    expect(resolve(input.locator).element).toBe(document.getElementById('u'));
  });

  it('不采集输入框的当前值，value 不在 attrs 中', () => {
    html('<input id="u" name="username" value="张三-当前值">');
    const input = byTag('input');
    expect(input.attrs).not.toHaveProperty('value');
    expect(JSON.stringify(input)).not.toContain('张三-当前值');
  });

  it('普通字段保留白名单属性（含 placeholder），其他属性不带出', () => {
    html(
      '<input id="u" name="n" placeholder="请输入" data-secret-token="abc" class="x" style="color:red">',
    );
    const { attrs } = byTag('input');
    expect(attrs).toMatchObject({ id: 'u', name: 'n', placeholder: '请输入' });
    expect(attrs).not.toHaveProperty('data-secret-token');
    expect(attrs).not.toHaveProperty('class');
    expect(attrs).not.toHaveProperty('style');
  });

  it('属性值截断到 200 字符，文本截断到 200 字符', () => {
    html(`<button aria-label="${'a'.repeat(300)}">${'字'.repeat(300)}</button>`);
    const b = byTag('button');
    expect(b.attrs['aria-label']).toHaveLength(200);
    expect(b.text).toHaveLength(200);
  });

  describe('敏感字段', () => {
    it('密码框 sensitive=true，没有 name/text，attrs 只含类型类属性', () => {
      html(
        '<label for="p">登录密码</label>' +
          '<input id="p" name="pwd" type="password" value="hunter2" placeholder="至少8位" ' +
          'autocomplete="current-password" aria-label="密码" data-testid="pw">',
      );
      const el = byTag('input');
      expect(el.sensitive).toBe(true);
      expect(el.name).toBeUndefined();
      expect(el.text).toBeUndefined();
      expect(Object.keys(el.attrs).sort()).toEqual(['autocomplete', 'id', 'name', 'type']);
      const json = JSON.stringify(el);
      expect(json).not.toContain('hunter2');
      expect(json).not.toContain('至少8位');
    });

    it('支付字段与验证码容器内的输入框同样按敏感处理', () => {
      html(
        '<input name="cardnumber" autocomplete="cc-number" value="4111111111111111" placeholder="卡号">' +
          '<div class="g-recaptcha"><input name="x" value="abc"></div>',
      );
      const els = captureElements().filter((e) => e.tag === 'input');
      expect(els).toHaveLength(2);
      for (const e of els) {
        expect(e.sensitive).toBe(true);
        expect(e.name).toBeUndefined();
        expect(e.attrs).not.toHaveProperty('placeholder');
        expect(e.attrs).not.toHaveProperty('value');
      }
      expect(JSON.stringify(els)).not.toContain('4111111111111111');
    });
  });

  describe('链接', () => {
    it('非 http(s) 链接不产生垃圾数据', () => {
      html('<a href="mailto:a@b.c?subject=1">邮件</a><a href="javascript:void(0)">脚本</a>');
      for (const e of captureElements().filter((x) => x.tag === 'a')) {
        expect(e.attrs.href).toBe('');
      }
    });

    it('href 只保留 origin + pathname，查询串与 hash 里的令牌不出现', () => {
      html(
        '<a href="https://pay.example.com/cb/done?token=SECRET123&u=1#access_token=ZZZ">完成</a>',
      );
      const a = byTag('a');
      expect(a.attrs.href).toBe('https://pay.example.com/cb/done');
      expect(JSON.stringify(a)).not.toContain('SECRET123');
      expect(JSON.stringify(a)).not.toContain('ZZZ');
    });

    it('相对链接按当前页面解析后同样去掉查询串', () => {
      html('<a href="/orders/1?session=abc">订单</a>');
      expect(byTag('a').attrs.href).toBe(`${location.origin}/orders/1`);
    });

    it('没有 href 的 a 标签不属于交互元素', () => {
      html('<a name="top">锚点</a>');
      expect(captureElements()).toHaveLength(0);
    });
  });

  it('最多采集 500 个元素', () => {
    html(Array.from({ length: 520 }, (_, i) => `<button>b${i}</button>`).join(''));
    const els = captureElements();
    expect(els).toHaveLength(500);
    expect(els[0]?.text).toBe('b0');
    expect(els.at(-1)?.text).toBe('b499');
  });

  it('role、data-testid 等标记的元素也会被采集', () => {
    html('<div role="tab">标签</div><span data-testid="x">y</span>');
    expect(captureElements().map((e) => e.tag)).toEqual(['div', 'span']);
  });
});
