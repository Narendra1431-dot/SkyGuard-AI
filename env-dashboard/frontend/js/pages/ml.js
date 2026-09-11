import { mlApi } from '../api/index.js';
import { escapeHtml, statusBadge, loadingState, errorState, formatNumber, formatDateTime, toast } from '../utils/ui.js';

let cmChart, rocChart, featChart;

export const mlPage = {
  id: 'ml', title: 'Machine Learning', sub: 'Status, metrics, and run history for anomaly classification.', group: 'System', icon: 'fa-solid fa-brain',
  async render(root) {
    root.innerHTML = `
      <div class="card">
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;">
          <span id="ml-status"></span>
          <button class="btn" id="ml-validate"><i class="fa-solid fa-flask"></i> Validate</button>
          <button class="btn danger" id="ml-retrain"><i class="fa-solid fa-rotate"></i> Retrain</button>
          <button class="btn secondary" id="ml-refresh" style="margin-left:auto;"><i class="fa-solid fa-rotate"></i> Refresh</button>
        </div>
        <div class="grid grid-4" id="ml-kpis">${loadingState()}</div>
      </div>
      <div class="grid grid-2" style="margin-top:14px;">
        <div class="card"><h3>Confusion matrix</h3><canvas id="ml-cm" height="160"></canvas></div>
        <div class="card"><h3>ROC</h3><canvas id="ml-roc" height="160"></canvas></div>
      </div>
      <div class="card" style="margin-top:14px;"><h3>Feature importance</h3><canvas id="ml-feat" height="120"></canvas></div>
      <div class="card" style="margin-top:14px;"><h3>Drift & threshold</h3><div id="ml-drift">${loadingState()}</div></div>
      <div class="card" style="margin-top:14px;"><h3>Run history</h3><div id="ml-runs">${loadingState()}</div></div>
    `;
    document.getElementById('ml-validate').onclick = async (b) => { b.disabled = true; try { await mlApi.validate(); toast('Validation triggered', 'success'); await load(); } catch (e) { toast(e.message, 'error'); } finally { b.disabled = false; } };
    document.getElementById('ml-retrain').onclick = async (b) => { b.disabled = true; try { await mlApi.retrain(); toast('Retrain triggered', 'success'); await load(); } catch (e) { toast(e.message, 'error'); } finally { b.disabled = false; } };
    document.getElementById('ml-refresh').onclick = load;
    await load();
    return () => destroy();
  },
};

function destroy() { for (const c of [cmChart, rocChart, featChart]) { try { c?.destroy(); } catch {} } cmChart = rocChart = featChart = null; }

