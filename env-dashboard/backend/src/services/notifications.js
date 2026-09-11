'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

/**
 * NotificationService
 *  - Configures multiple channel adapters (email, webhook, sms, telegram, slack)
 *  - Each adapter supports: configure, validateConfig, send, test, status, history
 *  - Test sends a real payload when credentials are configured; otherwise GRAY.
 *  - Delivery history is persisted to data/notifications.history.json.
 *
 * Channels:
 *   email    - SMTP delivery using nodemailer if installed, else raw SMTP via net
 *   webhook  - HTTP POST/GET/etc to a configured URL
 *   sms      - Twilio REST API (real HTTP request when configured)
 *   telegram - Telegram Bot API (real HTTP request when configured)
 *   slack    - Slack incoming webhook (real HTTP request when configured)
 */

const NOTIFICATIONS_DIR = process.env.SKYGUARD_DATA_DIR
  ? path.resolve(process.env.SKYGUARD_DATA_DIR)
  : path.resolve(__dirname, '..', '..', 'data');
const HISTORY_FILE = path.join(NOTIFICATIONS_DIR, 'notifications.history.json');
const CONFIG_FILE = path.join(NOTIFICATIONS_DIR, 'notifications.config.json');
const MAX_HISTORY = 500;
const OUTBOX_FILE = path.join(NOTIFICATIONS_DIR, 'notifications.outbox.json');
const MAX_OUTBOX = 1000;
const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 1000;

function loadOutbox() {
  try { return JSON.parse(fs.readFileSync(OUTBOX_FILE, 'utf8')); }
  catch { return []; }
}
function saveOutbox(list) {
  try {
    fs.mkdirSync(path.dirname(OUTBOX_FILE), { recursive: true });
    fs.writeFileSync(OUTBOX_FILE, JSON.stringify(list.slice(0, MAX_OUTBOX), null, 2));
  } catch (_) {}
}
let outbox = loadOutbox();

function outboxPush(entry) {
  outbox.unshift({ ...entry, queuedAt: new Date().toISOString(), attempts: 0, nextAttemptAt: new Date(Date.now()).toISOString() });
  if (outbox.length > MAX_OUTBOX) outbox.length = MAX_OUTBOX;
  saveOutbox(outbox);
}

async function processOutbox() {
  if (!outbox.length) return;
  const now = new Date();
  const remaining = [];
  for (const item of outbox) {
    if (item.attempts >= MAX_RETRIES) continue;
    if (new Date(item.nextAttemptAt).getTime() > now.getTime()) { remaining.push(item); continue; }
    const adapter = adapters[item.channelType];
    if (!adapter) continue;
    const ch = getChannelRaw(item.channelId);
    const creds = ch ? (ch.credentials || {}) : {};
    if (!adapter.isConfigured(creds)) {
      record({ channelId: item.channelId, channelType: item.channelType, alertId: item.alertId, kind: item.kind || 'alert', status: 'GRAY', error: 'channel not configured', retries: item.attempts, retryCount: item.attempts });
      continue;
    }
    const message = { subject: item.subject || 'SkyGuard Notification', text: item.text || '', meta: item.meta || {} };
    const r = await adapter.send(creds, message);
    const delay = Math.min(BACKOFF_BASE_MS * (2 ** item.attempts), 30000);
    if (r.status === 'GREEN') {
      record({ channelId: item.channelId, channelType: item.channelType, alertId: item.alertId, kind: item.kind || 'alert', status: 'GREEN', statusCode: r.statusCode, latencyMs: r.latencyMs, error: null, retries: item.attempts, retryCount: item.attempts });
    } else {
      remaining.push({ ...item, attempts: item.attempts + 1, nextAttemptAt: new Date(Date.now() + delay).toISOString() });
      record({ channelId: item.channelId, channelType: item.channelType, alertId: item.alertId, kind: item.kind || 'alert', status: 'RETRYING', statusCode: r.statusCode, latencyMs: r.latencyMs, error: r.error || 'retry', retries: item.attempts + 1, retryCount: item.attempts + 1 });
    }
  }
  outbox = remaining;
  saveOutbox(outbox);
}

