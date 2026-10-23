// PagePilot 管理页：纯原生 JS。所有接口文本一律经 textContent 插入，不拼接 innerHTML。

const state = { me: null, tab: 'rules', limit: {}, sel: {}, busy: 0 };
const $ = (id) => document.getElementById(id);
const main = $('main');

// ---------- 通用工具 ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const pick = (o, ...keys) => {
  for (const k of keys) if (o && o[k] != null) return o[k];
  return undefined;
};
const isAdmin = () => state.me && state.me.role === 'admin';

function fmtTime(v) {
  if (v == null || v === '') return '';
  const d = new Date(typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v);
  return isNaN(d) ? String(v) : d.toLocaleString();
}
const fmtMs = (v) => (v == null ? '' : v >= 1000 ? (v / 1000).toFixed(1) + ' 秒' : v + ' 毫秒');

// 把含 {{…}} 的文本拆成普通文本与高亮占位符
function withPlaceholders(text) {
  const out = [];
  String(text ?? '')
    .split(/(\{\{[^}]*\}\})/)
    .forEach((part) => {
      if (!part) return;
      out.push(/^\{\{[^}]*\}\}$/.test(part) ? h('span', { class: 'ph', text: part }) : part);
    });
  return out;
}

function showError(msg) {
  const el = $('error');
  el.textContent = msg || '';
  el.hidden = !msg;
  if (msg) el.scrollIntoView({ block: 'nearest' });
}
function setBusy(delta) {
  state.busy += delta;
  $('loading').hidden = state.busy <= 0;
}

class ApiError extends Error {
  constructor(status, body) {
    super(describeError(status, body));
    this.status = status;
    this.body = body;
  }
}
function errorList(body) {
  if (!body || typeof body !== 'object') return [];
  const src = body.errors ?? body.detail?.errors ?? body.detail;
  if (Array.isArray(src))
    return src.map((e) => (typeof e === 'string' ? e : e.msg || JSON.stringify(e)));
  if (typeof src === 'string') return [src];
  return [];
}
function describeError(status, body) {
  if (status === 401) return '未登录，请通过门户登录后刷新';
  if (status === 403) return '没有权限或来源不被允许（403）';
  if (status === 404) return '未找到，或无权访问（404）';
  if (status === 413) return '内容过大（413）';
  const list = errorList(body);
  return list.length ? `请求失败（${status}）：\n${list.join('\n')}` : `请求失败（${status}）`;
}

async function api(method, path, body) {
  setBusy(1);
  try {
    const res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    const text = await res.text();
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    if (!res.ok) throw new ApiError(res.status, data);
    return data;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new Error('网络错误：' + (e && e.message ? e.message : e));
  } finally {
    setBusy(-1);
  }
}
// 执行并把错误统一显示在顶部；成功返回结果，失败返回 undefined
async function guard(fn) {
  showError('');
  try {
    return await fn();
  } catch (e) {
    showError(e.message);
  }
}

// 返回数组：兼容 [..] 与 {items:[..]}
const asList = (d) => (Array.isArray(d) ? d : Array.isArray(d?.items) ? d.items : []);

function dataTable(columns, rows, onSelect, selectedKey, keyOf) {
  const head = h(
    'tr',
    {},
    columns.map((c) => h('th', { scope: 'col', text: c.title })),
  );
  const body = rows.map((r) => {
    const key = keyOf(r);
    const tr = h(
      'tr',
      {
        class: onSelect ? 'row' + (key === selectedKey ? ' sel' : '') : null,
        tabindex: onSelect ? '0' : null,
        role: onSelect ? 'button' : null,
      },
      columns.map((c) => h('td', {}, c.render(r))),
    );
    if (onSelect) {
      tr.addEventListener('click', () => onSelect(r));
      tr.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(r);
        }
      });
    }
    return tr;
  });
  if (!rows.length)
    body.push(h('tr', {}, h('td', { colspan: columns.length, class: 'muted', text: '暂无数据' })));
  return h(
    'div',
    { class: 'table-wrap' },
    h('table', {}, h('thead', {}, head), h('tbody', {}, body)),
  );
}

