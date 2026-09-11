'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { egressAllowed, sanitizeHeaderName, sanitizeHeaderValue } = require('../src/services/notifications');

test('security: egress allows public https', () => {
  const r = egressAllowed('https://api.example.com/webhook');
  assert.equal(r.allowed, true);
});

test('security: egress blocks loopback', () => {
  const r = egressAllowed('http://127.0.0.1:8000/');
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'loopback_host');
});

test('security: egress blocks RFC1918', () => {
  for (const host of ['http://10.0.0.5', 'http://192.168.1.1', 'http://172.16.0.1']) {
    const r = egressAllowed(host);
    assert.equal(r.allowed, false, `should block ${host}`);
  }
});

test('security: egress blocks cloud metadata', () => {
  const r = egressAllowed('http://169.254.169.254/latest/meta-data/');
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'private_ip');
});

test('security: egress blocks file:// scheme', () => {
  const r = egressAllowed('file:///etc/passwd');
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'unsupported_scheme');
});

test('security: egress enforces allowlist when configured', () => {
  const r = egressAllowed('https://evil.com/x', ['allowed.example.com']);
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'host_not_in_allowlist');
});

test('security: egress allows subdomain of allowlist entry', () => {
  const r = egressAllowed('https://api.allowed.example.com/x', ['allowed.example.com']);
  assert.equal(r.allowed, true);
});

test('security: header sanitization strips CRLF and limits length', () => {
  assert.equal(sanitizeHeaderName('X-Test'), 'X-Test');
  assert.equal(sanitizeHeaderName('X-Test\r\nInjected'), 'X-TestInjected');
  assert.match(sanitizeHeaderValue('safe'), /^safe$/);
  assert.equal(sanitizeHeaderValue('a\r\nb'), 'a  b');
  assert.equal(sanitizeHeaderValue('x'.repeat(2000)).length, 1024);
});
