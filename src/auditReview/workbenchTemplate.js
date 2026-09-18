// Task workbench rendered through the existing Dashboard entry point. All data is server supplied.

const paths = {
  layers: '<path d="m12 3 10 5-10 5L2 8Zm-10 9 10 5 10-5M2 16l10 5 10-5"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  alert: '<path d="m10.3 3.9-8.1 14a2 2 0 0 0 1.7 3h16.2a2 2 0 0 0 1.7-3l-8.1-14a2 2 0 0 0-3.4 0M12 9v4m0 4h.01"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Zm0 0v6h6M8 13h8m-8 4h6"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  back: '<path d="m12 19-7-7 7-7m-7 7h14"/>',
  check: '<path d="m9 12 2 2 4-4"/><circle cx="12" cy="12" r="10"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
};

function icon(name) {
  return `<svg class="lucide" viewBox="0 0 24 24" aria-hidden="true">${paths[name] ?? paths.file}</svg>`;
}

export function renderTaskWorkbench(input, escape) {
  const w = input.workbench;
  const filters = w.filters ?? {};
  const selected = w.selected;
  const stateKey = (state) => ['attention', 'pending', 'done', 'unreviewed'].includes(state?.key) ? state.key : 'unreviewed';
  const badge = (state) => `<span class="badge ${stateKey(state)}">${escape(state?.text ?? '未审查')}</span>`;
  const text = (value) => escape(value === null || value === undefined || value === '' ? '未记录' : value);
  const formatTime = (value) => {
    if (!value) return '未记录';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).format(date);
  };
  const time = (value) => value ? `<time datetime="${escape(value)}" title="北京时间 UTC+8">${escape(formatTime(value))}</time>` : '未记录';
  const select = (name, label, options, current) => `<label class="filter-select"><span class="sr-only">${label}</span><select name="${name}" aria-label="${label}">${options.map(({ value, label: caption }) => `<option value="${escape(value)}"${String(current ?? '') === String(value) ? ' selected' : ''}>${escape(caption)}</option>`).join('')}</select></label>`;
  const facts = (items) => `<dl class="facts">${items.map(([label, value]) => `<dt>${label}</dt><dd>${text(value)}</dd>`).join('')}</dl>`;
  const eventId = (index) => `evidence-event-${index}`;

  function detail() {
    if (!selected) return '<div class="empty detail-empty">选择一条任务，查看请求、执行结果与审计记录。</div>';
    const events = selected.events ?? [];
    const references = (selected.evidence_ids ?? []).map((id) => {
      const index = events.findIndex((event) => String(event.id) === String(id));
      return index < 0 ? `<span class="mono">${escape(id)}（当前记录中未找到）</span>` : `<a href="#${eventId(index)}" data-evidence-link>${escape(id)}</a>`;
    }).join(' ');
    return `<header class="detail-head">
      <div class="detail-kicker"><a class="detail-back" href="${escape(selected.back_href ?? w.back_href ?? '/')}">${icon('back')}返回任务列表</a><span class="mono">${escape(selected.trace_id)}</span></div>
      ${badge(selected.state)}<h2>${text(selected.request)}</h2>
      <div class="detail-meta"><span>${text(selected.agent_id)}</span><span>${text(selected.requester)}</span><span>最近活动 ${time(selected.time)}</span></div>
    </header>
    <div class="tabs" role="tablist" aria-label="任务详情页签">
      <button id="tab-audit" class="tab active" role="tab" aria-selected="true" aria-controls="panel-audit" tabindex="0" type="button">任务与审计</button>
      <button id="tab-evidence" class="tab" role="tab" aria-selected="false" aria-controls="panel-evidence" tabindex="-1" type="button">证据记录 <span>${events.length}</span></button>
    </div>
    <section id="panel-audit" class="detail-content" role="tabpanel" aria-labelledby="tab-audit" tabindex="0">
      <section class="task-facts" aria-label="任务上下文"><h3>${icon('file')}任务记录</h3>${facts([['发起人', selected.requester], ['原始请求', selected.request], ['执行结果', selected.result]])}
        ${selected.purpose ? `<details class="purpose"><summary>Agent 预期目的</summary><p>${escape(selected.purpose)}</p></details>` : ''}
      </section>
      <section class="verdict ${stateKey(selected.state)}" aria-label="审计结论"><h3>${icon(stateKey(selected.state) === 'attention' ? 'alert' : 'file')}审计结论</h3><p>${text(selected.reason)}</p></section>
      ${(selected.notices ?? []).map((notice) => `<p class="notice">${escape(notice)}</p>`).join('')}
      <div class="audit-metadata">${facts([['审计状态', selected.audit_status], ['链路结果', selected.trace_status_label], ['风险等级', selected.risk], ['审计版本', selected.review_version > 0 ? selected.review_version : '尚未审计'], ['首次审计', formatTime(selected.first_reviewed_at)], ['最近审计', formatTime(selected.last_reviewed_at)]])}</div>
      ${references ? `<div class="evidence-refs"><h3>引用证据</h3>${references}</div>` : ''}
    </section>
    <section id="panel-evidence" class="detail-content" role="tabpanel" aria-labelledby="tab-evidence" tabindex="0" hidden>
      <h3>${icon('layers')}完整事件链</h3><p class="muted evidence-note">按记录顺序查看任务证据；原始日志可逐条展开。</p>
      ${events.length ? `<ol class="timeline">${events.map((event, index) => `<li id="${eventId(index)}" class="${event.error ? 'event-error' : ''}" tabindex="-1">
        <div class="event-heading"><strong>${text(event.event)}</strong>${event.evidence ? '<span class="badge pending">引用证据</span>' : ''}</div>
        <div class="event-meta">${time(event.time)}<span class="mono">事件 ID ${text(event.id)}</span></div>
        ${event.tool ? `<p>工具：${escape(event.tool)}</p>` : ''}${event.status ? `<p>状态：${escape(event.status)}</p>` : ''}${event.error ? `<p class="event-error-text">${escape(event.error)}</p>` : ''}${event.result ? `<p>${escape(event.result)}</p>` : ''}
        <details class="raw-log"><summary>原始日志 · JSON</summary><pre>${text(event.raw_json)}</pre></details>
      </li>`).join('')}</ol>` : '<div class="empty">当前没有可读取的事件记录。</div>'}
    </section>`;
  }

  const p = w.pagination ?? {};
  const stats = (w.stats ?? []).map((stat) => `<a class="metric ${escape(stat.key)}${(filters.state || 'all') === stat.key ? ' active' : ''}" href="${escape(stat.href)}"${(filters.state || 'all') === stat.key ? ' aria-current="true"' : ''}><span class="metric-label">${icon(stat.key === 'attention' ? 'alert' : stat.key === 'done' ? 'check' : stat.key === 'pending' ? 'clock' : 'layers')}${escape(stat.label)}</span><strong>${escape(stat.count)}</strong></a>`).join('');
  const agents = (w.agents ?? []).map((agent) => `<a class="agent-item${agent.selected ? ' selected' : ''}" href="${escape(agent.href)}"${agent.selected ? ' aria-current="true"' : ''}><span class="agent-label">${text(agent.label)}</span><strong>${escape(agent.count ?? 0)}</strong></a>`).join('');
  const rows = (w.tasks ?? []).map((task) => `<a class="task${task.selected ? ' selected' : ''}" href="${escape(task.href)}"${task.selected ? ' aria-current="true"' : ''}><div class="task-top"><h3>${text(task.request)}</h3>${badge(task.state)}</div><p class="task-requester">${text(task.requester)}</p><div class="task-meta"><span>${text(task.agent_id)}</span><span>最近活动 ${time(task.time)}</span></div></a>`).join('');

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(input.page?.title ?? '任务工作台')} · Audit Logger</title><style>${styles}</style></head>
<body class="task-workbench${w.standalone && selected ? ' detail-open' : ''}"><a class="skip-link" href="#main-content">跳到主要内容</a>
<div class="shell"><aside class="sidebar"><a href="/" class="brand"><span class="brand-mark">${icon('layers')}</span>Audit Logger</a><div class="workspace">任务审计<span>请求、结果与完整证据</span></div><nav aria-label="主导航"><a class="nav-link" href="/">${icon('grid')}数据看板</a><a class="nav-link active" href="/tasks">${icon('file')}任务工作台</a></nav><section class="agent-nav" aria-label="Agent 列表"><div class="agent-nav-heading"><span>Agent 列表</span><span>任务数</span></div>${agents || '<p class="agent-empty">暂无已审计的 Agent</p>'}</section><div class="sidebar-note">以日志记录为依据<br>查看任务结果与审计结论</div></aside>
<main class="main" id="main-content"><header class="topbar"><span>审计空间 <span aria-hidden="true">/</span> 任务工作台</span><a class="overview-link" href="/">数据看板</a></header>
<section class="intro"><span class="eyebrow">TASK WORKSPACE</span><h1>每个任务，都有迹可循。</h1><p>查看谁发起了任务、提出了什么请求，以及 Agent 最终做了什么。</p></section>
<section class="metrics" aria-label="任务状态筛选" aria-describedby="stats-scope">${stats}</section><p id="stats-scope" class="stats-scope">统计范围：当前搜索、Agent 与发起人；点击卡片查看对应状态。</p>
<section class="workbench" aria-label="任务工作台"><form class="toolbar" method="get" action="${escape(w.action ?? '/tasks')}"><label class="search">${icon('search')}<span class="sr-only">搜索任务或发起人</span><input type="search" name="q" value="${escape(filters.q ?? '')}" placeholder="搜索任务或发起人"></label>
${select('requester', '发起人', [{ value: '', label: '全部发起人' }, ...(w.options?.requesters ?? [])], filters.requester)}
${select('state', '行动状态', [{ value: '', label: '全部状态' }, { value: 'attention', label: '需要关注' }, { value: 'pending', label: '结果待核实' }, { value: 'done', label: '已完成' }, { value: 'unreviewed', label: '未审查' }], filters.state)}
${select('sort', '任务排序', [{ value: 'priority', label: '需要关注优先' }, { value: 'recent', label: '最近活动优先' }], filters.sort ?? 'priority')}
<button class="apply-filter" type="submit">筛选</button><a class="clear-filters" href="${escape(w.clear_href ?? '/')}">清除筛选</a></form>
${w.error ? `<div class="error-state" role="alert">${escape(w.error)}</div>` : ''}
<div class="body-grid"><section class="task-list" aria-label="任务记录"><div class="list-heading"><span>任务记录</span><span>共 ${escape(p.total ?? 0)} 条</span></div>${rows || `<div class="empty">${w.error ? '任务数据暂不可用。' : '没有符合条件的任务。'}<p>可调整筛选条件后重试。</p></div>`}
${p.totalPages > 1 ? `<nav class="pagination" aria-label="任务分页">${p.previousHref ? `<a href="${escape(p.previousHref)}">上一页</a>` : '<span>上一页</span>'}<span>第 ${escape(p.currentPage)} / ${escape(p.totalPages)} 页</span>${p.nextHref ? `<a href="${escape(p.nextHref)}">下一页</a>` : '<span>下一页</span>'}</nav>` : ''}</section><aside class="detail" id="task-detail" aria-label="任务详情">${detail()}</aside></div></section>
<footer>日志审计 · 以原始请求、执行结果与完整证据为依据。时间均为北京时间（UTC+8）。</footer></main></div>
<script>
const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
function activateTab(tab, focus) {
  tabs.forEach(function(item) {
    const active = item === tab;
    item.setAttribute('aria-selected', String(active)); item.tabIndex = active ? 0 : -1;
    item.classList.toggle('active', active);
    document.getElementById(item.getAttribute('aria-controls')).hidden = !active;
  });
  if (focus) tab.focus();
}
tabs.forEach(function(tab, index) {
  tab.addEventListener('click', function() { activateTab(tab, false); });
  tab.addEventListener('keydown', function(event) {
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = tabs.length - 1;
    if (next !== undefined) { event.preventDefault(); activateTab(tabs[next], true); }
  });
});
document.querySelectorAll('[data-evidence-link]').forEach(function(link) {
  link.addEventListener('click', function(event) {
    const target = document.getElementById(link.hash.slice(1));
    if (!target) return;
    event.preventDefault(); activateTab(document.getElementById('tab-evidence'), false);
    target.scrollIntoView({ block: 'center' }); target.focus({ preventScroll: true });
  });
});
</script></body></html>`;
}

const styles = `
:root{color-scheme:dark;--bg:#0B0F14;--panel:#111926;--raised:#17212e;--line:#25313e;--text:#E6EDF3;--muted:#9FB0BF;--faint:#8193a4;--mint:#b9f4d0;--red:#ffaaa2;--amber:#eac68b;--mono:"Cascadia Code",Consolas,monospace}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:13px/1.6 "Microsoft YaHei","Segoe UI",sans-serif}a{color:inherit;text-decoration:none}a:hover{text-decoration:underline}button,input,select{font:inherit}button,select,summary{cursor:pointer}button{color:inherit}h1,h2,h3,p{margin:0}h3{font-size:12px;font-weight:500}.lucide{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;flex-shrink:0}.mono,time{font-family:var(--mono)}time{overflow-wrap:anywhere}.muted{color:var(--muted)}[hidden]{display:none!important}:focus-visible{outline:2px solid var(--mint);outline-offset:3px}.sr-only,.skip-link:not(:focus){position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}.skip-link:focus{position:fixed;z-index:20;background:var(--panel);padding:12px}.shell{display:grid;grid-template-columns:204px minmax(0,1fr);min-height:100vh}.sidebar{padding:31px 20px 22px;border-right:1px solid var(--line);display:flex;flex-direction:column;background:#0e151f}.brand{display:flex;align-items:center;gap:10px;font-size:15px;font-weight:700}.brand-mark{display:grid;place-items:center;width:30px;height:30px;background:var(--mint);border-radius:9px;color:#173026}.workspace{margin:26px 0 28px;padding:12px 10px;border:1px solid var(--line);border-radius:8px;font-size:12px}.workspace span{display:block;color:var(--faint);font-size:10px}.nav-link{display:flex;align-items:center;gap:10px;padding:11px 12px;border-radius:7px;color:var(--muted);margin:4px 0}.nav-link.active{background:#22352d;color:var(--mint)}.nav-link:hover{background:var(--raised)}.sidebar-note{margin-top:auto;padding:80px 8px 0;color:var(--faint);font-size:11px}.main{min-width:0;padding:0 34px 26px}.topbar{height:68px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--line);gap:12px;font-size:11px;color:var(--muted)}.topbar>span{display:flex;gap:12px}.overview-link{color:var(--faint)}.mobile-nav{display:none}.intro{padding:28px 0 24px}.eyebrow{display:block;color:var(--mint);font:10px var(--mono);letter-spacing:2px;margin-bottom:9px}h1{font-size:29px;font-weight:600;letter-spacing:-1px}.intro p{margin-top:6px;color:var(--muted);font-size:12px}.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:24px}.metric{border:1px solid var(--line);border-radius:9px;padding:17px 19px;background:var(--panel)}.metric:hover{border-color:#66776e;text-decoration:none}.metric.active{border-color:#92b09f;background:#192a25}.metric-label{display:flex;align-items:center;gap:7px;color:var(--muted);font-size:12px}.metric strong{font:32px/1.4 var(--mono);display:block;margin-top:8px}.metric small{color:var(--faint);font-size:10px}.metric.attention strong,.metric.attention .lucide{color:var(--red)}.metric.pending strong{color:var(--amber)}.metric.done strong{color:var(--mint)}.workbench{border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--panel)}.toolbar{padding:15px 18px;border-bottom:1px solid var(--line);display:flex;gap:10px;align-items:center;flex-wrap:wrap}.search{display:flex;align-items:center;gap:10px;flex:1 1 240px;min-width:0;color:var(--faint)}.search input{width:100%;border:0;background:transparent;color:var(--text);padding:7px 0;min-width:0}.search input::placeholder{color:var(--faint)}.filter-select{min-width:0;max-width:190px}select{width:100%;background:var(--raised);border:1px solid #354454;color:var(--text);padding:7px 9px;border-radius:5px;font-size:11px;min-width:0}.apply-filter{background:#223c30;border:1px solid #456752;border-radius:5px;padding:7px 13px;color:var(--mint)}.clear-filters{font-size:11px;color:var(--mint);padding:6px}.body-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,.98fr)}.task-list{min-width:0}.list-heading{padding:14px 18px;display:flex;justify-content:space-between;gap:10px;align-items:center;border-bottom:1px solid var(--line);font-size:11px;color:var(--muted)}.task{display:block;padding:18px 19px;border-bottom:1px solid var(--line);border-left:2px solid transparent}.task:hover{background:var(--raised);text-decoration:none}.task.selected{background:#192a25;border-left-color:var(--mint)}.task-top{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:8px}.task-top h3{font-size:13px;min-width:0;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.badge{display:inline-flex;flex-shrink:0;font-size:10px;white-space:nowrap;padding:2px 7px;border-radius:4px;line-height:1.8;color:var(--muted);background:var(--raised)}.badge.attention{color:var(--red);background:#3a2827}.badge.pending{color:var(--amber);background:#352f23}.badge.done{color:#c2dfcc;background:#25382d}.task-meta{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:10px;flex-wrap:wrap;overflow-wrap:anywhere}.task-meta time{color:var(--faint)}.task-result{font-size:11px;color:var(--muted);margin-top:7px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere}.task-trace{display:block;color:var(--faint);font-size:10px;margin-top:5px;overflow-wrap:anywhere}.detail{border-left:1px solid var(--line);background:#0e1721;min-width:0}.detail-head{padding:20px 24px 18px;border-bottom:1px solid var(--line)}.detail-kicker{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;margin-bottom:13px;color:var(--faint);font-size:10px;overflow-wrap:anywhere}.detail-back{display:inline-flex;gap:6px;align-items:center;color:var(--mint)}.detail-back .lucide{width:14px;height:14px}.detail h2{font-size:19px;line-height:1.5;font-weight:550;margin:10px 0 8px;letter-spacing:-.4px;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.detail-meta{display:flex;flex-wrap:wrap;gap:7px 12px;color:var(--muted);font-size:11px;overflow-wrap:anywhere}.tabs{display:flex;gap:24px;padding:0 24px;border-bottom:1px solid var(--line)}.tab{background:none;border:0;padding:13px 0;font-size:12px;color:var(--faint);border-bottom:2px solid transparent}.tab.active{color:var(--mint);border-bottom-color:var(--mint)}.tab span{font:10px var(--mono);margin-left:5px}.detail-content{padding:22px 24px}.detail-content h3{display:flex;align-items:center;gap:8px;color:var(--muted);margin-bottom:12px}.detail-content h3 .lucide{width:15px;height:15px}.task-facts{padding-bottom:22px;margin-bottom:22px;border-bottom:1px solid var(--line)}.facts{display:grid;grid-template-columns:65px minmax(0,1fr);gap:14px 13px;font-size:12px;margin:0}.facts dt{color:var(--faint)}.facts dd{margin:0;overflow-wrap:anywhere;white-space:pre-wrap;line-height:1.85}.task-facts .facts dd:last-child{border-left:2px solid #7d9988;padding-left:12px}.purpose{background:var(--raised)}details{border:1px solid var(--line);border-radius:6px;padding:11px 13px;margin-top:14px}summary{font-size:11px;color:var(--muted)}details:not([open])>:not(summary){display:none}details p{font-size:12px;margin-top:10px;white-space:pre-wrap;overflow-wrap:anywhere}.verdict{border:1px solid var(--line);border-radius:7px;padding:15px;background:var(--raised);margin-bottom:16px}.verdict.attention{border-color:#57403a;background:#261e1c}.verdict.attention h3{color:var(--red)}.verdict.pending{border-color:#514835;background:#25231b}.verdict.pending h3{color:var(--amber)}.verdict.done{border-color:#37483d;background:#1d2620}.verdict.done h3{color:var(--mint)}.verdict p{font-size:12px;line-height:1.85;overflow-wrap:anywhere;white-space:pre-wrap}.notice{padding:10px 12px;border-left:2px solid var(--amber);background:#24241f;color:var(--muted);font-size:11px;margin-block:12px;overflow-wrap:anywhere}.audit-metadata{margin-top:20px;padding-top:15px;border-top:1px solid var(--line)}.audit-metadata .facts{font-size:11px;gap:9px 13px}.evidence-refs{margin-top:18px;font-size:11px;overflow-wrap:anywhere}.evidence-refs a{color:var(--mint);margin-right:10px}.evidence-note{font-size:11px}.timeline{list-style:none;padding:0;margin:20px 0 0}.timeline li{position:relative;margin-left:5px;padding:0 0 24px 24px;border-left:1px solid #3b4447;overflow-wrap:anywhere}.timeline li:last-child{padding-bottom:0;border-left-color:transparent}.timeline li::before{content:"";position:absolute;left:-4px;top:5px;width:7px;height:7px;border-radius:50%;background:#72857c;box-shadow:0 0 0 4px #0e1721}.timeline li.event-error::before{background:var(--red)}.event-heading{display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap}.event-heading strong{font-size:12px;font-weight:500}.event-meta{display:flex;gap:8px;flex-wrap:wrap;color:var(--faint);font-size:10px;margin-top:5px}.timeline p{font-size:11px;color:var(--muted);margin-top:7px;white-space:pre-wrap}.timeline p.event-error-text{color:var(--red)}pre{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;font:10px/1.8 var(--mono);color:#b6cabb;margin-bottom:0;max-width:100%}.empty{padding:64px 24px;text-align:center;color:var(--muted);font-size:12px}.empty p{font-size:11px;margin-top:8px}.error-state{padding:15px 18px;background:#33221f;color:var(--red);overflow-wrap:anywhere}.pagination{display:flex;justify-content:space-between;gap:12px;padding:18px;font-size:11px;color:var(--faint)}.pagination a{color:var(--mint)}footer{padding-top:17px;color:var(--faint);font-size:10px}
.stats-scope{font-size:10px;color:var(--faint);margin:-12px 0 18px}
@media(min-width:1450px){.main{padding-inline:48px}.body-grid{grid-template-columns:minmax(0,1.12fr) minmax(0,1fr)}}
@media(max-width:1100px){.shell{grid-template-columns:165px minmax(0,1fr)}.sidebar{padding-inline:12px}.main{padding-inline:20px}.detail-head,.detail-content{padding:18px}.tabs{padding-inline:18px}.metric{padding:14px}.metric small{font-size:9px}}
@media(max-width:850px){.shell{grid-template-columns:1fr}.sidebar{display:none}.mobile-nav{display:flex;gap:18px;padding-top:12px;font-size:11px;color:var(--muted);flex-wrap:wrap}.body-grid{display:block}.detail{display:none}.detail-open .detail{display:block;border:0}.detail-open .task-list,.detail-open .toolbar,.detail-open .intro,.detail-open .metrics,.detail-open .mobile-nav{display:none}.detail-head{padding:22px}.detail-content{padding:22px}.main{padding:0 20px 20px}.metrics{gap:8px}.metric strong{font-size:27px}.metric small{display:none}.topbar{height:58px}.intro{padding-block:23px}.detail h2{font-size:22px}}
@media(max-width:720px){.main{padding-inline:14px}.metrics{grid-template-columns:repeat(2,minmax(0,1fr));margin-bottom:18px}.metric{padding:12px 14px}.metric strong{font-size:25px;margin-top:3px}.intro h1{font-size:26px}.toolbar{padding:12px;gap:8px}.search{flex-basis:100%;border-bottom:1px solid var(--line);padding-bottom:8px}.filter-select{flex:1 1 40%;max-width:none}.task{padding-inline:14px}.task-top h3{font-size:12px}.facts{grid-template-columns:1fr;gap:4px}.facts dt:not(:first-child){margin-top:10px}.audit-metadata .facts{grid-template-columns:70px minmax(0,1fr)}.audit-metadata .facts dt:not(:first-child){margin-top:0}.detail-head,.detail-content{padding:18px}.tabs{gap:20px;padding-inline:18px}.topbar{font-size:10px}.timeline li{padding-left:18px}}
@media(max-width:850px){.detail-open .stats-scope{display:none}}
@media(prefers-reduced-motion:no-preference){a,button{transition:background .15s,border-color .15s}}

/* 12.5.7: business-facing three-column task workspace. */
body{font-size:16px;line-height:1.65}.shell{grid-template-columns:260px minmax(0,1fr)}.sidebar{padding:28px 16px 20px}.brand{font-size:18px}.workspace{font-size:16px}.workspace span,.sidebar-note{font-size:14px}.nav-link{font-size:16px}.agent-nav{margin-top:26px;border-top:1px solid var(--line);padding-top:16px;min-height:0}.agent-nav-heading{display:flex;justify-content:space-between;gap:12px;padding:0 10px 10px;color:var(--faint);font-size:14px}.agent-item{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 10px;border-radius:7px;font-size:16px}.agent-item:hover{text-decoration:none;background:var(--raised)}.agent-item.selected{background:#22352d;color:var(--mint)}.agent-label{min-width:0;overflow-wrap:anywhere}.agent-item strong{font:14px/1 var(--mono);color:var(--faint)}.agent-item.selected strong{color:inherit}.agent-empty{padding:10px;color:var(--faint);font-size:14px}.main{padding:0 30px 26px}.topbar{font-size:14px}.overview-link{font-size:14px}.intro p{font-size:16px}.eyebrow{font-size:14px}h1{font-size:32px}.metrics{margin-bottom:22px}.metric-label{font-size:16px}.metric strong{font-size:30px}.workbench{border-radius:10px}.toolbar{padding:16px 18px}.search input,select,.apply-filter,.clear-filters{font-size:16px}.body-grid{grid-template-columns:minmax(360px,.9fr) minmax(440px,1.1fr)}.list-heading{font-size:16px;padding:16px 18px}.task{padding:20px 18px}.task-top{margin-bottom:8px}.task-top h3{font-size:18px;line-height:1.5}.badge{font-size:14px;padding:3px 8px;line-height:1.55}.task-requester{font-size:16px;color:var(--muted);overflow-wrap:anywhere}.task-meta{font-size:14px;margin-top:8px;gap:7px 12px}.detail-head{padding:22px 24px}.detail-kicker{font-size:14px}.detail h2{font-size:24px}.detail-meta,.tab{font-size:16px}.tab span{font-size:14px}.detail-content{padding:24px}.detail-content h3{font-size:20px}.facts{font-size:16px;grid-template-columns:88px minmax(0,1fr)}summary,details p,.verdict p,.notice,.audit-metadata .facts,.evidence-refs,.evidence-note,.event-heading strong,.timeline p,.empty,.empty p,.pagination,footer{font-size:16px}.audit-metadata .facts{gap:12px 13px}.event-meta,pre{font-size:14px}.empty{padding:64px 24px}.pagination{padding:18px}.sidebar-note{padding-top:36px}
@media(max-width:1100px){.shell{grid-template-columns:220px minmax(0,1fr)}.sidebar{padding-inline:12px}.body-grid{grid-template-columns:minmax(310px,.85fr) minmax(360px,1.15fr)}}
@media(max-width:850px){.shell{display:block}.sidebar{display:block;border-right:0;border-bottom:1px solid var(--line);padding:14px}.brand,.workspace,.sidebar-note{display:none}.sidebar nav{display:flex;gap:4px;overflow-x:auto}.nav-link{white-space:nowrap;margin:0;padding:9px 10px}.agent-nav{margin-top:12px;padding-top:12px}.agent-nav-heading{display:none}.agent-nav{display:flex;gap:8px;overflow-x:auto}.agent-item{flex:0 0 auto;border:1px solid var(--line);padding:8px 10px;font-size:14px}.agent-item strong{font-size:14px}.mobile-nav{display:none}.main{padding-inline:16px}.detail-open .agent-nav{display:none}.detail-open .task-list,.detail-open .toolbar,.detail-open .intro,.detail-open .metrics{display:none}.detail-open .detail{display:block;border:0}.detail h2{font-size:24px}}
@media(max-width:720px){body{font-size:16px}.main{padding-inline:12px}.intro h1{font-size:28px}.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.metric-label{font-size:14px}.metric strong{font-size:25px}.toolbar{padding:12px}.filter-select{flex:1 1 100%;max-width:none}.apply-filter,.clear-filters{flex:1 1 auto;text-align:center}.task{padding:18px 14px}.task-top h3{font-size:18px}.detail-head,.detail-content{padding:18px}.detail h2{font-size:22px}.facts{font-size:16px}.audit-metadata .facts{grid-template-columns:88px minmax(0,1fr)}.tabs{padding-inline:18px}.tab{font-size:16px}}
`;