function moreButton(tab, count, reload) {
  const limit = state.limit[tab] || 100;
  if (count < limit || limit >= 500) return null;
  return h('button', {
    class: 'btn more',
    type: 'button',
    text: '加载更多',
    onclick: () => {
      state.limit[tab] = Math.min(limit + 100, 500);
      reload();
    },
  });
}
const limitQs = (tab) => 'limit=' + (state.limit[tab] || 100);

function deleteButton(label, confirmMsg, fn) {
  return h('button', {
    class: 'btn danger',
    type: 'button',
    text: label,
    onclick: async () => {
      if (confirm(confirmMsg)) await fn();
    },
  });
}

// ---------- 规则 ----------
const ruleTemplate = () => ({
  id: 'new-rule',
  name: '新规则',
  version: 1,
  trigger: 'manual',
  inputMode: 'auto',
  match: { urls: ['https://example.com/*'] },
  steps: [{ id: 's1', type: 'open', url: 'https://example.com/' }],
});

async function renderRules() {
  const all = !!state.rulesAll;
  const data = await guard(() =>
    api('GET', `/api/rules?${limitQs('rules')}${all ? '&all=1' : ''}`),
  );
  if (!data) return;
  const items = asList(data);
  const sel = state.sel.rules;
  const editor = h(
    'div',
    { class: 'panel' },
    h('p', { class: 'muted', text: '选择左侧规则，或点击“新建规则”。' }),
  );
  const reload = () => show('rules');

  const toolbar = h(
    'div',
    { class: 'toolbar' },
    h('button', {
      class: 'btn primary',
      type: 'button',
      text: '新建规则',
      onclick: () => {
        state.sel.rules = null;
        state.draft = { rule: ruleTemplate(), shared: false, isNew: true };
        reload();
      },
    }),
    isAdmin() &&
      h(
        'label',
        {},
        h('input', {
          type: 'checkbox',
          checked: all ? true : null,
          onchange: (e) => {
            state.rulesAll = e.target.checked;
            reload();
          },
        }),
        ' 显示全部用户的规则',
      ),
    h('button', { class: 'btn', type: 'button', text: '刷新', onclick: reload }),
  );

  const cols = [
    { title: 'ID', render: (r) => r.rule?.id },
    { title: '名称', render: (r) => r.rule?.name },
    { title: '版本', render: (r) => r.rule?.version },
    { title: '触发方式', render: (r) => r.rule?.trigger || 'manual' },
    { title: '匹配网址', render: (r) => (r.rule?.match?.urls || []).join('\n') },
    { title: '共享', render: (r) => (r.shared ? '共享' : '私有') },
    { title: '所有者', render: (r) => r.ownerSub },
    { title: '更新时间', render: (r) => fmtTime(r.updatedAt) },
  ];
  const table = dataTable(
    cols,
    items,
    (r) => {
      state.sel.rules = r.rule.id;
      state.draft = { rule: r.rule, shared: !!r.shared, isNew: false };
      reload();
    },
    sel,
    (r) => r.rule?.id,
  );

  const d = state.draft;
  if (d) editor.replaceChildren(...ruleEditor(d, reload));
  const left = h('div', {}, table, moreButton('rules', items.length, reload));
  main.replaceChildren(toolbar, h('div', { class: 'split wide' }, left, editor));
}

