'use strict';

const state = { csrf: null, selectedJob: null };

function el(id) { return document.getElementById(id); }

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (state.csrf) headers['x-csrf-token'] = state.csrf;
  if (opts.body && typeof opts.body !== 'string') {
    opts = { ...opts, body: JSON.stringify(opts.body) };
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) { showLogin(); throw new Error('authentication required'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function mutation(path, body) {
  return api(path, { method: 'POST', body: body ?? {} });
}

function showLogin() {
  el('login-view').classList.remove('hidden');
  el('app-view').classList.add('hidden');
}

async function login(password) {
  const res = await fetch('/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { el('login-error').textContent = data.error || 'login failed'; return false; }
  state.csrf = data.csrfToken;
  el('login-view').classList.add('hidden');
  el('app-view').classList.remove('hidden');
  await refreshAll();
  return true;
}

async function refreshAll() {
  await Promise.all([loadSummary(), loadJobs()]);
  if (state.selectedJob) await loadJob(state.selectedJob);
}

async function loadSummary() {
  const data = await api('/api/summary');
  const grid = el('summary');
  grid.innerHTML = '';

  // Stat counters.
  for (const [label, value] of Object.entries(data.summary)) {
    const div = document.createElement('div');
    div.className = 'stat';
    div.innerHTML = `<b>${value}</b><span>${escapeHtml(label)}</span>`;
    grid.appendChild(div);
  }

  // Provider mode indicators (MOCK/TEST/LIVE must be unambiguous).
  const modes = data.providerModes || {};
  const modeBar = document.createElement('div');
  modeBar.className = 'mode-bar';
  const indicators = [
    ['system', modes.system ?? '?'],
    ['ollama', data.ollamaStatus ?? 'unknown'],
    ['email', modes.email ?? 'mock'],
    ['outbound', modes.outbound ?? 'disabled'],
    ['payment', modes.payment ?? 'mock'],
    ['deployment', modes.deployment ?? 'local'],
  ];
  for (const [key, mode] of indicators) {
    const chip = document.createElement('span');
    const value = String(mode);
    const live = value === 'live' || value === 'stripe_live' || value === 'cloudflare' || value === 'production';
    chip.className = 'mode-chip' + (live ? ' live' : '');
    chip.textContent = `${key}: ${value}`;
    modeBar.appendChild(chip);
  }
  grid.appendChild(modeBar);
  setToggle(el('btn-kill'), 'Kill switch', data.settings.killSwitch);
  setToggle(el('btn-pause'), 'Pause', data.settings.automationPaused);
  el('btn-kill').classList.toggle('armed', data.settings.killSwitch);
  el('btn-pause').classList.toggle('armed', data.settings.automationPaused);
}

function setToggle(btn, label, on) {
  btn.textContent = `${label}: ${on ? 'ON' : 'off'}`;
}

async function loadJobs() {
  const data = await api('/api/jobs');
  const list = el('job-list');
  list.innerHTML = '';
  for (const job of data.jobs) {
    const li = document.createElement('li');
    li.className = job.jobId === state.selectedJob ? 'active' : '';
    li.innerHTML = `<strong>${escapeHtml(job.businessName || '(unnamed)')}</strong>
      <span class="state">${job.state} · score ${job.score ?? '—'}</span>`;
    li.addEventListener('click', () => { state.selectedJob = job.jobId; loadJobs(); loadJob(job.jobId); });
    list.appendChild(li);
  }
}

async function loadJob(jobId) {
  let data;
  try {
    data = await api(`/api/jobs/${jobId}`);
  } catch (err) {
    el('detail').innerHTML = `<p class="error">${escapeHtml(String(err))}</p>`;
    return;
  }
  const msg = (m) => escapeHtml(m || '');
  const detail = el('detail');
  const rows = [];
  const row = (k, v) => rows.push(`<tr><th>${k}</th><td>${v}</td></tr>`);
  row('State', `<span class="badge">${data.job.state}</span> (revisions: ${data.job.revisionCycles})`);
  row('Business', msg(data.business.name));
  row('Website', data.lead.websiteUrl ? `<a href="${msg(data.lead.websiteUrl)}" target="_blank" rel="noopener noreferrer">${msg(data.lead.websiteUrl)}</a>` : '—');
  row('Contact', msg(data.lead.contactEmail || '—'));
  row('Score', data.lead.score !== null ? `${data.lead.score} (confidence ${data.lead.confidence ?? '—'})` : '—');
  const payment = data.payment ? `${data.payment.status} · ${data.payment.tier} · ${(data.payment.amountCents / 100).toFixed(2)} ${data.payment.currency}` : '—';
  row('Payment', msg(payment));
  const preview = (data.deployments || []).filter((d) => d.kind === 'preview' && d.status === 'deployed').pop();
  const production = (data.deployments || []).filter((d) => d.kind === 'production' && d.status === 'deployed').pop();
  row('Preview', preview ? `<a href="${msg(preview.url)}" target="_blank" rel="noopener noreferrer">${msg(preview.url)}</a>` : '—');
  row('Production', production ? `<a href="${msg(production.url)}" target="_blank" rel="noopener noreferrer">${msg(production.url)}</a>` : '—');

  const reviews = (data.reviews || []).map((r) => `<div><span class="badge ${r.verdict === 'PASS' ? 'ok' : 'warn'}">cycle ${r.cycle}: ${r.verdict}</span></div>`).join('') || '—';
  const requirements = (data.requirements || []).map((r) => `<li>[${r.category}] ${msg(r.title)} — ${msg(r.detail)}</li>`).join('') || '<li>none</li>';
  const messages = (data.messages || []).map((m) => `<tr><td>${m.direction}</td><td>${msg(m.sender)}</td><td>${msg(m.bodyText).slice(0, 220)}</td><td>${msg(m.createdAt)}</td></tr>`).join('') || '';
  const audit = (data.audit || []).slice(-30).map((a) => `<tr><td>${msg(a.at)}</td><td>${msg(a.action)}</td><td>${msg(a.actor)}</td></tr>`).join('');

  detail.innerHTML = `
    <h2>${msg(data.business.name)} <span class="badge">${data.job.state}</span></h2>
    <table>${rows.join('')}</table>

    <div class="actions">
      ${data.job.state === 'LEAD_DISCOVERED' ? `<button data-act="research">Run research</button>` : ''}
      ${data.job.state === 'READY_FOR_OUTREACH' ? `<button data-act="draft">Draft outreach</button>` : ''}
      ${data.latestDraft && data.latestDraft.status === 'pending' ? `
        <button data-act="approve" class="ok">Approve outreach</button>
        <button data-act="reject" class="warn">Reject draft</button>` : ''}
      ${data.job.state === 'READY_TO_BUILD' || data.job.state === 'REVISION_REQUIRED' ? `<button data-act="build">${data.job.state === 'READY_TO_BUILD' ? 'Build website' : 'Run revision'}</button>` : ''}
      ${data.job.state === 'REVIEWING' ? `<button data-act="review">Run review</button>` : ''}
      ${data.job.state === 'PREVIEW_READY' ? `<button data-act="deploy-preview">Deploy + send preview</button>` : ''}
      ${data.job.state === 'CLIENT_APPROVED' ? `<button data-act="payment">Create payment request</button>` : ''}
      ${data.job.state === 'READY_FOR_PRODUCTION' ? `<button data-act="deploy-production" class="ok">Deploy production</button>` : ''}
      ${!['COMPLETED', 'OPTED_OUT', 'LEAD_REJECTED'].includes(data.job.state) ? `<button data-act="optout" class="warn">Opt out / suppress</button>` : ''}
      ${!['COMPLETED', 'OPTED_OUT', 'LEAD_REJECTED'].includes(data.job.state) ? `<button data-act="needs-review" class="warn">Force human review</button>` : ''}
    </div>
    <p class="msg" id="action-msg"></p>

    <h3>Latest draft</h3>
    <div>${data.latestDraft ? `<b>${msg(data.latestDraft.subject)}</b> <span class="badge">${data.latestDraft.status}</span><pre>${msg(data.latestDraft.bodyText)}</pre>` : '—'}</div>

    <h3>Requirements</h3><ul>${requirements}</ul>
    <h3>Reviews</h3><div>${reviews}</div>
    <h3>Conversation</h3>
    <table><tr><th>Dir</th><th>Sender</th><th>Body</th><th>At</th></tr>${messages}</table>
    <h3>Audit history</h3>
    <table><tr><th>At</th><th>Action</th><th>Actor</th></tr>${audit}</table>
  `;

  detail.querySelectorAll('button[data-act]').forEach((btn) => {
    btn.addEventListener('click', () => runAction(jobId, btn.dataset.act, btn, data.latestDraft));
  });
}

async function runAction(jobId, action, btn, latestDraft) {
  btn.disabled = true;
  el('action-msg').textContent = 'Working…';
  try {
    switch (action) {
      case 'research': await mutation(`/api/jobs/${jobId}/research`); break;
      case 'optout': await mutation(`/api/jobs/${jobId}/transition`, { to: 'OPTED_OUT', reason: 'owner opt-out' }); break;
      case 'draft': await mutation(`/api/jobs/${jobId}/draft-outreach`); break;
      case 'approve': await mutation(`/api/outreach/drafts/${latestDraft.id}/approve`); break;
      case 'reject': await mutation(`/api/outreach/drafts/${latestDraft.id}/reject`); break;
      case 'build': await mutation(`/api/jobs/${jobId}/build`); break;
      case 'review': await mutation(`/api/jobs/${jobId}/review`); break;
      case 'deploy-preview': await mutation(`/api/jobs/${jobId}/deploy-preview`); break;
      case 'payment': await mutation(`/api/jobs/${jobId}/payment-request`, { tier: 'starter' }); break;
      case 'deploy-production': await mutation(`/api/jobs/${jobId}/deploy-production`); break;
      case 'needs-review': await mutation(`/api/jobs/${jobId}/transition`, { to: 'NEEDS_HUMAN_REVIEW', reason: 'owner forced review' }); break;
      default: throw new Error('unknown action');
    }
    el('action-msg').textContent = 'Done.';
  } catch (err) {
    el('action-msg').textContent = `Failed: ${err.message}`;
  } finally {
    btn.disabled = false;
    await refreshAll();
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

el('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  await login(el('login-password').value);
});

el('import-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  const payload = {};
  for (const [k, v] of form.entries()) if (v) payload[k] = v;
  try {
    await mutation('/api/leads/import', payload);
    e.target.reset();
    await refreshAll();
  } catch (err) {
    alert(`Import failed: ${err.message}`);
  }
});

el('btn-kill').addEventListener('click', async () => {
  const summary = await api('/api/summary');
  await mutation('/api/settings', { killSwitch: !summary.settings.killSwitch });
  await loadSummary();
});

el('btn-pause').addEventListener('click', async () => {
  const summary = await api('/api/summary');
  await mutation('/api/settings', { paused: !summary.settings.automationPaused });
  await loadSummary();
});

el('btn-logout').addEventListener('click', async () => {
  await fetch('/logout', { method: 'POST' });
  showLogin();
});

// Auto-detect an existing session.
fetch('/api/summary').then((res) => {
  if (res.status === 401) { showLogin(); return null; }
  return api('/api/csrf').then(async (d) => {
    state.csrf = d.csrfToken;
    el('login-view').classList.add('hidden');
    el('app-view').classList.remove('hidden');
    await refreshAll();
  });
}).catch(showLogin);