setInterval(processOutbox, 5000);

function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); }
  catch { return []; }
}
function saveHistory(list) {
  try {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(list.slice(0, MAX_HISTORY), null, 2));
  } catch (_) {}
}
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch { return { channels: [] }; }
}
function saveConfig(cfg) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  } catch (_) {}
}

let history = loadHistory();
let config = loadConfig();

function record(entry) {
  const full = {
    id: `NTF-${Date.now()}-${randomUUID().slice(0, 6)}`,
    time: new Date().toISOString(),
    ...entry,
  };
  history.unshift(full);
  if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
  saveHistory(history);
  return full;
}

// ---------------------------------------------------------------------------
// Email adapter (real SMTP delivery via raw SMTP protocol; no third-party dep)
// ---------------------------------------------------------------------------
const EmailAdapter = {
  type: 'email',
  description: 'SMTP email delivery. Requires host, port, username, password, sender.',
  validateConfig(cfg = {}) {
    const errors = [];
    if (!cfg.host) errors.push('host required');
    if (!cfg.port) errors.push('port required');
    if (!cfg.username) errors.push('username required');
    if (!cfg.password) errors.push('password required');
    if (!cfg.sender) errors.push('sender required');
    if (!cfg.recipient) errors.push('recipient required');
    return { valid: !errors.length, errors };
  },
  isConfigured(cfg = {}) {
    return !!(cfg.host && cfg.port && cfg.username && cfg.password && cfg.sender && cfg.recipient);
  },
  async send(cfg, message) {
    if (!this.isConfigured(cfg)) {
      return { status: 'GRAY', error: 'not configured' };
    }
    const net = require('net');
    const tls = require('tls');
    const start = Date.now();
    const secure = cfg.secure === true || Number(cfg.port) === 465;
    let socket;
    const connect = () => new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      socket = secure ? tls.connect({ host: cfg.host, port: Number(cfg.port), servername: cfg.host }, resolve)
        : net.connect(Number(cfg.port), cfg.host, resolve);
      socket.setTimeout(Number(cfg.timeoutMs) || 10000, () => socket.destroy(new Error('timeout')));
      socket.once('error', onError);
    });
    const response = () => new Promise((resolve, reject) => {
      let buffer = '';
      const onData = (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\r\n');
        const terminal = lines.filter((line) => /^\d{3} /.test(line)).pop();
        if (terminal) { socket.off('data', onData); resolve({ code: Number(terminal.slice(0, 3)), text: terminal }); }
      };
      socket.on('data', onData);
      socket.once('error', reject);
    });
    const command = async (value) => { socket.write(`${value}\r\n`); return response(); };
    try {
      await connect();
      let reply = await response();
      if (reply.code >= 400) throw new Error(`smtp ${reply.code}: ${reply.text}`);
      reply = await command('EHLO skyguard.local');
      if (!secure && cfg.tls !== false) {
        if (reply.code >= 400) throw new Error(`smtp ${reply.code}: ${reply.text}`);
        reply = await command('STARTTLS');
        if (reply.code >= 400) throw new Error(`smtp ${reply.code}: ${reply.text}`);
        socket = await new Promise((resolve, reject) => {
          const upgraded = tls.connect({ socket, host: cfg.host, servername: cfg.host }, () => resolve(upgraded));
          upgraded.once('error', reject);
        });
        reply = await command('EHLO skyguard.local');
      }
      reply = await command('AUTH LOGIN');
      if (reply.code >= 400) throw new Error(`smtp ${reply.code}: ${reply.text}`);
      reply = await command(Buffer.from(String(cfg.username)).toString('base64'));
      if (reply.code >= 400) throw new Error(`smtp ${reply.code}: ${reply.text}`);
      reply = await command(Buffer.from(String(cfg.password)).toString('base64'));
      if (reply.code >= 400) throw new Error(`smtp ${reply.code}: ${reply.text}`);
      for (const cmd of [`MAIL FROM:<${cfg.sender}>`, `RCPT TO:<${cfg.recipient}>`, 'DATA']) {
        reply = await command(cmd);
        if (reply.code >= 400) throw new Error(`smtp ${reply.code}: ${reply.text}`);
      }
      const body = (message.text || '').replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
      reply = await command(`Subject: ${message.subject || 'SkyGuard Notification'}\r\nFrom: ${cfg.sender}\r\nTo: ${cfg.recipient}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n.`);
      if (reply.code >= 400) throw new Error(`smtp ${reply.code}: ${reply.text}`);
      try { await command('QUIT'); } catch (_) {}
      socket.end();
      return { status: 'GREEN', statusCode: reply.code, latencyMs: Date.now() - start, error: null };
    } catch (e) {
      try { socket?.destroy(); } catch (_) {}
      return { status: 'RED', latencyMs: Date.now() - start, error: e.message || 'smtp delivery failed' };
    }
  },
};