function ruleEditor(d, reload) {
  const ta = h('textarea', { 'aria-label': '规则 JSON', spellcheck: 'false' });
  ta.value = JSON.stringify(d.rule, null, 2);
  const shared =
    isAdmin() &&
    h(
      'label',
      {},
      h('input', { type: 'checkbox', checked: d.shared ? true : null }),
      ' 共享给所有用户',
    );
  const out = h('div', { 'aria-live': 'polite' });
  const retry = h('button', { class: 'btn', type: 'button', text: '版本 +1 后重试', hidden: true });

  const parse = () => {
    try {
      return JSON.parse(ta.value);
    } catch (e) {
      out.replaceChildren(h('p', { class: 'errs', text: 'JSON 格式错误：' + e.message }));
      return null;
    }
  };
  const showErrs = (errs) =>
    out.replaceChildren(
      h(
        'ul',
        { class: 'errs' },
        errs.map((e) => h('li', { text: e })),
      ),
    );

  const validate = async () => {
    const rule = parse();
    if (!rule) return false;
    const res = await guard(() => api('POST', '/api/rules/validate', { rule }));
    if (!res) return false;
    if (res.ok) {
      out.replaceChildren(h('p', { class: 'okmsg', text: '校验通过' }));
      return true;
    }
    showErrs(res.errors?.length ? res.errors : ['校验未通过']);
    return false;
  };
  const save = async () => {
    const rule = parse();
    if (!rule) return;
    retry.hidden = true;
    showError('');
    try {
      const body = { rule };
      if (isAdmin()) body.shared = shared.querySelector('input').checked;
      await api('PUT', '/api/rules/' + encodeURIComponent(rule.id), body);
      state.sel.rules = rule.id;
      state.draft = null;
      await reload();
    } catch (e) {
      if (e.status === 409) {
        showError('版本冲突：规则版本必须大于已有版本。');
        retry.hidden = false;
      } else if (e.status === 422 || errorList(e.body).length) {
        showErrs(errorList(e.body));
        showError(e.message);
      } else showError(e.message);
    }
  };
  retry.addEventListener('click', () => {
    const rule = parse();
    if (!rule) return;
    rule.version = (Number.isInteger(rule.version) ? rule.version : 0) + 1;
    ta.value = JSON.stringify(rule, null, 2);
    save();
  });

  const buttons = h(
    'div',
    { class: 'toolbar' },
    h('button', { class: 'btn', type: 'button', text: '校验', onclick: validate }),
    h('button', { class: 'btn primary', type: 'button', text: '保存', onclick: save }),
    retry,
    !d.isNew &&
      deleteButton('删除', `确认删除规则 ${d.rule.id}？`, async () => {
        const ok = await guard(() =>
          api('DELETE', '/api/rules/' + encodeURIComponent(d.rule.id)).then(() => true),
        );
        if (ok) {
          state.sel.rules = null;
          state.draft = null;
          reload();
        }
      }),
  );
  return [h('h2', { text: d.isNew ? '新建规则' : '规则：' + d.rule.id }), ta, shared, buttons, out];
}

// ---------- 录制 ----------
function stepBrief(s) {
  const t = s.target?.strategies?.[0];
  const parts = [];
  if (t) parts.push(`${t.kind}: ${t.value}`);
  for (const k of ['url', 'value', 'key', 'urlPattern', 'saveAs'])
    if (s[k] != null && s[k] !== '') parts.push(`${k}=${s[k]}`);
  if (typeof s.checked === 'boolean') parts.push('checked=' + s.checked);
  return parts.join('  ');
}
const unwrap = (d) =>
  Object.assign({}, d?.body || d?.raw || d?.message || d?.payload || {}, d || {});

