'use strict';

const bcrypt = require('bcryptjs');

const pg = require('./pg');
const pgUsers = require('./users');

// In-memory user store used when PG is disabled or unreachable
const memStore = { users: new Map() };

async function initFromEnv(cfg) {
  const isProd = process.env.NODE_ENV === 'production';
  const demoMode = process.env.DEMO_MODE === 'true';

  // In production with demo mode disabled, require explicit credentials
  if (isProd && !demoMode) {
    if (!cfg.adminUsername || !cfg.adminPassword) {
      throw new Error('FATAL: ADMIN_USERNAME and ADMIN_PASSWORD must be set in production with DEMO_MODE=false');
    }
  }

  const username = (cfg.adminUsername || 'admin').toLowerCase();
  const password = cfg.adminPassword || (demoMode ? 'admin123!Change' : null);

  // In production without demo mode, reject default password
  if (isProd && !demoMode && password === 'admin123!Change') {
    throw new Error('FATAL: ADMIN_PASSWORD must be set to a strong value in production');
  }

  // Always seed the in-memory admin so authentication keeps working even if
  // PostgreSQL is enabled but temporarily unreachable.
  if (!memStore.users.has(username)) {
    if (!password) {
      throw new Error('FATAL: ADMIN_PASSWORD not configured and no demo mode fallback available');
    }
    const hash = await bcrypt.hash(password, 10);
    memStore.users.set(username, { id: 1, username, password_hash: hash, role: 'admin' });
    console.log(`[auth] seeded in-memory admin user: ${username}`);
  }
  if (pg.isEnabled()) {
    try { await pgUsers.ensureAdmin(cfg); } catch (e) { console.error('[auth] PG admin seed skipped:', e.message); }
  }
}

async function findUserByUsername(username) {
  if (pg.isEnabled()) {
    try { return await pgUsers.findUserByUsername(username); } catch (_) { /* fall back to memory */ }
  }
  return memStore.users.get(username.toLowerCase()) || null;
}

async function findUserById(id) {
  if (pg.isEnabled()) {
    try { return await pgUsers.findUserById(id); } catch (_) { /* fall back to memory */ }
  }
  for (const u of memStore.users.values()) {
    if (u.id === id) return { id: u.id, username: u.username, role: u.role };
  }
  return null;
}

async function listUsers() {
  if (pg.isEnabled()) {
    try { return await pgUsers.listUsers(); } catch (_) { /* fall back to memory */ }
  }
  return [...memStore.users.values()].map(({ id, username, role }) => ({ id, username, role }));
}

async function createUser({ username, password, role = 'analyst' }) {
  if (pg.isEnabled()) {
    try { return await pgUsers.createUser({ username, password, role }); } catch (_) { /* fall back to memory */ }
  }
  const hash = await bcrypt.hash(password, 10);
  const id = memStore.users.size + 1;
  const u = { id, username: username.toLowerCase(), password_hash: hash, role };
  memStore.users.set(u.username, u);
  return { id: u.id, username: u.username, role: u.role };
}

module.exports = { initFromEnv, findUserByUsername, findUserById, listUsers, createUser };