// ---------------------------------------------------------------------------
// Webhook adapter (real HTTP request)
// ---------------------------------------------------------------------------
const PRIVATE_HOSTS = new Set([
  'localhost', '127.0.0.1', '0.0.0.0', '::1', 'metadata.google.internal',
]);

function isPrivateIPv4(host) {
  if (!host) return true;
  const parts = host.split('.').map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return false;
  if (parts[0] === 10) return true;
  if (parts[0] === 127) return true;
  if (parts[0] === 169 && parts[1] === 254) return true; // link-local + cloud metadata
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true; // CGNAT
  if (parts[0] === 0) return true;
  return false;
}

function egressAllowed(urlString, allowlist = []) {
  let u;
  try { u = new URL(urlString); } catch (_) { return { allowed: false, reason: 'invalid_url' }; }
  if (!['http:', 'https:'].includes(u.protocol)) return { allowed: false, reason: 'unsupported_scheme' };
  const host = (u.hostname || '').toLowerCase();
  if (PRIVATE_HOSTS.has(host)) return { allowed: false, reason: 'loopback_host' };
  if (isPrivateIPv4(host)) return { allowed: false, reason: 'private_ip' };
  if (allowlist && allowlist.length) {
    const ok = allowlist.some((entry) => {
      const e = (entry || '').toLowerCase();
      return host === e || host.endsWith(`.${e}`);
    });
    if (!ok) return { allowed: false, reason: 'host_not_in_allowlist' };
  }
  return { allowed: true };
}

function sanitizeHeaderName(name) {
  return String(name || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 64);
}
function sanitizeHeaderValue(value) {
  return String(value == null ? '' : value).replace(/[\r\n\t]/g, ' ').slice(0, 1024);
}

const WebhookAdapter = {
  type: 'webhook',
  description: 'Generic HTTP webhook. POST/GET/PUT to a configured URL with optional auth header.',
  validateConfig(cfg = {}) {
    const errors = [];
    if (!cfg.url) errors.push('url required');
    try { new URL(cfg.url); } catch (_) { errors.push('url invalid'); }
    return { valid: !errors.length, errors };
  },
  isConfigured(cfg = {}) {
    if (!cfg.url) return false;
    try { new URL(cfg.url); return true; } catch { return false; }
  },
  async send(cfg, message) {
    if (!this.isConfigured(cfg)) return { status: 'GRAY', error: 'not configured' };
    const egress = egressAllowed(cfg.url, require('../config').egress.webhookAllowlist);
    if (!egress.allowed) return { status: 'RED', error: `egress_blocked:${egress.reason}` };
    const method = (cfg.method || 'POST').toUpperCase();
    const headers = { 'Content-Type': 'application/json', 'User-Agent': 'SkyGuard-AI/1.0' };
    for (const [k, v] of Object.entries(cfg.headers || {})) {
      headers[sanitizeHeaderName(k)] = sanitizeHeaderValue(v);
    }
    if (cfg.authHeader) headers['Authorization'] = sanitizeHeaderValue(cfg.authHeader);
    const body = method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify({
      type: 'skyguard.notification',
      subject: message.subject,
      text: message.text,
      meta: message.meta || {},
      time: new Date().toISOString(),
    });
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Number(cfg.timeoutMs) || 8000);
      const res = await fetch(cfg.url, { method, headers, body, signal: controller.signal, redirect: 'manual' });
      clearTimeout(timer);
      const latencyMs = Date.now() - start;
      if (res.status >= 300 && res.status < 400) return { status: 'RED', error: 'redirects_disallowed' };
      if (res.status >= 200 && res.status < 300) return { status: 'GREEN', statusCode: res.status, latencyMs, error: null };
      return { status: 'RED', statusCode: res.status, latencyMs, error: `HTTP ${res.status}` };
    } catch (e) {
      return { status: 'RED', error: e.message || 'fetch failed', latencyMs: Date.now() - start };
    }
  },
};