async function renderRecordings() {
  const data = await guard(() => api('GET', '/api/recordings?' + limitQs('recordings')));
  if (!data) return;
  const items = asList(data);
  const reload = () => show('recordings');
  const idOf = (r) => pick(r, 'recordingId', 'id');
  const cols = [
    { title: '录制 ID', render: idOf },
    { title: '开始时间', render: (r) => fmtTime(pick(r, 'startedAt')) },
    {
      title: '步骤数',
      render: (r) => {
        const v = pick(r, 'stepCount', 'steps', 'stepsCount');
        return Array.isArray(v) ? v.length : v;
      },
    },
    { title: '上报时间', render: (r) => fmtTime(pick(r, 'reportedAt', 'createdAt', 'receivedAt')) },
    { title: '所有者', render: (r) => pick(r, 'ownerSub', 'owner') },
  ];
  const sel = state.sel.recordings;
  const detail = h(
    'div',
    { class: 'panel' },
    h('p', { class: 'muted', text: '选择左侧录制查看步骤。' }),
  );
  main.replaceChildren(
    h(
      'div',
      { class: 'toolbar' },
      h('button', { class: 'btn', type: 'button', text: '刷新', onclick: reload }),
    ),
    h(
      'div',
      { class: 'split wide' },
      h(
        'div',
        {},
        dataTable(
          cols,
          items,
          (r) => {
            state.sel.recordings = idOf(r);
            reload();
          },
          sel,
          idOf,
        ),
        moreButton('recordings', items.length, reload),
      ),
      detail,
    ),
  );
  if (sel) await fillRecording(detail, sel, reload);
}

async function fillRecording(box, id, reload) {
  const raw = await guard(() => api('GET', '/api/recordings/' + encodeURIComponent(id)));
  if (!raw) return;
  const rec = unwrap(raw);
  const steps = Array.isArray(rec.steps) ? rec.steps : [];
  const list = h(
    'ol',
    {},
    steps.map((s) =>
      h('li', {}, h('strong', { text: s.type || '?' }), ' ', withPlaceholders(stepBrief(s))),
    ),
  );
  const inp = (name, val) => h('input', { type: 'text', name, value: val ?? '' });
  const ta = (name) => h('textarea', { name, rows: '3', spellcheck: 'false' });
  const idIn = inp('id', ''),
    nameIn = inp('name', '');
  nameIn.required = true;
  nameIn.placeholder = '例如：韩国签证预约';
  idIn.placeholder = '留空自动生成';
  const urls = ta('urls'),
    exclude = ta('exclude');
  urls.placeholder = '留空则从录制里的页面地址推断';
  const captchaLen = h('input', { type: 'number', name: 'captchaLength', min: '1', max: '20' });
  captchaLen.placeholder = '留空：输入框填满（达到它的 maxlength）就继续';
  const trigger = h(
    'select',
    { name: 'trigger' },
    ['manual', 'auto'].map((v) => h('option', { value: v, text: v })),
  );
  const mode = h(
    'select',
    { name: 'inputMode' },
    ['auto', 'trusted', 'synthetic'].map((v) => h('option', { value: v, text: v })),
  );
  const sharedCb = isAdmin() && h('label', {}, h('input', { type: 'checkbox' }), ' 共享给所有用户');
  const out = h('div', { 'aria-live': 'polite' });
  const lines = (el) =>
    el.value
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  const field = (label, el) => h('label', {}, h('span', { text: label }), el);

  const submit = async (e) => {
    e.preventDefault();
    out.replaceChildren();
    // 只有名称必填；其余留空时由后台自动生成或推断
    const body = {
      name: nameIn.value.trim(),
      trigger: trigger.value,
      inputMode: mode.value,
    };
    if (idIn.value.trim()) body.id = idIn.value.trim();
    if (captchaLen.value) body.captchaLength = Number(captchaLen.value);
    const matchUrls = lines(urls);
    if (matchUrls.length) body.urls = matchUrls;
    const ex = lines(exclude);
    if (ex.length) body.exclude = ex;
    if (sharedCb) body.shared = sharedCb.querySelector('input').checked;
    showError('');
    try {
      const res = await api('POST', `/api/recordings/${encodeURIComponent(id)}/rule`, body);
      const created = res && (res.rule || res);
      state.sel.rules = created && created.id ? created.id : body.id;
      state.draft = null;
      await show('rules');
    } catch (err) {
      showError(err.message);
      const errs = errorList(err.body);
      if (errs.length)
        out.replaceChildren(
          h(
            'ul',
            { class: 'errs' },
            errs.map((x) => h('li', { text: x })),
          ),
        );
    }
  };
  const form = h(
    'form',
    { class: 'form-grid', onsubmit: submit },
    h('h2', { text: '生成规则' }),
    field('名称', nameIn),
    h(
      'details',
      { class: 'adv' },
      h('summary', { text: '更多设置（一般不用填）' }),
      field('规则 ID', idIn),
      field('匹配网址（每行一条）', urls),
      field('排除网址（每行一条，可空）', exclude),
      field('验证码位数（可空）', captchaLen),
      field('触发方式', trigger),
      field('输入方式', mode),
      sharedCb,
    ),
    h(
      'div',
      { class: 'toolbar' },
      h('button', { class: 'btn primary', type: 'submit', text: '生成规则' }),
      deleteButton('删除录制', '确认删除该录制？', async () => {
        const ok = await guard(() =>
          api('DELETE', '/api/recordings/' + encodeURIComponent(id)).then(() => true),
        );
        if (ok) {
          state.sel.recordings = null;
          reload();
        }
      }),
    ),
    out,
  );
  box.replaceChildren(
    h('h2', { text: '录制：' + id }),
    steps.length ? list : h('p', { class: 'muted', text: '没有步骤' }),
    form,
  );
}

