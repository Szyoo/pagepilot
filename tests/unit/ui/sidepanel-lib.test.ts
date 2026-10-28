import { describe, expect, it } from 'vitest';
import {
  adminUrl,
  connectionStatus,
  describeError,
  failedStepText,
  filterRules,
  formatDuration,
  resumeLabel,
  sortRuns,
  stepLabel,
  stepOptionLabel,
} from '../../../src/entrypoints/sidepanel/lib';
import type { BgState, RuleView, RunView } from '../../../src/shared/rpc';

describe('describeError', () => {
  it.each([
    ['TARGET_NOT_FOUND', '找不到页面上的元素（页面可能改版了）'],
    ['TIMEOUT', '等待超时'],
    ['ASSERT_FAILED', '页面状态和预期不符'],
    ['NAVIGATION_FAILED', '页面跳转失败'],
    ['PERMISSION_DENIED', '缺少网站访问权限'],
    ['DATA_MISSING', '缺少本地数据（去设置页的保险库补充）'],
    ['SECRET_ORIGIN_DENIED', '这个凭据不允许在当前网站使用'],
    ['REPEAT_EXHAUSTED', '反复尝试后条件仍未满足'],
    ['USER_ABORTED', '已被中止'],
    ['INTERNAL', '内部错误'],
  ])('%s', (code, text) => {
    expect(describeError(code)).toBe(text);
  });

  it('未知错误码原样返回', () => {
    expect(describeError('SOMETHING_ELSE')).toBe('SOMETHING_ELSE');
  });
});

const run = (over: Partial<RunView> = {}): RunView => ({
  runId: 'r1',
  ruleId: 'x',
  ruleName: '规则',
  tabId: 1,
  status: 'running',
  startedAt: 1000,
  ...over,
});

function bg(
  over: { auth?: BgState['auth']; connection?: BgState['connection']; runs?: RunView[] } = {},
) {
  return {
    auth: over.auth ?? { status: 'signedIn' },
    connection: over.connection ?? { status: 'connected', channel: 'sse' },
    runs: over.runs ?? [],
  } as Pick<BgState, 'auth' | 'connection' | 'runs'>;
}

describe('connectionStatus', () => {
  it('未登录优先于一切', () => {
    const s = bg({
      auth: { status: 'signedOut' },
      connection: { status: 'error', error: 'x' },
      runs: [run({ status: 'handoff' })],
    });
    expect(connectionStatus(s)).toEqual({ tone: 'gray', text: '未登录' });
  });

  it('连接出错优先于交还', () => {
    const s = bg({ connection: { status: 'error' }, runs: [run({ status: 'handoff' })] });
    expect(connectionStatus(s)).toEqual({ tone: 'red', text: '连接出错' });
  });

  it('有运行在交还时优先于连接中与已连接', () => {
    const handoff = [run({ status: 'handoff' })];
    expect(connectionStatus(bg({ runs: handoff }))).toEqual({ tone: 'yellow', text: '等你处理' });
    expect(connectionStatus(bg({ connection: { status: 'connecting' }, runs: handoff })).text).toBe(
      '等你处理',
    );
  });

  it('连接中', () => {
    expect(connectionStatus(bg({ connection: { status: 'connecting' } }))).toEqual({
      tone: 'yellow',
      text: '连接中…',
    });
  });

  it('已连接带通道名', () => {
    const text = (channel: 'sse' | 'websocket' | 'poll') =>
      connectionStatus(bg({ connection: { status: 'connected', channel } })).text;
    expect(text('sse')).toBe('已连接 · SSE');
    expect(text('websocket')).toBe('已连接 · WebSocket');
    expect(text('poll')).toBe('已连接 · 轮询');
    expect(connectionStatus(bg({ connection: { status: 'connected' } })).text).toBe('已连接');
    expect(connectionStatus(bg()).tone).toBe('green');
  });

  it('其他运行状态不影响', () => {
    expect(connectionStatus(bg({ runs: [run({ status: 'running' })] })).tone).toBe('green');
  });
});

describe('adminUrl', () => {
  it('没有后台地址时为 null', () => {
    expect(adminUrl(undefined, 'page')).toBeNull();
    expect(adminUrl('', 'rules')).toBeNull();
  });

  it('非法地址与非 http(s) 为 null', () => {
    expect(adminUrl('not a url', 'page')).toBeNull();
    expect(adminUrl('ftp://example.com', 'page')).toBeNull();
    expect(adminUrl('javascript:alert(1)', 'page')).toBeNull();
  });

  it('只取 origin，忽略路径与查询', () => {
    expect(adminUrl('https://admin.example.com', 'page')).toBe('https://admin.example.com/');
    expect(adminUrl('https://admin.example.com/api/v1?x=1', 'page')).toBe(
      'https://admin.example.com/',
    );
    expect(adminUrl('http://203.0.113.5:8080/base/', 'page')).toBe('http://203.0.113.5:8080/');
  });

  it('按页签带 hash', () => {
    const base = 'https://admin.example.com/api';
    expect(adminUrl(base, 'recording')).toBe('https://admin.example.com/#recordings');
    expect(adminUrl(base, 'runs')).toBe('https://admin.example.com/#runs');
    expect(adminUrl(base, 'rules')).toBe('https://admin.example.com/#rules');
    expect(adminUrl(base, 'page')).toBe('https://admin.example.com/');
  });
});

