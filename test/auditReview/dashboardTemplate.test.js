import test from 'node:test';
import assert from 'node:assert/strict';
import { renderDashboard } from '../../src/auditReview/dashboardTemplate.js';
import { renderDataDashboard } from '../../src/auditReview/dataDashboardTemplate.js';

test('数据看板使用柱状趋势，且不显示 Agent 接入卡片', () => {
  const html = renderDataDashboard({
    dashboard: {
      range_label: '最近 7 天',
      range_links: { seven: '/?range=7', thirty: '/?range=30' },
      total: 8,
      completion_rate: '75%',
      attention_count: 2,
      pending_count: 1,
      trend: [{ label: '2026-09-17', short_label: '09-17', total: 3, attention: 1, total_percent: 100, attention_percent: 33 }],
      agents: [],
      requesters: [],
      attention: [],
    },
  });

  assert.match(html, /<div class="trend"><div title="2026-09-17：3 个任务，1 个需要关注"><i style="height:100%"><\/i><b style="height:33%"><\/b><span>09-17<\/span><\/div><\/div>/);
  assert.doesNotMatch(html, /trend-line|polyline|Agent 接入/);
});

test('task workbench renders post-audit facts, accessible evidence tabs and closed escaped raw logs', () => {
  const html = renderDashboard({
    page: { title: '任务工作台', task_workbench: true },
    workbench: {
      filters: { q: '<unsafe>', agent_id: 'agent/a', requester: 'id:user', state: 'attention', sort: 'recent' },
      options: { agents: [{ value: 'agent/a', label: 'Agent A' }], requesters: [{ value: 'id:user', label: 'user' }] },
      agents: [{ value: '', label: '全部 Agent', count: 1, href: '/' }, { value: 'agent/a', label: 'Agent A', count: 1, href: '/?agent_id=agent%2Fa', selected: true }],
      stats: [{ key: 'attention', label: '需要关注', count: 1, href: '/?state=attention' }],
      tasks: [{ trace_id: 't', request: '核查库存', requester: 'user', agent_id: 'agent/a', result: '发现缺货', state: { key: 'attention', text: '需要关注' }, href: '/dashboard/agents/a/traces/t', selected: true }],
      pagination: { total: 1, totalPages: 1, currentPage: 1 },
      selected: { trace_id: 't', agent_id: 'a', requester: 'user', request: '核查库存', result: '发现缺货', reason: '库存不足',
        state: { key: 'attention', text: '需要关注' }, audit_status: '已审计', trace_status_label: '失败', risk: '高风险', review_version: 1,
        back_href: '/?q=库存&state=attention', evidence_ids: [5], events: [{ id: 5, event: 'tool.end', raw_json: '{"value":"<script>unsafe</script>"}' }] },
    },
  });
  const audit = html.slice(html.indexOf('<section id="panel-audit"'), html.indexOf('<section id="panel-evidence"'));
  assert.match(audit, /发起人[\s\S]*原始请求[\s\S]*执行结果[\s\S]*审计结论/);
  assert.match(audit, /发现缺货/);
  assert.match(audit, /链路结果[\s\S]*失败/);
  assert.match(html, /role="tab" aria-selected="true" aria-controls="panel-audit"/);
  assert.match(html, /id="panel-evidence"[^>]* hidden/);
  assert.match(html, /<details class="raw-log">/);
  assert.doesNotMatch(html, /<details class="raw-log"[^>]*\bopen\b/);
  assert.match(html, /href="#evidence-event-0" data-evidence-link/);
  assert.match(html, /&lt;script&gt;unsafe/);
  assert.doesNotMatch(html, /<script>unsafe|执行中|等待用户|建议下一步|fetch\(|XMLHttpRequest/);
  assert.match(html, /method="get" action="\/tasks"/);
  assert.match(html, /href="\/">[\s\S]*数据看板/);
  assert.match(html, /href="\/tasks"[\s\S]*任务工作台/);
  assert.doesNotMatch(html, /风险发现|审查批次|日报与概览/);
  assert.match(html, /class="agent-nav" aria-label="Agent 列表"/);
  assert.match(html, /class="agent-item selected" href="\/\?agent_id=agent%2Fa"/);
  assert.match(html, /\.task-top h3\{font-size:18px/);
  assert.match(html, /\.task-meta\{font-size:14px/);
  const taskList = html.slice(html.indexOf('<section class="task-list"'), html.indexOf('<aside class="detail"'));
  assert.match(taskList, /核查库存[\s\S]*user[\s\S]*agent\/a[\s\S]*最近活动/);
  assert.doesNotMatch(taskList, /发现缺货|task-result|task-trace|Trace ID/);
});

test('renderDashboard renders Chinese labels, zh-CN, and no browser fetch', () => {
  const html = renderDashboard({
    page: { title: '审计审查总览', subtitle: '最近审查与风险概览', updated_at: '2026-07-03T10:30:00.000Z' },
    summary_metrics: [{ label: '高风险', value: 3, tone: 'high' }],
    sections: [{
      id: 'latest_findings',
      type: 'table',
      title: '最新风险发现',
      columns: [{ key: 'title', label: '标题' }],
      rows: [{ title: '高危删除操作' }],
    }],
  });

  assert.ok(html.includes('lang="zh-CN"'));
  assert.ok(html.includes('<a class="skip-link" href="#main-content">跳到主要内容</a>'));
  assert.ok(html.includes('<main id="main-content" class="legacy-main">'));
  assert.ok(html.includes('<div class="container">'));
  assert.ok(html.includes('<h1 id="page-title" class="page-title">审计审查总览</h1>'));
  assert.ok(html.includes('<aside class="sidebar">'));
  assert.ok(html.includes('<nav aria-label="主导航">'));
  assert.ok(html.includes('href="/tasks"'));
  assert.ok(html.includes('数据看板'));
  assert.ok(html.includes('审计审查总览'));
  assert.ok(html.includes('最新风险发现'));
  assert.equal(html.includes('Data source'), false);
  assert.equal(html.includes('fetch('), false);
  assert.equal(html.includes('<script'), false);
  assert.equal(html.includes('<link'), false);
  assert.equal(html.includes('gradient'), false);
  assert.equal(html.includes('severity-legend'), false);
  assert.equal(html.includes('Severity'), false);
});

test('renderDashboard keeps zero metrics visible and hides only empty values and sections', () => {
  const html = renderDashboard({
    page: { title: '审计审查总览' },
    summary_metrics: [
      { label: '严重', value: 0, tone: 'critical' },
      { label: '高风险', value: 2, tone: 'high' },
    ],
    sections: [
      { id: 'empty_table', type: 'table', title: '空表格', columns: [{ key: 'name', label: '名称' }], rows: [] },
      { id: 'detail', type: 'definition_list', title: '详情', items: [
        { label: 'Agent', value: 'mt-agent' },
        { label: '空字段', value: '' },
      ] },
    ],
  });

  assert.equal(html.includes('空表格'), false);
  assert.equal(html.includes('空字段'), false);
  assert.ok(html.includes('<div class="metric-value">0</div>'));
  assert.ok(html.includes('严重'));
  assert.ok(html.includes('mt-agent'));
});

test('renderDashboard renders rich table cells with links, mono text, secondary text, and tone tags', () => {
  const html = renderDashboard({
    page: { title: '审计审查总览' },
    sections: [{
      id: 'reviews',
      type: 'table',
      title: '最近有发现的审查批次',
      columns: [
        { key: 'review', label: '审查批次' },
        { key: 'status', label: '状态' },
      ],
      rows: [{
        review: {
          text: 'review_<unsafe>',
          href: '/dashboard/audit-reviews/review_1?x=1&y=2',
          mono: true,
          secondary: '5 个发现',
        },
        status: {
          text: '已完成',
          tone: 'success',
        },
      }],
    }],
  });

  assert.ok(html.includes('<a href="/dashboard/audit-reviews/review_1?x=1&amp;y=2" class="cell-link mono">review_&lt;unsafe&gt;</a>'));
  assert.ok(html.includes('<div class="cell-secondary">5 个发现</div>'));
  assert.ok(html.includes('class="status-tag"'));
  assert.equal((html.match(/已完成/g) ?? []).length, 1);
});

test('renderDashboard renders a continuous summary strip and links only actionable metrics', () => {
  const html = renderDashboard({
    page: { title: '审计审查总览' },
    summary_metrics: [
      { label: '高风险', value: 3, tone: 'high', href: '/dashboard?severity=high#findings' },
      { label: '低风险', value: 1, tone: 'low' },
    ],
    sections: [{
      id: 'latest_findings',
      type: 'table',
      title: '最新风险发现',
      columns: [{ key: 'title', label: '标题' }],
      rows: [{ title: '高危删除操作' }],
    }],
  });

  assert.ok(html.includes('<section class="summary-metrics" aria-label="概要指标">'));
  assert.ok(html.includes('<a href="/dashboard?severity=high#findings" class="summary-metric-link"><div class="summary-metric" data-tone="high"'));
  assert.ok(html.includes('<div class="summary-metric" data-tone="low"'));
  assert.equal(html.includes('<a href="" class="summary-metric-link">'), false);
  assert.ok(html.includes('gap: 0;'));
});

test('renderDashboard renders safe section ids for anchor navigation', () => {
  const html = renderDashboard({
    page: { title: '审计审查总览' },
    sections: [
      {
        id: 'safe_anchor',
        type: 'table',
        title: '安全锚点',
        columns: [{ key: 'event', label: '事件' }],
        rows: [{ event: 'tool.end' }],
      },
      {
        id: 'bad" onclick="x',
        type: 'callout',
        title: '异常提示',
        body: '已转义',
      },
    ],
  });

  assert.ok(html.includes('<section id="safe_anchor" class="data-section">'));
  assert.ok(html.includes('<section id="bad&quot; onclick=&quot;x" class="data-section callout">'));
  assert.equal(html.includes('id="bad" onclick="x"'), false);
});

test('renderDashboard renders raw log snippets without parsing or splitting them', () => {
  const raw = '{"event":"tool.error","payload":{"b":2,"a":1},"text":"<unsafe>&value"}';
  const html = renderDashboard({
    page: { title: '审计审查总览' },
    sections: [{
      id: 'evidence_raw_logs',
      type: 'raw_log_list',
      title: '原始日志片段',
      snippets: [{ label: '日志 ID 7', body: raw }],
    }],
  });

  assert.ok(html.includes('<details id="evidence_raw_logs" class="data-section raw-log-section collapsible-section">'));
  assert.equal(html.includes('<details id="evidence_raw_logs" class="data-section raw-log-section collapsible-section" open>'), false);
  assert.ok(html.includes('<summary class="section-summary"><span class="section-title">原始日志片段</span>'));
  assert.ok(html.includes('<div class="raw-log-label">日志 ID 7</div>'));
  assert.ok(html.includes('<pre class="raw-log-pre"><code>'));
  assert.ok(html.includes('{&quot;event&quot;:&quot;tool.error&quot;,&quot;payload&quot;:{&quot;b&quot;:2,&quot;a&quot;:1},&quot;text&quot;:&quot;&lt;unsafe&gt;&amp;value&quot;}'));
  assert.equal(html.includes('<td>{'), false);
});

test('renderDashboard renders trace sequence and LLM analysis sections', () => {
  const html = renderDashboard({
    page: { title: '风险发现' },
    sections: [
      {
        id: 'trace_sequence',
        type: 'trace_sequence',
        title: '工具调用顺序（共 2 步）',
        steps: [
          {
            order: 1,
            timestamp: '2026-07-03T10:28:00.000Z',
            event: 'tool.start',
            status: { text: '正常', tone: 'success' },
            tool_name: 'db.delete',
            span_id: 'span-1',
            parent_span_id: '',
            duration_ms: '',
            summary: 'delete requested',
          },
          {
            order: 2,
            timestamp: '2026-07-03T10:29:00.000Z',
            event: 'tool.end',
            status: { text: '错误', tone: 'critical' },
            tool_name: 'db.delete',
            span_id: 'span-2',
            parent_span_id: 'span-1',
            duration_ms: '640 ms',
            summary: 'delete failed <unsafe>',
          },
        ],
      },
      {
        id: 'trace_llm_analysis',
        type: 'trace_analysis',
        title: 'LLM 链路分析',
        purpose: '尝试执行 db.delete 删除操作。',
        chain_summary: '先启动工具，再返回 permission denied。',
        risk_points: ['可能存在部分变更。'],
        next_actions: ['核查授权记录。'],
        model: 'test-model',
      },
    ],
  });

  assert.ok(html.includes('<section id="trace_sequence" class="data-section trace-sequence-section">'));
  assert.ok(html.includes('<ol class="trace-sequence">'));
  assert.ok(html.includes('<span class="trace-step-index">1</span>'));
  assert.ok(html.includes('db.delete'));
  assert.ok(html.includes('delete failed &lt;unsafe&gt;'));
  assert.ok(html.includes('<section id="trace_llm_analysis" class="data-section trace-analysis-section">'));
  assert.ok(html.includes('尝试执行 db.delete 删除操作。'));
  assert.ok(html.includes('可能存在部分变更。'));
  assert.ok(html.includes('test-model'));
  assert.equal(html.includes('<script'), false);
});

test('renderDashboard renders breadcrumbs, context badges, and page actions', () => {
  const html = renderDashboard({
    page: {
      title: '审查批次',
      subtitle: '2026-07-03 16:35 - 16:49',
      updated_at: '2026-07-03T10:30:00.000Z',
      breadcrumbs: [
        { label: '总览', href: '/dashboard' },
        { label: '审查批次' },
      ],
      context_badges: [
        { label: '开放 finding 15', tone: 'neutral' },
        { label: '降级完成', tone: 'medium' },
      ],
      page_actions: [
        { label: '返回总览', href: '/dashboard', kind: 'secondary' },
        { label: '最新有发现批次', href: '/dashboard/audit-reviews/review_1', kind: 'primary' },
      ],
    },
    sections: [{
      id: 'latest_findings',
      type: 'table',
      title: '最新风险发现',
      columns: [{ key: 'title', label: '标题' }],
      rows: [{ title: '高危删除操作' }],
    }],
  });

  assert.ok(html.includes('<nav class="breadcrumbs" aria-label="页面导航">'));
  assert.ok(html.includes('class="context-badge"'));
  assert.ok(html.includes('开放 finding 15'));
  assert.ok(html.includes('<a href="/dashboard/audit-reviews/review_1" class="page-action primary">最新有发现批次</a>'));
});

test('renderDashboard renders real GET filter links, active state, and clear actions', () => {
  const html = renderDashboard({
    page: {
      title: '审计审查总览',
    },
    clear_filters_href: '/dashboard?status=open',
    filters: [{
      id: 'severity',
      label: '严重级别',
      value: 'high',
      clear_href: '/dashboard?status=open',
      options: [
        { value: 'critical', label: '严重', href: '/dashboard?status=open&severity=critical' },
        { value: 'high', label: '高风险', href: '/dashboard?status=open&severity=high', active: true },
      ],
    }],
    sections: [{
      id: 'pending_findings',
      type: 'table',
      title: '待处理风险发现',
      columns: [{ key: 'title', label: '标题', priority: 'primary' }],
      rows: [{ title: '风险项' }],
    }],
  });

  assert.ok(html.includes('<nav class="filter-bar" aria-label="审计筛选">'));
  assert.ok(html.includes('href="/dashboard?status=open&amp;severity=high" class="filter-option active" aria-current="true">高风险</a>'));
  assert.ok(html.includes('href="/dashboard?status=open" class="filter-clear">清除严重级别</a>'));
  assert.ok(html.includes('href="/dashboard?status=open" class="filter-clear-all">清除全部筛选</a>'));
  assert.equal(html.includes('<select'), false);
  assert.equal(html.includes('<select disabled'), false);
});

test('renderDashboard renders Agent log pagination with stable disabled controls', () => {
  const html = renderDashboard({
    page: { title: 'Agent 日志审计' },
    sections: [{
      id: 'agent_log_pagination',
      type: 'pagination',
      title: '日志分页（第 1/3 页）',
      currentPage: 1,
      totalPages: 3,
      nextHref: '/dashboard?agent_id=agent-1&log_page=2#agent_logs',
    }],
  });

  assert.ok(html.includes('<nav class="pagination-controls" aria-label="日志分页">'));
  assert.ok(html.includes('class="pagination-control pagination-previous is-disabled" aria-disabled="true">上一页</span>'));
  assert.ok(html.includes('<span class="pagination-status" aria-current="page">第 1 / 3 页</span>'));
  assert.ok(html.includes('<a href="/dashboard?agent_id=agent-1&amp;log_page=2#agent_logs" class="pagination-control pagination-next">下一页</a>'));
  assert.equal(html.includes('<ul class="link-list">'), false);
});

test('renderDashboard adds scoped responsive column classes from safe keys and priorities', () => {
  const html = renderDashboard({
    page: { title: '审计审查总览' },
    sections: [{
      id: 'pending_findings',
      type: 'table',
      title: '待处理风险发现',
      columns: [
        { key: 'title', label: '标题', priority: 'primary' },
        { key: 'agent_name', label: 'Agent', priority: 'secondary' },
        { key: 'trace id onclick=x', label: 'Trace ID', priority: 'metadata' },
      ],
      rows: [{ title: '风险项', agent_name: 'agent-1', 'trace id onclick=x': 'trace-1' }],
    }],
  });

  assert.ok(html.includes('<th scope="col" class="column-title column-priority-primary">标题</th>'));
  assert.ok(html.includes('<td class="column-agent_name column-priority-secondary">agent-1</td>'));
  assert.ok(html.includes('<th scope="col" class="column-trace-id-onclick-x column-priority-metadata">Trace ID</th>'));
  assert.equal(html.includes('class="column-trace id onclick=x'), false);
});

test('renderDashboard supports collapsible metadata and semantic status markers', () => {
  const html = renderDashboard({
    page: {
      title: '审查批次',
      context_badges: [{ label: '降级完成', tone: 'medium' }],
    },
    sections: [
      {
        id: 'run_metadata',
        type: 'definition_list',
        title: '审查元数据',
        collapsible: true,
        items: [{ label: 'Review ID', value: 'review-1' }],
      },
      {
        id: 'review_findings',
        type: 'table',
        title: '本批风险发现',
        columns: [{ key: 'status', label: '状态' }],
        rows: [{ status: { text: 'Open', tone: 'critical' } }],
      },
    ],
  });

  assert.ok(html.includes('<details id="run_metadata" class="data-section collapsible-section">'));
  assert.ok(html.includes('class="context-badge" data-tone="medium"><span class="status-marker" aria-hidden="true"></span><span>降级完成</span>'));
  assert.ok(html.includes('class="status-tag" data-tone="critical"><span class="status-marker" aria-hidden="true"></span><span>Open</span>'));
});

test('renderDashboard includes sticky headers, trace connectors, responsive breakpoints, and reduced motion', () => {
  const html = renderDashboard({
    page: { title: '风险发现' },
    sections: [{
      id: 'trace_sequence',
      type: 'trace_sequence',
      title: 'Trace',
      steps: [
        { order: 1, tool_name: 'db.read', event: 'tool.start', status: { text: '正常', tone: 'success' } },
        { order: 2, tool_name: 'db.read', event: 'tool.end', status: { text: '完成', tone: 'success' } },
      ],
    }],
  });

  assert.ok(html.includes('.data-table thead th {'));
  assert.ok(html.includes('position: sticky;'));
  assert.ok(html.includes('.trace-step:not(:last-child)::after {'));
  assert.ok(html.includes('@media (max-width: 768px)'));
  assert.ok(html.includes('@media (max-width: 375px)'));
  assert.ok(html.includes('.column-priority-metadata { display: none; }'));
  assert.ok(html.includes('@media (prefers-reduced-motion: reduce)'));
  assert.ok(html.includes('overflow-x: hidden;'));
  assert.ok(html.includes('overscroll-behavior-inline: contain;'));
});

test('renderDashboard includes focus ring and row hover CSS rules', () => {
  const html = renderDashboard({
    page: { title: '审计审查总览' },
    sections: [{
      id: 'latest_findings',
      type: 'table',
      title: '最新风险发现',
      columns: [{ key: 'title', label: '标题' }],
      rows: [{ title: '高危删除操作' }],
    }],
  });

  assert.ok(html.includes(':focus-visible {'));
  assert.ok(html.includes('outline: 2px solid var(--accent);'));
  assert.ok(html.includes('.data-table tbody tr:hover { background: var(--surface-muted); }'));
});

test('renderDashboard renders lifecycle notices and SSR action forms without browser scripts', () => {
  const html = renderDashboard({
    page: { title: '风险发现' },
    notices: [{ tone: 'critical', title: '操作未完成', body: 'Finding 已更新，请重试。' }],
    sections: [{
      id: 'finding_actions',
      type: 'action_forms',
      title: '处置 Finding',
      action_url: '/dashboard/audit-findings/f%3C1/actions',
      state_version: 7,
      forms: [
        { action: 'resolve', label: '解决', requires_note: true },
        { action: 'snooze', label: '暂缓', requires_snoozed_until: true },
      ],
    }],
  });

  assert.ok(html.includes('class="notice" data-tone="critical" role="status"'));
  assert.ok(html.includes('操作未完成'));
  assert.ok(html.includes('<form method="post" action="/dashboard/audit-findings/f%3C1/actions" class="finding-action-form">'));
  assert.ok(html.includes('<input type="hidden" name="expected_state_version" value="7">'));
  assert.ok(html.includes('<input type="hidden" name="action" value="resolve">'));
  assert.ok(html.includes('<textarea name="note" required rows="3"></textarea>'));
  assert.ok(html.includes('<input type="datetime-local" name="snoozed_until" required>'));
  assert.ok(html.includes('name="actor" required'));
  assert.equal(html.includes('fetch('), false);
  assert.equal(html.includes('<script'), false);
});

test('renderDashboard renders a natural notification status link without exposing its hidden action', () => {
  const html = renderDashboard({
    page: {
      title: '审计审查总览',
      notification_status: {
        label: '飞书通知正常 <unsafe>',
        tone: 'success',
        href: '/dashboard/daily-report/send?next=1&source=<unsafe>',
        active: true,
      },
    },
    sections: [{ id: 'overview', type: 'callout', title: '运行概览', body: '运行正常' }],
  });

  assert.ok(html.includes('class="notification-status active" data-tone="success" aria-label="飞书通知状态"'));
  assert.ok(html.includes('href="/dashboard/daily-report/send?next=1&amp;source=&lt;unsafe&gt;"'));
  assert.ok(html.includes('class="notification-status-icon"'));
  assert.ok(html.includes('飞书通知正常 &lt;unsafe&gt;'));
  assert.equal(html.includes('title="'), false);
  assert.equal(html.includes('发送日报'), false);
  assert.equal(html.includes('立即发送'), false);
  assert.equal(html.includes('触发日报'), false);
});

test('renderDashboard renders an escaped POST confirmation form with return action', () => {
  const html = renderDashboard({
    page: { title: '确认发送当前日报' },
    sections: [{
      id: 'manual_daily_report_confirmation',
      type: 'confirmation',
      title: '发送当前日报 <确认>',
      description: '核对范围 & 确认',
      items: [
        { label: '操作', value: '发送当前日报' },
        { label: '统计日期', value: '2026-07-20（北京时间）' },
        { label: '统计范围', value: '00:00 至 14:35' },
        { label: '覆盖范围', value: '全部 Agent 与 <业务链路>' },
      ],
      form: {
        method: 'post',
        action: '/dashboard/daily-report/send?source=<manual>&next=1',
        submit_label: '确认发送 <日报>',
        cancel_label: '返回 & 总览',
        cancel_href: '/dashboard?from=<confirm>&x=1',
      },
    }],
  });

  assert.ok(html.includes('<section id="manual_daily_report_confirmation" class="data-section confirmation-section">'));
  assert.ok(html.includes('发送当前日报 &lt;确认&gt;'));
  assert.equal(html.includes('发送当前日报 &amp;lt;确认&amp;gt;'), false);
  assert.ok(html.includes('核对范围 &amp; 确认'));
  assert.ok(html.includes('<dt>统计日期</dt><dd>2026-07-20（北京时间）</dd>'));
  assert.ok(html.includes('<dt>统计范围</dt><dd>00:00 至 14:35</dd>'));
  assert.ok(html.includes('全部 Agent 与 &lt;业务链路&gt;'));
  assert.ok(html.includes('<form method="post" action="/dashboard/daily-report/send?source=&lt;manual&gt;&amp;next=1" class="confirmation-form">'));
  assert.ok(html.includes('<a href="/dashboard?from=&lt;confirm&gt;&amp;x=1" class="confirmation-cancel">返回 &amp; 总览</a>'));
  assert.ok(html.includes('<button type="submit" class="form-submit confirmation-submit">确认发送 &lt;日报&gt;</button>'));
  assert.equal(html.includes('<script'), false);
  assert.equal(html.includes('fetch('), false);
});

test('renderDashboard shows unavailable confirmation state without a POST form', () => {
  const html = renderDashboard({
    page: { title: '确认发送当前日报' },
    sections: [{
      id: 'manual_daily_report_confirmation',
      type: 'confirmation',
      title: '发送当前日报',
      description: '临近定时报送时段，请等待自动日报。',
      allowed: false,
      items: [
        { label: '统计日期', value: '2026-07-20（北京时间）' },
        { label: '统计范围', value: '00:00 至 16:58' },
      ],
      form: { cancel_label: '返回', cancel_href: '/dashboard' },
    }],
  });

  assert.ok(html.includes('临近定时报送时段，请等待自动日报。'));
  assert.ok(html.includes('class="confirmation-form confirmation-unavailable" role="status"'));
  assert.ok(html.includes('<a href="/dashboard" class="confirmation-cancel">返回</a>'));
  assert.equal(html.includes('<form method="post"'), false);
  assert.equal(html.includes('<button type="submit"'), false);
});

test('renderDashboard default UI text is readable Chinese without mojibake', () => {
  const html = renderDashboard({
    sections: [{
      id: 'trace_sequence',
      type: 'trace_sequence',
      title: '工具调用顺序',
      steps: [{
        order: 1,
        timestamp: '2026-07-10T08:15:38.000Z',
        event: 'tool.end',
        status: { text: '正常', tone: 'success' },
        tool_name: 'db.delete',
        span_id: 'span-1',
        parent_span_id: 'parent-1',
        duration_ms: '20 ms',
        summary: '完成',
      }],
    }],
  });

  assert.ok(html.includes('审计看板'));
  assert.ok(html.includes('更新时间'));
  assert.ok(html.includes('父 Span parent-1'));
  assert.ok(html.includes('日志审计 · 以原始请求、执行结果与完整证据为依据。'));
  assert.doesNotMatch(html, /(?:涓|楂|椋|闄|浣|淇|鎴|鍏|鈥|椤|瀵|艰|埅|鐖|璋|鐩|閾|捐|矾|寤|妯|鏆|棤|鍙|睍|绀|鐧|诲|綍|璁|块|棶|浠|ょ|墝|鏇|柊|堕|棿|鎬|昏||规||澶|氭|潯|佹|嵁)/);
});

test('requester groups render accessible controls, escaped search, share links and Lucide icons', () => {
  const html = renderDashboard({ page: { task_audit: true }, sections: [{
    type: 'requester_groups', id: 'requester_groups', title: '发起用户', search: '"><script>bad</script>', action: '/dashboard/agents/a',
    groups: [{ requester_id: '', name: '发起人未知', count: 1, attention: 0, time: '2026-09-16', open: true, href: '/dashboard/agents/a?requester_id=', tasks: [] }], moreHref: '/dashboard/agents/a?groups=40',
  }] });
  assert.match(html, /name="q" type="search"/);
  assert.match(html, /data-group-expand="true"/);
  assert.match(html, /data-group-expand="false"/);
  assert.match(html, /class="requester-group" open/);
  assert.match(html, /lucide-search/);
  assert.match(html, /lucide-chevron-right/);
  assert.match(html, /上下文不完整/);
  assert.match(html, /加载更多/);
  assert.doesNotMatch(html, /<script>bad|›|&#9654;|&rsaquo;/);
});

test('home agent list renders compact rows without health dot, with counts, time, chevron and omits Agent count metric', () => {
  const html = renderDashboard({
    page: {
      title: 'Agent 审计总览',
      subtitle: '按 Agent 查看任务，进入后按发起用户分组',
      agent_index: true,
      task_audit: true,
    },
    summary_metrics: [
      { label: 'Agent 数', value: 3, tone: 'neutral' },
    ],
    sections: [
      {
        id: 'agents',
        title: '已接收日志的 Agent',
        type: 'agent_rows',
        rows: [
          {
            name: 'MT Agent',
            requester_count: 4,
            task_count: 13,
            time: '14:48',
            href: '/dashboard/agents/mt-agent',
          },
          {
            agent_id: { text: 'Catalog Agent', href: '/dashboard/agents/catalog-agent' },
            requester_count: '1 发起人',
            task_count: '8 任务',
            last_event_at: '昨天',
          },
          {
            agent_id: 'deploy-agent',
            requesters: 2,
            tasks: 5,
            time: '2 天前',
          },
          {
            name: 'Ticket Agent',
            requester_num: 2,
            task_num: 21,
            time: '3 天前',
          },
        ],
      },
    ],
  });

  // 去掉首页“Agent 数”汇总指标卡
  assert.doesNotMatch(html, /<div class="metric-label">Agent 数<\/div>/);
  assert.doesNotMatch(html, /<section class="summary-metrics"/);

  // 验证不包含 health/dot 相关元素
  assert.doesNotMatch(html, /<span class="dot/);
  assert.doesNotMatch(html, /\bdot\b/);

  // 紧凑列表行形态验证（结构：名称 + 发起人数 + 任务数 + 相对时间 + chevron）
  assert.match(html, /<div class="list">/);
  assert.match(html, /<a class="row" href="\/dashboard\/agents\/mt-agent"><span class="name">MT Agent<\/span><span class="num">4 发起人<\/span><span class="num">13 任务<\/span><span class="time">14:48<\/span><span class="chev"><svg class="lucide lucide-chevron-right"/);

  assert.match(html, /<span class="name">Catalog Agent<\/span>/);
  assert.match(html, /<span class="time">昨天<\/span>/);

  assert.match(html, /<span class="name">deploy-agent<\/span>/);
  assert.match(html, /<span class="time">2 天前<\/span>/);

  assert.match(html, /<span class="name">Ticket Agent<\/span>/);
  assert.match(html, /<span class="time">3 天前<\/span>/);

  // 工作台侧栏入口常驻验证（即使 agent_index 为真）
  const navLinks = html.match(/class="nav-link/g) ?? [];
  assert.equal(navLinks.length, 2);
  assert.match(html, /<a class="nav-link active" href="\/" aria-current="page">[\s\S]*数据看板<\/a>/);
  assert.match(html, /<a class="nav-link" href="\/tasks">[\s\S]*任务工作台<\/a>/);

  // 720px 及以下媒体查询规则验证
  assert.match(html, /@media \(max-width: 720px\)/);
  assert.match(html, /\.row\s*\{\s*flex-wrap:\s*wrap;\s*gap:\s*8px;\s*\}/);
  assert.match(html, /\.row \.name\s*\{\s*flex:\s*1 1 100%;/);
});

test('renderAgentRow prioritizes name and agent_name over agent_id, handles long names and preserves href', () => {
  const html = renderDashboard({
    page: {
      title: 'Agent 审计总览',
      agent_index: true,
      task_audit: true,
    },
    sections: [
      {
        id: 'agents',
        title: '已接收日志的 Agent',
        type: 'agent_rows',
        rows: [
          // 1. 同时有 agent_id 和 name：确保 name 优先，不被 agent_id 覆盖
          {
            agent_id: { text: 'raw-agent-id-1', href: '/dashboard/agents/raw-agent-id-1' },
            name: '人类可读 Agent 甲',
            requester_count: 5,
            task_count: 20,
            time: '12:00',
          },
          // 2. 同时有 agent_id 和 agent_name：确保 agent_name 优先
          {
            agent_id: 'raw-agent-id-2',
            agent_name: '人类可读 Agent 乙',
            href: '/dashboard/agents/raw-agent-id-2',
            requester_count: 2,
            task_count: 8,
            time: '昨天',
          },
          // 3. 仅有 agent_id：优雅降级展示 agent_id
          {
            agent_id: { text: 'fallback-agent-id', href: '/dashboard/agents/fallback-agent-id' },
            requester_count: 1,
            task_count: 3,
            time: '2 天前',
          },
          // 4. 超长名称与长 ID
          {
            name: '超长名称-Very-Long-Agent-Name-That-Could-Potentially-Break-Flex-Layout-If-Not-Wrapped',
            href: '/dashboard/agents/very-long',
            requester_count: 99,
            task_count: 999,
            time: '2026-09-01',
          },
        ],
      },
      // 5. 原始日志 section 默认折叠
      {
        id: 'task_raw_logs',
        title: '原始日志（1 条事件）',
        type: 'raw_log_list',
        collapsible: true,
        snippets: [
          {
            label: '事件 1',
            body: '{"event":"run.start"}',
          },
        ],
      },
    ],
  });

  // 1. 验证展示名没有被 agent_id 覆盖
  assert.match(html, /<span class=\"name\">人类可读 Agent 甲<\/span>/);
  assert.doesNotMatch(html, /<span class=\"name\">raw-agent-id-1<\/span>/);
  assert.match(html, /href=\"\/dashboard\/agents\/raw-agent-id-1\"/);

  // 2. 验证 agent_name 优先
  assert.match(html, /<span class=\"name\">人类可读 Agent 乙<\/span>/);
  assert.doesNotMatch(html, /<span class=\"name\">raw-agent-id-2<\/span>/);

  // 3. 验证 fallback agent_id
  assert.match(html, /<span class=\"name\">fallback-agent-id<\/span>/);

  // 4. 验证长名称被正确渲染
  assert.match(html, /Very-Long-Agent-Name/);

  // 5. 验证原始日志为 details 折叠结构且默认不带 open 属性
  assert.match(html, /<details id=\"task_raw_logs\" class=\"data-section raw-log-section collapsible-section\">/);
  assert.doesNotMatch(html, /<details id=\"task_raw_logs\"[^>]*\bopen\b/);

  // 6. 验证折叠规则确保 not([open]) 时子内容隐藏
  assert.match(html, /\.collapsible-section:not\(\[open\]\)\s*>\s*:not\(summary\)\s*\{\s*display:\s*none;\s*\}/);
});

test('legacy Dashboard pages reuse the workbench sidebar and readable type scale', () => {
  const html = renderDashboard({
    page: { title: '风险发现', updated_at: '2026-09-17T10:30:00.000Z' },
    sections: [{
      id: 'pending_findings', type: 'table', title: '待处理风险发现',
      columns: [{ key: 'title', label: '标题' }], rows: [{ title: '权限异常' }],
    }],
  });

  assert.match(html, /<div class="legacy-shell">[\s\S]*<aside class="sidebar">/);
  assert.match(html, /<a class="nav-link active" href="\/" aria-current="page">[\s\S]*数据看板<\/a>/);
  assert.match(html, /<a class="nav-link" href="\/tasks">[\s\S]*任务工作台<\/a>/);
  assert.match(html, /\.legacy-dashboard \{[\s\S]*font-size: 16px;/);
  assert.match(html, /\.legacy-dashboard \.section-title, \.legacy-dashboard \.data-section h3 \{ font-size: 20px; \}/);
  assert.match(html, /\.legacy-dashboard \.data-table th, [\s\S]*font-size: 14px;/);
  assert.match(html, /@media \(max-width: 850px\)[\s\S]*\.legacy-dashboard \.sidebar \{ display: none; \}/);
});
