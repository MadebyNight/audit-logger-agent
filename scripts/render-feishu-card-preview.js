import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildDailyReportPayloads,
  buildHighRiskAlertPayloads,
  feishuPayloadBytes,
} from '../src/auditReview/feishuCards.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const outputDir = path.join(projectRoot, 'data', 'tmp', 'feishu-card-preview');
const dashboardUrl = 'https://example.invalid/audit/demo-review-20260717';

function finding(severity, title, summary, observedAt) {
  return {
    severity,
    title,
    summary,
    observed_at: observedAt,
  };
}

const commonAlert = {
  reviewId: 'demo-review-20260717-001',
  window: {
    from: '2026-07-17T09:00:00.000Z',
    to: '2026-07-17T09:30:00.000Z',
  },
  agentId: 'demo-agent-finance-001',
  agentName: '财务对账演示 Agent',
  traceId: 'demo-trace-reconciliation-20260717',
  dashboardUrl,
};

const longSummary = [
  '虚构订单批次在演示环境中触发了重复写入保护。',
  '当前仅能确认演示记录发生冲突，未使用任何真实业务数据，也不推断额外影响。',
  '请通过虚构 Dashboard 链接查看模拟影响范围。',
].join('').repeat(8);

const previewCases = [
  {
    id: 'single-high-alert',
    title: '单条高风险告警',
    description: '验证单条 high、橙色标题、关键结论和唯一 Dashboard 操作。',
    payloads: buildHighRiskAlertPayloads({
      ...commonAlert,
      reviewId: 'demo-review-single-high',
      findings: [finding(
        'high',
        '演示环境批量导出范围异常',
        '虚构财务导出任务访问范围超过演示策略，尚无证据表明数据已离开演示环境。',
        '2026-07-17T09:18:00.000Z',
      )],
    }),
  },
  {
    id: 'mixed-severity-alert',
    title: '严重与高风险混合告警',
    description: '验证文字等级、严重风险优先、Top 风险和完整折叠明细。',
    payloads: buildHighRiskAlertPayloads({
      ...commonAlert,
      reviewId: 'demo-review-mixed-severity',
      foldThresholdChars: 1,
      findings: [
        finding('high', '演示报表下载次数异常', '同一虚构报表在短时间内被重复下载，需要核对演示任务配置。', '2026-07-17T09:27:00.000Z'),
        finding('critical', '演示付款权限范围扩大', '虚构付款任务获得了超出预期的演示权限，需要立即确认配置影响范围。', '2026-07-17T09:29:00.000Z'),
        finding('high', '演示对账记录连续失败', '虚构对账记录连续三次写入失败，已知影响仅限演示批次。', '2026-07-17T09:26:00.000Z'),
        finding('critical', '演示凭证访问策略失效', '虚构凭证访问未命中演示限制策略，需要检查规则配置。', '2026-07-17T09:28:00.000Z'),
      ],
    }),
  },
  {
    id: 'multipart-alert',
    title: '超长折叠与多分片告警',
    description: '使用较低预览字节阈值稳定触发同一 Agent + Trace 内分片。',
    payloads: buildHighRiskAlertPayloads({
      ...commonAlert,
      reviewId: 'demo-review-multipart',
      foldThresholdChars: 1,
      maxPayloadBytes: 12 * 1024,
      findings: Array.from({ length: 10 }, (_, index) => finding(
        index % 4 === 0 ? 'critical' : 'high',
        `演示长内容风险 ${String(index + 1).padStart(2, '0')}`,
        `${longSummary} 分项编号 ${index + 1}。`,
        `2026-07-17T09:${String(10 + index).padStart(2, '0')}:00.000Z`,
      )),
    }),
  },
  {
    id: 'daily-with-risk',
    title: '有风险日报',
    description: '验证原生分栏、Agent 与发起人概览、数字层级和独立风险块。',
    payloads: buildDailyReportPayloads({
      date: '2026-07-17',
      generatedAt: '2026-07-17T09:00:00.000Z',
      window: { from: '2026-07-16T16:00:00.000Z', to: '2026-07-17T09:00:00.000Z' },
      dashboardUrl,
      foldThresholdChars: 1,
      group: {
        agent_id: 'demo-agent-finance-001',
        agent_name: '财务对账演示 Agent',
        trace_id: 'demo-trace-reconciliation-20260717',
        event_count: 186,
        agent_count: 3,
        requester_count: 2,
        agents: [{ agent_id: '财务对账 Agent', task_count: 5, risk_count: 2 }, { agent_id: '报表 Agent', task_count: 2, risk_count: 1 }, { agent_id: '客服 Agent', task_count: 1, risk_count: 0 }],
        requesters: [{ requester_id: 'demo-user-finance', task_count: 5, risk_count: 2 }, { requester_id: 'demo-user-operations', task_count: 2, risk_count: 1 }, { requester_id: null, task_count: 1, risk_count: 0 }],
        trace_count: 8,
        reviewed_trace_count: 8,
        high_risk_count: 3,
        trace_status_counts: { success: 5, failed: 2, interrupted: 1, incomplete: 0 },
        risk_level_counts: { none: 5, low: 0, medium: 0, high: 3 },
        error_count: 12,
        tool_count: 4,
        tools: [
          { tool_name: 'demo.reconcile.write', total: 42, error_count: 8 },
          { tool_name: 'demo.invoice.query', total: 96, error_count: 3 },
          { tool_name: 'demo.report.export', total: 18, error_count: 1 },
          { tool_name: 'demo.account.read', total: 30, error_count: 0 },
        ],
        findings: [
          finding('critical', '演示付款权限范围扩大', '虚构付款任务获得了超出预期的演示权限。', '2026-07-17T08:58:00.000Z'),
          finding('high', '演示对账记录连续失败', '虚构对账记录连续失败，已知影响仅限演示批次。', '2026-07-17T08:52:00.000Z'),
          finding('high', '演示报表下载次数异常', '同一虚构报表在短时间内被重复下载。', '2026-07-17T08:48:00.000Z'),
        ],
      },
    }),
  },
  {
    id: 'daily-medium-risk',
    title: '中风险日报 · 窄卡片',
    description: '虚构日报任务，验证 Agent、发起人、长任务标题、中风险标签和零值弱化。可切换浏览器深浅色主题查看。',
    payloads: buildDailyReportPayloads({
      date: '2026-09-21', generatedAt: '2026-09-21T09:00:00.000Z',
      window: { from: '2026-09-20T16:00:00.000Z', to: '2026-09-21T09:00:00.000Z' },
      dashboardUrl,
      group: {
        event_count: 199, error_count: 2, agent_count: 2, trace_count: 3, tool_count: 8,
        requester_count: 1,
        agents: [{ agent_id: 'demo-report-agent', task_count: 2, risk_count: 1 }, { agent_id: 'audit-logger-agent', task_count: 1, risk_count: 0 }],
        requesters: [{ requester_id: 'demo-user-operations', task_count: 2, risk_count: 1 }, { requester_id: null, task_count: 1, risk_count: 0 }],
        reviewed_trace_count: 2, high_risk_count: 0,
        trace_status_counts: { success: 2, failed: 0, interrupted: 0, incomplete: 0 },
        risk_level_counts: { none: 1, low: 0, medium: 1, high: 0 },
        top_risks: [{ severity: 'medium', title: '请获取今天最新的经营日报，并确认数据覆盖范围',
          agent_id: 'demo-report-agent', requester_id: 'demo-user-operations', trace_id: 'demo-report-trace-20260921-0001',
          summary: '任务最终完成，但过程中存在工具错误与恢复证据，建议核查日报数据日期。' }],
        tools: [
          { tool_name: 'unknown.report_query', total: 4, error_count: 1 },
          { tool_name: 'unknown.data_health_check', total: 2, error_count: 1 },
          { tool_name: 'audit.review', total: 74, error_count: 0 },
          { tool_name: 'audit.detector', total: 37, error_count: 0 },
          { tool_name: 'audit.ingest', total: 37, error_count: 0 },
        ],
      },
    }),
  },
  {
    id: 'daily-without-risk',
    title: '无风险日报',
    description: '验证无 high/critical 时隐藏风险区，仅保留运行结论和必要统计。',
    payloads: buildDailyReportPayloads({
      date: '2026-07-17',
      generatedAt: '2026-07-17T09:00:00.000Z',
      window: { from: '2026-07-16T16:00:00.000Z', to: '2026-07-17T09:00:00.000Z' },
      dashboardUrl,
      group: {
        agent_id: 'demo-agent-customer-service-002',
        agent_name: '客户服务演示 Agent',
        trace_id: 'demo-trace-ticket-summary-20260717',
        event_count: 128,
        agent_count: 2,
        requester_count: 1,
        agents: [{ agent_id: '客户服务 Agent', task_count: 4, risk_count: 0 }, { agent_id: '报表 Agent', task_count: 2, risk_count: 0 }],
        requesters: [{ requester_id: 'demo-user-support', task_count: 6, risk_count: 0 }],
        trace_count: 6,
        reviewed_trace_count: 6,
        trace_status_counts: { success: 6, failed: 0, interrupted: 0, incomplete: 0 },
        risk_level_counts: { none: 6, low: 0, medium: 0, high: 0 },
        error_count: 0,
        tool_count: 2,
        tools: [
          { tool_name: 'demo.ticket.query', total: 82, error_count: 0 },
          { tool_name: 'demo.summary.create', total: 46, error_count: 0 },
        ],
        findings: [],
      },
    }),
  },
];

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderInlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/&lt;font color=&#39;(orange|yellow|red|blue|green|grey)&#39;&gt;(.+?)&lt;\/font&gt;/g, '<span class="severity-$1">$2</span>')
    .replace(/&lt;text_tag color=&#39;(orange|red|blue|purple)&#39;&gt;(.+?)&lt;\/text_tag&gt;/g, '<span class="text-tag severity-$1">$2</span>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

function renderTextBlock(value, className = '') {
  const lines = String(value ?? '').split('\n');
  return `<div class="text-block ${className}">${lines.map((line) => `<div>${renderInlineMarkdown(line) || '&nbsp;'}</div>`).join('')}</div>`;
}

function renderElement(element, { expanded = false } = {}) {
  if (!element || typeof element !== 'object') return '';
  if (element.tag === 'markdown' || element.tag === 'plain_text') return `<div class="${element.text_color === 'grey' ? 'muted-text' : ''}" style="font-size:${({ 'heading-1': 24, 'heading-3': 18, heading: 16, notation: 12 })[element.text_size] ?? 14}px;text-align:${element.text_align === 'right' ? 'right' : element.text_align === 'center' ? 'center' : 'left'}">${renderTextBlock(element.content, element.tag)}</div>`;
  if (element.tag === 'hr') return '<hr>';
  if (element.tag === 'button') {
    const label = element.text?.content ?? '打开链接';
    return `<div class="button-row"><span class="primary-button${element.width === 'fill' ? ' button-fill' : ''}"${element.size === 'large' ? ' style="min-height:48px"' : ''}>${escapeHtml(label)}</span></div>`;
  }
  if (element.tag === 'collapsible_panel') {
    const title = element.header?.title?.content ?? '查看明细';
    const children = Array.isArray(element.elements) ? element.elements : [];
    const borderClass = element.border?.color === 'orange' ? ' border-orange' : '';
    const isOpen = expanded || element.expanded === true;
    return `<details class="fold${borderClass}"${isOpen ? ' open' : ''}><summary>${escapeHtml(title)}</summary><div class="fold-body">${children.map((child) => renderElement(child, { expanded })).join('')}</div></details>`;
  }
  if (element.tag === 'div') {
    const fields = Array.isArray(element.fields) ? element.fields : [];
    const text = element.text ? renderElement(element.text, { expanded }) : '';
    return `<div class="div-element">${text}${fields.map((field) => renderElement(field, { expanded })).join('')}</div>`;
  }
  if (element.tag === 'column_set') {
    const columns = Array.isArray(element.columns) ? element.columns : [];
    const style = element.flex_mode === 'none' ? `grid-template-columns:${columns.map(column => `minmax(0,${column.weight ?? 1}fr)`).join(' ')};gap:${escapeHtml(element.horizontal_spacing ?? '8px')}` : '';
    return `<div class="column-set" style="${style}">${columns.map((column) => renderElement(column, { expanded })).join('')}</div>`;
  }
  if (element.tag === 'column') {
    const children = Array.isArray(element.elements) ? element.elements : [];
    const surface = { report_surface: 'report-surface', report_agents: 'report-agents', report_requesters: 'report-requesters' }[element.background_style] ?? '';
    return `<div class="column ${surface}" style="padding:${escapeHtml(element.padding ?? '0px')};gap:${escapeHtml(element.vertical_spacing ?? '8px')}">${children.map((child) => renderElement(child, { expanded })).join('')}</div>`;
  }
  if (element.text?.content !== undefined) return renderTextBlock(element.text.content, 'fallback-text');
  if (element.content !== undefined) return renderTextBlock(element.content, 'fallback-text');
  return `<pre class="unknown-element">${escapeHtml(JSON.stringify(element, null, 2))}</pre>`;
}

function renderCard(payload, { expanded = false, partIndex = 0 } = {}) {
  const card = payload?.card ?? {};
  const header = card.header ?? {};
  const elements = Array.isArray(card.body?.elements) ? card.body.elements : [];
  const template = String(header.template ?? 'blue').toLowerCase();
  const maxWidth = card.config?.width_mode === 'fill' ? 'none' : card.config?.width_mode === 'compact' ? '400px' : '600px';
  return `<article class="feishu-card template-${escapeHtml(template)}" style="width:100%;max-width:${maxWidth}">
    <header class="card-header" style="padding:${escapeHtml(header.padding ?? '12px')}">
      <div class="card-title">${escapeHtml(header.title?.content ?? '未命名卡片')}</div>
      ${header.subtitle?.content ? `<div class="card-subtitle">${escapeHtml(header.subtitle.content)}</div>` : ''}
    </header>
    <div class="card-body" style="padding:${escapeHtml(card.body?.padding ?? '12px')};gap:${escapeHtml(card.body?.vertical_spacing ?? '8px')}">${elements.map((element) => renderElement(element, { expanded })).join('')}</div>
    <div class="part-marker">Payload ${partIndex + 1} · ${feishuPayloadBytes(payload)} bytes</div>
  </article>`;
}

function renderPreviewCase(item) {
  const cards = item.payloads.map((payload, index) => renderCard(payload, { expanded: false, partIndex: index })).join('');
  return `<section class="preview-case" id="${escapeHtml(item.id)}">
    <div class="case-heading">
      <div><span class="case-index">${escapeHtml(item.id)}</span><h2>${escapeHtml(item.title)}</h2></div>
      <p>${escapeHtml(item.description)} · 共 ${item.payloads.length} 个 payload</p>
    </div>
    <div class="viewport-grid">
      <div class="viewport-panel desktop-panel">
        <h3>桌面端 · 默认折叠态</h3>
        <div class="desktop-viewport">${cards}</div>
      </div>
      <div class="viewport-panel mobile-panel">
        <h3>移动端 390px · 默认态，可点击展开明细</h3>
        <div class="mobile-shell"><div class="mobile-viewport">${cards}</div></div>
      </div>
    </div>
  </section>`;
}

function renderHtml(items, mode = 'combined') {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>飞书管理层审计卡片 · 本地虚构数据预览</title>
  <style>
    :root { color-scheme: light; font-family: Inter, "PingFang SC", "Microsoft YaHei", sans-serif; background: #f3f5f8; color: #1f2329; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #f3f5f8; }
    .page { width: min(1480px, calc(100% - 40px)); margin: 0 auto; padding: 36px 0 80px; }
    .page-intro { margin-bottom: 28px; padding: 24px 28px; background: #fff; border: 1px solid #dee3ea; border-radius: 14px; }
    .page-intro h1 { margin: 0 0 10px; font-size: 28px; }
    .page-intro p { margin: 6px 0; color: #646a73; line-height: 1.65; }
    .safety-note { color: #8f5b00 !important; }
    .preview-case { margin-top: 24px; padding: 24px; background: #fff; border: 1px solid #dee3ea; border-radius: 14px; box-shadow: 0 4px 18px rgb(31 35 41 / 5%); }
    .case-heading { display: flex; align-items: end; justify-content: space-between; gap: 24px; margin-bottom: 18px; }
    .case-heading h2 { display: inline; margin: 0 0 0 10px; font-size: 20px; }
    .case-heading p { max-width: 620px; margin: 0; color: #646a73; text-align: right; }
    .case-index { color: #8f959e; font: 12px ui-monospace, SFMono-Regular, Consolas, monospace; }
    .viewport-grid { display: grid; grid-template-columns: minmax(560px, 1fr) 430px; gap: 24px; align-items: start; }
    .viewport-panel { min-width: 0; padding: 18px; background: #eef1f5; border-radius: 12px; }
    .viewport-panel h3 { margin: 0 0 14px; color: #646a73; font-size: 13px; font-weight: 600; }
    .desktop-viewport { max-width: 680px; margin: 0 auto; }
    .mobile-shell { width: 390px; max-width: 100%; margin: 0 auto; padding: 10px; background: #dfe3e8; border-radius: 28px; box-shadow: inset 0 0 0 1px #c9cdd4; }
    .mobile-viewport { overflow: hidden; padding: 10px 8px 18px; background: #f5f6f7; border-radius: 20px; }
    .feishu-card { overflow: hidden; margin-bottom: 16px; background: #fff; border: 1px solid #d9dce1; border-radius: 10px; box-shadow: 0 4px 14px rgb(31 35 41 / 10%); }
    .card-header { padding: 15px 18px 14px; color: #fff; background: #3370ff; }
    .template-orange .card-header { background: #d97706; }
    .template-yellow .card-header { background: #d89b00; }
    .template-blue .card-header, .template-wathet .card-header { background: #3370ff; }
    .template-grey .card-header { background: #646a73; }
    .card-title { font-size: 18px; font-weight: 700; line-height: 1.4; }
    .card-subtitle { margin-top: 3px; opacity: .88; font-size: 12px; line-height: 1.45; overflow-wrap: anywhere; }
    .card-body { display: flex; flex-direction: column; gap: 10px; padding: 16px 18px; }
    .text-block { color: #1f2329; font-size: inherit; line-height: 1.65; overflow-wrap: anywhere; }
    .text-block > div + div { margin-top: 3px; }
    .div-element { min-width: 0; }
    .column-set { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 8px; }
    .column { min-width: 0; display:flex;flex-direction:column; }
    .report-surface { background:rgba(245,247,250,1); }
    .report-agents{background:rgba(240,245,255,1)}.report-requesters{background:rgba(247,243,255,1)}.severity-purple{color:#7952b8}
    @media(prefers-color-scheme:dark){.report-agents{background:rgba(30,42,61,1)}.report-requesters{background:rgba(43,36,58,1)}.severity-purple{color:#c2a1f3}}
    .text-tag { display:inline-block;padding:1px 6px;background:color-mix(in srgb,currentColor 12%,transparent);border-radius:4px;font-size:12px; }
    .severity-red { color:#d83931; }.severity-blue { color:#245bdb; }.severity-green { color:#26804b; }.severity-grey { color:#8f959e; }
    .button-fill { width:100%;min-height:40px; }
    @media(prefers-color-scheme:dark){
      .feishu-card{background:#1f2228;border-color:#383d47}.text-block{color:#e4e7ed}
      .report-surface{background:rgba(40,44,52,1)}.template-blue .card-header{background:#193968;color:#accbff}
      .severity-red{color:#ff8a83}.severity-orange{color:#ffc078}.severity-yellow{color:#efce6f}
      .severity-blue{color:#82aeff}.severity-green{color:#79d8a0}.severity-grey{color:#a6aebb}
      hr{border-color:#383d47}.primary-button{background:#3370ff}
    }
    .fold { overflow: hidden; border: 1px solid #d9dce1; border-radius: 8px; background: #fafbfc; }
    .fold.border-orange { border-color: #d97706; background: #fff7ed; }
    .fold summary { padding: 10px 12px; cursor: pointer; color: #3d4249; font-size: 13px; font-weight: 600; list-style-position: inside; }
    .fold-body { display: flex; flex-direction: column; gap: 10px; padding: 2px 12px 12px; border-top: 1px solid #ebeef2; }
    .fold-body .text-block { padding-top: 8px; }
    .fold:not([open])>.fold-body{display:none}
    .button-row { padding-top: 2px; }
    .primary-button { display: inline-flex; min-height: 34px; align-items: center; justify-content: center; padding: 7px 16px; color: #fff; background: #3370ff; border-radius: 6px; font-size: 14px; font-weight: 600; }
    .severity-orange { color: #b45309; font-weight: 700; }
    .severity-yellow { color: #a16207; font-weight: 700; }
    .muted-text .text-block{color:#8f959e}
    @media(prefers-color-scheme:dark){.fold{background:#262a32;border-color:#454b55}.fold summary{color:#c5cbd4}.fold-body{border-color:#454b55}}
    @media(prefers-color-scheme:dark){.severity-orange{color:#ffc078}.severity-yellow{color:#efce6f}.muted-text .text-block{color:#a6aebb}hr{border-color:#383d47}}
    hr { width: 100%; border: 0; border-top: 1px solid #ebeef2; }
    .unknown-element { overflow: auto; margin: 0; padding: 8px; color: #8f3f00; background: #fff3e8; border-radius: 6px; font-size: 11px; }
    .part-marker { padding: 0 18px 12px; color: #8f959e; font: 11px ui-monospace, SFMono-Regular, Consolas, monospace; }
    .mobile-viewport .card-header { padding: 13px 14px; }
    .mobile-viewport .card-title { font-size: 16px; }
    .mobile-viewport .card-body { padding: 13px 14px; }
    .mobile-viewport .column-set { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .mobile-viewport .primary-button { width: 100%; }
    .desktop-only .mobile-panel { display: none; }
    .desktop-only .viewport-grid { grid-template-columns: minmax(0, 760px); justify-content: center; }
    .mobile-only .desktop-panel { display: none; }
    .mobile-only .page { width: 100%; padding: 12px 8px 48px; }
    .mobile-only .page-intro, .mobile-only .preview-case { padding: 16px; }
    .mobile-only .page-intro h1 { font-size: 23px; }
    .mobile-only .case-heading { display: block; }
    .mobile-only .case-heading h2 { display: block; margin: 8px 0; }
    .mobile-only .case-heading p { text-align: left; }
    .mobile-only .viewport-grid { grid-template-columns: minmax(0, 1fr); }
    .mobile-only .viewport-panel { padding: 10px; }
    @media (max-width: 1120px) { .viewport-grid { grid-template-columns: 1fr; } .case-heading { align-items: start; flex-direction: column; } .case-heading p { text-align: left; } }
  </style>
</head>
<body class="${escapeHtml(mode)}-only">
  <main class="page">
    <section class="page-intro">
      <h1>飞书管理层审计卡片 · 本地预览</h1>
      <p>本页直接使用项目 renderer 生成的 Feishu Card JSON，并以本地 HTML 近似呈现桌面端和 390px 移动端布局。</p>
      <p class="safety-note">全部内容均为固定虚构数据；脚本不读取环境变量、数据库、Webhook 或业务日志，也不发起网络请求。本预览不能替代真实飞书客户端验收。</p>
    </section>
    ${items.map(renderPreviewCase).join('\n')}
  </main>
</body>
</html>`;
}

for (const item of previewCases) {
  if (!Array.isArray(item.payloads) || item.payloads.length === 0) {
    throw new Error(`Preview case ${item.id} produced no payloads`);
  }
}
if (previewCases.find((item) => item.id === 'multipart-alert').payloads.length < 2) {
  throw new Error('Multipart preview case did not produce multiple payloads');
}

const payloadDocument = {
  generated_from: 'src/auditReview/feishuCards.js',
  data_classification: '完全虚构的本地预览数据',
  network_access: false,
  cases: previewCases.map((item) => ({
    id: item.id,
    title: item.title,
    description: item.description,
    payload_count: item.payloads.length,
    payload_bytes: item.payloads.map(feishuPayloadBytes),
    payloads: item.payloads,
  })),
};

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, 'payloads.json'), `${JSON.stringify(payloadDocument, null, 2)}\n`, 'utf8');
fs.writeFileSync(path.join(outputDir, 'index.html'), renderHtml(previewCases), 'utf8');
fs.writeFileSync(path.join(outputDir, 'desktop.html'), renderHtml(previewCases, 'desktop'), 'utf8');
fs.writeFileSync(path.join(outputDir, 'mobile.html'), renderHtml(previewCases, 'mobile'), 'utf8');
for (const item of previewCases) {
  fs.writeFileSync(path.join(outputDir, `${item.id}-desktop.html`), renderHtml([item], 'desktop'), 'utf8');
  fs.writeFileSync(path.join(outputDir, `${item.id}-mobile.html`), renderHtml([item], 'mobile'), 'utf8');
}

process.stdout.write(`Feishu card preview generated at ${outputDir}\n`);
for (const item of previewCases) {
  process.stdout.write(`- ${item.id}: ${item.payloads.length} payload(s), ${item.payloads.map(feishuPayloadBytes).join(', ')} bytes\n`);
}
