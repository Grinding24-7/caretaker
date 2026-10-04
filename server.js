'use strict';

const path = require('node:path');
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');

const { connect, seed, DB_PATH } = require('./src/db');
const { requireAuth } = require('./src/auth');

const PORT = Number(process.env.PORT) || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-only-secret-change-me';

const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
app.use(cookieParser());

app.use(
  session({
    name: 'caretaker.sid',
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production' && process.env.FORCE_HTTPS === '1',
      maxAge: 1000 * 60 * 60 * 24 * 7
    }
  })
);

// Minimal security headers; the dashboard is a single self-hosted page.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
      "connect-src 'self'; worker-src 'self'; manifest-src 'self'"
  );
  next();
});

app.use('/api/auth', require('./src/routes/auth'));
app.use('/api/doses', require('./src/routes/doses'));
app.use('/api/medicines', require('./src/routes/medicines'));
app.use('/api/doctor', require('./src/routes/doctor'));

// Lightweight profile endpoint used by the frontend on first paint.
app.get('/api/me', requireAuth, (req, res) => res.json({ user: req.user }));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, db: path.basename(DB_PATH), uptime: process.uptime() });
});

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// SPA fallback for any non-API GET, so a refresh keeps you on the dashboard.
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// JSON error handler — keeps malformed bodies from dumping an HTML stack.
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Malformed JSON body.' });
  }
  if (res.headersSent) return next(err);
  console.error(err);
  res.status(500).json({ error: 'Unexpected server error.' });
});

if (require.main === module) {
  connect();
  seed();

  app.listen(PORT, () => {
    console.log(`\n  Medicine Reminder Dashboard → http://localhost:${PORT}\n`);
  });
}

module.exports = app;
