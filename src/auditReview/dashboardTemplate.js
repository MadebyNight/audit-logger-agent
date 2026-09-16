// src/auditReview/dashboardTemplate.js
// Renders a complete, self-contained HTML dashboard from a direct-data view model.
// No browser-side fetch — the template receives fully-populated sections and renders them directly.

const SEVERITY_TONES = {
  critical: { color: '#B42318', bg: '#fdecea', label: '严重' },
  high: { color: '#C2410C', bg: '#fff1e8', label: '高风险' },
  medium: { color: '#A66B00', bg: '#fff8e1', label: '中风险' },
  low: { color: '#526173', bg: '#f1f5f9', label: '低风险' },
  neutral: { color: '#475467', bg: '#f5f7fa', label: '信息' },
  success: { color: '#16805D', bg: '#ecfdf5', label: '成功' },
};

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function hasValue(value) {
  return value !== null && value !== undefined && value !== '';
}

function visibleMetrics(metrics = []) {
  return metrics.filter((metric) => hasValue(metric.value));
}

function visibleSections(sections = []) {
  return sections.filter((section) => {
    if (['requester_groups', 'task_list'].includes(section.type)) return true;
    if (section.type === 'table') return Array.isArray(section.rows) && section.rows.length > 0;
    if (section.type === 'definition_list') return Array.isArray(section.items) && section.items.some((item) => hasValue(item.value));
    if (section.type === 'link_list') return Array.isArray(section.links) && section.links.length > 0;
    if (section.type === 'pagination') return Number(section.totalPages) > 1;
    if (section.type === 'callout') return hasValue(section.body) || hasValue(section.title);
    if (section.type === 'raw_log_list') return Array.isArray(section.snippets) && section.snippets.some((snippet) => hasValue(snippet.body));
    if (section.type === 'trace_sequence') return Array.isArray(section.steps) && section.steps.length > 0;
    if (section.type === 'trace_analysis') {
      return hasValue(section.purpose) || hasValue(section.chain_summary)
        || (Array.isArray(section.risk_points) && section.risk_points.length > 0)
        || (Array.isArray(section.next_actions) && section.next_actions.length > 0);
    }
    if (section.type === 'action_forms') return Array.isArray(section.forms) && section.forms.length > 0;
    if (section.type === 'confirmation') {
      return Array.isArray(section.items) && section.items.some((item) => hasValue(item?.value))
        && (hasValue(section.form?.action) || section.allowed === false);
    }
    return false;
  });
}

function toneFor(tone) {
  return SEVERITY_TONES[tone] ?? SEVERITY_TONES.neutral;
}

function renderStatusTag(text, toneKey) {
  const tone = escapeHtml(toneKey ?? 'neutral');
  return `<span class="status-tag" data-tone="${tone}"><span class="status-marker" aria-hidden="true"></span><span>${escapeHtml(text)}</span></span>`;
}

function renderSecondaryText(secondary) {
  return hasValue(secondary) ? `<div class="cell-secondary">${escapeHtml(secondary)}</div>` : '';
}

function renderTextValue(text, { href, mono, tone } = {}) {
  const escapedText = escapeHtml(text ?? '');

  if (tone) {
    const tag = renderStatusTag(text, tone);
    if (href) {
      return `<a href="${escapeHtml(href)}" class="cell-link">${tag}</a>`;
    }
    return tag;
  }

  const className = mono ? 'cell-link mono' : 'cell-link';
  if (href) {
    return `<a href="${escapeHtml(href)}" class="${className}">${escapedText}</a>`;
  }

  const valueClass = mono ? 'cell-primary mono' : 'cell-primary';
  return `<span class="${valueClass}">${escapedText}</span>`;
}

function renderTableCellValue(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const primary = renderTextValue(value.text, value);
    const secondary = renderSecondaryText(value.secondary);
    return `<div class="cell-stack">${primary}${secondary}</div>`;
  }

  return escapeHtml(value ?? '');
}

function renderSectionIdAttr(id) {
  return hasValue(id) ? ` id="${escapeHtml(id)}"` : '';
}

function columnKeyClass(column) {
  const key = String(column?.key ?? 'value')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `column-${key || 'value'}`;
}

function columnPriorityClass(column) {
  const priority = ['primary', 'secondary', 'metadata'].includes(column?.priority)
    ? column.priority
    : 'primary';
  return `column-priority-${priority}`;
}

function renderColumnClass(column) {
  return `${columnKeyClass(column)} ${columnPriorityClass(column)}`;
}

function renderDataSection({ id, title, className = '', body, collapsible = false }) {
  const escapedTitle = escapeHtml(title ?? '');
  const classes = ['data-section', className, collapsible ? 'collapsible-section' : '']
    .filter(Boolean)
    .join(' ');
  if (collapsible) {
    return `<details${renderSectionIdAttr(id)} class="${classes}">
    <summary class="section-summary"><span class="section-title">${escapedTitle || '详细信息'}</span><span class="section-summary-hint">展开</span></summary>
    ${body}
  </details>`;
  }
  return `<section${renderSectionIdAttr(id)} class="${classes}">
    ${escapedTitle ? `<h2 class="section-title">${escapedTitle}</h2>` : ''}
    ${body}
  </section>`;
}

function renderSummaryMetric(metric) {
  const tone = toneFor(metric.tone);
  const value = escapeHtml(metric.value);
  const label = escapeHtml(metric.label ?? tone.label ?? '');
  const cardContent = `<div class="summary-metric" data-tone="${escapeHtml(metric.tone ?? 'neutral')}">
    <div class="metric-value">${value}</div>
    <div class="metric-label">${label}</div>
  </div>`;

  if (metric.href) {
    return `<a href="${escapeHtml(metric.href)}" class="summary-metric-link">${cardContent}</a>`;
  }

  return cardContent;
}

function renderSummaryMetrics(metrics) {
  const visible = visibleMetrics(metrics);
  if (!Array.isArray(visible) || visible.length === 0) return '';
  return `<section class="summary-metrics" aria-label="概要指标">${visible.map(renderSummaryMetric).join('\n')}</section>`;
}

