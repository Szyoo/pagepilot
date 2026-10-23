import { z } from 'zod';

/** 本地数据：只存在浏览器本机，不会上报 */
export const localDataSchema = z.object({
  profile: z.record(z.string(), z.string()).default({}),
  secret: z.record(z.string(), z.string()).default({}),
  /** 每条凭据允许使用的域名（精确域名或 `*.example.com`），未配置则不可使用 */
  secretOrigins: z.record(z.string(), z.array(z.string())).default({}),
});

export type LocalData = z.infer<typeof localDataSchema>;
