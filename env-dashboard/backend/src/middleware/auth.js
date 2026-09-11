'use strict';

const { randomUUID } = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config');
const { findUserById } = require('../db/auth');

function signToken(user) {
  return jwt.sign(
    { sub: user.id, username: user.username, role: user.role },
    config.auth.jwtSecret,
    { expiresIn: `${config.auth.expiresHours}h` }
  );
}

function verifyToken(token) {
  return jwt.verify(token, config.auth.jwtSecret);
}

function extractToken(req) {
  const h = req.headers['authorization'] || '';
  if (h.toLowerCase().startsWith('bearer ')) return h.slice(7).trim();
  // Query-string tokens are no longer supported; they leak via referer/logs.
  return null;
}

async function authRequired(req, res, next) {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ success: false, error: { message: 'Authentication required', requestId: req.requestId } });
  try {
    const payload = verifyToken(token);
    const user = await findUserById(payload.sub);
    if (!user) return res.status(401).json({ success: false, error: { message: 'Invalid token', requestId: req.requestId } });
    req.user = { id: user.id, username: user.username, role: user.role };
    next();
  } catch (e) {
    return res.status(401).json({ success: false, error: { message: 'Invalid or expired token', requestId: req.requestId } });
  }
}

function roleRequired(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ success: false, error: { message: 'Authentication required', requestId: req.requestId } });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, error: { message: 'Forbidden: insufficient role', requestId: req.requestId } });
    }
    next();
  };
}

function requestId(req, res, next) {
  const incoming = req.headers['x-request-id'];
  req.requestId = (typeof incoming === 'string' && incoming.length > 0 && incoming.length < 200) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
}

const rateLimitBuckets = new Map();
function rateLimit({ keyFn, limit, windowMs, message }) {
  return (req, res, next) => {
    const k = `${keyFn(req)}`;
    const now = Date.now();
    const bucket = rateLimitBuckets.get(k) || { count: 0, resetAt: now + windowMs };
    if (now > bucket.resetAt) { bucket.count = 0; bucket.resetAt = now + windowMs; }
    bucket.count += 1;
    rateLimitBuckets.set(k, bucket);
    if (bucket.count > limit) {
      return res.status(429).json({ success: false, error: { code: 'RATE_LIMITED', message: message || 'Too many requests', requestId: req.requestId } });
    }
    next();
  };
}

function authRateLimit({ limit = 10, windowMs = 60_000 } = {}) {
  return rateLimit({ keyFn: (req) => `auth:${req.ip || req.headers['x-forwarded-for'] || 'unknown'}`, limit, windowMs, message: 'Too many auth attempts' });
}

function agentRateLimit({ limit = 60, windowMs = 60_000 } = {}) {
  return rateLimit({ keyFn: (req) => `agent:${(req.user && req.user.id) || req.ip || 'unknown'}`, limit, windowMs, message: 'Too many agent requests' });
}

module.exports = { signToken, verifyToken, authRequired, roleRequired, requestId, rateLimit, authRateLimit, agentRateLimit };
