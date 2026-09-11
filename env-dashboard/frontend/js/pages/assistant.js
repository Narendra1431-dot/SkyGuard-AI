import { assistantApi, assistantV2Api, stationApi, eventsApi } from '../api/index.js';
import { escapeHtml, loadingState, errorState, formatDateTime, statusBadge } from '../utils/ui.js';

const SUGGESTIONS = [
  'What is happening right now?',
  'Which stations are critical?',
  'What changed in the last hour?',
  'Which provider is failing?',
  'What should I investigate first?',
  'Which stations need maintenance?',
  'What is the current AQI in Delhi?',
];

export const assistantPage = {
  id: 'assistant', title: 'AI Assistant', sub: 'Operational copilot grounded in live fleet data. Asks return real evidence.', group: 'System', icon: 'fa-solid fa-robot',
  async render(root) {
    root.innerHTML = `
      <div class="grid grid-3" style="margin-bottom:14px;">
        <div class="card">
          <h3>Suggested questions</h3>
          <div id="as-suggestions"></div>
        </div>
        <div class="card" style="grid-column:span 2;">
          <h3>Recent activity</h3>
          <div id="as-events" class="event-log" style="max-height:200px;"></div>
        </div>
      </div>
      <div class="card" style="display:flex;flex-direction:column;height:calc(100vh - 320px);">
        <div id="as-log" style="flex:1;overflow-y:auto;padding:8px;background:#050a14;border-radius:8px;border:1px solid #1e293b;margin-bottom:8px;"></div>
        <form id="as-form" style="display:flex;gap:8px;">
          <input id="as-input" class="input" placeholder="Ask the operational copilot… (e.g. What is happening right now?)" />
          <button class="btn" type="submit">Send</button>
        </form>
      </div>
    `;
    const log = document.getElementById('as-log');
    log.innerHTML = `<div class="state empty" style="text-align:left;">Hi — I'm the SkyGuard operational copilot. Ask about the current situation, critical stations, recent changes, providers, maintenance, or anomalies.</div>`;
    const sug = document.getElementById('as-suggestions');
    sug.innerHTML = SUGGESTIONS.map((s) => `<button class="btn compact ghost" data-q="${escapeHtml(s)}" style="width:100%;justify-content:flex-start;margin-bottom:4px;">${escapeHtml(s)}</button>`).join('');
    sug.querySelectorAll('[data-q]').forEach((b) => b.onclick = () => {
      document.getElementById('as-input').value = b.dataset.q;
      document.getElementById('as-form').requestSubmit();
    });

    const form = document.getElementById('as-form');
    const input = document.getElementById('as-input');
    let inFlight = false;
    let lastQuery = '';
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (inFlight) return;
      const q = input.value.trim(); if (!q) return;
      if (q === lastQuery) return;
      inFlight = true;
      lastQuery = q;
      input.disabled = true;
      const btn = form.querySelector('button[type="submit"]');
      btn.disabled = true;
      input.value = '';
      append(log, q, 'user');
      const placeholder = append(log, '…', 'bot');
      try {
        const r = await assistantV2Api.query(q);
        renderBot(log, placeholder, r);
      } catch (e2) {
        try {
          const fallback = await assistantApi.query(q);
          placeholder.querySelector('.text').textContent = fallback.text || e2.message;
        } catch (_) {
          placeholder.querySelector('.text').innerHTML = `<span class="state error">${escapeHtml(e2.message)}</span>`;
        }
      }
      log.scrollTop = log.scrollHeight;
      inFlight = false;
      input.disabled = false;
      btn.disabled = false;
    });

    try {
      const events = await eventsApi.list({ limit: 12 });
      const eh = document.getElementById('as-events');
      if (events.length) {
        eh.innerHTML = events.map((e) => `<div class="event"><span class="time">${formatDateTime(e.timestamp)}</span><span class="badge ${e.severity === 'info' ? 'blue' : e.severity === 'warning' ? 'yellow' : 'red'}" style="min-width:80px;justify-content:center;">${escapeHtml(e.category)}</span><span><strong>${escapeHtml(e.title)}</strong></span></div>`).join('');
      } else { eh.innerHTML = '<div class="state empty">No events yet.</div>'; }
    } catch (_) {}

    return () => {};
  },
};

function append(log, text, who) {
  const div = document.createElement('div');
  div.style.cssText = 'margin:6px 0;padding:8px 10px;border-radius:6px;max-width:80%;';
  div.style.background = who === 'user' ? '#1d4ed8' : '#111827';
  div.style.color = '#e2e8f0';
  div.style.marginLeft = who === 'user' ? 'auto' : '0';
  div.innerHTML = `<div class="text">${escapeHtml(text)}</div>`;
  log.appendChild(div);
  return div;
}

function renderBot(log, placeholder, reply) {
  const intent = reply.intent ? `<div class="muted" style="font-size:11px;margin-top:4px;">intent: ${escapeHtml(reply.intent)}</div>` : '';
  const llmStatus = reply.llmStatus ? `<div class="muted" style="font-size:11px;margin-top:4px;">LLM: ${escapeHtml(reply.llmStatus)}${reply.llmProvider ? ' (' + escapeHtml(reply.llmProvider) + ')' : ''}${reply.llmMode ? ' mode=' + escapeHtml(reply.llmMode) : ''}</div>` : '';
  const evidence = reply.evidence ? `<details style="margin-top:6px;font-size:11px;color:#94a3b8;"><summary>Evidence</summary><pre style="white-space:pre-wrap;font-size:11px;">${escapeHtml(JSON.stringify(reply.evidence, null, 2))}</pre></details>` : '';
  placeholder.innerHTML = `<div class="text">${escapeHtml(reply.text || '—')}</div>${llmStatus}${intent}${evidence}`;
}