async function load() {
  try {
    const [status, cm, roc, feat, drift, runs] = await Promise.all([mlApi.status(), mlApi.confusion(), mlApi.roc(), mlApi.features(), mlApi.drift(), mlApi.runs()]);
    const m = status.metrics || {};
    const tr = status.threshold || {};
    const badgeLabel = status.evaluationStatus === 'UNVERIFIED' ? 'UNVERIFIED' : (status.status || 'IDLE');
    const modelType = status.modelType || 'UNKNOWN';
    const isTrained = modelType === 'LOGISTIC_REGRESSION';
    const modelLabel = isTrained ? 'LOGISTIC_REGRESSION' : (modelType === 'RULE_BASED_DETECTOR' ? 'RULE_BASED' : 'NO_MODEL');
    const evalNote = status.evaluationStatus === 'UNVERIFIED'
      ? '<span class="state warning">Evaluation: unverified — no independent labeled evaluation data. Upload labeled samples to eval.jsonl to verify.</span>'
      : (status.independentEval ? '<span class="state ok">Evaluation: verified on independent labeled data.</span>' : '');
    document.getElementById('ml-status').innerHTML = `Model: <strong>${escapeHtml(modelLabel)}</strong> ${statusBadge(badgeLabel)}${evalNote ? '<br>' + evalNote : ''}`;
    if (!status.metrics) {
      const isTrained = status.modelType === 'LOGISTIC_REGRESSION';
      document.getElementById('ml-kpis').innerHTML = `
        ${card('Status', status.status || 'IDLE', isTrained ? 'green' : 'gray')}
        ${card('Model', isTrained ? 'Trained' : (status.modelType === 'RULE_BASED_DETECTOR' ? 'Rule-based' : 'Not trained'), isTrained ? 'green' : 'gray')}
        ${card('Last run', status.completedAt || '—', 'gray')}
        ${card('Threshold', tr.state || 'UNKNOWN', 'gray')}
        ${card('Notes', status.notes || (isTrained ? 'No evaluation run yet' : 'Run retrain to train the ML model'), 'gray')}
      `;
      document.getElementById('ml-cm').replaceWith(grayCanvas('ml-cm'));
      document.getElementById('ml-roc').replaceWith(grayCanvas('ml-roc'));
      document.getElementById('ml-feat').replaceWith(grayCanvas('ml-feat'));
      document.getElementById('ml-drift').innerHTML = `<div class="state empty">${isTrained ? 'No drift data. Run validation to compute drift.' : 'No trained model. Click Retrain to train the ML model.'}</div>`;
    } else {
      document.getElementById('ml-kpis').innerHTML = `
        ${card('Accuracy', formatNumber(m.accuracy*100,1)+'%', m.accuracy >= 0.9 ? 'green' : m.accuracy >= 0.7 ? 'yellow' : 'red')}
        ${card('Precision', formatNumber(m.precision*100,1)+'%', 'blue')}
        ${card('Recall', formatNumber(m.recall*100,1)+'%', 'blue')}
        ${card('F1', formatNumber(m.f1*100,1)+'%', 'blue')}
        ${card('AUC', formatNumber(m.auc,3), 'blue')}
        ${card('Samples', m.samples || 0, 'gray')}
        ${card('Latency (ms/sample)', status.latency?.perSampleMs ?? '—', 'gray')}
        ${card('Drift score', drift.score + '%', drift.score > 20 ? 'red' : 'yellow')}
      `;
      destroy();
      cmChart = drawMatrix('ml-cm', cm);
      rocChart = drawRoc('ml-roc', roc);
      featChart = drawFeatures('ml-feat', feat);
      document.getElementById('ml-drift').innerHTML = `
        <div style="margin-bottom:8px;">${statusBadge(tr.state || 'UNKNOWN')} Threshold: ${tr.threshold} (recommended ${tr.recommended})</div>
        <table><thead><tr><th>Field</th><th>Previous</th><th>Recent</th><th>Drift %</th></tr></thead><tbody>${Object.entries(drift.perField || {}).map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${v.previous}</td><td>${v.recent}</td><td>${v.driftPct}%</td></tr>`).join('')}</tbody></table>
      `;
    }
    const rh = document.getElementById('ml-runs');
    if (!runs.length) rh.innerHTML = '<div class="state empty">No runs yet.</div>';
    else rh.innerHTML = `<table><thead><tr><th>ID</th><th>Status</th><th>Started</th><th>Completed</th><th>Requested by</th><th>Accuracy</th></tr></thead><tbody>${runs.map((r) => `<tr><td><small>${escapeHtml(r.id)}</small></td><td>${statusBadge(r.status)}</td><td>${formatDateTime(r.startedAt)}</td><td>${formatDateTime(r.completedAt)}</td><td>${escapeHtml(r.requestedBy || '—')}</td><td>${r.metrics?.accuracy != null ? (r.metrics.accuracy*100).toFixed(1)+'%' : '—'}</td></tr>`).join('')}</tbody></table>`;
  } catch (e) { document.getElementById('ml-kpis').innerHTML = errorState(e.message); }
}

function card(l, v, c) { return `<div class="stat-card ${c}"><div class="lbl">${escapeHtml(l)}</div><div class="val">${escapeHtml(String(v))}</div></div>`; }
function grayCanvas(id) { const c = document.createElement('canvas'); c.id = id; return c; }

function drawMatrix(id, cm) {
  const ctx = document.getElementById(id); if (!ctx) return null;
  const matrix = (cm && cm.matrix) || [[0,0],[0,0]];
  return new Chart(ctx, { type: 'bar', data: { labels: ['Pred neg','Pred pos'], datasets: [{ label: 'Actual neg', data: matrix[0], backgroundColor: '#22c55e' }, { label: 'Actual pos', data: matrix[1], backgroundColor: '#ef4444' }] }, options: { animation: false, plugins: { legend: { labels: { color: '#94a3b8' } } }, scales: { x: { ticks: { color: '#94a3b8' }, grid: { color: '#1e293b' } }, y: { ticks: { color: '#64748b' }, grid: { color: '#1e293b' } } } } });
}
function drawRoc(id, roc) {
  const ctx = document.getElementById(id); if (!ctx) return null;
  const pts = (roc && roc.points) || [];
  return new Chart(ctx, { type: 'line', data: { datasets: [{ label: `ROC (AUC ${roc?.auc ?? '—'})`, data: pts.map((p) => ({ x: p.fpr, y: p.tpr })), borderColor: '#60a5fa', backgroundColor: '#60a5fa22', fill: true, tension: 0.3, pointRadius: 2 }] }, options: { animation: false, plugins: { legend: { labels: { color: '#94a3b8' } } }, scales: { x: { type: 'linear', min: 0, max: 1, title: { display: true, text: 'FPR', color: '#64748b' }, ticks: { color: '#64748b' }, grid: { color: '#1e293b' } }, y: { min: 0, max: 1, title: { display: true, text: 'TPR', color: '#64748b' }, ticks: { color: '#64748b' }, grid: { color: '#1e293b' } } } } });
}
function drawFeatures(id, feat) {
  const ctx = document.getElementById(id); if (!ctx) return null;
  const rows = (feat || []).slice(0, 12);
  return new Chart(ctx, { type: 'bar', data: { labels: rows.map((f) => f.name), datasets: [{ data: rows.map((f) => f.importance), backgroundColor: '#60a5fa' }] }, options: { indexAxis: 'y', animation: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: '#64748b' }, grid: { color: '#1e293b' } }, y: { ticks: { color: '#94a3b8' }, grid: { color: '#1e293b' } } } } });
}
