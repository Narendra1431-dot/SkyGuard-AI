'use strict';

const bcrypt = require('bcryptjs');
const pg = require('./pg');
const { ensureSchema } = require('./schema');

async function ensureAdmin(cfg) {
  if (!pg.isEnabled()) return;
  await ensureSchema(pg);

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

  if (!password) {
    throw new Error('FATAL: ADMIN_PASSWORD not configured and no demo mode fallback available');
  }

  const r = await pg.query('SELECT id FROM users WHERE username = $1', [username]);
  if (r.rowCount === 0) {
    const hash = await bcrypt.hash(password, 10);
    await pg.query(
      'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3)',
      [username, hash, 'admin']
    );
    console.log(`[auth] seeded default admin user: ${username}`);
  }
}

async function findUserByUsername(username) {
  if (!pg.isEnabled()) return null;
  const r = await pg.query(
    'SELECT id, username, password_hash, role FROM users WHERE username = $1',
    [username.toLowerCase()]
  );
  return r.rows[0] || null;
}

async function findUserById(id) {
  if (!pg.isEnabled()) return null;
  const r = await pg.query(
    'SELECT id, username, role FROM users WHERE id = $1',
    [id]
  );
  return r.rows[0] || null;
}

async function listUsers() {
  if (!pg.isEnabled()) return [];
  const r = await pg.query('SELECT id, username, role, created_at FROM users ORDER BY id');
  return r.rows;
}

async function createUser({ username, password, role = 'analyst' }) {
  if (!pg.isEnabled()) throw new Error('PG disabled');
  const hash = await bcrypt.hash(password, 10);
  const r = await pg.query(
    'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id, username, role',
    [username.toLowerCase(), hash, role]
  );
  return r.rows[0];
}

module.exports = { ensureAdmin, findUserByUsername, findUserById, listUsers, createUser };
