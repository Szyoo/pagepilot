// PagePilot 管理页：纯原生 JS。所有接口文本一律经 textContent 插入，不拼接 innerHTML。

const state = {
  me: null,
  tab: 'rules',
  limit: {},
  sel: {},
  busy: 0,
  ai: { available: false, model: null },
};
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
  // 表单控件统一用设计包的 .field / .switch
  if (tag === 'textarea' || tag === 'select') el.classList.add('field');
  else if (tag === 'input') {
    if (el.type === 'checkbox') el.classList.add('switch');
    else el.classList.add('field');
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
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString();
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
    throw new Error('网络错误：' + (e?.message ? e.message : e));
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

// AI 接口的错误文案；404 视为接口不存在
function aiErrorText(e) {
  if (e instanceof ApiError) {
    if (e.status === 503) return 'AI 未配置';
    if (e.status === 504) return 'AI 响应超时';
    if (e.status === 502) return 'AI 解读失败';
  }
  return e.message || 'AI 请求失败';
}
const checkLabel = (input, text) =>
  h('label', { class: 'field-row check-row' }, input, h('span', { text }));
const spinner = (text) =>
  h(
    'span',
    { class: 'ai-wait muted', role: 'status' },
    h('span', { class: 'spinner' }),
    ' ' + text,
  );
const AI_PRIVACY = '发送前会抹掉你输入的值，只发步骤类型、按钮文字和页面地址。';

// 步骤的可读视图：大字说明 + 小字类型/目标
function stepList(steps, noteOf) {
  return h(
    'ol',
    { class: 'step-list' },
    steps.map((s, i) => {
      const note = noteOf(s);
      const brief = withPlaceholders(`${s.type || '?'}  ${stepBrief(s)}`.trim());
      return h(
        'li',
        { class: 'step-item' },
        h('span', { class: 'step-no num', text: String(i + 1) }),
        h(
          'div',
          { class: 'step-body' },
          note && h('div', { class: 'step-note', text: note }),
          h('div', { class: note ? 'step-sub small muted' : 'step-note' }, brief),
        ),
      );
    }),
  );
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
    { class: 'table-wrap glass' },
    h('table', { class: 'tbl' }, h('thead', {}, head), h('tbody', {}, body)),
  );
}