describe('formatDuration', () => {
  it('秒、分、小时', () => {
    expect(formatDuration(0)).toBe('0 秒');
    expect(formatDuration(42_900)).toBe('42 秒');
    expect(formatDuration(60_000)).toBe('1 分 00 秒');
    expect(formatDuration(185_000)).toBe('3 分 05 秒');
    expect(formatDuration(3_720_000)).toBe('1 小时 02 分');
  });

  it('负数与非法值按 0 处理', () => {
    expect(formatDuration(-5000)).toBe('0 秒');
    expect(formatDuration(Number.NaN)).toBe('0 秒');
  });
});

const rule = (id: string, name: string, matchUrls: string[]): RuleView => ({
  id,
  name,
  version: 1,
  enabled: true,
  trigger: 'manual',
  inputMode: 'auto',
  matchUrls,
  requires: { profile: [], secret: [] },
  stepCount: 1,
  approved: true,
  autoEnabled: false,
});

describe('filterRules', () => {
  const rules = [
    rule('a', '登录门户', ['https://portal.example.com/*']),
    rule('b', 'Export Report', ['https://reports.example.org/app/*', 'https://x.example.net/*']),
  ];

  it('空查询返回全部', () => {
    expect(filterRules(rules, '')).toEqual(rules);
    expect(filterRules(rules, '   ')).toEqual(rules);
  });

  it('按名称匹配（不区分大小写）', () => {
    expect(filterRules(rules, '登录').map((r) => r.id)).toEqual(['a']);
    expect(filterRules(rules, 'export').map((r) => r.id)).toEqual(['b']);
  });

  it('按任一网址匹配', () => {
    expect(filterRules(rules, 'example.org').map((r) => r.id)).toEqual(['b']);
    expect(filterRules(rules, 'X.EXAMPLE.NET').map((r) => r.id)).toEqual(['b']);
  });

  it('无匹配时为空', () => {
    expect(filterRules(rules, 'nothing')).toEqual([]);
  });
});

describe('sortRuns', () => {
  it('进行中置顶，其余按开始时间倒序', () => {
    const sorted = sortRuns([
      run({ runId: 'old-done', status: 'succeeded', startedAt: 1 }),
      run({ runId: 'new-done', status: 'failed', startedAt: 9 }),
      run({ runId: 'active', status: 'handoff', startedAt: 5 }),
    ]);
    expect(sorted.map((r) => r.runId)).toEqual(['active', 'new-done', 'old-done']);
  });
});

describe('步骤失败暂停的文案', () => {
  const stuck = {
    failedStepId: 's2',
    failedIndex: 1,
    errorCode: 'TARGET_NOT_FOUND',
    suggestedIndex: 1,
    steps: [
      { index: 0, id: 's1', type: 'click' },
      { index: 1, id: 's2', type: 'click', note: '点「下一步」' },
      { index: 2, id: 's3', type: 'waitFor', note: '  ' },
    ],
  };

  it('stepLabel：优先 note，空白 note 用类型人话，未知类型原样', () => {
    expect(stepLabel({ type: 'click', note: '点「下一步」' })).toBe('点「下一步」');
    expect(stepLabel({ type: 'waitFor', note: '  ' })).toBe('等待');
    expect(stepLabel({ type: 'open' })).toBe('打开网页');
    expect(stepLabel({ type: 'weird' })).toBe('weird');
  });

  it('stepOptionLabel 带序号', () => {
    expect(stepOptionLabel({ index: 2, id: 's3', type: 'waitFor' })).toBe('3. 等待');
  });

  it('failedStepText', () => {
    expect(failedStepText(stuck)).toBe('第 2 步「点「下一步」」');
  });

  it('resumeLabel：从建议的那一步继续', () => {
    expect(resumeLabel(stuck)).toBe('从第 2 步「点「下一步」」继续');
    expect(resumeLabel({ ...stuck, suggestedIndex: 2 })).toBe('从第 3 步「等待」继续');
  });

  it('resumeLabel：建议位置等于步骤数时这一段已完成', () => {
    expect(resumeLabel({ ...stuck, suggestedIndex: 3 })).toBe('这一段已完成，继续后面的步骤');
  });
});
