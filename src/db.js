'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'caretaker.db');

let db = null;

function connect() {
  if (db) return db;

  if (DB_PATH !== ':memory:') {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  }

  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      email         TEXT    NOT NULL UNIQUE,
      password_hash TEXT    NOT NULL,
      role          TEXT    NOT NULL CHECK (role IN ('patient','doctor')),
      full_name     TEXT    NOT NULL,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS patients (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      dob        TEXT,
      phone      TEXT,
      timezone   TEXT    NOT NULL DEFAULT 'UTC'
    );

    CREATE TABLE IF NOT EXISTS doctors (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      specialty       TEXT,
      registration_no TEXT
    );

    CREATE TABLE IF NOT EXISTS care_contracts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      doctor_id   INTEGER NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
      patient_id  INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
      status      TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
      start_date  TEXT    NOT NULL,
      end_date    TEXT,
      notes       TEXT,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE (doctor_id, patient_id)
    );

    CREATE TABLE IF NOT EXISTS medicines (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id    INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
      name          TEXT    NOT NULL,
      dosage        TEXT    NOT NULL,
      instructions  TEXT,
      color         TEXT    NOT NULL DEFAULT '#4f8ef7',
      active        INTEGER NOT NULL DEFAULT 1,
      start_date    TEXT    NOT NULL,
      end_date      TEXT,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS dose_schedules (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      medicine_id   INTEGER NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
      time_of_day   TEXT    NOT NULL,
      days_of_week  INTEGER NOT NULL DEFAULT 127,
      start_date    TEXT    NOT NULL,
      end_date      TEXT
    );

    CREATE TABLE IF NOT EXISTS dose_logs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id    INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
      medicine_id   INTEGER NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
      occurrence    TEXT    NOT NULL,
      status        TEXT    NOT NULL CHECK (status IN ('taken','skipped')),
      note          TEXT,
      logged_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE (medicine_id, occurrence)
    );

    CREATE TABLE IF NOT EXISTS reminder_prefs (
      patient_id    INTEGER PRIMARY KEY REFERENCES patients(id) ON DELETE CASCADE,
      grace_minutes INTEGER NOT NULL DEFAULT 60,
      notifications INTEGER NOT NULL DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_contracts_doctor ON care_contracts(doctor_id, status);
    CREATE INDEX IF NOT EXISTS idx_contracts_patient ON care_contracts(patient_id, status);
    CREATE INDEX IF NOT EXISTS idx_meds_patient     ON medicines(patient_id, active);
    CREATE INDEX IF NOT EXISTS idx_sched_medicine   ON dose_schedules(medicine_id);
    CREATE INDEX IF NOT EXISTS idx_logs_patient_occ ON dose_logs(patient_id, occurrence);
    CREATE INDEX IF NOT EXISTS idx_logs_medicine    ON dose_logs(medicine_id, occurrence);
  `);
}

// node:sqlite's DatabaseSync exposes no transaction() helper, so wrap one.
// Not re-entrant: call sites must not nest transactions.
function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    throw err;
  }
}

function reset() {
  if (DB_PATH !== ':memory:' && fs.existsSync(DB_PATH)) {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = DB_PATH + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  }
  db = null;
  connect();
}

function close() {
  if (db) {
    db.close();
    db = null;
  }
}

const SEED_PASSWORD = process.env.SEED_PASSWORD || 'password123';

function seed() {
  const database = connect();
  const bcrypt = require('bcryptjs');

  const existing = database.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (existing > 0) {
    console.log('Database already has %d user(s); skipping seed.', existing);
    return;
  }

  const hash = (pw) => bcrypt.hashSync(pw, 10);
  const today = new Date().toISOString().slice(0, 10);
  const contractStart = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

  const createUser = database.prepare(
    'INSERT INTO users (email, password_hash, role, full_name) VALUES (?, ?, ?, ?)'
  );
  const addPatient = database.prepare(
    'INSERT INTO patients (user_id, dob, phone, timezone) VALUES (?, ?, ?, ?)'
  );
  const addDoctor = database.prepare(
    'INSERT INTO doctors (user_id, specialty, registration_no) VALUES (?, ?, ?)'
  );
  const addContract = database.prepare(
    `INSERT INTO care_contracts (doctor_id, patient_id, status, start_date, notes)
     VALUES (?, ?, 'active', ?, ?)`
  );
  const addMed = database.prepare(
    `INSERT INTO medicines (patient_id, name, dosage, instructions, color, start_date)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const addSchedule = database.prepare(
    'INSERT INTO dose_schedules (medicine_id, time_of_day, days_of_week, start_date) VALUES (?, ?, ?, ?)'
  );
  const addPref = database.prepare(
    'INSERT INTO reminder_prefs (patient_id, grace_minutes, notifications) VALUES (?, ?, ?)'
  );

  const run = () => {
    // Patients
    const adaId = createUser.run(
      'ada@example.com', hash(SEED_PASSWORD), 'patient', 'Ada Sharma'
    ).lastInsertRowid;
    const adaPatientId = addPatient.run(adaId, '1992-04-18', '+1-555-0142', 'UTC').lastInsertRowid;
    addPref.run(adaPatientId, 60, 1);

    const benId = createUser.run(
      'ben@example.com', hash(SEED_PASSWORD), 'patient', 'Ben Carter'
    ).lastInsertRowid;
    const benPatientId = addPatient.run(benId, '1985-11-02', '+1-555-0198', 'UTC').lastInsertRowid;
    addPref.run(benPatientId, 60, 1);

    // Doctors
    const miraId = createUser.run(
      'dr.mira@example.com', hash(SEED_PASSWORD), 'doctor', 'Dr. Mira Okafor'
    ).lastInsertRowid;
    const miraDoctorId = addDoctor.run(miraId, 'Internal Medicine', 'MD-40213').lastInsertRowid;

    const finnId = createUser.run(
      'dr.finn@example.com', hash(SEED_PASSWORD), 'doctor', 'Dr. Finn Delacroix'
    ).lastInsertRowid;
    const finnDoctorId = addDoctor.run(finnId, 'Endocrinology', 'MD-77819').lastInsertRowid;

    // Contracts: Mira covers both patients. Finn covers only Ben.
    addContract.run(miraDoctorId, adaPatientId, contractStart, 'Primary care, quarterly review');
    addContract.run(miraDoctorId, benPatientId, contractStart, 'Post-surgery medication monitoring');
    addContract.run(finnDoctorId, benPatientId, contractStart, 'Endocrine follow-up');

    // Medicines must start before the seeded history window, or buildOccurrences
    // would filter every historical day out of range.
    const seedStart = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

    // Ada's medicines
    const metforminId = addMed.run(
      adaPatientId, 'Metformin', '500 mg', 'Take with food', '#4f8ef7', seedStart
    ).lastInsertRowid;
    addSchedule.run(metforminId, '08:00', 127, seedStart);
    addSchedule.run(metforminId, '20:00', 127, seedStart);

    const vitaminDId = addMed.run(
      adaPatientId, 'Vitamin D3', '2000 IU', 'Take in the morning', '#f7b24f', seedStart
    ).lastInsertRowid;
    addSchedule.run(vitaminDId, '09:00', 62, seedStart); // weekdays only (Mon-Fri)

    const atorvaId = addMed.run(
      adaPatientId, 'Atorvastatin', '20 mg', 'At bedtime', '#e06a6a', seedStart
    ).lastInsertRowid;
    addSchedule.run(atorvaId, '22:00', 127, seedStart);

    // Ben's medicines
    const levoId = addMed.run(
      benPatientId, 'Levothyroxine', '50 mcg', 'Empty stomach, 30 min before food', '#4fd7c1', seedStart
    ).lastInsertRowid;
    addSchedule.run(levoId, '06:30', 127, seedStart);

    const amoxId = addMed.run(
      benPatientId, 'Amoxicillin', '500 mg', 'Complete the full course', '#b46af7', seedStart
    ).lastInsertRowid;
    addSchedule.run(amoxId, '12:00', 127, seedStart);
    addSchedule.run(amoxId, '18:00', 127, seedStart);

    // Historic adherence so the doctor dashboard has something real to show.
    const logDose = database.prepare(
      `INSERT OR IGNORE INTO dose_logs (patient_id, medicine_id, occurrence, status, logged_at)
       VALUES (?, ?, ?, ?, ?)`
    );

    const seedHistory = (patientId, medId, dayOffset, times, skip = []) => {
      for (const time of times) {
        const d = new Date();
        d.setUTCDate(d.getUTCDate() - dayOffset);
        const occ = `${d.toISOString().slice(0, 10)}T${time}:00Z`;
        if (skip.includes(dayOffset)) continue;
        logDose.run(patientId, medId, occ, 'taken', occ);
      }
    };

    // Ada: 6 days of near-perfect adherence, deliberately missed a few doses.
    for (let day = 1; day <= 6; day++) {
      seedHistory(adaPatientId, metforminId, day, ['08:00', '20:00'], [day === 3 ? day : -1]);
      seedHistory(adaPatientId, atorvaId, day, ['22:00'], [day === 3 || day === 5 ? day : -1]);
      seedHistory(adaPatientId, vitaminDId, day, ['09:00']);
    }

    // Ben: noticeably worse adherence, including a completely missed day.
    for (let day = 1; day <= 6; day++) {
      if (day === 4) continue;
      seedHistory(benPatientId, levoId, day, ['06:30'], [day === 2 ? day : -1]);
      seedHistory(benPatientId, amoxId, day, ['12:00', '18:00'], [day === 2 ? day : -1]);
    }
  };

  transaction(database, run);

  console.log('Seeded demo accounts (password: %s):', SEED_PASSWORD);
  console.log('  patient  ada@example.com');
  console.log('  patient  ben@example.com');
  console.log('  doctor   dr.mira@example.com   (contracts: Ada, Ben)');
  console.log('  doctor   dr.finn@example.com   (contract: Ben only)');
}

module.exports = { connect, reset, close, seed, transaction, DB_PATH };