function moreButton(tab, count, reload) {
  const limit = state.limit[tab] || 100;
  if (count < limit || limit >= 500) return null;
  return h('button', {
    class: 'btn-ghost btn-small more',
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
    class: 'btn-ghost btn-small danger',
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
    { class: 'glass panel panel-detail' },
    h('p', { class: 'muted', text: '选择左侧规则，或点击“新建规则”。' }),
  );
  const reload = () => show('rules');

  const toolbar = h(
    'div',
    { class: 'toolbar' },
    h('button', {
      class: 'btn btn-small',
      type: 'button',
      text: '新建规则',
      onclick: () => {
        state.sel.rules = null;
        state.draft = { rule: ruleTemplate(), shared: false, isNew: true };
        reload();
      },
    }),
    isAdmin() &&
      checkLabel(
        h('input', {
          type: 'checkbox',
          checked: all ? true : null,
          onchange: (e) => {
            state.rulesAll = e.target.checked;
            reload();
          },
        }),
        '显示全部用户的规则',
      ),
    h('button', { class: 'btn-ghost btn-small', type: 'button', text: '刷新', onclick: reload }),
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
  if (d) editor.replaceChildren(...ruleEditor(d, reload).filter(Boolean));
  const left = h('div', {}, table, moreButton('rules', items.length, reload));
  main.replaceChildren(toolbar, h('div', { class: 'split wide' }, left, editor));
}

function ruleEditor(d, reload) {
  const ta = h('textarea', { 'aria-label': '规则 JSON', spellcheck: 'false' });
  ta.value = JSON.stringify(d.rule, null, 2);
  const shared =
    isAdmin() &&
    checkLabel(h('input', { type: 'checkbox', checked: d.shared ? true : null }), '共享给所有用户');
  const out = h('div', { 'aria-live': 'polite' });
  const aiOut = h('div', { class: 'ai-out', 'aria-live': 'polite' });
  // 步骤可读视图：跟着编辑器里的 JSON 实时更新（JSON 暂时写坏时保持上一次的内容）
  const steps = h('div', { class: 'steps-view' });
  const paintSteps = () => {
    try {
      const rule = JSON.parse(ta.value);
      if (Array.isArray(rule?.steps) && rule.steps.length)
        steps.replaceChildren(stepList(rule.steps, (s) => s.note));
      else steps.replaceChildren(h('p', { class: 'muted', text: '还没有步骤' }));
    } catch {
      /* 保持上一次 */
    }
  };
  ta.addEventListener('input', paintSteps);
  paintSteps();
  if (state.ruleNote && state.ruleNote.id === d.rule.id) {
    aiOut.replaceChildren(
      h(
        'div',
        { class: 'callout ok' },
        h('strong', { text: state.ruleNote.title || '已保存为新版本并下发到扩展' }),
        h('p', { class: 'ai-summary', text: state.ruleNote.summary || '' }),
      ),
    );
    state.ruleNote = null;
  }
  const describe =
    state.ai.available &&
    !d.isNew &&
    h('button', {
      class: 'btn-ghost btn-small',
      type: 'button',
      text: 'AI 补充说明',
      onclick: async (ev) => {
        const btn = ev.currentTarget;
        if (
          ta.value !== JSON.stringify(d.rule, null, 2) &&
          !confirm('编辑器里有未保存的修改，AI 补充说明基于已保存的版本，继续？')
        )
          return;
        btn.disabled = true;
        aiOut.replaceChildren(spinner('AI 正在补充说明…'));
        try {
          const res = await api('POST', `/api/rules/${encodeURIComponent(d.rule.id)}/describe`, {});
          state.draft = { rule: res.rule, shared: d.shared, isNew: false };
          state.ruleNote = { id: d.rule.id, summary: res.summary };
          await reload();
        } catch (e) {
          btn.disabled = false;
          aiOut.replaceChildren(
            h('div', { class: 'callout err', role: 'alert', text: aiErrorText(e) }),
          );
        }
      },
    });
  const retry = h('button', {
    class: 'btn-ghost btn-small',
    type: 'button',
    text: '版本 +1 后重试',
    hidden: true,
  });

  const parse = () => {
    try {
      return JSON.parse(ta.value);
    } catch (e) {
      out.replaceChildren(h('p', { class: 'errs err-text', text: 'JSON 格式错误：' + e.message }));
      return null;
    }
  };
  const showErrs = (errs) =>
    out.replaceChildren(
      h(
        'ul',
        { class: 'errs err-text' },
        errs.map((e) => h('li', { text: e })),
      ),
    );

  const validate = async () => {
    const rule = parse();
    if (!rule) return false;
    const res = await guard(() => api('POST', '/api/rules/validate', { rule }));
    if (!res) return false;
    if (res.ok) {
      out.replaceChildren(h('p', { class: 'okmsg ok-text', text: '校验通过' }));
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
    h('button', { class: 'btn-ghost btn-small', type: 'button', text: '校验', onclick: validate }),
    h('button', { class: 'btn btn-small', type: 'button', text: '保存', onclick: save }),
    retry,
    describe,
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
  return [
    h('h3', { class: 'panel-title', text: d.isNew ? '新建规则' : '规则：' + d.rule.id }),
    h('h4', { class: 'sub-title muted', text: '步骤' }),
    steps,
    describe && h('p', { class: 'hint', text: AI_PRIVACY }),
    aiOut,
    state.ai.available && !d.isNew && aiEditBox(d, ta, reload),
    h('h4', { class: 'sub-title muted', text: '规则 JSON' }),
    ta,
    shared,
    buttons,
    out,
  ];
}

// ---------- AI 修改：提案与前后对比 ----------
const AI_EDIT_PRIVACY = '发送前会把规则里你录入的具体值换成记号，不会发给 AI；网址只发网站与路径。';
const STEP_CHILDREN = ['then', 'else', 'steps'];

// 按出现顺序列出全部步骤（含 login.steps 与嵌套），pos 是给人看的位置（如 “6.1”“登录 1”）
function flatRuleSteps(rule) {
  const out = [];
  const walk = (steps, prefix) => {
    if (!Array.isArray(steps)) return;
    steps.forEach((s, i) => {
      if (!s || typeof s !== 'object') return;
      const pos = prefix + (i + 1);
      out.push({ step: s, pos });
      for (const k of STEP_CHILDREN)
        if (Array.isArray(s[k])) walk(s[k], pos + (k === 'else' ? '.否则 ' : '.'));
    });
  };
  walk(rule?.login?.steps, '登录 ');
  walk(rule?.steps, '');
  return out;
}
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function shortValue(v) {
  if (v === undefined) return '（无）';
  const t = typeof v === 'string' ? v : JSON.stringify(v);
  return t.length > 160 ? t.slice(0, 159) + '…' : t;
}
// 两个对象的字段级差异（跳过 skip 里的键）
function fieldChanges(before, after, skip) {
  const keys = [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])];
  return keys
    .filter((k) => !skip.includes(k) && !sameJson(before?.[k], after?.[k]))
    .map((k) => ({ key: k, before: before?.[k], after: after?.[k] }));
}
// 按步骤 id 对比：新增 / 删除 / 修改（修改只看步骤自身字段，子步骤单独对比）
function diffSteps(oldRule, newRule) {
  const olds = new Map(flatRuleSteps(oldRule).map((e) => [e.step.id, e]));
  const news = flatRuleSteps(newRule);
  const ids = new Set(news.map((e) => e.step.id));
  const items = [];
  for (const e of news) {
    const old = olds.get(e.step.id);
    if (!old) items.push({ kind: 'add', entry: e });
    else {
      const fields = fieldChanges(old.step, e.step, ['id', ...STEP_CHILDREN]);
      if (fields.length) items.push({ kind: 'mod', entry: e, fields });
    }
  }
  for (const [id, e] of olds) if (!ids.has(id)) items.push({ kind: 'del', entry: e });
  return items;
}
function diffTop(oldRule, newRule) {
  const top = fieldChanges(oldRule, newRule, ['steps', 'login', 'version']);
  const ol = oldRule?.login;
  const nl = newRule?.login;
  if (!ol !== !nl)
    top.push({
      key: 'login',
      before: ol ? '（有登录流程）' : undefined,
      after: nl ? '（有登录流程）' : undefined,
    });
  else if (ol && nl)
    for (const f of fieldChanges(ol, nl, ['steps'])) top.push({ ...f, key: 'login.' + f.key });
  return top;
}
const DIFF_LABEL = { add: ['新增', 'green'], del: ['删除', 'red'], mod: ['修改', 'amber'] };
function fieldList(fields) {
  return h(
    'ul',
    { class: 'diff-fields small' },
    fields.map((f) =>
      h(
        'li',
        {},
        h('code', { text: f.key }),
        '：',
        h('span', { class: 'diff-old', text: shortValue(f.before) }),
        ' → ',
        h('span', { class: 'diff-new', text: shortValue(f.after) }),
      ),
    ),
  );
}
function diffView(oldRule, newRule) {
  const steps = diffSteps(oldRule, newRule);
  const top = diffTop(oldRule, newRule);
  const box = h('div', { class: 'diff' });
  if (!steps.length && !top.length) {
    box.append(h('p', { class: 'muted', text: '与当前保存的版本相比没有变化。' }));
    return box;
  }
  if (steps.length)
    box.append(
      h(
        'ul',
        { class: 'diff-list' },
        steps.map(({ kind, entry, fields }) => {
          const [label, color] = DIFF_LABEL[kind];
          const s = entry.step;
          return h(
            'li',
            { class: 'diff-item ' + kind },
            h(
              'div',
              { class: 'diff-head' },
              h('span', { class: 'pill ' + color, text: label }),
              h('span', { class: 'num', text: `第 ${entry.pos} 步` }),
              h('span', { class: 'muted small', text: `${s.type || '?'} · ${s.id}` }),
            ),
            s.note && h('div', { class: 'diff-note', text: s.note }),
            kind === 'add' &&
              h('div', { class: 'small muted step-sub' }, withPlaceholders(stepBrief(s))),
            fields && fieldList(fields),
          );
        }),
      ),
    );
  if (top.length)
    box.append(h('h5', { class: 'sub-title muted', text: '其他字段' }), fieldList(top));
  return box;
}

function aiEditBox(d, editor, reload) {
  const id = d.rule.id;
  let base = null; // 在上一次提案上继续改时的规则
  const input = h('textarea', {
    class: 'ai-edit-input',
    rows: '3',
    'aria-label': 'AI 修改要求',
    maxlength: '2000',
    placeholder: '例如：第 5 步之后加一个每 10 秒刷新、直到出现可预约名额的循环，最多 200 次',
  });
  const baseHint = h('p', { class: 'hint', hidden: true });
  const out = h('div', { class: 'ai-out', 'aria-live': 'polite' });
  const run = h('button', { class: 'btn btn-small', type: 'button', text: '生成修改' });
  const fail = (text) => h('div', { class: 'callout err', role: 'alert', text });
  const setBase = (rule) => {
    base = rule;
    baseHint.hidden = !rule;
    baseHint.textContent = rule ? '将在上一次的提案（未保存）基础上继续修改。' : '';
  };

  const showProposal = (res) => {
    const errs = Array.isArray(res.errors) ? res.errors : [];
    const changes = Array.isArray(res.changes) ? res.changes : [];
    const save = h('button', {
      class: 'btn btn-small',
      type: 'button',
      text: '保存为新版本',
      disabled: errs.length ? true : null,
    });
    const msg = h('div', { 'aria-live': 'polite' });
    save.addEventListener('click', async () => {
      save.disabled = true;
      msg.replaceChildren();
      try {
        const saved = await api('PUT', '/api/rules/' + encodeURIComponent(id), { rule: res.rule });
        state.draft = { rule: saved.rule, shared: !!saved.shared, isNew: false };
        state.ruleNote = {
          id,
          title: `已保存为第 ${saved.rule.version} 版并下发到扩展`,
          summary: res.summary,
        };
        await reload();
      } catch (e) {
        save.disabled = false;
        if (e.status === 409)
          msg.replaceChildren(fail('规则在此期间被改过（版本冲突），请刷新后重新生成修改。'));
        else {
          const list = errorList(e.body);
          msg.replaceChildren(fail(list.length ? list.join('\n') : e.message));
        }
      }
    });
    // 参数里有条件项（没有校验错误时是 false），交给 replaceChildren 前去掉，否则会显示成文字“false”
    const proposalParts = [
      h(
        'div',
        { class: 'callout info' },
        h('strong', { text: `AI 修改提案（保存后为第 ${res.rule?.version ?? '?'} 版）` }),
        res.summary && h('p', { class: 'ai-summary', text: res.summary }),
        changes.length > 0 &&
          h(
            'ul',
            { class: 'ai-changes' },
            changes.map((c) => h('li', { text: c })),
          ),
      ),
      errs.length > 0 &&
        h(
          'div',
          { class: 'callout err', role: 'alert' },
          h('strong', { text: '还不能保存：修改后的规则没有通过校验' }),
          h(
            'ul',
            { class: 'errs' },
            errs.map((e) => h('li', { text: e })),
          ),
          h('p', { text: '可以点「在此基础上继续修改」让 AI 修正这些问题，或者放弃。' }),
        ),
      h('h4', { class: 'sub-title muted', text: '前后对比（与当前保存的版本）' }),
      diffView(d.rule, res.rule),
      h(
        'details',
        { class: 'adv' },
        h('summary', { text: '查看提案的规则 JSON' }),
        h('pre', { class: 'json-pre', text: JSON.stringify(res.rule, null, 2) }),
      ),
      h(
        'div',
        { class: 'toolbar' },
        save,
        h('button', {
          class: 'btn-ghost btn-small',
          type: 'button',
          text: '在此基础上继续修改',
          onclick: () => {
            setBase(res.rule);
            out.replaceChildren();
            input.value = '';
            input.focus();
          },
        }),
        h('button', {
          class: 'btn-ghost btn-small',
          type: 'button',
          text: '放弃',
          onclick: () => {
            setBase(null);
            out.replaceChildren();
          },
        }),
      ),
      msg,
    ];
    out.replaceChildren(...proposalParts.filter(Boolean));
  };

  run.addEventListener('click', async () => {
    const instruction = input.value.trim();
    if (!instruction) {
      out.replaceChildren(fail('请先写下要怎么修改。'));
      input.focus();
      return;
    }
    if (
      !base &&
      editor.value !== JSON.stringify(d.rule, null, 2) &&
      !confirm('编辑器里有未保存的修改，AI 修改基于已保存的版本，继续？')
    )
      return;
    run.disabled = true;
    out.replaceChildren(spinner('AI 正在生成修改…（可能要几十秒）'));
    try {
      const body = { instruction };
      if (base) body.base = base;
      const res = await api('POST', `/api/rules/${encodeURIComponent(id)}/ai-edit`, body);
      setBase(null);
      showProposal(res);
    } catch (e) {
      const list =
        e instanceof ApiError && (e.status === 422 || e.status === 403) ? errorList(e.body) : [];
      const text =
        e instanceof ApiError && e.status === 502 ? 'AI 修改失败，请稍后重试' : aiErrorText(e);
      out.replaceChildren(fail(list.length ? list.join('\n') : text));
    } finally {
      run.disabled = false;
    }
  });

  return h(
    'section',
    { class: 'ai-edit', 'aria-label': 'AI 修改' },
    h('h4', { class: 'sub-title muted', text: 'AI 修改' }),
    h('p', { class: 'hint', text: AI_EDIT_PRIVACY }),
    baseHint,
    input,
    h('div', { class: 'toolbar' }, run),
    out,
  );
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
    { class: 'glass panel panel-detail' },
    h('p', { class: 'muted', text: '选择左侧录制查看步骤。' }),
  );
  main.replaceChildren(
    h(
      'div',
      { class: 'toolbar' },
      h('button', { class: 'btn-ghost btn-small', type: 'button', text: '刷新', onclick: reload }),
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
  let ai = rec.ai && typeof rec.ai === 'object' ? rec.ai : null;
  const stepsBox = h('div', { class: 'steps-view' });
  const aiBox = h('div', { class: 'ai-out', 'aria-live': 'polite' });
  const aiBtn = state.ai.available
    ? h('button', { class: 'btn-ghost btn-small', type: 'button', onclick: () => runAi() })
    : null;
  const paint = () => {
    const notes = new Map((ai?.steps || []).map((x) => [x.id, x.text]));
    stepsBox.replaceChildren(
      steps.length
        ? stepList(steps, (s) => notes.get(s.id))
        : h('p', { class: 'muted', text: '没有步骤' }),
    );
    if (aiBtn) aiBtn.textContent = ai ? '重新解读' : 'AI 解读';
    if (!ai) return aiBox.replaceChildren();
    const meta = [ai.model, ai.createdAt && fmtTime(ai.createdAt), ai.cached ? '缓存' : '']
      .filter(Boolean)
      .join(' · ');
    aiBox.replaceChildren(
      h(
        'div',
        { class: 'callout info' },
        h('strong', { text: 'AI 解读' }),
        h('p', { class: 'ai-summary', text: ai.summary || '' }),
        meta && h('div', { class: 'tiny muted', text: meta }),
      ),
    );
  };
  const runAi = async () => {
    aiBtn.disabled = true;
    aiBox.replaceChildren(spinner('AI 解读中…'));
    try {
      const qs = ai ? '?refresh=1' : '';
      ai = await api('POST', `/api/recordings/${encodeURIComponent(id)}/describe${qs}`, {});
      paint();
    } catch (e) {
      paint();
      aiBox.append(h('div', { class: 'callout err', role: 'alert', text: aiErrorText(e) }));
    } finally {
      aiBtn.disabled = false;
    }
  };
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
  const sharedCb = isAdmin() && checkLabel(h('input', { type: 'checkbox' }), '共享给所有用户');
  const out = h('div', { 'aria-live': 'polite' });
  const lines = (el) =>
    el.value
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  const field = (label, el) => h('label', { class: 'form-row' }, h('span', { text: label }), el);

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
      state.sel.rules = created?.id ? created.id : body.id;
      state.draft = null;
      await show('rules');
    } catch (err) {
      showError(err.message);
      const errs = errorList(err.body);
      if (errs.length)
        out.replaceChildren(
          h(
            'ul',
            { class: 'errs err-text' },
            errs.map((x) => h('li', { text: x })),
          ),
        );
    }
  };
  const form = h(
    'form',
    { class: 'gen-form', onsubmit: submit },
    h('h3', { class: 'panel-title', text: '生成规则' }),
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
      h('button', { class: 'btn btn-small', type: 'submit', text: '生成规则' }),
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
  // AI 不可用时 aiBtn 为空，条件项要去掉，否则 replaceChildren 会把它显示成文字
  box.replaceChildren(
    ...[
      h(
        'div',
        { class: 'detail-head' },
        h('h3', { class: 'panel-title', text: '录制：' + id }),
        aiBtn,
      ),
      aiBtn && h('p', { class: 'hint', text: AI_PRIVACY }),
      aiBox,
      stepsBox,
      form,
    ].filter(Boolean),
  );
  paint();
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
    { class: 'glass panel panel-detail' },
    h('p', { class: 'muted', text: '选择左侧抓取查看元素。' }),
  );
  main.replaceChildren(
    h(
      'div',
      { class: 'toolbar' },
      h('button', { class: 'btn-ghost btn-small', type: 'button', text: '刷新', onclick: reload }),
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
    h('h3', { class: 'panel-title', text: pick(cap, 'pageUrl', 'url') || '抓取详情' }),
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
  const stat = (s) =>
    h('span', {
      class: 'pill ' + (s === 'succeeded' ? 'green' : s === 'failed' ? 'red' : 'slate'),
      text: s,
    });
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
    { class: 'glass panel panel-detail' },
    h('p', { class: 'muted', text: '选择左侧报告查看逐步结果。' }),
  );
  main.replaceChildren(
    h(
      'div',
      { class: 'toolbar' },
      h('div', { class: 'grow' }, filter),
      h('button', { class: 'btn-ghost btn-small', type: 'button', text: '过滤', onclick: apply }),
      h('button', { class: 'btn-ghost btn-small', type: 'button', text: '刷新', onclick: reload }),
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
    h('h3', { class: 'panel-title', text: `运行：${run.ruleId ?? ''} ${sel}` }),
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

// 支持 #rules / #recordings / #captures / #runs 直达对应标签页（扩展侧边栏的「管理页」链接用）
const tabFromHash = () => {
  const t = location.hash.slice(1);
  return renderers[t] ? t : 'rules';
};

async function init() {
  document.querySelectorAll('.tabs [role="tab"]').forEach((b) => {
    b.addEventListener('click', () => {
      showError('');
      history.replaceState(null, '', '#' + b.dataset.tab);
      show(b.dataset.tab);
    });
  });
  // AI 状态：接口不存在或失败一律视为不可用（不显示 AI 按钮）
  try {
    const st = await api('GET', '/api/ai/status');
    state.ai = { available: !!st?.available, model: st?.model ?? null };
  } catch {
    state.ai = { available: false, model: null };
  }
  const me = await guard(() => api('GET', '/api/me'));
  if (me) {
    state.me = me;
    $('me').textContent = `${me.sub}（${me.role === 'admin' ? '管理员' : '用户'}）`;
    await show(tabFromHash());
  } else {
    $('me').textContent = '未知用户';
  }
}
init();
