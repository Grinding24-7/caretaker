'use strict';

const bcrypt = require('bcryptjs');
const { connect } = require('./db');

function loadUser(id) {
  const db = connect();
  return db
    .prepare(
      `SELECT u.id, u.email, u.role, u.full_name,
              p.id AS patient_id, d.id AS doctor_id
         FROM users u
         LEFT JOIN patients p ON p.user_id = u.id
         LEFT JOIN doctors  d ON d.user_id = u.id
        WHERE u.id = ?`
    )
    .get(id);
}

function login(email, password) {
  const db = connect();
  const user = db
    .prepare('SELECT id, email, password_hash, role, full_name FROM users WHERE email = ?')
    .get(String(email || '').trim().toLowerCase());

  if (!user) return { ok: false, error: 'No account found for that email.' };
  if (!bcrypt.compareSync(String(password || ''), user.password_hash)) {
    return { ok: false, error: 'Incorrect password.' };
  }

  return { ok: true, user: loadUser(user.id) };
}

// --- Guards -------------------------------------------------------------

// Requires any authenticated user.
function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Not signed in.' });
  }
  const user = loadUser(req.session.userId);
  if (!user) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: 'Session is no longer valid.' });
  }
  req.user = user;
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (req.user.role !== role) {
      return res.status(403).json({ error: `This area is only for ${role}s.` });
    }
    next();
  };
}

// The access boundary. A doctor may only reach a patient through an
// ACTIVE care contract that covers today's date. Enforced on every
// doctor -> patient route; this is not a UI concern.
function requireContract(req, res, next) {
  const doctorId = req.user.doctor_id;
  const patientId = Number(req.params.patientId);

  if (!doctorId) {
    return res.status(403).json({ error: 'Not a doctor account.' });
  }
  if (!Number.isInteger(patientId)) {
    return res.status(400).json({ error: 'Invalid patient id.' });
  }

  const db = connect();
  const today = new Date().toISOString().slice(0, 10);

  const contract = db
    .prepare(
      `SELECT id, status, start_date, end_date
         FROM care_contracts
        WHERE doctor_id = ? AND patient_id = ?`
    )
    .get(doctorId, patientId);

  if (!contract || contract.status !== 'active') {
    return res.status(403).json({ error: 'No active contract with this patient.' });
  }
  if (contract.start_date && contract.start_date > today) {
    return res.status(403).json({ error: 'This contract has not started yet.' });
  }
  if (contract.end_date && contract.end_date < today) {
    return res.status(403).json({ error: 'This contract has expired.' });
  }

  req.contract = contract;
  next();
}

module.exports = { login, loadUser, requireAuth, requireRole, requireContract };
