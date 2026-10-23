import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// 由 server/tests/test_protocol.py 调用：用扩展自己的 Zod schema 校验后台输出的样例
export default defineConfig({
  root: fileURLToPath(new URL('../../..', import.meta.url)),
  test: {
    include: ['server/tests/zod/**/*.test.ts'],
  },
});
