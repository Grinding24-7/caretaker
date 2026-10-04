'use strict';

const { connect } = require('./db');

// Schedules joined with their medicine, shaped for buildOccurrences().
function getSchedules(patientId) {
  const db = connect();
  return db
    .prepare(
      `SELECT s.id,
              s.medicine_id,
              s.time_of_day,
              s.days_of_week,
              s.start_date,
              s.end_date,
              m.name,
              m.dosage,
              m.instructions,
              m.color,
              m.active,
              m.start_date AS med_start,
              m.end_date   AS med_end
         FROM dose_schedules s
         JOIN medicines m ON m.id = s.medicine_id
        WHERE m.patient_id = ?`
    )
    .all(patientId);
}

function getLogs(patientId, from, to) {
  const db = connect();
  const start = `${from}T00:00:00Z`;
  const end = `${to}T23:59:59Z`;
  return db
    .prepare(
      `SELECT medicine_id, occurrence, status, note, logged_at
         FROM dose_logs
        WHERE patient_id = ? AND occurrence >= ? AND occurrence <= ?`
    )
    .all(patientId, start, end);
}

function getPrefs(patientId) {
  const db = connect();
  return (
    db.prepare('SELECT grace_minutes, notifications FROM reminder_prefs WHERE patient_id = ?').get(patientId) || {
      grace_minutes: 60,
      notifications: 1
    }
  );
}

function getMedicines(patientId, { includeInactive = false } = {}) {
  const db = connect();
  const sql = includeInactive
    ? `SELECT * FROM medicines WHERE patient_id = ? ORDER BY active DESC, name`
    : `SELECT * FROM medicines WHERE patient_id = ? AND active = 1 ORDER BY active DESC, name`;
  const meds = db.prepare(sql).all(patientId);

  // Consumers render times per medicine, so attach them here rather than
  // leaving every caller to re-query.
  const schedStmt = db.prepare(
    'SELECT id, time_of_day, days_of_week, start_date, end_date FROM dose_schedules WHERE medicine_id = ?'
  );
  return meds.map((m) => ({ ...m, schedules: schedStmt.all(m.id) }));
}

function patientExists(patientId) {
  const db = connect();
  return !!db.prepare('SELECT 1 FROM patients WHERE id = ?').get(patientId);
}

module.exports = { getSchedules, getLogs, getPrefs, getMedicines, patientExists };
