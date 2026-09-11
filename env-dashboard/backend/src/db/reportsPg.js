'use strict';

const fs = require('fs');
const path = require('path');

const REPORTS_DIR = (() => {
  const envDir = process.env.SKYGUARD_DATA_DIR;
  return envDir
    ? path.resolve(envDir, 'reports')
    : path.resolve(__dirname, '..', '..', 'reports');
})();

function ensureDir() {
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

module.exports = { REPORTS_DIR, ensureDir };
