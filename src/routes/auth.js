'use strict';

const express = require('express');
const { login, requireAuth } = require('../auth');

const router = express.Router();

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  const result = login(email, password);

  if (!result.ok) {
    return res.status(401).json({ error: result.error });
  }

  req.session.userId = result.user.id;
  req.session.role = result.user.role;

  // Regenerate to prevent session fixation, then re-bind the ids.
  req.session.regenerate((err) => {
    if (err) {
      return res.status(500).json({ error: 'Could not create session.' });
    }
    req.session.userId = result.user.id;
    req.session.role = result.user.role;
    res.json({ user: result.user });
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('caretaker.sid');
    res.json({ ok: true });
  });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
