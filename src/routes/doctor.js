'use strict';

const express = require('express');
const { connect } = require('../db');
const { requireAuth, requireRole, requireContract } = require('../auth');
const repo = require('../repo');
const { buildOccurrences, summarize, missedByMedicine, addDays, toISODate } = require('../schedule');

const router = express.Router();

router.use(requireAuth, requireRole('doctor'));

// Rolling window used for every summary in this router.
function windowFor(days = 7) {
  const today = toISODate(new Date());
  return { from: addDays(today, -(days - 1)), to: today };
}

// GET /api/doctor/patients
// Every patient this doctor has an active contract with, with adherence.
router.get('/patients', (req, res) => {
  const db = connect();
  const today = toISODate(new Date());
  const { from, to } = windowFor(7);

  const rows = db
    .prepare(
      `SELECT c.id AS contract_id, c.status, c.start_date, c.end_date, c.notes,
              p.id AS patient_id, p.dob, p.phone,
              u.full_name, u.email
         FROM care_contracts c
         JOIN patients p ON p.id = c.patient_id
         JOIN users u    ON u.id = p.user_id
        WHERE c.doctor_id = ?
        ORDER BY u.full_name`
    )
    .all(req.user.doctor_id);

  const patients = rows.map((row) => {
    const contractActive =
      row.status === 'active' &&
      (!row.start_date || row.start_date <= today) &&
      (!row.end_date || row.end_date >= today);

    if (!contractActive) {
      return { ...row, contract_active: false, summary: null, last_dose: null };
    }

    const occ = occurrencesFor(row.patient_id, from, to);
    return {
      ...row,
      contract_active: true,
      summary: summarize(occ),
      missed: occ.filter((o) => o.status === 'missed'),
      last_dose: lastTaken(row.patient_id)
    };
  });

  res.json({ from, to, patients });
});

// GET /api/doctor/patients/:patientId
// Full read-only adherence view for one contracted patient.
router.get('/patients/:patientId', requireContract, (req, res) => {
  const patientId = Number(req.params.patientId);
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
  const { from, to } = windowFor(days);

  const db = connect();
  const patient = db
    .prepare(
      `SELECT p.id, p.dob, p.phone, u.full_name, u.email
         FROM patients p JOIN users u ON u.id = p.user_id
        WHERE p.id = ?`
    )
    .get(patientId);

  if (!patient) return res.status(404).json({ error: 'Patient not found.' });

  const occurrences = occurrencesFor(patientId, from, to);
  const medicines = repo.getMedicines(patientId, { includeInactive: true });

  res.json({
    patient,
    from,
    to,
    days,
    summary: summarize(occurrences),
    occurrences,
    missed_by_medicine: missedByMedicine(occurrences),
    missed_doses: occurrences.filter((o) => o.status === 'missed'),
    medicines,
    contract: req.contract
  });
});

// GET /api/doctor/missed?days=30
// Every missed dose across all of this doctor's active contracts.
router.get('/missed', (req, res) => {
  const db = connect();
  const today = toISODate(new Date());
  const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 365);
  const { from, to } = windowFor(days);

  const rows = db
    .prepare(
      `SELECT p.id AS patient_id, u.full_name
         FROM care_contracts c
         JOIN patients p ON p.id = c.patient_id
         JOIN users u    ON u.id = p.user_id
        WHERE c.doctor_id = ?
          AND c.status = 'active'
          AND (c.start_date IS NULL OR c.start_date <= ?)
          AND (c.end_date   IS NULL OR c.end_date   >= ?)
        ORDER BY u.full_name`
    )
    .all(req.user.doctor_id, today, today);

  const patients = rows.map((r) => {
    const occ = occurrencesFor(r.patient_id, from, to);
    const missed = occ.filter((o) => o.status === 'missed');
    return {
      patient_id: r.patient_id,
      full_name: r.full_name,
      summary: summarize(occ),
      missed_count: missed.length,
      missed_by_medicine: missedByMedicine(occ),
      missed_doses: missed
    };
  });

  res.json({ from, to, days, patients });
});

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

function lastTaken(patientId) {
  const db = connect();
  return (
    db
      .prepare(
        `SELECT occurrence, logged_at
           FROM dose_logs
          WHERE patient_id = ? AND status = 'taken'
          ORDER BY occurrence DESC
          LIMIT 1`
      )
      .get(patientId) || null
  );
}

module.exports = router;
