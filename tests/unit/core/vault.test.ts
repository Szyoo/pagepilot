import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser, resetFakeBrowser } from '../../helpers/fake-browser';

vi.mock('wxt/browser', async () => (await import('../../helpers/fake-browser')).browserModule);

const vault = await import('../../../src/core/vault');

const data = {
  profile: { name: 'Zhang-San-Profile' },
  secret: { pass: 'S3cr3t-Value-XYZ' },
  secretOrigins: { pass: ['example.com', '*.shop.example.com'] },
};
const empty = { profile: {}, secret: {}, secretOrigins: {} };

beforeEach(() => {
  resetFakeBrowser();
});

describe('loadVault / saveVault', () => {
  it('未保存时返回空数据', async () => {
    expect(await vault.loadVault('u1')).toEqual(empty);
  });

  it('保存后可读回', async () => {
    await vault.saveVault('u1', data);
    expect(await vault.loadVault('u1')).toEqual(data);
  });

  it('按用户隔离', async () => {
    await vault.saveVault('u1', data);
    expect(await vault.loadVault('u2')).toEqual(empty);
    await vault.saveVault('u2', { ...empty, profile: { city: 'Tokyo' } });
    expect(await vault.loadVault('u1')).toEqual(data);
    expect((await vault.loadVault('u2')).profile).toEqual({ city: 'Tokyo' });
  });

  it('存储里不是合法对象时返回空数据', async () => {
    await fakeBrowser.storage.local.set({ 'vault:u1': 'garbage' });
    expect(await vault.loadVault('u1')).toEqual(empty);
    await fakeBrowser.storage.local.set({ 'vault:u1': { profile: 42 } });
    expect(await vault.loadVault('u1')).toEqual(empty);
  });
});

describe('resolvePlaceholder', () => {
  it('键不存在抛 DATA_MISSING', () => {
    expect(() => vault.resolvePlaceholder(data, 'profile', 'nope', 'example.com')).toThrowError(
      expect.objectContaining({ code: 'DATA_MISSING' }),
    );
    expect(() => vault.resolvePlaceholder(data, 'secret', 'nope', 'example.com')).toThrowError(
      expect.objectContaining({ code: 'DATA_MISSING' }),
    );
  });

  it('凭据域名不在允许列表抛 SECRET_ORIGIN_DENIED', () => {
    expect(() => vault.resolvePlaceholder(data, 'secret', 'pass', 'evil.test')).toThrowError(
      expect.objectContaining({ code: 'SECRET_ORIGIN_DENIED' }),
    );
  });

  it('未配置允许域名的凭据被拒绝', () => {
    const d = { ...data, secretOrigins: {} };
    expect(() => vault.resolvePlaceholder(d, 'secret', 'pass', 'example.com')).toThrowError(
      expect.objectContaining({ code: 'SECRET_ORIGIN_DENIED' }),
    );
  });

  it('域名匹配时返回值，支持通配符', () => {
    expect(vault.resolvePlaceholder(data, 'secret', 'pass', 'example.com')).toBe(data.secret.pass);
    expect(vault.resolvePlaceholder(data, 'secret', 'pass', 'a.shop.example.com')).toBe(
      data.secret.pass,
    );
  });

  it('个人信息不校验域名', () => {
    expect(vault.resolvePlaceholder(data, 'profile', 'name', 'anything.test')).toBe(
      data.profile.name,
    );
  });
});

describe('missingData', () => {
  it('列出缺失的键', () => {
    expect(
      vault.missingData(data, { profile: ['name', 'phone'], secret: ['pass', 'token'] }),
    ).toEqual(['profile.phone', 'secret.token']);
  });

  it('requires 为空返回 []', () => {
    expect(vault.missingData(empty, { profile: [], secret: [] })).toEqual([]);
  });
});

describe('profileValueIndex', () => {
  it('把值映射回键，不含凭据', () => {
    const index = vault.profileValueIndex(data);
    expect(index.get('Zhang-San-Profile')).toBe('name');
    expect(index.has('S3cr3t-Value-XYZ')).toBe(false);
    expect(vault.profileValueIndex(empty).size).toBe(0);
  });
});

describe('导出与导入', () => {
  it('导出 → 清空 → 导入后数据一致', async () => {
    await vault.saveVault('u1', data);
    const backup = await vault.exportVault('u1');
    expect(JSON.parse(backup)).toEqual(data);
    resetFakeBrowser();
    await vault.importVault('u1', backup);
    expect(await vault.loadVault('u1')).toEqual(data);
  });

  it('格式不正确的备份被拒绝且不改动现有数据', async () => {
    await vault.saveVault('u1', data);
    await expect(vault.importVault('u1', 'not json')).rejects.toThrow('备份格式不正确');
    await expect(vault.importVault('u1', '{"profile":42}')).rejects.toThrow('备份格式不正确');
    expect(await vault.loadVault('u1')).toEqual(data);
  });
});
