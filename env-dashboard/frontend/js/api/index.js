import { apiClient } from './client.js';

export { socketMgr } from './socket.js';

export const authApi = {
  async login(username, password) {
    const res = await apiClient.request('POST', '/api/v1/auth/login', { body: { username, password }, auth: false });
    if (res?.data?.token) {
      apiClient.setToken(res.data.token);
      apiClient.setUser(res.data.user);
    }
    return res.data;
  },
  me() { return apiClient.get('/api/v1/auth/me'); },
  logout() { apiClient.setToken(null); apiClient.setUser(null); },
};

export const dashboardApi = {
  summary() { return apiClient.get('/api/v1/dashboard'); },
  readings(query) { return apiClient.get('/api/v1/readings', { query }); },
  history(query) { return apiClient.get('/api/v1/history', { query }); },
  historyBatch(query) { return apiClient.post('/api/v1/history/batch', query); },
};

export const stationApi = {
  list() { return apiClient.get('/api/v1/stations'); },
  meta() { return apiClient.get('/api/v1/stations/meta'); },
  create(body) { return apiClient.post('/api/v1/stations', body); },
};

export const anomalyApi = {
  list(query) { return apiClient.get('/api/v1/anomalies', { query }); },
  analytics(query) { return apiClient.get('/api/v1/analytics', { query }); },
};

export const alertApi = {
  list(query) { return apiClient.get('/api/v1/alerts', { query }); },
  stats() { return apiClient.get('/api/v1/alerts/stats'); },
  get(id) { return apiClient.get(`/api/v1/alerts/${encodeURIComponent(id)}`); },
  acknowledge(id) { return apiClient.post(`/api/v1/alerts/${encodeURIComponent(id)}/acknowledge`); },
  resolve(id) { return apiClient.post(`/api/v1/alerts/${encodeURIComponent(id)}/resolve`); },
  reopen(id) { return apiClient.post(`/api/v1/alerts/${encodeURIComponent(id)}/reopen`); },
  mute(id) { return apiClient.post(`/api/v1/alerts/${encodeURIComponent(id)}/mute`); },
  unmute(id) { return apiClient.post(`/api/v1/alerts/${encodeURIComponent(id)}/unmute`); },
  escalate(id) { return apiClient.post(`/api/v1/alerts/${encodeURIComponent(id)}/escalate`); },
  retry(id) { return apiClient.post(`/api/v1/alerts/${encodeURIComponent(id)}/retry`); },
};

export const providerApi = {
  async list() {
    try {
      const promise = apiClient.get('/api/v1/providers');
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Provider list timeout')), 2000)
      );
      const providers = await Promise.race([promise, timeoutPromise]);
      return providers;
    } catch (e) {
      console.warn('Provider list failed or timed out:', e.message);
      return [];
    }
  },
  get(id) { return apiClient.get(`/api/v1/providers/${encodeURIComponent(id)}`); },
  create(body) { return apiClient.post('/api/v1/providers', body); },
  save(id, body) { return apiClient.put(`/api/v1/providers/${encodeURIComponent(id)}`, body); },
  remove(id) { return apiClient.delete(`/api/v1/providers/${encodeURIComponent(id)}`); },
  test(id) { return apiClient.post(`/api/v1/providers/${encodeURIComponent(id)}/test`); },
  enable(id) { return apiClient.post(`/api/v1/providers/${encodeURIComponent(id)}/enable`); },
  disable(id) { return apiClient.post(`/api/v1/providers/${encodeURIComponent(id)}/disable`); },
  setPriority(id, priority) { return apiClient.post(`/api/v1/providers/${encodeURIComponent(id)}/priority`, { priority }); },
};

export const configApi = {
  getAll() { return apiClient.get('/api/v1/config'); },
  get(section) { return apiClient.get(`/api/v1/config/${encodeURIComponent(section)}`); },
  save(section, body) { return apiClient.put(`/api/v1/config/${encodeURIComponent(section)}`, body); },
  test(section) { return apiClient.post(`/api/v1/config/${encodeURIComponent(section)}/test`); },
  reset(section) { return apiClient.post(`/api/v1/config/${encodeURIComponent(section)}/reset`); },
  schema() { return apiClient.get('/api/v1/config/schema'); },
  getThresholds() { return apiClient.get('/api/v1/thresholds'); },
  saveThresholds(body) { return apiClient.put('/api/v1/thresholds', body); },
};