// ---------------------------------------------------------------------------
// SMS adapter (Twilio REST API – real HTTP when configured)
// ---------------------------------------------------------------------------
const SmsAdapter = {
  type: 'sms',
  description: 'SMS via Twilio REST API. Requires accountSid, authToken, from, to.',
  validateConfig(cfg = {}) {
    const errors = [];
    if (!cfg.accountSid) errors.push('accountSid required');
    if (!cfg.authToken) errors.push('authToken required');
    if (!cfg.from) errors.push('from required');
    if (!cfg.to) errors.push('to required');
    return { valid: !errors.length, errors };
  },
  isConfigured(cfg = {}) {
    return !!(cfg.accountSid && cfg.authToken && cfg.from && cfg.to);
  },
  async send(cfg, message) {
    if (!this.isConfigured(cfg)) return { status: 'GRAY', error: 'not configured' };
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(cfg.accountSid)}/Messages.json`;
    const body = new URLSearchParams({ From: cfg.from, To: cfg.to, Body: message.text || message.subject || '' }).toString();
    const auth = Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString('base64');
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);
      const latencyMs = Date.now() - start;
      const text2 = await res.text();
      if (res.status >= 200 && res.status < 300) {
        const parsed = JSON.parse(text2);
        return { status: 'GREEN', statusCode: res.status, latencyMs, providerId: parsed.sid || null, error: null };
      }
      return { status: 'RED', statusCode: res.status, latencyMs, error: text2.slice(0, 200) };
    } catch (e) {
      return { status: 'RED', error: e.message || 'fetch failed', latencyMs: Date.now() - start };
    }
  },
};

// ---------------------------------------------------------------------------
// Telegram adapter (real HTTP when configured)
// ---------------------------------------------------------------------------
const TelegramAdapter = {
  type: 'telegram',
  description: 'Telegram Bot API. Requires botToken and chatId.',
  validateConfig(cfg = {}) {
    const errors = [];
    if (!cfg.botToken) errors.push('botToken required');
    if (!cfg.chatId) errors.push('chatId required');
    return { valid: !errors.length, errors };
  },
  isConfigured(cfg = {}) {
    return !!(cfg.botToken && cfg.chatId);
  },
  async send(cfg, message) {
    if (!this.isConfigured(cfg)) return { status: 'GRAY', error: 'not configured' };
    const url = `https://api.telegram.org/bot${encodeURIComponent(cfg.botToken)}/sendMessage`;
    const body = JSON.stringify({
      chat_id: cfg.chatId,
      text: `${message.subject || 'SkyGuard'}\n\n${message.text || ''}`,
    });
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: controller.signal });
      clearTimeout(timer);
      const latencyMs = Date.now() - start;
      const parsed = await res.json().catch(() => ({}));
      if (res.ok && parsed.ok) return { status: 'GREEN', statusCode: res.status, latencyMs, providerId: parsed.result?.message_id, error: null };
      return { status: 'RED', statusCode: res.status, latencyMs, error: parsed.description || `HTTP ${res.status}` };
    } catch (e) {
      return { status: 'RED', error: e.message || 'fetch failed', latencyMs: Date.now() - start };
    }
  },
};