// ---------- 抓取 ----------
async function renderCaptures() {
  const data = await guard(() => api('GET', '/api/captures?' + limitQs('captures')));
  if (!data) return;
  const items = asList(data);
  const reload = () => show('captures');
  const idOf = (c) => pick(c, 'captureId', 'id');
  const cols = [
    { title: '页面 URL', render: (c) => pick(c, 'pageUrl', 'url') },
    { title: '标题', render: (c) => c.title },
    {
      title: '元素数',
      render: (c) => {
        const v = pick(c, 'elementCount', 'elements', 'count');
        return Array.isArray(v) ? v.length : v;
      },
    },
    { title: '时间', render: (c) => fmtTime(pick(c, 'capturedAt', 'createdAt', 'receivedAt')) },
  ];
  const sel = state.sel.captures;
  const detail = h(
    'div',
    { class: 'panel' },
    h('p', { class: 'muted', text: '选择左侧抓取查看元素。' }),
  );
  main.replaceChildren(
    h(
      'div',
      { class: 'toolbar' },
      h('button', { class: 'btn', type: 'button', text: '刷新', onclick: reload }),
    ),
    h(
      'div',
      { class: 'split' },
      h(
        'div',
        {},
        dataTable(
          cols,
          items,
          (c) => {
            state.sel.captures = idOf(c);
            reload();
          },
          sel,
          idOf,
        ),
        moreButton('captures', items.length, reload),
      ),
      detail,
    ),
  );
  if (!sel) return;
  const raw = await guard(() => api('GET', '/api/captures/' + encodeURIComponent(sel)));
  if (!raw) return;
  const cap = unwrap(raw);
  const els = Array.isArray(cap.elements) ? cap.elements : [];
  const ecols = [
    { title: '标签', render: (e) => e.tag },
    { title: '角色', render: (e) => e.role },
    { title: '名称', render: (e) => e.name },
    {
      title: '属性',
      render: (e) =>
        Object.entries(e.attrs || {})
          .map(([k, v]) => `${k}=${v}`)
          .join('\n'),
    },
    {
      title: '定位器',
      render: (e) => {
        const s = e.locator?.strategies?.[0];
        return s ? `${s.kind}: ${s.value}` : '';
      },
    },
    { title: '敏感', render: (e) => (e.sensitive ? '是' : '否') },
  ];
  detail.replaceChildren(
    h('h2', { text: pick(cap, 'pageUrl', 'url') || '抓取详情' }),
    dataTable(ecols, els, null, null, () => ''),
    h(
      'div',
      { class: 'toolbar more' },
      deleteButton('删除抓取', '确认删除该抓取？', async () => {
        const ok = await guard(() =>
          api('DELETE', '/api/captures/' + encodeURIComponent(sel)).then(() => true),
        );
        if (ok) {
          state.sel.captures = null;
          reload();
        }
      }),
    ),
  );
}

