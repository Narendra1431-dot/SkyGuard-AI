'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const FRONTEND = path.join(APP_ROOT, 'frontend');
const LEGACY_HTML = path.join(APP_ROOT, '..', 'Html.html');

function checkJavaScript(source, label) {
  const temp = path.join(os.tmpdir(), `skyguard-bootstrap-${process.pid}-${Date.now()}.js`);
  try {
    fs.writeFileSync(temp, source, 'utf8');
    const result = spawnSync(process.execPath, ['--check', temp], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${label}: ${result.stderr || result.stdout}`);
  } finally {
    try { fs.unlinkSync(temp); } catch (_) {}
  }
}

function collectFiles(dir, extension) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectFiles(file, extension);
    return path.extname(entry.name).toLowerCase() === extension ? [file] : [];
  });
}

test('frontend bootstrap: HTML script blocks and modules parse', () => {
  const htmlFiles = [LEGACY_HTML, ...collectFiles(FRONTEND, '.html')];
  for (const file of htmlFiles) {
    const html = fs.readFileSync(file, 'utf8');
    const opens = html.match(/<script\b/gi) || [];
    const closes = html.match(/<\/script\s*>/gi) || [];
    assert.equal(opens.length, closes.length, `${file}: unbalanced script tags`);

    for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
      const attrs = match[1];
      if (!/\bsrc\s*=\s*/i.test(attrs)) checkJavaScript(match[2], `${file} inline script`);
    }
  }

  for (const file of collectFiles(FRONTEND, '.js')) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${file}: ${result.stderr || result.stdout}`);
  }
});