import type { RawRule } from './fake-backend';
import { css } from './fixtures';

/** 登录表单规则：用户名取个人信息，密码取凭据，提交后等待出现用户菜单 */
export function loginRule(origins: string[], version = 1): RawRule {
  return {
    id: 'e2e-login',
    name: '测试登录',
    version,
    match: { urls: origins.map((o) => `${o}/pages/*`) },
    requires: { profile: ['name'], secret: ['pass'] },
    steps: [
      { id: 's1', type: 'fill', target: css('#user'), value: '{{profile.name}}' },
      { id: 's2', type: 'fill', target: css('#pass'), value: '{{secret.pass}}' },
      { id: 's3', type: 'click', target: css('#submit') },
      {
        id: 's4',
        type: 'waitFor',
        until: 'condition',
        condition: {
          kind: 'element',
          target: { strategies: [{ kind: 'testid', value: 'user-menu' }] },
        },
      },
    ],
  };
}

/** 含人机验证组件的页面：点击提交并确认结果 */
export function captchaRule(origin: string): RawRule {
  return {
    id: 'e2e-captcha',
    name: '测试验证码交还',
    version: 1,
    match: { urls: [`${origin}/pages/captcha.html`] },
    steps: [
      { id: 's1', type: 'click', target: css('#go') },
      {
        id: 's2',
        type: 'assert',
        condition: { kind: 'element', target: css('#result'), text: '已提交' },
      },
    ],
  };
}

/** 中间有较长等待的规则，用来在运行中途终止 service worker */
export function slowRule(origin: string, delayMs: number): RawRule {
  return {
    id: 'e2e-slow',
    name: '测试长等待',
    version: 1,
    match: { urls: [`${origin}/pages/trusted.html`] },
    steps: [
      { id: 's1', type: 'click', target: css('#bump') },
      { id: 's2', type: 'waitFor', until: 'delay', delayMs },
      { id: 's3', type: 'click', target: css('#go') },
      {
        id: 's4',
        type: 'assert',
        condition: { kind: 'element', target: css('#status'), text: 'clicked' },
      },
    ],
  };
}

/** 反复刷新直到出现名额，再点击名额 */
export function bookingRule(origin: string, intervalMs: number): RawRule {
  return {
    id: 'e2e-booking',
    name: '测试刷新等待名额',
    version: 1,
    match: { urls: [`${origin}/pages/booking.html*`] },
    steps: [
      {
        id: 's1',
        type: 'repeat',
        reload: true,
        intervalMs,
        maxAttempts: 10,
        notify: false,
        steps: [{ id: 's1a', type: 'waitFor', until: 'idle' }],
        until: { kind: 'element', target: css('.slot.available') },
      },
      { id: 's2', type: 'click', target: css('.slot.available') },
      {
        id: 's3',
        type: 'assert',
        condition: { kind: 'element', target: css('#picked'), text: '已选择' },
      },
    ],
  };
}

/** 输入事件页面：点击、填写字面量、回车、再点击；inputMode 指定真实或合成输入 */
export function inputRule(
  origin: string,
  inputMode: 'trusted' | 'synthetic',
  text: string,
): RawRule {
  return {
    id: `e2e-input-${inputMode}`,
    name: `测试${inputMode === 'trusted' ? '真实' : '合成'}输入`,
    version: 1,
    inputMode,
    match: { urls: [`${origin}/pages/trusted.html`] },
    steps: [
      { id: 's1', type: 'click', target: css('#bump') },
      { id: 's2', type: 'fill', target: css('#field'), value: text },
      { id: 's3', type: 'press', target: css('#field'), key: 'Enter' },
      { id: 's4', type: 'click', target: css('#go') },
      {
        id: 's5',
        type: 'assert',
        condition: { kind: 'element', target: css('#status'), text: 'clicked' },
      },
    ],
  };
}
