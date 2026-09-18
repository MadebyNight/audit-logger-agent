const escape = (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const date = value => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
const icon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15.5 7.5 3 3L22 7l-3-3-3.5 3.5a5.5 5.5 0 1 0-4 4Z"/><circle cx="7.5" cy="15.5" r=".5"/></svg>';
export const renderApiTokenLauncher = () => `<button type="button" class="api-token-launch" id="open-api-tokens">${icon}API Token</button>`;

export function renderApiTokenDrawer({ accounts, records, token, error, open, returnTo }) {
  return `<style>
.api-token-launch{display:inline-flex;align-items:center;justify-content:center;gap:8px;flex-shrink:0;padding:10px 16px;background:#1b3029;color:#b9f4d0;border:1px solid #3c5c4c;border-radius:8px;cursor:pointer;font:500 14px/1.5 "Microsoft YaHei",sans-serif;transition:background .15s,border-color .15s,transform .15s}
.api-token-launch:hover{background:#294638;border-color:#8aba9b}
.head:has(.api-token-launch){position:relative;min-height:132px}.head>.api-token-launch{position:absolute;right:0;top:24px}
.api-token-drawer{margin:0 0 0 auto;height:100dvh;max-height:100dvh;width:min(600px,100vw);max-width:100vw;box-sizing:border-box;border:0;border-left:1px solid #293746;padding:0;background:#0e151f;color:#e6edf3;overflow:auto;overflow-wrap:anywhere;font:14px/1.6 "Microsoft YaHei",sans-serif}
.api-token-drawer::backdrop{background:#02060baa;backdrop-filter:blur(3px)}
.api-token-drawer *{box-sizing:border-box}
.api-token-drawer .at-header{position:sticky;top:0;z-index:2;display:flex;justify-content:space-between;align-items:center;padding:24px 28px;background:#0e151ff5;border-bottom:1px solid #25313e}
.api-token-drawer h2,.api-token-drawer h3,.api-token-drawer p{margin:0}
.api-token-drawer h2{font-size:22px;letter-spacing:-.5px}.api-token-drawer h3{font-size:16px}
.api-token-drawer .at-content{padding:28px;display:grid;gap:28px}
.api-token-drawer .at-muted{color:#9fb0bf;font-size:13px}
.api-token-drawer .at-create{padding:20px;background:#16221f;border:1px solid #304a3e;border-radius:14px;display:grid;gap:14px}
.api-token-drawer label{display:grid;gap:8px;font-weight:500}
.api-token-drawer input{width:100%;min-width:0;padding:12px 14px;background:#0b1219;color:#e6edf3;border:1px solid #3c4f5e;border-radius:8px;font:inherit}
.api-token-drawer form{margin:0}.api-token-drawer .at-create form{display:grid;gap:12px}
.api-token-drawer button{border:1px solid #476071;border-radius:8px;background:#203141;color:#e6edf3;padding:9px 14px;font:600 13px/1.5 "Microsoft YaHei",sans-serif;cursor:pointer;transition:background .15s,border-color .15s,transform .15s}
.api-token-drawer button:hover{background:#30495e;border-color:#7899b0}
.api-token-drawer button:active,.api-token-launch:active{transform:translateY(1px)}
.api-token-drawer .at-primary{background:#b9f4d0;color:#173026;border-color:#b9f4d0}
.api-token-drawer .at-primary:hover{background:#d6ffe5;border-color:#d6ffe5}
.api-token-drawer .at-danger{color:#ffb4ac;border-color:#774b4b;background:#312026}
.api-token-drawer .at-danger:hover{background:#522c32;border-color:#e28b85}
.api-token-drawer button:disabled{opacity:.55;cursor:wait;transform:none}
.api-token-drawer :focus-visible,.api-token-launch:focus-visible{outline:2px solid #b9f4d0;outline-offset:3px}
.api-token-drawer .at-list{display:grid;gap:12px;margin-top:14px}
.api-token-drawer .at-card{padding:18px;background:#141e2a;border:1px solid #2c3b4a;border-radius:12px}
.api-token-drawer .at-card-top{display:flex;align-items:start;justify-content:space-between;gap:14px}
.api-token-drawer .at-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}
.api-token-drawer .at-status{color:#edc58c;font-size:12px;white-space:nowrap}
.api-token-drawer details{margin-top:16px;border-top:1px solid #2c3b4a;padding-top:12px}
.api-token-drawer summary{color:#bad7ed;cursor:pointer;font-size:13px}
.api-token-drawer summary:hover{color:#eef7ff}
.api-token-drawer .at-record{padding:12px 0;border-bottom:1px solid #273443}
.api-token-drawer .at-record:last-child{border:0}
.api-token-drawer .at-secret{display:grid;gap:10px;padding-top:14px;border-top:1px solid #304a3e}
.api-token-drawer .at-secret input{font-family:monospace}
.api-token-drawer .at-empty{padding:24px;border:1px dashed #3b4e5e;border-radius:12px;color:#9fb0bf;text-align:center}
.api-token-drawer .at-error{color:#ffb4ac}
@media(max-width:720px){.api-token-drawer{width:100vw}.api-token-drawer .at-header{padding:20px}.api-token-drawer .at-content{padding:20px;gap:24px}.head:has(.api-token-launch){padding-top:76px}.head>.api-token-launch{top:16px}.api-token-launch{padding:8px 12px}}
@media(prefers-reduced-motion:reduce){.api-token-drawer button{transition:none}}
</style>
<dialog class="api-token-drawer" id="api-token-drawer" aria-labelledby="api-token-heading">
<header class="at-header"><div><h2 id="api-token-heading">API Token</h2><p class="at-muted">管理 Agent 的日志读取凭证</p></div><button type="button" id="close-api-tokens">关闭</button></header>
<div class="at-content">${renderApiTokens({ accounts, records, token, error })}</div></dialog>
<script>(()=>{const drawer=document.getElementById('api-token-drawer');
document.getElementById('open-api-tokens').onclick=()=>drawer.showModal();
document.getElementById('close-api-tokens').onclick=()=>drawer.close();
drawer.querySelectorAll('form').forEach(form=>{const field=document.createElement('input');field.type='hidden';field.name='return_to';field.value=${JSON.stringify(returnTo).replaceAll('<', '\\u003c')};form.append(field);
form.addEventListener('submit',event=>{if(form.dataset.delete==='true'&&!confirm('删除后该 Token 永久失效，历史调用记录仍会保留。确认删除？')){event.preventDefault();return;}const button=form.querySelector('button');button.disabled=true;button.textContent='处理中…';});});
const copy=document.getElementById('copy-api-token');if(copy)copy.onclick=async()=>{const field=document.getElementById('new-api-token');try{await navigator.clipboard.writeText(field.value);copy.textContent='已复制';}catch{field.select();document.getElementById('copy-result').textContent='请按 Ctrl+C 或使用系统复制';}};
${open ? `drawer.showModal();history.replaceState(null,'',${JSON.stringify(returnTo).replaceAll('<', '\\u003c')});` : ''}
})();</script>`;
}

function recordRows(records) {
  return records.map(r => `<div class="at-record"><p>${escape(date(r.requested_at))} · HTTP ${escape(r.status_code)}</p><p class="at-muted">${escape(r.trace_count)} 条日志 · ${escape(r.duration_ms)} ms</p><details><summary>查询条件</summary><p class="at-muted">${escape(r.filters_json)}</p></details></div>`).join('') || '<p class="at-muted">暂无调用记录</p>';
}

export function renderApiTokens({ accounts, records, token, error }) {
  const visible = new Set(accounts.map(a => a.account_id));
  const historical = records.filter(r => !visible.has(r.account_id));
  return `<section class="at-create"><div><h3>申请新 Token</h3><p class="at-muted">填写调用方名称，即可读取审计日志。</p></div>
${error ? `<p class="at-error" role="alert">${escape(error)}</p>` : ''}
<form method="post" action="/dashboard/api-tokens"><label>调用方名称<input name="name" required maxlength="80" placeholder="例如：研发审计 Agent"></label><button class="at-primary" type="submit">申请 Token</button></form>
${token ? `<div class="at-secret" role="status"><h3>已生成，请复制保存</h3><p class="at-muted">完整 Token 仅本次展示。</p><label>新 Token<input id="new-api-token" readonly value="${escape(token)}" autocomplete="off"></label><button class="at-primary" type="button" id="copy-api-token">复制 Token</button><span id="copy-result" role="status"></span></div>` : ''}
</section><section><h3>我的 Token</h3><div class="at-list">
${accounts.map(a => `<article class="at-card"><div class="at-card-top"><div><h3>${escape(a.name)}</h3><p class="at-muted">创建于 ${escape(date(a.created_at))}</p></div>${a.revoked_at ? '<span class="at-status">已停用</span>' : ''}</div>
<div class="at-actions"><form method="post" action="/dashboard/api-tokens/${escape(a.account_id)}/${a.revoked_at ? 'restore' : 'revoke'}"><button class="${a.revoked_at ? 'at-primary' : ''}">${a.revoked_at ? '恢复 Token' : '停用 Token'}</button></form><form method="post" action="/dashboard/api-tokens/${escape(a.account_id)}/delete" data-delete="true"><button class="at-danger">删除 Token</button></form></div>
<details><summary>调用记录</summary>${recordRows(records.filter(r => r.account_id === a.account_id))}</details></article>`).join('') || '<p class="at-empty">尚未申请 Token</p>'}
</div><p class="at-muted">调用记录展示最近 100 次访问，时间为北京时间。</p></section>
${historical.length ? `<details><summary>历史调用记录（已删除或未识别的调用方）</summary>${historical.map(r => `<div class="at-record"><h3>${escape(r.name ?? '未识别调用方')}</h3>${recordRows([r])}</div>`).join('')}</details>` : ''}`;
}
