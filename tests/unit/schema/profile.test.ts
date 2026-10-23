import { describe, expect, it } from 'vitest';
import { localDataSchema } from '../../../src/schema/profile';

describe('localDataSchema', () => {
  it('空对象填充为三个空记录', () => {
    expect(localDataSchema.parse({})).toEqual({ profile: {}, secret: {}, secretOrigins: {} });
  });

  it('profile 值必须是字符串', () => {
    expect(localDataSchema.safeParse({ profile: { age: 3 } }).success).toBe(false);
  });
});
