'use strict';

// `npm run migrate` — initialize (or repair) the PostgreSQL schema using the
// same idempotent ensureSchema mechanism the server boot path uses.
//
// Usage:
//   PG_ENABLED=true node src/db/migrate.js
//
// Exits non-zero when PostgreSQL is disabled or unreachable so CI/pipelines
// can fail loudly instead of silently skipping schema provisioning.

const config = require('../config');
const pg = require('./pg');
const { ensureSchema } = require('./schema');

async function main() {
  if (!config.pg.enabled) {
    console.error('PG_ENABLED is not "true"; enable PostgreSQL before running migrations.');
    process.exit(1);
  }
  pg.init(config.pg);
  const up = await pg.ping();
  if (!up) {
    console.error('PostgreSQL is not reachable; start the database first.');
    pg.disable();
    process.exit(1);
  }
  try {
    await ensureSchema(pg);
  } finally {
    await pg.close();
  }
  console.log('PostgreSQL schema up to date.');
  process.exit(0);
}

main().catch((e) => {
  console.error('migrate failed:', e && e.message ? e.message : e);
  process.exit(1);
});