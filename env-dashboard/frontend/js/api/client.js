// Centralized API client for SkyGuard backend.
// All pages import from here; no direct fetch scattered through the UI.

const TOKEN_KEY = 'skyguard.token';
const USER_KEY = 'skyguard.user';

// Single-origin deployment: the backend serves the SPA and /api together, so
// requests resolve against the current origin. For a separately-served SPA,
// set window.SKYGUARD_API_BASE to the backend origin (e.g. http://localhost:4000)
// in a script tag BEFORE /js/main.js loads. Default keeps same-origin behavior.
const API_BASE = (typeof window !== 'undefined' && window.SKYGUARD_API_BASE) || (typeof window !== 'undefined' ? window.location.origin : '');

const _inflight = new Map();

function getToken() { return localStorage.getItem(TOKEN_KEY); }
function setToken(t) { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); }
function getUser() { try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch { return null; } }
function setUser(u) { if (u) localStorage.setItem(USER_KEY, JSON.stringify(u)); else localStorage.removeItem(USER_KEY); }

function isAuthed() { return !!getToken(); }

function _dedupeKey(method, path, body, query) {
  const q = query ? JSON.stringify(Object.entries(query).sort(([a], [b]) => a.localeCompare(b))) : '';
  const b = body ? JSON.stringify(body) : '';
  return `${method}:${path}:${q}:${b}`;
}

const ERROR_MESSAGES = {
  400: 'Invalid request',
  401: 'Authentication required',
  403: 'Permission denied',
  404: 'Resource not found',
  409: 'Conflict',
  422: 'Invalid data submitted',
  429: 'Too many requests',
  500: 'Internal server error',
  502: 'Bad gateway',
  503: 'Service unavailable',
  504: 'Gateway timeout',
};

function classifyError(status, backendMessage, isNetworkError) {
  if (isNetworkError) {
    if (status === 'timeout') {
      return { kind: 'TIMEOUT', message: 'Request timed out', retryable: false };
    }
    return { kind: 'NETWORK_ERROR', message: 'Backend is unreachable. Check whether SkyGuard server is running.', retryable: true };
  }

  const kind = status >= 500 ? 'SERVER_ERROR'
    : status === 429 ? 'RATE_LIMIT'
    : status === 401 ? 'AUTH_ERROR'
    : status === 403 ? 'FORBIDDEN'
    : status === 404 ? 'NOT_FOUND'
    : status === 422 ? 'VALIDATION_ERROR'
    : status >= 400 ? 'CLIENT_ERROR'
    : 'UNKNOWN';

  const backendMsg = backendMessage && backendMessage.length < 200 ? backendMessage : null;
  let message;

  if (backendMsg) {
    message = backendMsg;
  } else if (ERROR_MESSAGES[status]) {
    message = ERROR_MESSAGES[status];
  } else if (status >= 500) {
    message = 'Server error. Please retry shortly.';
  } else if (status >= 400) {
    message = `Request failed (${status})`;
  } else {
    message = `HTTP ${status}`;
  }

  const retryable = [502, 503, 504].includes(status) || isNetworkError;

  return { kind, message, status, retryable };
}

async function request(method, path, { body, query, timeoutMs = 15000, auth = true } = {}) {
  const dedupeKey = _dedupeKey(method, path, body, query);
  if (_inflight.has(dedupeKey)) {
    return _inflight.get(dedupeKey);
  }
  const url = new URL(path, API_BASE);
  if (query) for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const headers = { 'Content-Type': 'application/json' };
  if (auth) {
    const token = getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }
  let res;
  const promise = (async () => {
    let isNetworkError = false;
    try {
      res = await fetch(url.toString(), { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal });
    } catch (e) {
      clearTimeout(timer);
      _inflight.delete(dedupeKey);
      isNetworkError = true;
      const isTimeout = e.name === 'AbortError';
      const classified = classifyError(isTimeout ? 'timeout' : 0, null, true);
      const err = new Error(classified.message);
      err.kind = classified.kind;
      err.retryable = classified.retryable;
      err.network = true;
      throw err;
    }
    clearTimeout(timer);
    const text = await res.text();
    let data = null;
    let parseError = false;
    try { data = text ? JSON.parse(text) : null; } catch { parseError = true; data = { raw: text }; }
    _inflight.delete(dedupeKey);
    if (!res.ok) {
      const backendMessage = data?.error?.message || (parseError ? text.slice(0, 200) : null);
      const classified = classifyError(res.status, backendMessage, false);
      const err = new Error(classified.message);
      err.kind = classified.kind;
      err.status = res.status;
      err.retryable = classified.retryable;
      err.body = data;
      if (res.status === 401) {
        setToken(null); setUser(null);
        window.dispatchEvent(new CustomEvent('skyguard:unauthorized'));
      }
      throw err;
    }
    return data;
  })();
  _inflight.set(dedupeKey, promise);
  return promise;
}

function ok(path, opts) { return request('GET', path, opts).then((r) => r.data); }
function post(path, body, opts) { return request('POST', path, { ...opts, body }).then((r) => r.data); }
function put(path, body, opts) { return request('PUT', path, { ...opts, body }).then((r) => r.data); }
function del(path, opts) { return request('DELETE', path, opts).then((r) => r.data); }

export const apiClient = {
  get: ok, post, put, delete: del,
  isAuthed,
  getToken, setToken, getUser, setUser,
  request,
};

window.SkyGuardAPI = apiClient;