// ---------------------------------------------------------------------------
// Slack adapter (real HTTP when configured)
// ---------------------------------------------------------------------------
const SlackAdapter = {
  type: 'slack',
  description: 'Slack incoming webhook. Requires webhookUrl.',
  validateConfig(cfg = {}) {
    const errors = [];
    if (!cfg.webhookUrl) errors.push('webhookUrl required');
    return { valid: !errors.length, errors };
  },
  isConfigured(cfg = {}) {
    return !!cfg.webhookUrl;
  },
  async send(cfg, message) {
    if (!this.isConfigured(cfg)) return { status: 'GRAY', error: 'not configured' };
    const body = JSON.stringify({
      text: `*${message.subject || 'SkyGuard Notification'}*\n${message.text || ''}`,
    });
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(cfg.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);
      const latencyMs = Date.now() - start;
      if (res.status === 200) return { status: 'GREEN', statusCode: 200, latencyMs, error: null };
      return { status: 'RED', statusCode: res.status, latencyMs, error: `HTTP ${res.status}` };
    } catch (e) {
      return { status: 'RED', error: e.message || 'fetch failed', latencyMs: Date.now() - start };
    }
  },
};

const adapters = { email: EmailAdapter, webhook: WebhookAdapter, sms: SmsAdapter, telegram: TelegramAdapter, slack: SlackAdapter };

// Keep the channel contract uniform while allowing each adapter to own its
// provider-specific validation and transport implementation.
for (const adapter of Object.values(adapters)) {
  adapter.configure ||= (cfg = {}) => ({ ...cfg });
  adapter.test ||= (cfg, message) => adapter.send(cfg, message || { subject: 'SkyGuard test message', text: 'SkyGuard notification test' });
  adapter.status ||= (cfg = {}) => ({ status: adapter.isConfigured(cfg) ? 'GRAY' : 'NOT_CONFIGURED', configured: adapter.isConfigured(cfg) });
  adapter.history ||= (channelId) => historyFor({ channelId });
}

function listChannels() {
  return Object.entries(adapters).map(([k, a]) => ({ type: k, description: a.description }));
}

function getConfig() { return config; }

function getChannelRaw(id) {
  return (config.channels || []).find((c) => c.id === id) || null;
}

function getChannels() {
  return (config.channels || []).map((c) => ({
    ...c,
    credentials: mask(c.credentials || {}),
    status: adapterStatus(c),
    lastTestAt: lastTestFor(c.id)?.time || null,
    lastTestResult: lastTestFor(c.id)?.status || null,
    lastError: lastTestFor(c.id)?.error || null,
  }));
}

function lastTestFor(channelId) {
  return history.find((h) => h.channelId === channelId && h.kind === 'test') || null;
}

function mask(creds) {
  const out = {};
  for (const [k, v] of Object.entries(creds)) {
    if (v == null || v === '') { out[k] = ''; continue; }
    const s = String(v);
    out[k] = s.length < 6 ? '****' : `${s.slice(0, 2)}****${s.slice(-2)}`;
  }
  return out;
}

function adapterStatus(channel) {
  const a = adapters[channel.type];
  if (!a) return { status: 'GRAY', configured: false, error: 'unknown channel type' };
  const configured = a.isConfigured(channel.credentials || {});
  return { status: configured ? 'GRAY' : 'NOT_CONFIGURED', configured };
}

function upsertChannel(input) {
  const id = input.id || `CH-${randomUUID().slice(0, 8)}`;
  const type = String(input.type || '').toLowerCase();
  const a = adapters[type];
  if (!a) throw new Error(`Unsupported channel type: ${type}`);
  const channel = {
    id,
    type,
    name: input.name || `${type}-${id.slice(-3)}`,
    target: input.target || '',
    enabled: input.enabled !== false,
    severityFilter: input.severityFilter || ['critical'],
    credentials: { ...(input.credentials || {}) },
  };
  const idx = (config.channels || []).findIndex((c) => c.id === id);
  if (idx >= 0) config.channels[idx] = channel; else (config.channels ||= []).push(channel);
  saveConfig(config);
  return channel;
}

function deleteChannel(id) {
  if (!config.channels) return false;
  const before = config.channels.length;
  config.channels = config.channels.filter((c) => c.id !== id);
  saveConfig(config);
  return config.channels.length < before;
}