export const reportApi = {
  list(query) { return apiClient.get('/api/v1/reports', { query }); },
  get(id) { return apiClient.get(`/api/v1/reports/${encodeURIComponent(id)}`); },
  generate(body) { return apiClient.post('/api/v1/reports', body); },
  remove(id) { return apiClient.delete(`/api/v1/reports/${encodeURIComponent(id)}`); },
  downloadUrl(id) { return `/api/v1/reports/${encodeURIComponent(id)}/download?token=${encodeURIComponent(apiClient.getToken() || '')}`; },
};

export const qualityApi = {
  snapshot() { return apiClient.get('/api/v1/quality'); },
  issues() { return apiClient.get('/api/v1/quality/issues'); },
  history() { return apiClient.get('/api/v1/quality/history'); },
};

export const maintenanceApi = {
  list() { return apiClient.get('/api/v1/maintenance'); },
  history(stationId) { return apiClient.get(`/api/v1/maintenance/${encodeURIComponent(stationId)}`); },
};

export const mlApi = {
  status() { return apiClient.get('/api/v1/ml/status'); },
  metrics() { return apiClient.get('/api/v1/ml/metrics'); },
  performance() { return apiClient.get('/api/v1/ml/performance'); },
  confusion() { return apiClient.get('/api/v1/ml/confusion-matrix'); },
  roc() { return apiClient.get('/api/v1/ml/roc'); },
  features() { return apiClient.get('/api/v1/ml/features'); },
  drift() { return apiClient.get('/api/v1/ml/drift'); },
  latency() { return apiClient.get('/api/v1/ml/latency'); },
  threshold() { return apiClient.get('/api/v1/ml/threshold'); },
  runs() { return apiClient.get('/api/v1/ml/runs'); },
  validate() { return apiClient.post('/api/v1/ml/validate'); },
  retrain() { return apiClient.post('/api/v1/ml/retrain'); },
};

export const healthApi = {
  system() { return apiClient.get('/api/v1/system/health'); },
  components() { return apiClient.get('/api/v1/system/components'); },
  pipeline() { return apiClient.get('/api/v1/system/pipeline'); },
  metrics() { return apiClient.get('/api/v1/system/metrics'); },
  architecture() { return apiClient.get('/api/v1/architecture'); },
  dataFlow() { return apiClient.get('/api/v1/architecture/data-flow'); },
};

export const auditApi = {
  list(query) { return apiClient.get('/api/v1/audit', { query }); },
  get(id) { return apiClient.get(`/api/v1/audit/${encodeURIComponent(id)}`); },
};

export const assistantApi = {
  query(text) { return apiClient.post('/api/v1/assistant', { query: text }); },
  llmStatus() { return apiClient.get('/api/v1/assistant/llm-status'); },
};

export const notificationApi = {
  channels() { return apiClient.get('/api/v1/notifications/channels'); },
  upsert(body) { return apiClient.post('/api/v1/notifications/channels', body); },
  update(id, body) { return apiClient.put(`/api/v1/notifications/channels/${encodeURIComponent(id)}`, body); },
  remove(id) { return apiClient.delete(`/api/v1/notifications/channels/${encodeURIComponent(id)}`); },
  test(id) { return apiClient.post(`/api/v1/notifications/channels/${encodeURIComponent(id)}/test`); },
  enable(id) { return apiClient.post(`/api/v1/notifications/channels/${encodeURIComponent(id)}/enable`); },
  disable(id) { return apiClient.post(`/api/v1/notifications/channels/${encodeURIComponent(id)}/disable`); },
  history(query) { return apiClient.get('/api/v1/notifications/history', { query }); },
  retry(alertId) { return apiClient.post(`/api/v1/notifications/alerts/${encodeURIComponent(alertId)}/retry`); },
  deadLetter() { return apiClient.get('/api/v1/notifications/dead-letter'); },
};

export const intelligenceApi = {
  situation() { return apiClient.get('/api/v1/intelligence/situation'); },
  whatChanged(minutes = 60) { return apiClient.get('/api/v1/intelligence/what-changed', { query: { minutes } }); },
  why(query = {}) { return apiClient.get('/api/v1/intelligence/why', { query }); },
  whatNext(query = {}) { return apiClient.get('/api/v1/intelligence/what-next', { query }); },
  whatToDo() { return apiClient.get('/api/v1/intelligence/what-to-do'); },
};

export const eventsApi = {
  list(query = {}) { return apiClient.get('/api/v1/events', { query }); },
  get(id) { return apiClient.get(`/api/v1/events/${encodeURIComponent(id)}`); },
  meta() { return apiClient.get('/api/v1/events/meta'); },
};

