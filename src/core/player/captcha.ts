import { isVisible } from '../selector';

/** 常见人机验证组件；检测到后由回放引擎自动交还给用户，不尝试绕过 */
const SELECTORS = [
  'iframe[src*="recaptcha/api2/anchor"]',
  'iframe[src*="recaptcha/api2/bframe"]',
  'iframe[src*="recaptcha/enterprise"]',
  '.g-recaptcha',
  'iframe[src*="hcaptcha.com"]',
  '.h-captcha',
  'iframe[src*="challenges.cloudflare.com"]',
  '.cf-turnstile',
  '#nc_1_wrapper',
  '.nc-container',
  '[class*="geetest"]',
  '[class*="captcha" i]:not(script):not(style)',
  'img[src*="captcha" i]',
  'input[name*="captcha" i]',
];

export function detectCaptcha(): boolean {
  for (const sel of SELECTORS) {
    for (const el of document.querySelectorAll(sel)) {
      if (isVisible(el)) return true;
    }
  }
  return false;
}
