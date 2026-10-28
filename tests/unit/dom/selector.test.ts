// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  generateLocator,
  isSensitive,
  isUserCodeField,
  isVisible,
  nameOf,
  resolve,
  roleOf,
} from '../../../src/core/selector';
import type { Locator } from '../../../src/schema/rule';
import { $, html, mockLayout } from '../../helpers/dom';

const one = (s: Locator['strategies'][number]): Locator => ({ strategies: [s] });

/** 每条策略单独解析都必须唯一命中原元素 */
function expectEveryStrategyHits(el: Element) {
  const loc = generateLocator(el);
  expect(loc.strategies.length).toBeGreaterThan(0);
  for (const s of loc.strategies) {
    const res = resolve(one(s));
    expect(res.element, `${s.kind}: ${s.value}`).toBe(el);
    expect(res.count).toBe(1);
  }
  return loc;
}

beforeEach(() => html(''));
afterEach(() => vi.restoreAllMocks());

describe('generateLocator', () => {
  it('每条策略都能唯一命中原元素（带 testid / id / name / 文本的按钮）', () => {
    html(`
      <form>
        <input id="user" name="username" data-testid="user-input">
        <button id="go" type="submit" class="btn primary">提交</button>
        <button class="btn">取消</button>
      </form>`);
    for (const sel of ['#user', '#go', 'button.btn:not(#go)']) {
      expectEveryStrategyHits($(sel));
    }
  });

  it('策略按稳定性排序：testid → id → name → aria → css 路径 → text → xpath', () => {
    html('<div><button id="go" name="n" data-testid="t">提交</button></div>');
    const kinds = generateLocator($('#go')).strategies.map((s) => `${s.kind}:${s.value}`);
    expect(kinds[0]).toBe('testid:t');
    expect(kinds[1]).toBe('css:#go');
    expect(kinds[2]).toBe('css:button[name="n"]');
    expect(kinds[3]).toBe('aria:button[name="提交"]');
    expect(kinds.at(-2)).toBe('text:提交');
    expect(kinds.at(-1)).toMatch(/^xpath:\/html\/body\/div\/button$/);
  });

  it('相同结构的列表项通过 nth-of-type 区分，css 与 xpath 都唯一', () => {
    html(
      '<ul class="list"><li class="item">A</li><li class="item">A</li><li class="item">A</li></ul>',
    );
    const second = document.querySelectorAll('li')[1] as HTMLElement;
    const loc = expectEveryStrategyHits(second);
    expect(loc.strategies.some((s) => s.kind === 'css' && s.value.includes('nth-of-type(2)'))).toBe(
      true,
    );
    // 重复的文本和 aria 名称不唯一，不应成为策略
    expect(loc.strategies.some((s) => s.kind === 'text')).toBe(false);
  });

  it.each([':r1:', 'radix-:r2:-trigger', 'item-12345', 'a1b2c3d4e5f6', 'react-select-3-input'])(
    '不稳定 id %s 不会被用作策略',
    (id) => {
      html(`<div><button id="${id}">点我</button><button>其他</button></div>`);
      const el = $('button');
      const loc = expectEveryStrategyHits(el);
      for (const s of loc.strategies) {
        expect(s.value).not.toContain(CSS.escape(id));
        expect(s.value).not.toContain(`#${id}`);
      }
    },
  );

  it('稳定 id 可以作为 css 策略，特殊字符被转义', () => {
    html('<button id="a.b">x</button>');
    const loc = expectEveryStrategyHits($('button'));
    expect(loc.strategies).toContainEqual({ kind: 'css', value: '#a\\.b' });
  });

  it('不稳定的 class（css-、sc-、数字串）不进入 css 路径', () => {
    html('<div><span class="css-1x2y3z stable sc-abc">a</span><span>b</span></div>');
    const loc = expectEveryStrategyHits($('span'));
    const path = loc.strategies.find((s) => s.kind === 'css' && s.value.includes('span'));
    expect(path?.value).toContain('.stable');
    expect(path?.value).not.toContain('css-1x2y3z');
    expect(path?.value).not.toContain('sc-abc');
  });

  it('aria 策略形如 role[name="..."]，名称中的引号被转义且仍可命中', () => {
    html('<button aria-label=\'say "hi"\'>x</button><button>y</button>');
    const el = $('button');
    const loc = expectEveryStrategyHits(el);
    expect(loc.strategies).toContainEqual({ kind: 'aria', value: 'button[name="say \\"hi\\""]' });
  });

  it('名称超过 60 字符时不生成 aria 策略', () => {
    html(`<button aria-label="${'长'.repeat(61)}">x</button>`);
    const loc = generateLocator($('button'));
    expect(loc.strategies.some((s) => s.kind === 'aria')).toBe(false);
  });

  it('text 策略使用元素自身文本，过长文本不生成', () => {
    html('<div><a href="#">登录</a><a href="#">注册</a></div>');
    const loc = expectEveryStrategyHits($('a'));
    expect(loc.strategies).toContainEqual({ kind: 'text', value: '登录' });

    html(`<div><p>${'字'.repeat(41)}</p></div>`);
    expect(generateLocator($('p')).strategies.some((s) => s.kind === 'text')).toBe(false);
  });

  it('非唯一的 name 属性不会成为策略', () => {
    html('<input name="q"><input name="q">');
    const el = document.querySelectorAll('input')[0] as HTMLInputElement;
    const loc = expectEveryStrategyHits(el);
    expect(loc.strategies.some((s) => s.value === 'input[name="q"]')).toBe(false);
  });

  it('data-qa 等替代 testid 属性同样生成 testid 策略', () => {
    html('<button data-qa="pay">付款</button>');
    const loc = expectEveryStrategyHits($('button'));
    expect(loc.strategies[0]).toEqual({ kind: 'testid', value: 'pay' });
  });

  it('顶层页面的 locator 没有 frame 字段', () => {
    html('<button>x</button>');
    expect(generateLocator($('button')).frame).toBeUndefined();
  });

  it('处于同源 iframe 中时，frame 为从顶层到目标 frame 的选择器链', () => {
    html('<div><iframe id="booking"></iframe></div>');
    const iframe = $<HTMLIFrameElement>('#booking');
    const topWin = { top: undefined as unknown, frameElement: null, parent: undefined as unknown };
    topWin.top = topWin;
    topWin.parent = topWin;
    const childWin = { top: topWin, frameElement: iframe, parent: topWin };
    vi.stubGlobal('window', childWin);
    try {
      const loc = generateLocator(document.body);
      expect(loc.frame).toEqual(['#booking']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('处于跨域 iframe 时，frame 退化为按主机名的猜测选择器', () => {
    const topWin = { top: undefined as unknown, frameElement: null, parent: undefined as unknown };
    topWin.top = topWin;
    topWin.parent = topWin;
    vi.stubGlobal('window', { top: topWin, frameElement: null, parent: topWin });
    try {
      const loc = generateLocator(document.body);
      expect(loc.frame).toEqual([`iframe[src*="${location.hostname}"]`]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('resolve', () => {
  it('按顺序回退：前面的策略未命中时使用后面的', () => {
    html('<button id="go">提交</button>');
    const res = resolve({
      strategies: [
        { kind: 'testid', value: 'missing' },
        { kind: 'css', value: '#nope' },
        { kind: 'css', value: '#go' },
      ],
    });
    expect(res.element).toBe($('#go'));
    expect(res.count).toBe(1);
  });

  it('命中多个元素视为未命中，继续尝试下一条策略', () => {
    html('<button class="b">A</button><button class="b" id="second">B</button>');
    const res = resolve({
      strategies: [
        { kind: 'css', value: '.b' },
        { kind: 'css', value: '#second' },
      ],
    });
    expect(res.element).toBe($('#second'));
  });

  it('所有策略都未唯一命中时返回 null 且 count 为 0', () => {
    html('<button class="b"></button><button class="b"></button>');
    const res = resolve(one({ kind: 'css', value: '.b' }));
    expect(res).toMatchObject({ element: null, count: 0, crossOrigin: false });
  });

  it('策略值非法（如错误的 css/xpath）时不抛错，视为未命中', () => {
    html('<div></div>');
    expect(resolve(one({ kind: 'css', value: '###' })).element).toBeNull();
    expect(resolve(one({ kind: 'xpath', value: '//[' })).element).toBeNull();
  });

  it('testid 在 data-testid / data-test-id / data-qa / data-cy 上都能命中', () => {
    for (const attr of ['data-testid', 'data-test-id', 'data-qa', 'data-cy']) {
      html(`<span ${attr}="x"></span>`);
      expect(resolve(one({ kind: 'testid', value: 'x' })).element).toBe($('span'));
    }
  });

  it('xpath 策略', () => {
    html('<div><p>a</p><p>b</p></div>');
    expect(resolve(one({ kind: 'xpath', value: '/html/body/div/p[2]' })).element?.textContent).toBe(
      'b',
    );
    // 命中多个则视为未命中
    expect(resolve(one({ kind: 'xpath', value: '//p' })).element).toBeNull();
  });

  it('text 策略：自身文本精确匹配（忽略多余空白），子元素文本不算', () => {
    html('<div>外层 <b>内层</b></div><span>  登录   页  </span>');
    expect(resolve(one({ kind: 'text', value: '登录 页' })).element).toBe($('span'));
    expect(resolve(one({ kind: 'text', value: '内层' })).element).toBe($('b'));
    expect(resolve(one({ kind: 'text', value: '外层 内层' })).element).toBeNull();
  });

  it('aria 策略：角色加可选名称，无名称时按角色匹配', () => {
    html('<button>提交</button><a href="#">链接</a><input type="checkbox" aria-label="同意">');
    expect(resolve(one({ kind: 'aria', value: 'button[name="提交"]' })).element).toBe($('button'));
    expect(resolve(one({ kind: 'aria', value: 'link' })).element).toBe($('a'));
    expect(resolve(one({ kind: 'aria', value: 'checkbox[name="同意"]' })).element).toBe($('input'));
    expect(resolve(one({ kind: 'aria', value: 'button[name="不存在"]' })).element).toBeNull();
  });

  it('aria 策略：显式 role 属性优先于隐式角色', () => {
    html('<div role="button" aria-label="自定义">x</div>');
    expect(resolve(one({ kind: 'aria', value: 'button[name="自定义"]' })).element).toBe($('div'));
  });

  describe('同源 iframe', () => {
    function setupFrame() {
      html('<div id="host"><iframe id="booking"></iframe></div><button id="go">外部</button>');
      const iframe = $<HTMLIFrameElement>('#booking');
      const inner = iframe.contentDocument as Document;
      inner.body.innerHTML = '<button id="go">内部</button><iframe id="deep"></iframe>';
      return { iframe, inner };
    }

    it('frame 链把定位限定在 iframe 内部文档，与顶层同名元素互不干扰', () => {
      const { inner } = setupFrame();
      const inside = resolve({ strategies: [{ kind: 'css', value: '#go' }], frame: ['#booking'] });
      expect(inside.element).toBe(inner.getElementById('go'));
      const outside = resolve(one({ kind: 'css', value: '#go' }));
      expect(outside.element).toBe(document.getElementById('go'));
    });

    // 已知问题：enterFrames 用顶层 realm 的 HTMLIFrameElement 做 instanceof，
    // 第二层 iframe 元素属于子 frame 的 realm，判断为 false。修复后应改回 it。
    it('支持多层 iframe 链', () => {
      const { inner } = setupFrame();
      const deep = inner.getElementById('deep') as HTMLIFrameElement;
      const deepDoc = deep.contentDocument as Document;
      deepDoc.body.innerHTML = '<span id="target">深层</span>';
      const res = resolve({
        strategies: [{ kind: 'css', value: '#target' }],
        frame: ['#booking', '#deep'],
      });
      expect(res.element).toBe(deepDoc.getElementById('target'));
    });

    it('frame 选择器找不到 iframe（或不是 iframe）时未命中', () => {
      setupFrame();
      const missing = resolve({ strategies: [{ kind: 'css', value: '#go' }], frame: ['#nope'] });
      expect(missing).toMatchObject({ element: null, crossOrigin: false });
      const notFrame = resolve({ strategies: [{ kind: 'css', value: '#go' }], frame: ['#host'] });
      expect(notFrame.element).toBeNull();
    });

    it('累计同源 iframe 相对视口的偏移', () => {
      const { iframe } = setupFrame();
      vi.spyOn(iframe, 'getBoundingClientRect').mockReturnValue({ left: 30, top: 40 } as DOMRect);
      const res = resolve({ strategies: [{ kind: 'css', value: '#go' }], frame: ['#booking'] });
      expect(res.offset).toEqual({ x: 30, y: 40 });
    });

    it('ignoreFrame 为 true 时忽略 frame 链，直接在当前文档里查找', () => {
      setupFrame();
      const res = resolve(
        { strategies: [{ kind: 'css', value: '#go' }], frame: ['#booking'] },
        true,
      );
      expect(res.element).toBe(document.getElementById('go'));
    });

    it('经过无法访问的 iframe 时返回 crossOrigin', () => {
      const { iframe } = setupFrame();
      Object.defineProperty(iframe, 'contentDocument', {
        get() {
          throw new DOMException('blocked', 'SecurityError');
        },
      });
      const res = resolve({ strategies: [{ kind: 'css', value: '#go' }], frame: ['#booking'] });
      expect(res).toMatchObject({ crossOrigin: true, element: null });
    });

    it('contentDocument 为 null 同样视为 crossOrigin', () => {
      const { iframe } = setupFrame();
      Object.defineProperty(iframe, 'contentDocument', { get: () => null });
      expect(
        resolve({ strategies: [{ kind: 'css', value: '#go' }], frame: ['#booking'] }).crossOrigin,
      ).toBe(true);
    });
  });
});

describe('roleOf / nameOf', () => {
  it('隐式角色：按标签与 input 类型', () => {
    html(
      '<a href="#"></a><input type="checkbox"><input type="number"><textarea></textarea><h2></h2>',
    );
    expect(roleOf($('a'))).toBe('link');
    expect(roleOf($('input[type=checkbox]'))).toBe('checkbox');
    expect(roleOf($('input[type=number]'))).toBe('spinbutton');
    expect(roleOf($('textarea'))).toBe('textbox');
    expect(roleOf($('h2'))).toBe('heading');
  });

  it('名称优先级：aria-label → aria-labelledby → label → placeholder', () => {
    html(`
      <span id="lbl">由引用</span>
      <input id="a" aria-label="直接">
      <input id="b" aria-labelledby="lbl">
      <label for="c">关联标签</label><input id="c">
      <input id="d" placeholder="占位">`);
    expect(nameOf($('#a'))).toBe('直接');
    expect(nameOf($('#b'))).toBe('由引用');
    expect(nameOf($('#c'))).toBe('关联标签');
    expect(nameOf($('#d'))).toBe('占位');
  });

  it('按钮 input 的名称取自 value；文本过长的元素回退到 title', () => {
    html(`<input type="submit" value="支付"><div title="提示">${'字'.repeat(81)}</div>`);
    expect(nameOf($('input'))).toBe('支付');
    expect(nameOf($('div'))).toBe('提示');
  });
});

describe('isVisible', () => {
  it('jsdom 无布局时（零矩形）视为不可见', () => {
    html('<div>x</div>');
    expect(isVisible($('div'))).toBe(false);
  });

  it('有非零矩形且未被样式隐藏时可见', () => {
    mockLayout();
    html('<div>x</div>');
    expect(isVisible($('div'))).toBe(true);
  });

  it('visibility:hidden 与 display:none 不可见', () => {
    mockLayout();
    html('<div id="a" style="visibility:hidden">x</div><div id="b" style="display:none">y</div>');
    expect(isVisible($('#a'))).toBe(false);
    expect(isVisible($('#b'))).toBe(false);
  });
});

describe('isUserCodeField', () => {
  it('用途写在 title、placeholder、label 上的验证码 / 短信验证码也能识别', () => {
    html(
      '<input id="a" name="crtfKeyNo" title="Enter verification number">' +
        '<input id="b" placeholder="보안문자를 입력하세요">' +
        '<label for="c">短信验证码</label><input id="c" name="code1">' +
        '<input id="d" name="smsCode">' +
        '<input id="e" name="userNm" title="Enter your name">' +
        // 接短信用的手机号：名字含 sms、网站还标了 one-time-code，但不是验证码
        '<input id="f" name="smsNo" title="휴대폰 번호" autocomplete="one-time-code">',
    );
    for (const id of ['#a', '#b', '#c', '#d']) expect(isUserCodeField($(id))).toBe(true);
    for (const id of ['#e', '#f']) expect(isUserCodeField($(id))).toBe(false);
    // 验证码类输入同时不采集值
    expect(isSensitive($('#a'))).toBe(true);
  });
});

describe('isSensitive', () => {
  it('密码框', () => {
    html('<input type="password" name="x">');
    expect(isSensitive($('input'))).toBe(true);
  });

  it.each(['cc-number', 'cc-csc', 'current-password', 'new-password', 'one-time-code'])(
    'autocomplete=%s',
    (ac) => {
      html(`<input type="text" autocomplete="${ac}">`);
      expect(isSensitive($('input'))).toBe(true);
    },
  );

  it.each(['cvv', 'cvc', 'card_number', 'otp', 'captcha', 'verify_code', 'api_token'])(
    'name=%s 的输入框',
    (name) => {
      html(`<input name="${name}">`);
      expect(isSensitive($('input'))).toBe(true);
    },
  );

  it('通过 id 或 aria-label 命中敏感关键词', () => {
    html('<input id="pwd"><textarea aria-label="Secret note"></textarea>');
    expect(isSensitive($('input'))).toBe(true);
    expect(isSensitive($('textarea'))).toBe(true);
  });

  it('验证码容器内的输入框', () => {
    html(
      '<div class="g-recaptcha"><input name="a"></div>' +
        '<div id="my-Captcha-box"><input name="b"></div>' +
        '<div class="h-captcha"><input name="c"></div>' +
        '<div class="cf-turnstile"><input name="d"></div>',
    );
    for (const el of document.querySelectorAll('input')) expect(isSensitive(el)).toBe(true);
  });

  it('普通输入框不敏感', () => {
    html(
      '<input name="username"><input type="email" name="email"><textarea name="comment"></textarea>',
    );
    for (const el of document.querySelectorAll('input,textarea'))
      expect(isSensitive(el)).toBe(false);
  });

  it('按词判断：passenger、discard 不算敏感，user_password、cardNumber 算', () => {
    html('<input name="passenger_name"><input name="discard_reason">');
    for (const el of document.querySelectorAll('input')) expect(isSensitive(el)).toBe(false);
    html('<input name="user_password"><input name="cardNumber"><input name="otp-code">');
    for (const el of document.querySelectorAll('input')) expect(isSensitive(el)).toBe(true);
  });

  it('名称关键词只对 input / textarea 生效，按钮不受影响', () => {
    html('<button name="token">x</button>');
    expect(isSensitive($('button'))).toBe(false);
  });
});