export const searchApi = {
  search(q) { return apiClient.get('/api/v1/search', { query: { q } }); },
};

export const stationIntelApi = {
  detail(id) { return apiClient.get(`/api/v1/stations/${encodeURIComponent(id)}`); },
  telemetry(id) { return apiClient.get(`/api/v1/stations/${encodeURIComponent(id)}/telemetry`); },
  history(id, query = {}) { return apiClient.get(`/api/v1/stations/${encodeURIComponent(id)}/history`, { query }); },
  health(id) { return apiClient.get(`/api/v1/stations/${encodeURIComponent(id)}/health`); },
  anomalies(id, query = {}) { return apiClient.get(`/api/v1/stations/${encodeURIComponent(id)}/anomalies`, { query }); },
  alerts(id, query = {}) { return apiClient.get(`/api/v1/stations/${encodeURIComponent(id)}/alerts`, { query }); },
  maintenance(id) { return apiClient.get(`/api/v1/stations/${encodeURIComponent(id)}/maintenance`); },
  comparison(id, query = {}) { return apiClient.get(`/api/v1/stations/${encodeURIComponent(id)}/comparison`, { query }); },
  timeline(id) { return apiClient.get(`/api/v1/stations/${encodeURIComponent(id)}/timeline`); },
  decisionTrace(id) { return apiClient.get(`/api/v1/stations/${encodeURIComponent(id)}/decision-trace`); },
  environmental(id, query = {}) { return apiClient.get(`/api/v1/stations/${encodeURIComponent(id)}/environmental`, { query }); },
  intelligence(id) { return apiClient.get(`/api/v1/stations/${encodeURIComponent(id)}/intelligence`); },
  forecast(id, query = {}) { return apiClient.get(`/api/v1/forecast/${encodeURIComponent(id)}`, { query }); },
  lineAge(id, reading) { return Promise.resolve({ stationId: id, reading, lineage: buildLineage(reading) }); },
};

function buildLineage(reading) {
  if (!reading) return [];
  const t = reading.time || new Date().toISOString();
  return [
    { stage: 'SOURCE', detail: 'Simulated sensor cluster', ts: t },
    { stage: 'INGESTION', detail: 'Sensor tick', ts: t },
    { stage: 'VALIDATION', detail: 'Schema + range checks', ts: t, ts2: new Date(new Date(t).getTime() + 5).toISOString() },
    { stage: 'NORMALIZATION', detail: 'Units, timezone', ts: t, ts2: new Date(new Date(t).getTime() + 8).toISOString() },
    { stage: 'STORAGE', detail: 'MemoryStore / Influx / Postgres', ts: t, ts2: new Date(new Date(t).getTime() + 12).toISOString() },
    { stage: 'ANALYSIS', detail: 'paramCode + ML', ts: t, ts2: new Date(new Date(t).getTime() + 20).toISOString() },
    { stage: 'API', detail: 'GET /api/v1/stations', ts: t, ts2: new Date(new Date(t).getTime() + 22).toISOString() },
    { stage: 'UI', detail: 'Rendered', ts: t, ts2: new Date(new Date(t).getTime() + 24).toISOString() },
  ];
}

export const advancedAnalyticsApi = {
  comprehensive(query = {}) { return apiClient.get('/api/v1/analytics/advanced', { query }); },
  correlation(query = {}) { return apiClient.get('/api/v1/analytics/correlation', { query }); },
  baselines(query = {}) { return apiClient.get('/api/v1/analytics/baselines', { query }); },
  spatial(query = {}) { return apiClient.get('/api/v1/analytics/spatial', { query }); },
  trends(query = {}) { return apiClient.get('/api/v1/analytics/trends', { query }); },
  summary(query = {}) { return apiClient.get('/api/v1/analytics/summary', { query }); },
  compare(query = {}) { return apiClient.get('/api/v1/analytics/compare', { query }); },
  ranking(query = {}) { return apiClient.get('/api/v1/analytics/ranking', { query }); },
  risk(query = {}) { return apiClient.get('/api/v1/analytics/risk', { query }); },
  exportData(query = {}) { return `/api/v1/analytics/export?${new URLSearchParams(query).toString()}`; },
};

export const correlationApi = {
  correlated(query = {}) { return apiClient.get('/api/v1/alerts/correlated', { query }); },
};