// ---------- 运行报告 ----------
async function renderRuns() {
  const rid = state.runFilter || '';
  const q = limitQs('runs') + (rid ? '&ruleId=' + encodeURIComponent(rid) : '');
  const data = await guard(() => api('GET', '/api/runs?' + q));
  if (!data) return;
  const items = asList(data);
  const reload = () => show('runs');
  const idOf = (r) => pick(r, 'runId', 'id');
  const dur = (r) =>
    r.endedAt != null && r.startedAt != null ? fmtMs(r.endedAt - r.startedAt) : fmtMs(r.durationMs);
  const stat = (s) => h('span', { class: 'status-' + s, text: s });
  const cols = [
    { title: '规则 ID', render: (r) => r.ruleId },
    { title: '版本', render: (r) => pick(r, 'ruleVersion', 'version') },
    { title: '状态', render: (r) => stat(r.status) },
    { title: '触发', render: (r) => r.trigger },
    { title: '输入方式', render: (r) => r.inputMode },
    { title: '开始时间', render: (r) => fmtTime(r.startedAt) },
    { title: '耗时', render: dur },
  ];
  const filter = h('input', {
    type: 'text',
    value: rid,
    'aria-label': '按规则 ID 过滤',
    placeholder: '按规则 ID 过滤',
  });
  const apply = () => {
    state.runFilter = filter.value.trim();
    state.sel.runs = null;
    reload();
  };
  filter.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') apply();
  });
  const sel = state.sel.runs;
  const detail = h(
    'div',
    { class: 'panel' },
    h('p', { class: 'muted', text: '选择左侧报告查看逐步结果。' }),
  );
  main.replaceChildren(
    h(
      'div',
      { class: 'toolbar' },
      h('div', { class: 'grow' }, filter),
      h('button', { class: 'btn', type: 'button', text: '过滤', onclick: apply }),
      h('button', { class: 'btn', type: 'button', text: '刷新', onclick: reload }),
    ),
    h(
      'div',
      { class: 'split wide' },
      h(
        'div',
        {},
        dataTable(
          cols,
          items,
          (r) => {
            state.sel.runs = idOf(r);
            reload();
          },
          sel,
          idOf,
        ),
        moreButton('runs', items.length, reload),
      ),
      detail,
    ),
  );
  if (!sel) return;
  const raw = await guard(() => api('GET', '/api/runs/' + encodeURIComponent(sel)));
  if (!raw) return;
  const run = unwrap(raw);
  const scols = [
    { title: '步骤 ID', render: (s) => s.stepId },
    { title: '状态', render: (s) => stat(s.status) },
    { title: '次数', render: (s) => s.attempts },
    { title: '耗时', render: (s) => fmtMs(s.durationMs) },
    { title: '错误码', render: (s) => s.errorCode },
  ];
  detail.replaceChildren(
    h('h2', { text: `运行：${run.ruleId ?? ''} ${sel}` }),
    dataTable(scols, Array.isArray(run.steps) ? run.steps : [], null, null, () => ''),
  );
}

// ---------- 标签页与启动 ----------
const renderers = {
  rules: renderRules,
  recordings: renderRecordings,
  captures: renderCaptures,
  runs: renderRuns,
};

async function show(tab) {
  state.tab = tab;
  for (const b of document.querySelectorAll('.tabs [role="tab"]')) {
    b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  }
  await renderers[tab]();
}

async function init() {
  document.querySelectorAll('.tabs [role="tab"]').forEach((b) => {
    b.addEventListener('click', () => {
      showError('');
      show(b.dataset.tab);
    });
  });
  const me = await guard(() => api('GET', '/api/me'));
  if (me) {
    state.me = me;
    $('me').textContent = `${me.sub}（${me.role === 'admin' ? '管理员' : '用户'}）`;
    await show('rules');
  } else {
    $('me').textContent = '未知用户';
  }
}
init();
