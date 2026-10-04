'use strict';

const express = require('express');
const { connect, transaction } = require('../db');
const { requireAuth } = require('../auth');
const repo = require('../repo');

const router = express.Router();

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Client sends [0..6] where 0 = Sunday, matching Date#getDay().
function bitmaskFromDays(days) {
  if (!Array.isArray(days) || days.length === 0) return null;
  let mask = 0;
  for (const d of days) {
    const n = Number(d);
    if (!Number.isInteger(n) || n < 0 || n > 6) return null;
    mask |= 1 << n;
  }
  return mask;
}

function parseMedicinePayload(body, { requireSchedules }) {
  const name = String(body.name || '').trim();
  const dosage = String(body.dosage || '').trim();

  if (!name) return { error: 'Medicine name is required.' };
  if (name.length > 120) return { error: 'Name is too long.' };
  if (!dosage) return { error: 'Dosage is required (e.g. "500 mg").' };
  if (dosage.length > 60) return { error: 'Dosage is too long.' };

  const instructions = body.instructions ? String(body.instructions).trim().slice(0, 400) : null;
  const start_date = body.start_date || new Date().toISOString().slice(0, 10);
  if (!DATE_RE.test(start_date)) return { error: 'start_date must be YYYY-MM-DD.' };

  let end_date = null;
  if (body.end_date) {
    const candidate = String(body.end_date);
    if (!DATE_RE.test(candidate)) return { error: 'end_date must be YYYY-MM-DD.' };
    if (candidate < start_date) return { error: 'end_date cannot precede start_date.' };
    end_date = candidate;
  }

  const schedules = [];
  const raw = Array.isArray(body.schedules) ? body.schedules : [];
  for (const s of raw) {
    const time = String(s.time || '').trim();
    if (!TIME_RE.test(time)) return { error: `Invalid time "${time}". Use HH:MM (24h).` };
    const mask = bitmaskFromDays(s.days);
    if (mask === null) return { error: 'Each schedule needs at least one valid weekday (0=Sun..6=Sat).' };
    schedules.push({ time, mask });
  }

  if (requireSchedules && schedules.length === 0) {
    return { error: 'Add at least one reminder time.' };
  }

  const HEX_RE = /^#[0-9a-fA-F]{3,8}$/;
  const color = HEX_RE.test(String(body.color || '')) ? String(body.color) : '#4f8ef7';

  return { medicine: { name, dosage, instructions, start_date, end_date, color }, schedules };
}

router.use(requireAuth);

router.get('/', (req, res) => {
  const patientId = req.user.patient_id;
  if (!patientId) return res.status(403).json({ error: 'Patient-only endpoint.' });

  // Active only by default; `?all=1` also returns discontinued medicines so a
  // patient can see their history.
  const includeInactive = req.query.all === '1';

  res.json({ medicines: repo.getMedicines(patientId, { includeInactive }) });
});

router.post('/', (req, res) => {
  const patientId = req.user.patient_id;
  if (!patientId) return res.status(403).json({ error: 'Patient-only endpoint.' });

  const parsed = parseMedicinePayload(req.body || {}, { requireSchedules: true });
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const db = connect();
  const { medicine, schedules } = parsed;

  const id = transaction(db, () => {
    const medId = db
      .prepare(
        `INSERT INTO medicines (patient_id, name, dosage, instructions, color, start_date, end_date)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        patientId,
        medicine.name,
        medicine.dosage,
        medicine.instructions,
        medicine.color,
        medicine.start_date,
        medicine.end_date
      ).lastInsertRowid;

    const addSched = db.prepare(
      `INSERT INTO dose_schedules (medicine_id, time_of_day, days_of_week, start_date, end_date)
       VALUES (?, ?, ?, ?, ?)`
    );
    for (const s of schedules) {
      addSched.run(medId, s.time, s.mask, medicine.start_date, medicine.end_date);
    }
    return medId;
  });

  res.status(201).json({ id, ok: true });
});

// PATCH is also used to toggle a medicine off without destroying its history.
router.patch('/:id', (req, res) => {
  const patientId = req.user.patient_id;
  if (!patientId) return res.status(403).json({ error: 'Patient-only endpoint.' });

  const db = connect();
  const medId = Number(req.params.id);
  const med = db.prepare('SELECT * FROM medicines WHERE id = ? AND patient_id = ?').get(medId, patientId);
  if (!med) return res.status(404).json({ error: 'Medicine not found.' });

  const body = req.body || {};
  const active = body.active === undefined ? med.active : body.active ? 1 : 0;

  try {
    transaction(db, () => {
      db.prepare('UPDATE medicines SET active = ? WHERE id = ?').run(active, medId);

      if (Array.isArray(body.schedules)) {
        const parsed = parseMedicinePayload(
          { name: med.name, dosage: med.dosage, start_date: med.start_date, schedules: body.schedules },
          { requireSchedules: active === 1 }
        );
        if (parsed.error) throw new Error(parsed.error);
        db.prepare('DELETE FROM dose_schedules WHERE medicine_id = ?').run(medId);
        const addSched = db.prepare(
          `INSERT INTO dose_schedules (medicine_id, time_of_day, days_of_week, start_date, end_date)
           VALUES (?, ?, ?, ?, ?)`
        );
        for (const s of parsed.schedules) {
          addSched.run(medId, s.time, s.mask, med.start_date, med.end_date);
        }
      }
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  res.json({ ok: true, active });
});

router.delete('/:id', (req, res) => {
  const patientId = req.user.patient_id;
  if (!patientId) return res.status(403).json({ error: 'Patient-only endpoint.' });

  const db = connect();
  const medId = Number(req.params.id);
  const med = db.prepare('SELECT id FROM medicines WHERE id = ? AND patient_id = ?').get(medId, patientId);
  if (!med) return res.status(404).json({ error: 'Medicine not found.' });

  // Soft delete: keeps dose history intact for the doctor's reports.
  db.prepare('UPDATE medicines SET active = 0 WHERE id = ?').run(medId);
  res.json({ ok: true });
});

module.exports = router;
