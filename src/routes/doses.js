'use strict';

const express = require('express');
const { connect } = require('../db');
const { requireAuth, requireContract, requireRole } = require('../auth');
const repo = require('../repo');
const { buildOccurrences, summarize, addDays, toISODate } = require('../schedule');

const router = express.Router();

// Default window: 7 days ending today (yesterday .. today + rest of today).
function windowFromQuery(query) {
  const today = toISODate(new Date());
  let from = query.from || addDays(today, -6);
  let to = query.to || today;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return null;
  }
  if (from > to) [from, to] = [to, from];

  // Cap the span so one request cannot walk every row in the database.
  const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000;
  if (span > 400) return null;

  return { from, to };
}

function occurrencesFor(patientId, from, to) {
  const prefs = repo.getPrefs(patientId);
  return buildOccurrences({
    schedules: repo.getSchedules(patientId),
    logs: repo.getLogs(patientId, from, to),
    from,
    to,
    now: new Date(),
    graceMinutes: prefs.grace_minutes
  });
}

// GET /api/doses?from=&to=&patientId=  (patientId only for contracted doctors)
router.get('/', requireAuth, (req, res) => {
  let patientId = req.user.patient_id;

  if (req.user.role === 'doctor') {
    // Walk through the same contract guard a full detail route uses.
    const pid = Number(req.query.patientId);
    if (!Number.isInteger(pid)) {
      return res.status(400).json({ error: 'A patientId is required for a doctor.' });
    }
    req.params.patientId = pid;
    requireContract(req, res, () => {
      patientId = pid;
      sendDoses();
    });
    return;
  }

  sendDoses();

  function sendDoses() {
    const win = windowFromQuery(req.query);
    if (!win) {
      return res.status(400).json({ error: 'Invalid from/to dates.' });
    }
    const occurrences = occurrencesFor(patientId, win.from, win.to);
    res.json({ from: win.from, to: win.to, occurrences, summary: summarize(occurrences) });
  }
});

// POST /api/doses/log { medicine_id, occurrence, status, note? }
router.post('/log', requireAuth, (req, res) => {
  const { medicine_id, occurrence, status, note } = req.body || {};

  if (!['taken', 'skipped'].includes(status)) {
    return res.status(400).json({ error: "status must be 'taken' or 'skipped'." });
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(String(occurrence || ''))) {
    return res.status(400).json({ error: 'Malformed occurrence timestamp.' });
  }

  const patientId = req.user.patient_id;
  if (!patientId) {
    return res.status(403).json({ error: 'Only patients can log doses.' });
  }

  const medId = Number(medicine_id);
  if (!Number.isInteger(medId)) {
    return res.status(400).json({ error: 'Malformed medicine_id.' });
  }

  const db = connect();

  const medicine = db
    .prepare('SELECT id, patient_id FROM medicines WHERE id = ?')
    .get(medId);
  if (!medicine || medicine.patient_id !== patientId) {
    return res.status(404).json({ error: 'That medicine is not yours.' });
  }

  // The occurrence must correspond to a real scheduled dose; this blocks
  // inventing dose history that never existed in the schedule.
  const day = String(occurrence).slice(0, 10);
  const valid = occurrencesFor(patientId, day, day).some(
    (o) => o.occurrence === occurrence && o.medicine_id === medId
  );
  if (!valid) {
    return res.status(404).json({ error: 'No scheduled dose at that time.' });
  }

  db.prepare(
    `INSERT INTO dose_logs (patient_id, medicine_id, occurrence, status, note)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (medicine_id, occurrence)
     DO UPDATE SET status = excluded.status,
                   note = excluded.note,
                   logged_at = datetime('now')`
  ).run(patientId, medId, occurrence, status, note || null);

  const win = windowFromQuery(req.query);
  const finalWin = win || windowFromQuery({});
  const occurrences = occurrencesFor(patientId, finalWin.from, finalWin.to);

  res.json({
    ok: true,
    occurrences,
    summary: summarize(occurrences)
  });
});

// DELETE /api/doses/log?medicine_id=&occurrence=  — undo a mis-tap.
router.delete('/log', requireAuth, (req, res) => {
  const patientId = req.user.patient_id;
  if (!patientId) return res.status(403).json({ error: 'Patient-only endpoint.' });

  const medId = Number(req.query.medicine_id);
  const occurrence = String(req.query.occurrence || '');

  if (!Number.isInteger(medId)) return res.status(400).json({ error: 'Malformed medicine_id.' });
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(occurrence)) {
    return res.status(400).json({ error: 'Malformed occurrence timestamp.' });
  }

  const db = connect();
  const info = db
    .prepare('DELETE FROM dose_logs WHERE patient_id = ? AND medicine_id = ? AND occurrence = ?')
    .run(patientId, medId, occurrence);

  res.json({ ok: true, removed: Number(info.changes) });
});

// GET /api/doses/upcoming — poll target for the reminder timer.
router.get('/upcoming', requireAuth, (req, res) => {
  if (req.user.role !== 'patient') {
    return res.status(403).json({ error: 'Reminders are patient-only.' });
  }

  const patientId = req.user.patient_id;
  const today = toISODate(new Date());
  const from = addDays(today, -1);
  const to = addDays(today, 1);

  const occurrences = occurrencesFor(patientId, from, to);

  res.json({
    now: new Date().toISOString(),
    grace_minutes: repo.getPrefs(patientId).grace_minutes,
    // "due" and "upcoming" are what the client should alert on.
    pending: occurrences.filter((o) => o.status === 'due' || o.status === 'upcoming'),
    missed_today: occurrences.filter(
      (o) => o.status === 'missed' && o.occurrence.slice(0, 10) === today
    )
  });
});

router.get('/summary', requireAuth, (req, res) => {
  if (req.user.role !== 'patient') {
    return res.status(403).json({ error: 'Patient-only endpoint.' });
  }
  const today = toISODate(new Date());
  const from = req.query.from || addDays(today, -6);
  const to = req.query.to || today;
  const occurrences = occurrencesFor(req.user.patient_id, from, to);
  res.json({ from, to, occurrences, summary: summarize(occurrences) });
});

module.exports = router;
