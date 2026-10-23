import { execFileSync } from 'node:child_process';

/**
 * 构建带测试钩子的扩展，不影响正常构建产物：
 * - .output/e2e：普通测试构建
 * - .output/e2e-trusted：额外声明调试权限，用于真实输入场景
 */
export default function globalSetup(): void {
  if (process.env.PAGEPILOT_E2E_SKIP_BUILD) return;
  for (const flavor of ['1', 'trusted']) {
    execFileSync('pnpm', ['exec', 'wxt', 'build'], {
      stdio: 'inherit',
      env: { ...process.env, PAGEPILOT_E2E: flavor },
    });
  }
}