function setChannelEnabled(id, enabled) {
  const c = (config.channels || []).find((c) => c.id === id);
  if (!c) return null;
  c.enabled = !!enabled;
  saveConfig(config);
  return c;
}

function buildMessage(alert) {
  return {
    subject: `[${alert.severity?.toUpperCase()}] ${alert.title}`,
    text: `${alert.description}\n\nStation: ${alert.station} (${alert.stationId})\nRecommendation: ${alert.recommendation || '—'}\nAlert ID: ${alert.id}\nTime: ${alert.createdAt || alert.timestamp || new Date().toISOString()}`,
    meta: { alertId: alert.id, stationId: alert.stationId, severity: alert.severity },
  };
}

async function dispatchAlert(alert) {
  const channels = (config.channels || []).filter((c) => c.enabled && (!c.severityFilter || c.severityFilter.includes(alert.severity)));
  if (!channels.length) return [];
  const message = buildMessage(alert);
  const out = [];
  for (const ch of channels) {
    const adapter = adapters[ch.type];
    if (!adapter) continue;
    if (!adapter.isConfigured(ch.credentials || {})) {
      out.push(record({
        channelId: ch.id, channelType: ch.type, alertId: alert.id,
        kind: 'alert', status: 'GRAY', statusCode: null, latencyMs: 0,
        error: 'channel not configured', retries: 0, retryCount: 0,
      }));
      continue;
    }
    outboxPush({ channelId: ch.id, channelType: ch.type, alertId: alert.id, kind: 'alert', subject: message.subject, text: message.text, meta: message.meta });
    out.push(record({
      channelId: ch.id, channelType: ch.type, alertId: alert.id,
      kind: 'alert', status: 'QUEUED', statusCode: null, latencyMs: 0,
      error: null, retries: 0, retryCount: 0,
    }));
  }
  return out;
}

async function retryAlert(alertId) {
  const items = outbox.filter((o) => o.alertId === alertId);
  for (const item of items) {
    item.attempts = 0;
    item.nextAttemptAt = new Date(Date.now()).toISOString();
  }
  saveOutbox(outbox);
  return { queued: items.length, alertId };
}

async function deadLetter() {
  const dead = outbox.filter((o) => o.attempts >= MAX_RETRIES);
  return { deadLetterCount: dead.length, alertIds: dead.map((d) => d.alertId) };
}

async function testChannel(id) {
  const ch = (config.channels || []).find((c) => c.id === id);
  if (!ch) return null;
  const a = adapters[ch.type];
  if (!a) {
    return record({ channelId: id, channelType: ch.type, kind: 'test', status: 'GRAY', error: 'unknown channel type' });
  }
  if (!a.isConfigured(ch.credentials || {})) {
    return record({ channelId: id, channelType: ch.type, kind: 'test', status: 'GRAY', error: 'not configured' });
  }
  const message = { subject: 'SkyGuard test message', text: `This is a real ${ch.type} test from SkyGuard AI. ${new Date().toISOString()}` };
  const r = await a.send(ch.credentials, message);
  return record({
    channelId: id, channelType: ch.type, kind: 'test',
    status: r.status, statusCode: r.statusCode || null,
    latencyMs: r.latencyMs || 0, error: r.error || null, retries: 0, retryCount: 0,
  });
}

function historyFor({ channelId, alertId, limit = 100 } = {}) {
  let rows = history;
  if (channelId) rows = rows.filter((r) => r.channelId === channelId);
  if (alertId) rows = rows.filter((r) => r.alertId === alertId);
  return rows.slice(0, Math.min(limit, 500));
}

function reset() {
  config.channels = [];
  history = [];
  saveConfig(config);
  saveHistory(history);
}

module.exports = {
  listChannels,
  getConfig,
  getChannels,
  getChannelRaw,
  upsertChannel,
  deleteChannel,
  setChannelEnabled,
  egressAllowed,
  sanitizeHeaderName,
  sanitizeHeaderValue,
  testChannel,
  dispatchAlert,
  retryAlert,
  deadLetter,
  historyFor,
  reset,
  adapters,
};