function renderFilterBar(filters, clearFiltersHref) {
  if (!Array.isArray(filters) || filters.length === 0) return '';
  const groups = filters.map((filter) => {
    const label = escapeHtml(filter.label ?? filter.id ?? '');
    const options = Array.isArray(filter.options)
      ? filter.options.filter((option) => hasValue(option?.href))
      : [];
    if (options.length === 0 && !hasValue(filter.clear_href)) return '';

    const links = options.map((option) => {
      const isActive = option.active === true || String(option.value ?? '') === String(filter.value ?? '');
      const activeClass = isActive ? ' active' : '';
      const current = isActive ? ' aria-current="true"' : '';
      return `<a href="${escapeHtml(option.href)}" class="filter-option${activeClass}"${current}>${escapeHtml(option.label ?? option.value ?? '')}</a>`;
    }).join('');
    const clearLink = hasValue(filter.clear_href)
      ? `<a href="${escapeHtml(filter.clear_href)}" class="filter-clear">清除${label}</a>`
      : '';
    return `<div class="filter-group"><span class="filter-label">${label}</span><div class="filter-options">${links}${clearLink}</div></div>`;
  }).filter(Boolean).join('\n');
  if (!groups) return '';

  const clearAll = hasValue(clearFiltersHref)
    ? `<a href="${escapeHtml(clearFiltersHref)}" class="filter-clear-all">清除全部筛选</a>`
    : '';
  return `<nav class="filter-bar" aria-label="审计筛选">${groups}${clearAll}</nav>`;
}

function renderBreadcrumbs(breadcrumbs) {
  if (!Array.isArray(breadcrumbs) || breadcrumbs.length === 0) return '';

  const items = breadcrumbs.map((crumb, index) => {
    const isLast = index === breadcrumbs.length - 1;
    const label = escapeHtml(crumb.label ?? '');

    if (!isLast && crumb.href) {
      return `<a href="${escapeHtml(crumb.href)}" class="breadcrumb-link">${label}</a>`;
    }

    return `<span class="breadcrumb-current"${isLast ? ' aria-current="page"' : ''}>${label}</span>`;
  }).join(`<span class="breadcrumb-separator" aria-hidden="true">${lucideChevron()}</span>`);

  return `<nav class="breadcrumbs" aria-label="页面导航">${items}</nav>`;
}

function renderContextBadges(badges) {
  if (!Array.isArray(badges) || badges.length === 0) return '';
  return `<div class="context-badges">${badges.map((badge) => {
    const tone = escapeHtml(badge.tone ?? 'neutral');
    return `<span class="context-badge" data-tone="${tone}"><span class="status-marker" aria-hidden="true"></span><span>${escapeHtml(badge.label ?? '')}</span></span>`;
  }).join('')}</div>`;
}

function renderNotificationStatus(status) {
  if (!status || !hasValue(status.label)) return '';
  const tone = escapeHtml(status.tone ?? 'neutral');
  const activeClass = status.active === true ? ' active' : '';
  const content = `<span class="status-marker" aria-hidden="true"></span><svg class="notification-status-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M21 3 9.5 14.5M21 3l-7.2 18-4.3-6.5L3 10.2 21 3Z"></path></svg><span>${escapeHtml(status.label)}</span>`;
  if (hasValue(status.href)) {
    return `<a href="${escapeHtml(status.href)}" class="notification-status${activeClass}" data-tone="${tone}" aria-label="飞书通知状态">${content}</a>`;
  }
  return `<span class="notification-status${activeClass}" data-tone="${tone}" aria-label="飞书通知状态">${content}</span>`;
}

function renderPageActions(actions) {
  if (!Array.isArray(actions) || actions.length === 0) return '';
  return `<div class="page-actions">${actions.map((action) => {
    const kind = action.kind === 'primary' ? 'primary' : 'secondary';
    return `<a href="${escapeHtml(action.href ?? '')}" class="page-action ${kind}">${escapeHtml(action.label ?? '')}</a>`;
  }).join('')}</div>`;
}

function renderNotices(notices) {
  if (!Array.isArray(notices) || notices.length === 0) return '';
  return `<div class="notice-list" aria-live="polite">${notices.map((notice) => {
    const tone = escapeHtml(notice.tone ?? 'neutral');
    return `<section class="notice" data-tone="${tone}" role="status"><div class="notice-title">${escapeHtml(notice.title ?? '')}</div>${hasValue(notice.body) ? `<div class="notice-body">${escapeHtml(notice.body)}</div>` : ''}</section>`;
  }).join('')}</div>`;
}

function renderTableSection(section) {
  const id = section.id ?? '';
  const escapedId = escapeHtml(id);
  const title = section.title ?? '';
  const tableId = `table-${escapedId}`;
  const columns = Array.isArray(section.columns) ? section.columns : [];
  const rows = Array.isArray(section.rows) ? section.rows : [];
  if (rows.length === 0) return '';

  const thead = columns.length > 0
    ? `<tr>${columns.map((c) => `<th scope="col" class="${renderColumnClass(c)}">${escapeHtml(c.label ?? c.key ?? '')}</th>`).join('')}</tr>`
    : '<tr><th scope="col"></th></tr>';
  const tbody = rows.map((row) => {
    if (columns.length > 0) {
      return `<tr>${columns.map((c) => `<td class="${renderColumnClass(c)}">${renderTableCellValue(row?.[c.key])}</td>`).join('')}</tr>`;
    }
    return `<tr><td>${escapeHtml(row ?? '')}</td></tr>`;
  }).join('');

  return renderDataSection({
    id,
    title,
    body: `<div class="table-scroll" tabindex="0" role="region" aria-label="${escapeHtml(title)}"><table id="${tableId}" class="data-table"><thead>${thead}</thead><tbody>${tbody}</tbody></table></div>`,
  });
}

function isMonoMetaItem(item) {
  const label = String(item?.label ?? '');
  return /(^|\b)(id|trace|time|timestamp|时间|日期)(\b|$)/i.test(label);
}

function renderDefinitionListSection(section) {
  const id = section.id ?? '';
  const escapedId = escapeHtml(id);
  const title = section.title ?? '';
  const items = Array.isArray(section.items) ? section.items.filter((item) => hasValue(item.value)) : [];
  if (items.length === 0) return '';

  const rows = items.map((item) => {
    const label = escapeHtml(item.label ?? '');
    const value = escapeHtml(item.value ?? '');
    const valueClass = isMonoMetaItem(item) ? 'meta-val mono' : 'meta-val';
    return `<div class="meta-row"><span class="meta-key">${label}</span><span class="${valueClass}">${value}</span></div>`;
  }).join('');

  return renderDataSection({
    id,
    title,
    collapsible: section.collapsible === true,
    body: `<div id="meta-${escapedId}" class="metadata-block">${rows}</div>`,
  });
}

