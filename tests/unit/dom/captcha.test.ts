// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectCaptcha } from '../../../src/core/player/captcha';
import { html, mockLayout } from '../../helpers/dom';

beforeEach(() => {
  html('');
  mockLayout();
});
afterEach(() => vi.restoreAllMocks());

describe('detectCaptcha', () => {
  it('普通页面没有验证组件', () => {
    html('<form><input name="user"><button>登录</button></form>');
    expect(detectCaptcha()).toBe(false);
  });

  it.each([
    [
      'reCAPTCHA anchor',
      '<iframe src="https://www.google.com/recaptcha/api2/anchor?k=1"></iframe>',
    ],
    [
      'reCAPTCHA bframe',
      '<iframe src="https://www.google.com/recaptcha/api2/bframe?k=1"></iframe>',
    ],
    [
      'reCAPTCHA enterprise',
      '<iframe src="https://www.google.com/recaptcha/enterprise/anchor"></iframe>',
    ],
    ['reCAPTCHA 容器', '<div class="g-recaptcha"></div>'],
    ['hCaptcha iframe', '<iframe src="https://newassets.hcaptcha.com/captcha/v1"></iframe>'],
    ['hCaptcha 容器', '<div class="h-captcha"></div>'],
    ['Turnstile iframe', '<iframe src="https://challenges.cloudflare.com/cdn-cgi/x"></iframe>'],
    ['Turnstile 容器', '<div class="cf-turnstile"></div>'],
    ['阿里滑块', '<div id="nc_1_wrapper"></div>'],
    ['阿里滑块容器', '<div class="nc-container"></div>'],
    ['极验', '<div class="geetest_holder"></div>'],
    ['类名含 captcha（忽略大小写）', '<div class="Login-CAPTCHA-box"></div>'],
    ['验证码图片', '<img src="/api/Captcha.png">'],
    ['验证码输入框', '<input name="imgCaptchaCode">'],
  ])('检测到可见的 %s', (_name, markup) => {
    html(markup);
    expect(detectCaptcha()).toBe(true);
  });

  it('display:none 的验证组件不算', () => {
    html('<div class="g-recaptcha" style="display:none"></div>');
    expect(detectCaptcha()).toBe(false);
  });

  it('隐藏父容器里的验证组件不算', () => {
    html('<div hidden><div class="h-captcha"></div></div>');
    expect(detectCaptcha()).toBe(false);
  });

  it('visibility:hidden 的验证组件不算', () => {
    html('<input name="captcha" style="visibility:hidden">');
    expect(detectCaptcha()).toBe(false);
  });

  it('零尺寸（如 invisible reCAPTCHA 的占位）不算', () => {
    vi.restoreAllMocks(); // 去掉布局模拟：所有元素矩形为 0
    html('<div class="g-recaptcha"></div>');
    expect(detectCaptcha()).toBe(false);
  });

  it('隐藏的与可见的并存时，只要有一个可见就检测到', () => {
    html('<div class="g-recaptcha" style="display:none"></div><div class="cf-turnstile"></div>');
    expect(detectCaptcha()).toBe(true);
  });
});
