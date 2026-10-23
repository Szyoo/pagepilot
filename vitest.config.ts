import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    // 单元测试不使用本机 .env 里的真实地址
    env: { VITE_DEFAULT_BACKEND_URL: '', VITE_DEFAULT_PORTAL_URL: '' },
  },
});