function renderLinkListSection(section) {
  const id = section.id ?? '';
  const title = section.title ?? '';
  const links = Array.isArray(section.links) ? section.links : [];
  if (links.length === 0) return '';

  const items = links.map((link) => {
    const href = escapeHtml(link.href ?? '');
    const text = escapeHtml(link.label ?? link.text ?? '');
    return `<li><a href="${href}" class="section-link">${text}</a></li>`;
  }).join('');

  return renderDataSection({ id, title, body: `<ul class="link-list">${items}</ul>` });
}

function renderPaginationControl({ href, label, direction }) {
  const className = `pagination-control pagination-${direction}`;
  if (!hasValue(href)) {
    return `<span class="${className} is-disabled" aria-disabled="true">${escapeHtml(label)}</span>`;
  }
  return `<a href="${escapeHtml(href)}" class="${className}">${escapeHtml(label)}</a>`;
}

function renderPaginationSection(section) {
  const currentPage = Number(section.currentPage);
  const totalPages = Number(section.totalPages);
  if (!Number.isInteger(currentPage) || !Number.isInteger(totalPages) || totalPages <= 1) return '';
  return renderDataSection({
    id: section.id ?? '',
    title: section.title ?? '',
    className: 'pagination-section',
    body: `<nav class="pagination-controls" aria-label="日志分页">
      ${renderPaginationControl({ href: section.previousHref, label: '上一页', direction: 'previous' })}
      <span class="pagination-status" aria-current="page">第 ${currentPage} / ${totalPages} 页</span>
      ${renderPaginationControl({ href: section.nextHref, label: '下一页', direction: 'next' })}
    </nav>`,
  });
}

function renderCalloutSection(section) {
  const id = section.id ?? '';
  const title = section.title ?? '';
  const body = escapeHtml(section.body ?? '');
  if (!title && !body) return '';
  return renderDataSection({
    id,
    title,
    className: 'callout',
    body: body ? `<div class="callout-body">${body}</div>` : '',
  });
}

function renderRawLogListSection(section) {
  const id = section.id ?? '';
  const title = section.title ?? '';
  const snippets = Array.isArray(section.snippets) ? section.snippets.filter((snippet) => hasValue(snippet.body)) : [];
  if (snippets.length === 0) return '';

  const items = snippets.map((snippet) => `<article class="raw-log-snippet">
      ${hasValue(snippet.label) ? `<div class="raw-log-label">${escapeHtml(snippet.label)}</div>` : ''}
      <pre class="raw-log-pre"><code>${escapeHtml(snippet.body)}</code></pre>
    </article>`).join('');

  return renderDataSection({
    id,
    title,
    className: 'raw-log-section',
    collapsible: section.collapsible !== false,
    body: `<div class="raw-log-list">${items}</div>`,
  });
}

function renderTraceSequenceSection(section) {
  const id = section.id ?? '';
  const title = section.title ?? '';
  const steps = Array.isArray(section.steps) ? section.steps : [];
  if (steps.length === 0) return '';

  const items = steps.map((step) => {
    const status = step.status && typeof step.status === 'object'
      ? renderStatusTag(step.status.text ?? '', step.status.tone)
      : '';
    const metaItems = [
      hasValue(step.timestamp) ? `<span>${escapeHtml(step.timestamp)}</span>` : '',
      hasValue(step.span_id) ? `<span>Span ${escapeHtml(step.span_id)}</span>` : '',
      hasValue(step.parent_span_id) ? `<span>父 Span ${escapeHtml(step.parent_span_id)}</span>` : '',
      hasValue(step.duration_ms) ? `<span>${escapeHtml(step.duration_ms)}</span>` : '',
    ].filter(Boolean).join('');
    const summary = hasValue(step.error_message) ? step.error_message : step.summary;

    return `<li class="trace-step">
        <span class="trace-step-index">${escapeHtml(step.order ?? '')}</span>
        <div class="trace-step-body">
          <div class="trace-step-head">
            <span class="trace-step-tool mono">${escapeHtml(step.tool_name ?? '')}</span>
            <span class="trace-step-event">${escapeHtml(step.event ?? '')}</span>
            ${status}
          </div>
          ${metaItems ? `<div class="trace-step-meta mono">${metaItems}</div>` : ''}
          ${hasValue(summary) ? `<div class="trace-step-summary">${escapeHtml(summary)}</div>` : ''}
        </div>
      </li>`;
  }).join('');

  return renderDataSection({
    id,
    title,
    className: 'trace-sequence-section',
    body: `<ol class="trace-sequence">${items}</ol>`,
  });
}