export const investigationApi = {
  list(query = {}) { return apiClient.get('/api/v1/investigations', { query }); },
  get(id) { return apiClient.get(`/api/v1/investigations/${encodeURIComponent(id)}`); },
  create(body) { return apiClient.post('/api/v1/investigations', body); },
  transition(id, state, notes) { return apiClient.post(`/api/v1/investigations/${encodeURIComponent(id)}/transition`, { state, notes }); },
  addNote(id, notes) { return apiClient.post(`/api/v1/investigations/${encodeURIComponent(id)}/notes`, { notes }); },
  getEvidenceSources(id) { return apiClient.get(`/api/v1/investigations/${encodeURIComponent(id)}/evidence/sources`); },
  addEvidence(id, evidence) { return apiClient.post(`/api/v1/investigations/${encodeURIComponent(id)}/evidence`, evidence); },
  addFinding(id, finding) { return apiClient.post(`/api/v1/investigations/${encodeURIComponent(id)}/findings`, finding); },
  setSources(id, sources) { return apiClient.post(`/api/v1/investigations/${encodeURIComponent(id)}/sources`, { sources }); },
  addAction(id, action) { return apiClient.post(`/api/v1/investigations/${encodeURIComponent(id)}/actions`, action); },
  getAction(id, actionId) { return apiClient.get(`/api/v1/investigations/${encodeURIComponent(id)}/actions/${encodeURIComponent(actionId)}`); },
  setRecommendations(id, recommendations) { return apiClient.post(`/api/v1/investigations/${encodeURIComponent(id)}/recommendations`, { recommendations }); },
  setConfidence(id, confidence) { return apiClient.post(`/api/v1/investigations/${encodeURIComponent(id)}/confidence`, confidence); },
  verify(id) { return apiClient.post(`/api/v1/investigations/${encodeURIComponent(id)}/verify`); },
  advanceStage(id, stage, detail) { return apiClient.post(`/api/v1/investigations/${encodeURIComponent(id)}/stage`, { stage, detail }); },
  start(id, notes) { return apiClient.post(`/api/v1/investigations/${encodeURIComponent(id)}/start`, { notes }); },
  close(id, notes) { return apiClient.post(`/api/v1/investigations/${encodeURIComponent(id)}/close`, { notes }); },
  reopen(id, notes) { return apiClient.post(`/api/v1/investigations/${encodeURIComponent(id)}/reopen`, { notes }); },
};

export const assistantV2Api = {
  query(text) { return apiClient.post('/api/v1/assistant/v2', { query: text }); },
};

export const agentApi = {
  status() { return apiClient.get('/api/v1/agent/supervisor'); },
  tasks() { return apiClient.get('/api/v1/agent/tasks'); },
  task(id) { return apiClient.get(`/api/v1/agent/tasks/${encodeURIComponent(id)}`); },
  timeline(taskId) { return apiClient.get(`/api/v1/agent/timeline/${encodeURIComponent(taskId)}`); },
  summary(taskId) { return apiClient.get(`/api/v1/agent/task-summary/${encodeURIComponent(taskId)}`); },
  memory() { return apiClient.get('/api/v1/agent/memory'); },
  proposals() { return apiClient.get('/api/v1/approval/proposals'); },
  approveProposal(id) { return apiClient.post(`/api/v1/approval/proposals/${encodeURIComponent(id)}/approve`); },
  rejectProposal(id, reason) { return apiClient.post(`/api/v1/approval/proposals/${encodeURIComponent(id)}/reject`, { reason }); },
  verifyLast() { return apiClient.get('/api/v1/verification/last'); },
  tools() { return apiClient.get('/api/v1/agent/tools'); },
  investigate(body) { return apiClient.post('/api/v1/monitoring/investigate', body); },
};

export const ragApi = {
  documents() { return apiClient.get('/api/v1/rag/documents'); },
  stats() { return apiClient.get('/api/v1/rag/stats'); },
  search(query, params = {}) { return apiClient.get('/api/v1/rag/search', { query: { q: query, ...params } }); },
  ingest(body) { return apiClient.post('/api/v1/rag/documents', body); },
  reindex() { return apiClient.post('/api/v1/rag/reindex'); },
};

export const monitoringApi = {
  status() { return apiClient.get('/api/v1/monitoring/status'); },
  snapshot() { return apiClient.get('/api/v1/monitoring/snapshot'); },
  history() { return apiClient.get('/api/v1/monitoring/snapshot-history'); },
  events(query = {}) { return apiClient.get('/api/v1/monitoring/events', { query }); },
  brief() { return apiClient.get('/api/v1/monitoring/brief'); },
};
