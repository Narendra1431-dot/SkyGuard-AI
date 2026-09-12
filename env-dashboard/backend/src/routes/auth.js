const express = require('express');
const bcrypt = require('bcryptjs');
const { findUserByUsername, createUser, listUsers } = require('../db/auth');
const { signToken, authRequired, roleRequired, authRateLimit } = require('../middleware/auth');

const router = express.Router();
const loginLimit = authRateLimit({ limit: 30, windowMs: 60_000 });

router.post('/login', loginLimit, async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ success: false, error: { message: 'username and password required' }, timestamp: new Date().toISOString() });
    }
    const user = await findUserByUsername(username);
    if (!user) return res.status(401).json({ success: false, error: { message: 'Invalid credentials' }, timestamp: new Date().toISOString() });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ success: false, error: { message: 'Invalid credentials' }, timestamp: new Date().toISOString() });
    const token = signToken(user);
    res.json({
      success: true,
      data: {
        token,
        user: { id: user.id, username: user.username, role: user.role },
        expiresInHours: require('../config').auth.expiresHours,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (e) { next(e); }
});

router.get('/me', authRequired, (req, res) => {
  res.json({ success: true, data: req.user, timestamp: new Date().toISOString() });
});

router.get('/users', authRequired, roleRequired('admin'), async (req, res, next) => {
  try { res.json({ success: true, data: await listUsers(), timestamp: new Date().toISOString() }); }
  catch (e) { next(e); }
});

router.post('/users', authRequired, roleRequired('admin'), async (req, res, next) => {
  try {
    const { username, password, role } = req.body || {};
    if (!username || !password) return res.status(400).json({ success: false, error: { message: 'username and password required' }, timestamp: new Date().toISOString() });
    if (password.length < 8) return res.status(400).json({ success: false, error: { message: 'Password must be \\u2265 8 characters' }, timestamp: new Date().toISOString() });
    const u = await createUser({ username, password, role: role || 'analyst' });
    res.status(201).json({ success: true, data: u, timestamp: new Date().toISOString() });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ success: false, error: { message: 'Username already exists' }, timestamp: new Date().toISOString() });
    next(e);
  }
});

router.post('/rate-limit/clear', authRequired, roleRequired('admin'), (req, res) => {
  try {
    const result = require('../middleware/auth').clearRateLimitStore();
    res.json({
      success: true,
      data: result,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({
      success: false,
      error: { message: 'Failed to clear rate limit store', details: e.message },
      timestamp: new Date().toISOString(),
    });
  }
});

module.exports = router;