function renderTraceAnalysisSection(section) {
  const id = section.id ?? '';
  const title = section.title ?? '';
  const riskPoints = Array.isArray(section.risk_points) ? section.risk_points.filter(hasValue) : [];
  const nextActions = Array.isArray(section.next_actions) ? section.next_actions.filter(hasValue) : [];
  if (!hasValue(section.purpose) && !hasValue(section.chain_summary) && riskPoints.length === 0 && nextActions.length === 0) return '';

  const renderList = (items) => items.length > 0
    ? `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
    : '';

  return renderDataSection({
    id,
    title,
    className: 'trace-analysis-section',
    body: `<div class="trace-analysis-grid">
      ${hasValue(section.purpose) ? `<div class="trace-analysis-block"><div class="trace-analysis-label">调用目的</div><p>${escapeHtml(section.purpose)}</p></div>` : ''}
      ${hasValue(section.chain_summary) ? `<div class="trace-analysis-block"><div class="trace-analysis-label">链路解读</div><p>${escapeHtml(section.chain_summary)}</p></div>` : ''}
      ${riskPoints.length > 0 ? `<div class="trace-analysis-block"><div class="trace-analysis-label">风险点</div>${renderList(riskPoints)}</div>` : ''}
      ${nextActions.length > 0 ? `<div class="trace-analysis-block"><div class="trace-analysis-label">建议动作</div>${renderList(nextActions)}</div>` : ''}
    </div>
    ${hasValue(section.model) ? `<div class="trace-analysis-model mono">模型：${escapeHtml(section.model)}</div>` : ''}`,
  });
}

function renderActionFormsSection(section) {
  const forms = Array.isArray(section.forms) ? section.forms : [];
  if (forms.length === 0 || !hasValue(section.action_url)) return '';
  const body = forms.map((form) => `<form method="post" action="${escapeHtml(section.action_url)}" class="finding-action-form">
      <input type="hidden" name="action" value="${escapeHtml(form.action ?? '')}">
      <input type="hidden" name="expected_state_version" value="${escapeHtml(section.state_version ?? '')}">
      <div class="form-heading">${escapeHtml(form.label ?? form.action ?? '')}</div>
      <label class="form-field"><span>操作者</span><input type="text" name="actor" required autocomplete="username"></label>
      ${form.requires_note ? '<label class="form-field"><span>说明</span><textarea name="note" required rows="3"></textarea></label>' : ''}
      ${form.requires_snoozed_until ? '<label class="form-field"><span>暂缓至</span><input type="datetime-local" name="snoozed_until" required></label>' : ''}
      <button type="submit" class="form-submit">${escapeHtml(form.label ?? '提交')}</button>
    </form>`).join('');
  return renderDataSection({
    id: section.id,
    title: section.title ?? '',
    className: 'finding-actions-section',
    body: `<div class="finding-action-grid">${body}</div>`,
  });
}

function renderConfirmationSection(section) {
  const items = Array.isArray(section.items) ? section.items.filter((item) => hasValue(item?.value)) : [];
  const form = section.form ?? {};
  if (items.length === 0) return '';
  const rows = items.map((item) => `<div class="confirmation-row"><dt>${escapeHtml(item.label ?? '')}</dt><dd>${escapeHtml(item.value)}</dd></div>`).join('');
  const method = String(form.method ?? 'post').toLowerCase() === 'get' ? 'get' : 'post';
  const cancel = hasValue(form.cancel_href)
    ? `<a href="${escapeHtml(form.cancel_href)}" class="confirmation-cancel">${escapeHtml(form.cancel_label ?? '返回')}</a>`
    : '';
  const allowed = section.allowed !== false && hasValue(form.action);
  const controls = allowed
    ? `<form method="${method}" action="${escapeHtml(form.action)}" class="confirmation-form">
        ${cancel}
        <button type="submit" class="form-submit confirmation-submit">${escapeHtml(form.submit_label ?? '确认')}</button>
      </form>`
    : `<div class="confirmation-form confirmation-unavailable" role="status">${cancel}</div>`;
  const body = `${hasValue(section.description) ? `<p class="confirmation-description">${escapeHtml(section.description)}</p>` : ''}
    <dl class="confirmation-details">${rows}</dl>
    ${controls}`;
  return renderDataSection({
    id: section.id,
    title: section.title ?? '',
    className: 'confirmation-section',
    body,
  });
}

function lucideChevron() {
  return '<svg class="lucide lucide-chevron-right" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';
}

function renderTaskRows(tasks = []) {
  if (!tasks.length) return '<p class="empty-state">暂无任务</p>';
  return tasks.map((task) => `<a class="task-row" href="${escapeHtml(task.href)}">
    <time class="mono">${escapeHtml(task.time)}</time>
    <span class="task-request">${escapeHtml(task.request)}${task.incomplete ? '<small>上下文不完整</small>' : ''}</span>
    ${renderStatusTag(task.state.text, task.state.tone)}${lucideChevron()}
  </a>`).join('');
}

function renderRequesterGroups(section) {
  const groups = section.groups.map((group) => `<details class="requester-group"${group.open ? ' open' : ''}>
    <summary><span class="requester-name">${escapeHtml(group.name)}</span>
      ${!group.requester_id ? '<span>上下文不完整</span>' : ''}
      <span class="mono">${group.count} 任务</span><time class="mono">${escapeHtml(group.time)}</time>${lucideChevron()}</summary>
    <div class="group-tasks"><div class="group-caption">${group.attention} 条需要介入
      <a href="${escapeHtml(group.href)}">查看全部任务 / 分享此分组</a></div>${renderTaskRows(group.tasks)}</div>
  </details>`).join('');
  return renderDataSection({ id: section.id, title: section.title, className: 'requester-section', body: `
    <div class="group-toolbar"><form method="get" action="${escapeHtml(section.action)}">
      <label for="requester-search"><svg class="lucide lucide-search" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>按发起人筛选</label>
      <input id="requester-search" name="q" type="search" placeholder="发起人 ID 或展示名" value="${escapeHtml(section.search)}"><button type="submit">搜索</button>
    </form><div><button type="button" data-group-expand="true">全部展开</button><button type="button" data-group-expand="false">全部折叠</button></div></div>
    ${groups || '<p class="empty-state">没有匹配的发起人</p>'}
    ${section.moreHref ? `<a class="load-more" href="${escapeHtml(section.moreHref)}">加载更多</a>` : ''}` });
}

function renderSection(section) {
  if (!section) return '';
  switch (section.type) {
    case 'requester_groups': return renderRequesterGroups(section);
    case 'task_list': return renderDataSection({ id: section.id, title: section.title, body: renderTaskRows(section.tasks) });
    case 'table': return renderTableSection(section);
    case 'definition_list': return renderDefinitionListSection(section);
    case 'link_list': return renderLinkListSection(section);
    case 'pagination': return renderPaginationSection(section);
    case 'callout': return renderCalloutSection(section);
    case 'raw_log_list': return renderRawLogListSection(section);
    case 'trace_sequence': return renderTraceSequenceSection(section);
    case 'trace_analysis': return renderTraceAnalysisSection(section);
    case 'action_forms': return renderActionFormsSection(section);
    case 'confirmation': return renderConfirmationSection(section);
    default: return '';
  }
}

function renderSections(sections) {
  const visible = visibleSections(sections);
  if (!Array.isArray(visible) || visible.length === 0) return '<div class="empty-state">暂无可展示的审查数据</div>';
  return visible.map(renderSection).join('\n');
}

function renderEmptyState() {
  return '<div class="empty-state">暂无可展示的审查数据</div>';
}

function renderErrorState(message) {
  return `<div class="error-state">加载错误: ${escapeHtml(message ?? '')}</div>`;
}

export function renderDashboard(templateInput) {
  const page = templateInput?.page ?? {};
  const title = escapeHtml(page.title ?? '审计看板');
  const subtitle = escapeHtml(page.subtitle ?? '');
  const updatedAt = escapeHtml(page.updated_at ?? '');
  const metrics = renderSummaryMetrics(templateInput?.summary_metrics);
  const filters = renderFilterBar(
    templateInput?.filters,
    templateInput?.clear_filters_href ?? page.clear_filters_href,
  );
  const breadcrumbs = renderBreadcrumbs(page.breadcrumbs);
  const contextBadges = renderContextBadges(page.context_badges);
  const notificationStatus = renderNotificationStatus(page.notification_status);
  const pageActions = renderPageActions(page.page_actions);
  const notices = renderNotices(templateInput?.notices);
  const sections = renderSections(templateInput?.sections);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
:root {
  --surface-canvas: #F5F7FA;
  --surface-panel: #FFFFFF;
  --surface-subtle: #EEF2F6;
  --surface-inverse: #172033;
  --surface-code: #111827;
  --text-primary: #172033;
  --text-secondary: #667085;
  --text-inverse: #F8FAFC;
  --text-code: #E5E7EB;
  --border-default: #D8DEE8;
  --action-primary: #2F5D8A;
  --action-primary-hover: #244A70;
  --status-critical: #B42318;
  --status-critical-bg: #FDECEA;
  --status-high: #C2410C;
  --status-high-bg: #FFF1E8;
  --status-medium: #A66B00;
  --status-medium-bg: #FFF8E1;
  --status-low: #526173;
  --status-low-bg: #F1F5F9;
  --status-success: #16805D;
  --status-success-bg: #ECFDF5;
  --status-neutral: #475467;
  --status-neutral-bg: #F5F7FA;
  --component-radius: 6px;
  --component-transition: 180ms ease;
  --tone-color: var(--status-neutral);
  --tone-bg: var(--status-neutral-bg);
  --bg: var(--surface-canvas);
  --surface: var(--surface-panel);
  --surface-muted: var(--surface-subtle);
  --border: var(--border-default);
  --text: var(--text-primary);
  --text-muted: var(--text-secondary);
  --accent: var(--action-primary);
  --primary: var(--accent);
  --critical: var(--status-critical);
  --high: var(--status-high);
  --medium: var(--status-medium);
  --low: var(--status-low);
  --success: var(--status-success);
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-width: 0;
  overflow-x: hidden;
  font-family: "Noto Sans SC", "Source Han Sans SC", "Microsoft YaHei", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: var(--bg);
  color: var(--text);
  line-height: 1.5;
}
a {
  color: inherit;
  transition: color var(--component-transition), background-color var(--component-transition), border-color var(--component-transition), opacity var(--component-transition);
}
a:hover {
  text-decoration: underline;
}
:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.mono {
  font-family: "JetBrains Mono", "Cascadia Code", "Consolas", monospace;
}
.container { padding: 24px; max-width: 1200px; margin: 0 auto; }
.breadcrumbs {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
  color: var(--text-muted);
  font-size: 13px;
}
.breadcrumb-link {
  color: var(--accent);
  text-decoration: none;
}
.breadcrumb-current {
  color: var(--text);
  font-weight: 600;
}
.breadcrumb-separator {
  color: var(--text-muted);
}
.context-badges,
.page-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}
.context-badge,
.status-tag {
  display: inline-flex;
  align-items: center;
  min-height: 28px;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
}
.notification-status {
  min-height: 30px;
  padding: 4px 8px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid transparent;
  border-radius: var(--component-radius);
  color: #CBD5E1;
  font-size: 12px;
  font-weight: 600;
  text-decoration: none;
  white-space: nowrap;
}
.notification-status:hover,
.notification-status:focus-visible {
  border-color: var(--tone-color);
  background: #27344A;
  color: var(--text-inverse);
  text-decoration: none;
}
.notification-status .status-marker { color: var(--tone-color); }
.notification-status-icon {
  width: 14px;
  height: 14px;
  flex: none;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.8;
}
.page-actions {
  margin-bottom: 16px;
}
.page-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  padding: 10px 14px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  text-decoration: none;
}
.page-action.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #ffffff;
}
.page-action.secondary {
  background: var(--surface);
}
.notice-list {
  display: grid;
  gap: 8px;
  margin-bottom: 16px;
}
.notice {
  padding: 12px 14px;
  border: 1px solid var(--tone-color);
  border-left-width: 4px;
  border-radius: var(--component-radius);
  background: var(--tone-bg);
  color: var(--text-primary);
}
.notice-title { color: var(--tone-color); font-weight: 700; }
.notice-body { margin-top: 3px; font-size: 13px; }
.finding-action-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
}
.finding-action-form {
  display: grid;
  align-content: start;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--border-default);
  border-radius: var(--component-radius);
  background: var(--surface-subtle);
}
.form-heading { font-weight: 700; }
.form-field { display: grid; gap: 4px; color: var(--text-secondary); font-size: 12px; }
.form-field input,
.form-field textarea {
  width: 100%;
  min-height: 40px;
  padding: 8px 10px;
  border: 1px solid var(--border-default);
  border-radius: 4px;
  background: var(--surface-panel);
  color: var(--text-primary);
  font: inherit;
}
.form-field textarea { resize: vertical; }
.form-submit {
  min-height: 40px;
  padding: 8px 12px;
  border: 1px solid var(--action-primary);
  border-radius: 4px;
  background: var(--action-primary);
  color: var(--text-inverse);
  cursor: pointer;
  font: inherit;
  font-weight: 700;
}
.form-submit:hover { background: var(--action-primary-hover); }
.confirmation-section {
  max-width: 720px;
  margin-inline: auto;
}
.confirmation-description {
  margin: 0 0 16px;
  color: var(--text-secondary);
  font-size: 14px;
}
.confirmation-details {
  margin: 0;
  border-top: 1px solid var(--border-default);
}
.confirmation-row {
  padding: 12px 0;
  display: grid;
  grid-template-columns: minmax(110px, 0.35fr) minmax(0, 1fr);
  gap: 16px;
  border-bottom: 1px solid var(--border-default);
}
.confirmation-row dt { color: var(--text-secondary); font-size: 13px; }
.confirmation-row dd { margin: 0; font-weight: 600; overflow-wrap: anywhere; }
.confirmation-form {
  margin-top: 20px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
}
.confirmation-cancel {
  min-height: 40px;
  padding: 8px 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border-default);
  border-radius: 4px;
  background: var(--surface-panel);
  color: var(--text-primary);
  font-weight: 700;
  text-decoration: none;
}
.confirmation-cancel:hover { background: var(--surface-subtle); text-decoration: none; }
.confirmation-submit { min-width: 108px; }
.summary-metrics {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 16px;
  margin-bottom: 16px;
}
.metric-value { font-size: 28px; font-weight: 700; }
.metric-label { font-size: 13px; color: var(--text-muted); margin-top: 4px; }
.filter-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--component-radius);
  padding: 12px 16px;
  margin-bottom: 24px;
}
.data-section {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--component-radius);
  padding: 16px;
  margin-bottom: 16px;
}
.data-section h3 { margin: 0 0 12px 0; font-size: 16px; }
.table-scroll {
  overflow-x: auto;
}
.data-table { width: 100%; border-collapse: collapse; font-size: 13px; min-width: 375px; }
.data-table th, .data-table td { padding: 12px 10px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
.data-table th { background: #f8fafc; font-weight: 600; color: var(--text-muted); }
.data-table tbody tr {
  transition: background-color 180ms ease;
}
.data-table tbody tr:hover { background: var(--surface-muted); }
.cell-stack {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.cell-primary {
  color: var(--text);
}
.cell-secondary {
  color: var(--text-muted);
  font-size: 12px;
}
.cell-link,
.section-link {
  color: var(--accent);
  text-decoration: none;
}
.metadata-block { font-size: 13px; }
.meta-row { display: flex; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--border); }
.meta-key { width: 180px; color: var(--text-muted); flex-shrink: 0; }
.meta-val { flex: 1; word-break: break-all; }
.raw-log-list { display: flex; flex-direction: column; gap: 12px; }
.raw-log-label { font-size: 12px; color: var(--text-muted); margin-bottom: 6px; }
.raw-log-pre {
  margin: 0;
  padding: 12px;
  overflow-x: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: #0f172a;
  color: #e2e8f0;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre;
}
.raw-log-pre code { font-family: "JetBrains Mono", "Cascadia Code", monospace; }
.link-list { list-style: none; padding: 0; margin: 0; }
.link-list li { padding: 6px 0; }
.pagination-section { padding: 12px 16px; }
.pagination-controls { display: flex; align-items: center; justify-content: center; gap: 12px; }
.pagination-control {
  min-width: 72px;
  padding: 7px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--accent);
  background: var(--surface);
  text-align: center;
  text-decoration: none;
}
.pagination-control:hover { background: var(--surface-muted); text-decoration: none; }
.pagination-control.is-disabled { color: var(--text-muted); background: var(--surface-muted); cursor: not-allowed; }
.pagination-status { min-width: 96px; color: var(--text-muted); font-size: 13px; text-align: center; }
.callout-body { font-size: 14px; color: var(--text); }
.trace-sequence {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.trace-step {
  display: grid;
  grid-template-columns: 32px minmax(0, 1fr);
  gap: 12px;
}
.trace-step-index {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 999px;
  background: var(--accent);
  color: #fff;
  font-size: 12px;
  font-weight: 700;
}
.trace-step-body {
  min-width: 0;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
}
.trace-step:last-child .trace-step-body {
  border-bottom: 0;
  padding-bottom: 0;
}
.trace-step-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.trace-step-tool {
  font-weight: 700;
  word-break: break-all;
}
.trace-step-event {
  color: var(--text-muted);
  font-size: 12px;
}
.trace-step-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 6px;
  color: var(--text-muted);
  font-size: 12px;
}
.trace-step-summary {
  margin-top: 6px;
  font-size: 13px;
  color: var(--text);
}
.trace-analysis-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 14px 20px;
}
.trace-analysis-block {
  min-width: 0;
}
.trace-analysis-label {
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 700;
  margin-bottom: 6px;
}
.trace-analysis-block p {
  margin: 0;
  font-size: 14px;
}
.trace-analysis-block ul {
  margin: 0;
  padding-left: 18px;
  font-size: 14px;
}
.trace-analysis-model {
  margin-top: 12px;
  color: var(--text-muted);
  font-size: 12px;
}
.empty-state, .empty, .error-state, .error { color: var(--text-muted); font-size: 13px; padding: 12px; }
.error-state, .error { color: var(--critical); }
footer { text-align: center; color: var(--text-muted); font-size: 12px; padding: 24px; }
.skip-link {
  position: fixed;
  top: 8px;
  left: 8px;
  z-index: 100;
  padding: 10px 14px;
  border-radius: 4px;
  background: var(--surface-panel);
  color: var(--action-primary);
  font-weight: 700;
  transform: translateY(-160%);
  text-decoration: none;
}
.skip-link:focus { transform: translateY(0); }
.app-bar {
  background: var(--surface-inverse);
  color: var(--text-inverse);
  border-bottom: 1px solid #283449;
}
.app-bar-shell {
  max-width: 1200px;
  min-height: 64px;
  margin: 0 auto;
  padding: 10px 24px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
}
.app-identity {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
}
.app-brand {
  flex: none;
  font-size: 14px;
  font-weight: 800;
  letter-spacing: 0.01em;
  text-decoration: none;
}
.app-page {
  min-width: 0;
  overflow: hidden;
  color: #CBD5E1;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.app-separator { color: #64748B; }
.app-nav {
  margin-right: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
}
.app-nav-link {
  min-height: 40px;
  padding: 8px 10px;
  display: inline-flex;
  align-items: center;
  border-radius: 4px;
  color: #CBD5E1;
  font-size: 13px;
  text-decoration: none;
}
.app-nav-link:hover,
.app-nav-link:focus-visible {
  background: #27344A;
  color: var(--text-inverse);
  text-decoration: none;
}
.app-meta {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  color: #CBD5E1;
  font-size: 12px;
}
.updated-at { white-space: nowrap; }
.container {
  width: 100%;
  min-width: 0;
}
.context-header {
  margin-bottom: 20px;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 24px;
}
.context-copy { min-width: 0; }
.page-title {
  margin: 0;
  font-size: clamp(24px, 3vw, 28px);
  line-height: 1.25;
  letter-spacing: -0.02em;
}
.page-subtitle {
  max-width: 720px;
  margin: 6px 0 0;
  color: var(--text-secondary);
  font-size: 14px;
}
.context-badge,
.status-tag {
  gap: 6px;
  padding: 4px 8px;
  border: 1px solid var(--tone-color);
  border-radius: 4px;
  background: var(--tone-bg);
  color: var(--tone-color);
}
.status-marker {
  width: 7px;
  height: 7px;
  flex: none;
  border-radius: 50%;
  background: currentColor;
}
[data-tone="critical"] { --tone-color: var(--status-critical); --tone-bg: var(--status-critical-bg); }
[data-tone="high"] { --tone-color: var(--status-high); --tone-bg: var(--status-high-bg); }
[data-tone="medium"] { --tone-color: var(--status-medium); --tone-bg: var(--status-medium-bg); }
[data-tone="low"] { --tone-color: var(--status-low); --tone-bg: var(--status-low-bg); }
[data-tone="success"] { --tone-color: var(--status-success); --tone-bg: var(--status-success-bg); }
[data-tone="neutral"] { --tone-color: var(--status-neutral); --tone-bg: var(--status-neutral-bg); }
.page-actions { margin-bottom: 0; flex: none; }
.page-action {
  border-radius: var(--component-radius);
  border-color: var(--border-default);
  box-shadow: none;
}
.page-action.primary {
  background: var(--action-primary);
  border-color: var(--action-primary);
  color: var(--text-inverse);
}
.page-action.primary:hover { background: var(--action-primary-hover); }
.summary-metrics {
  grid-template-columns: repeat(auto-fit, minmax(132px, 1fr));
  gap: 0;
  margin: 0 0 20px;
  overflow: hidden;
  border: 1px solid var(--border-default);
  border-radius: var(--component-radius);
  background: var(--surface-panel);
}
.summary-metric-link {
  min-width: 0;
  display: block;
  color: inherit;
  text-decoration: none;
}
.summary-metric {
  position: relative;
  min-height: 88px;
  height: 100%;
  padding: 14px 16px 12px;
  border-right: 1px solid var(--border-default);
  background: var(--surface-panel);
}
.summary-metric::before {
  content: "";
  position: absolute;
  top: 0;
  right: 0;
  left: 0;
  height: 3px;
  background: var(--tone-color);
}
.summary-metric-link:hover .summary-metric,
.summary-metric-link:focus-visible .summary-metric { background: var(--surface-subtle); }
.metric-value {
  color: var(--tone-color);
  font-size: 26px;
  font-weight: 750;
  font-variant-numeric: tabular-nums;
}
.metric-label { margin-top: 2px; color: var(--text-secondary); font-size: 12px; }
.filter-bar {
  margin: 0 0 20px;
  padding: 12px 14px;
  display: grid;
  gap: 10px;
  border: 1px solid var(--border-default);
  border-radius: var(--component-radius);
  background: var(--surface-panel);
  box-shadow: none;
}
.filter-group {
  display: grid;
  grid-template-columns: 92px minmax(0, 1fr);
  align-items: center;
  gap: 10px;
}
.filter-label { color: var(--text-secondary); font-size: 12px; font-weight: 700; }
.filter-options { min-width: 0; display: flex; flex-wrap: wrap; gap: 6px; }
.filter-option,
.filter-clear,
.filter-clear-all {
  min-height: 32px;
  padding: 5px 9px;
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--border-default);
  border-radius: 4px;
  color: var(--action-primary);
  font-size: 12px;
  text-decoration: none;
}
.filter-option.active {
  border-color: var(--action-primary);
  background: var(--action-primary);
  color: var(--text-inverse);
}
.filter-clear,
.filter-clear-all { border-color: transparent; }
.filter-clear-all { justify-self: start; }
.data-section {
  min-width: 0;
  border-radius: var(--component-radius);
  box-shadow: none;
}
.section-title {
  display: block;
  margin: 0 0 12px;
  color: var(--text-primary);
  font-size: 17px;
  font-weight: 700;
}
.collapsible-section { padding: 0; }
.section-summary {
  min-height: 52px;
  padding: 12px 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  cursor: pointer;
  list-style: none;
}
.section-summary::-webkit-details-marker { display: none; }
.section-summary .section-title { margin: 0; }
.section-summary-hint { color: var(--text-secondary); font-size: 12px; }
.collapsible-section[open] .section-summary { border-bottom: 1px solid var(--border-default); }
.collapsible-section[open] .section-summary-hint { visibility: hidden; }
.collapsible-section[open] .section-summary-hint::after { content: "收起"; visibility: visible; }
.collapsible-section > :not(summary) { margin: 16px; }
.table-scroll {
  width: 100%;
  max-width: 100%;
  overflow-x: auto;
  overscroll-behavior-inline: contain;
}
.data-table { min-width: 640px; border-collapse: separate; border-spacing: 0; }
.data-table thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--surface-subtle);
  color: var(--text-secondary);
  white-space: nowrap;
}
.data-table tbody tr:last-child td { border-bottom: 0; }
.metadata-block { font-size: 13px; }
.meta-row { border-bottom-color: var(--border-default); }
.meta-row:last-child { border-bottom: 0; }
.raw-log-pre {
  border-color: #334155;
  border-radius: var(--component-radius);
  background: var(--surface-code);
  color: var(--text-code);
}
.raw-log-pre code { font-family: "JetBrains Mono", "Cascadia Code", "Consolas", monospace; }
.callout { border-left: 3px solid var(--action-primary); }
.trace-step { position: relative; }
.trace-step:not(:last-child)::after {
  content: "";
  position: absolute;
  top: 28px;
  bottom: -12px;
  left: 13px;
  width: 2px;
  background: var(--border-default);
}
.trace-step-index {
  position: relative;
  z-index: 1;
  border: 2px solid var(--surface-panel);
  border-radius: 50%;
  background: var(--action-primary);
  color: var(--text-inverse);
}
.trace-step-body { border-bottom: 0; }
@media (max-width: 768px) {
  .app-bar-shell {
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
    padding: 12px 16px;
  }
  .app-nav {
    justify-content: flex-start;
    margin-right: 0;
    overflow-x: auto;
  }
  .app-meta {
    justify-content: flex-start;
    flex-wrap: wrap;
  }
  .context-header {
    align-items: stretch;
    flex-direction: column;
    gap: 14px;
  }
  .header-shell,
  .header-meta {
    align-items: stretch;
  }
  .header-shell {
    flex-direction: column;
  }
  .header-meta {
    align-items: flex-start;
  }
  .context-badges,
  .page-actions {
    justify-content: flex-start;
  }
  .container {
    padding: 16px;
  }
  .column-priority-metadata { display: none; }
  .data-table { min-width: 520px; }
  .filter-group {
    grid-template-columns: 1fr;
    gap: 4px;
  }
  .meta-row {
    flex-direction: column;
    gap: 4px;
  }
  .meta-key {
    width: auto;
  }
  .confirmation-row { grid-template-columns: 1fr; gap: 4px; }
  .confirmation-form { align-items: stretch; flex-direction: column-reverse; }
  .confirmation-cancel,
  .confirmation-submit { width: 100%; }
}
@media (max-width: 375px) {
  .app-page,
  .app-separator { display: none; }
  .app-nav-link { padding-inline: 8px; }
  .container { padding: 12px; }
  .summary-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .summary-metric {
    min-height: 80px;
    padding: 12px;
  }
  .data-section { padding: 12px; }
  .collapsible-section { padding: 0; }
  .data-table { min-width: 440px; }
  .column-priority-metadata { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    scroll-behavior: auto !important;
    transition-duration: 0.01ms !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
  }
}
.lucide { width: 16px; height: 16px; flex: 0 0 auto; vertical-align: middle; }
.task-audit {
  --surface-canvas: #0B0F14; --surface-panel: #111926; --surface-subtle: #0E141C;
  --text-primary: #E6EDF3; --text-secondary: #9FB0BF; --border-default: #1C2531;
  --action-primary: #7EB6E8; --action-primary-hover: #A3CCF0;
  --status-neutral: #9FB0BF; --status-neutral-bg: #151C26;
  --status-high: #F0616D; --status-high-bg: #2A1216;
  --status-medium: #FFB454; --status-medium-bg: #241A0F;
  --status-success: #3FD68F; --status-success-bg: #0F2A20;
  --bg: #0B0F14; --surface: #111926; --surface-muted: #0E141C;
  --text: #E6EDF3; --text-muted: #9FB0BF; --border: #1C2531; --accent: #7EB6E8;
  background: var(--surface-canvas); color: var(--text-primary);
}
.task-audit .container { max-width: 1180px; margin-inline: auto; }
.task-audit .data-section { box-shadow: none; border-color: var(--border-default); }
.task-audit .data-section { background: var(--surface-panel); }
.task-audit .app-bar { background: var(--surface-subtle); }
.task-audit #task_context, .task-audit #task_audit_result { padding-block: 12px; }
.task-audit .section-title { margin-bottom: 8px; font-size: 15px; }
.task-audit .data-section { margin-bottom: 12px; }
.task-audit .meta-row { gap: 10px; padding-block: 3px; }
.task-audit .meta-key { width: 110px; }
.task-audit #task_conclusion .metadata-block { display: flex; flex-wrap: wrap; gap: 10px 24px; }
.task-audit #task_conclusion .meta-row { border: 0; }
.task-audit #task_conclusion .meta-key { width: auto; }
.task-audit #task_conclusion .meta-val { flex: auto; }
.task-audit .page-title { font-size: 24px; }
.task-audit .meta-value, .task-audit .trace-step-body { min-width: 0; overflow-wrap: anywhere; }
.task-audit .raw-log-pre { white-space: pre-wrap; overflow-wrap: anywhere; }
.task-audit #task_conclusion { border-left: 2px solid var(--status-high); }
.task-audit .status-tag { font-family: inherit; }
.group-toolbar, .group-toolbar form, .group-toolbar label, .group-caption { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.group-toolbar { justify-content: space-between; margin-bottom: 18px; }
.group-toolbar input, .group-toolbar button { color: var(--text-primary); background: var(--surface-subtle); border: 1px solid var(--border-default); padding: 9px 12px; font: inherit; }
.group-toolbar button { cursor: pointer; }
.requester-group { background: var(--surface-panel); border: 1px solid var(--border-default); border-left: 2px solid #2B3846; margin-top: 8px; }
.requester-group[open] { border-left-color: #3FD68F; }
.requester-group summary { display: flex; align-items: center; gap: 14px; padding: 16px; cursor: pointer; list-style: none; }
.requester-group summary::-webkit-details-marker { display: none; }
.requester-group[open] > summary .lucide { transform: rotate(90deg); }
.requester-name, .task-request { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.group-tasks { border-top: 1px solid var(--border-default); padding: 0 16px 12px; }
.group-caption { justify-content: space-between; padding: 12px 0; color: var(--text-secondary); }
.task-row { display: flex; align-items: center; gap: 16px; padding: 14px 0; border-top: 1px solid var(--border-default); color: var(--text-primary); text-decoration: none; }
.task-row:hover { background: var(--surface-subtle); }
.task-row time, .requester-group time { font-size: 11px; color: var(--text-secondary); }
.task-request small { display: block; margin-top: 4px; color: var(--text-secondary); }
.load-more { display: block; padding: 16px; text-align: center; }
@media (max-width: 720px) {
  .task-audit .container { padding: 16px 14px; }
  .task-audit .data-table { min-width: 0; width: 100%; table-layout: fixed; }
  .task-audit .data-table th, .task-audit .data-table td { white-space: normal; overflow-wrap: anywhere; }
  .task-audit .meta-row, .task-audit .kv { display: grid; grid-template-columns: 1fr; }
  .task-audit #task_context .metadata-block, .task-audit #task_audit_result .metadata-block { grid-template-columns: 1fr; }
  .task-audit .app-bar-shell, .task-audit .context-header { flex-direction: column; align-items: stretch; }
  .task-audit .app-nav { flex-wrap: wrap; overflow: visible; }
  .task-row, .requester-group summary { flex-wrap: wrap; }
  .task-request, .requester-name { flex-basis: 100%; }
  .group-toolbar, .group-toolbar form { align-items: stretch; flex-direction: column; width: 100%; }
  .group-toolbar input { min-width: 0; width: 100%; }
  .task-audit .mono, .task-audit .breadcrumbs { overflow-wrap: anywhere; }
}
</style>
</head>
<body${page.task_audit ? ' class="task-audit"' : ''}>
<a class="skip-link" href="#main-content">跳到主要内容</a>
<header class="app-bar">
  <div class="app-bar-shell">
    <div class="app-identity">
      <a href="/" class="app-brand">Audit Logger Agent</a>
      <span class="app-separator" aria-hidden="true">/</span>
      <span class="app-page">${title}</span>
    </div>
    <nav class="app-nav" aria-label="主导航">
      <a href="/" class="app-nav-link">Agent</a>
      ${page.agent_index ? '' : `<a href="/dashboard#pending_findings" class="app-nav-link">风险发现</a>
      <a href="/dashboard#reviews_with_findings" class="app-nav-link">审查批次</a>`}
    </nav>
    <div class="app-meta">
      ${notificationStatus}
      ${contextBadges}
      <span class="updated-at">更新时间：${updatedAt}</span>
    </div>
  </div>
</header>
<main id="main-content" class="container">
  <header class="context-header">
    <div class="context-copy">
      ${breadcrumbs}
      <h1 id="page-title" class="page-title">${title}</h1>
      ${subtitle ? `<p class="page-subtitle">${subtitle}</p>` : ''}
    </div>
    ${pageActions}
  </header>
  ${metrics}
  ${notices}
  ${filters}
  ${sections}
</main>
<footer>audit-logger-agent 审计看板</footer>
${templateInput?.sections?.some((section) => section.type === 'requester_groups') ? `<script>
document.querySelectorAll('[data-group-expand]').forEach(function(button) {
  button.addEventListener('click', function() {
    document.querySelectorAll('.requester-group').forEach(function(group) {
      group.open = button.dataset.groupExpand === 'true';
    });
  });
});
</script>` : ''}
</body>
</html>`;
}

export function renderOverviewHtml(templateInput) {
  return renderDashboard(templateInput);
}

export { renderEmptyState, renderErrorState, SEVERITY_TONES, hasValue, visibleMetrics, visibleSections };
