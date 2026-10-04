'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildOccurrences,
  summarize,
  missedByMedicine,
  addDays,
  dayOfWeekBit
} = require('../src/schedule');

// Fixed reference point: Sunday 2026-10-04, midday UTC.
const NOW = new Date('2026-10-04T12:00:00Z');
const TODAY = '2026-10-04';

function sched(overrides = {}) {
  return {
    id: 1,
    medicine_id: 1,
    time_of_day: '08:00',
    days_of_week: 127,
    start_date: '2026-09-01',
    end_date: null,
    name: 'Metformin',
    dosage: '500 mg',
    instructions: null,
    color: '#4f8ef7',
    active: 1,
    med_start: '2026-09-01',
    med_end: null,
    ...overrides
  };
}

function log(occurrence, status, medicineId = 1) {
  return { medicine_id: medicineId, occurrence, status, note: null, logged_at: occurrence };
}

function build(schedules, logs, opts = {}) {
  return buildOccurrences({
    schedules,
    logs,
    from: opts.from || TODAY,
    to: opts.to || TODAY,
    now: opts.now || NOW,
    graceMinutes: opts.graceMinutes === undefined ? 60 : opts.graceMinutes
  });
}

test('a dose past its grace window with no log is missed', () => {
  const occ = build([sched({ time_of_day: '08:00' })], []);
  assert.equal(occ.length, 1);
  assert.equal(occ[0].status, 'missed');
  assert.equal(occ[0].occurrence, '2026-10-04T08:00:00Z');
});

test('a dose still inside its grace window is due, not missed', () => {
  // 11:30 scheduled, now 12:00 -> 30 min elapsed, grace is 60 min.
  const occ = build([sched({ time_of_day: '11:30' })], []);
  assert.equal(occ[0].status, 'due');
});

test('a future dose is upcoming', () => {
  const occ = build([sched({ time_of_day: '13:00' })], []);
  assert.equal(occ[0].status, 'upcoming');
});

test('a logged dose reports its log status even when past grace', () => {
  const occ = build([sched({ time_of_day: '08:00' })], [log('2026-10-04T08:00:00Z', 'taken')]);
  assert.equal(occ[0].status, 'taken');
});

test('a deliberate skip is recorded as skipped, not missed', () => {
  const occ = build([sched({ time_of_day: '08:00' })], [log('2026-10-04T08:00:00Z', 'skipped')]);
  assert.equal(occ[0].status, 'skipped');
});

test('an early dose logged ahead of schedule is honoured', () => {
  // Scheduled for 14:00, patient takes it at 12:00.
  const occ = build([sched({ time_of_day: '14:00' })], [log('2026-10-04T14:00:00Z', 'taken')]);
  assert.equal(occ[0].status, 'taken');
});

test('absence of a log is the only missed signal', () => {
  // Same schedule, with and without a log -> opposite outcomes.
  const missed = build([sched({ time_of_day: '08:00' })], [log('2026-10-04T02:00:00Z', 'taken')]);
  assert.equal(missed[0].status, 'missed', 'a log on a different occurrence must not mask this one');
});

test('grace period is configurable', () => {
  const strict = build([sched({ time_of_day: '11:30' })], [], { graceMinutes: 0 });
  assert.equal(strict[0].status, 'missed');

  const generous = build([sched({ time_of_day: '08:00' })], [], { graceMinutes: 600 });
  assert.equal(generous[0].status, 'due');
});

test('days_of_week filters non-matching days', () => {
  const weekdayOnly = sched({ days_of_week: 62 }); // bits 1..5 = Mon-Fri
  const occ = build([weekdayOnly], []);

  // TODAY is a Sunday, so a Mon-Fri schedule must produce nothing.
  const dow = new Date(`${TODAY}T00:00:00Z`).getUTCDay();
  assert.equal(dow, 0, 'fixture assumes TODAY is a Sunday');
  assert.equal(occ.length, 0);
});

test('days_of_week bitmask matches getDay() numbering (0 = Sunday)', () => {
  assert.equal(dayOfWeekBit('2026-10-04'), 1); // Sunday
  assert.equal(dayOfWeekBit('2026-10-05'), 2); // Monday
  assert.equal(dayOfWeekBit('2026-10-10'), 64); // Saturday
});

test('schedule start_date excludes earlier days', () => {
  const occ = build([sched({ start_date: '2026-10-05' })], []); // starts tomorrow
  assert.equal(occ.length, 0);
});

test('schedule end_date excludes later days', () => {
  const occ = build([sched({ end_date: '2026-10-03' })], []);
  assert.equal(occ.length, 0);
});

test('medicine end_date caps the whole schedule', () => {
  const occ = build([sched({ med_end: '2026-10-03' })], []);
  assert.equal(occ.length, 0);
});

test('inactive medicines produce no occurrences', () => {
  const occ = build([sched({ active: 0 })], []);
  assert.equal(occ.length, 0);
});

test('window bounds are respected on both sides', () => {
  const occ = build([sched({ time_of_day: '08:00' })], [], { from: '2026-10-02', to: '2026-10-04' });
  assert.deepEqual(
    occ.map((o) => o.occurrence),
    ['2026-10-02T08:00:00Z', '2026-10-03T08:00:00Z', '2026-10-04T08:00:00Z']
  );
  assert.deepEqual(occ.map((o) => o.status), ['missed', 'missed', 'missed']);
});

test('multiple daily times on one medicine each get their own occurrence', () => {
  const occ = build(
    [sched({ time_of_day: '08:00' }), sched({ id: 2, time_of_day: '20:00' })],
    [],
    { from: '2026-10-04', to: '2026-10-04' }
  );
  assert.deepEqual(
    occ.map((o) => o.time_of_day),
    ['08:00', '20:00']
  );
});

test('occurrences are sorted chronologically', () => {
  const occ = build(
    [
      sched({ id: 3, time_of_day: '22:00', medicine_id: 3, name: 'Zinc' }),
      sched({ id: 1, time_of_day: '08:00' }),
      sched({ id: 2, time_of_day: '13:00', medicine_id: 2, name: 'VitD' })
    ],
    [],
    { from: '2026-10-04', to: '2026-10-04' }
  );
  assert.deepEqual(
    occ.map((o) => o.time_of_day),
    ['08:00', '13:00', '22:00']
  );
});

test('identical medicine + time pairs are deduplicated', () => {
  const occ = build([sched({ id: 1 }), sched({ id: 2, time_of_day: '08:00' })], []);
  assert.equal(occ.length, 1, 'two schedule rows for the same dose must collapse to one occurrence');
});

// --- summarize -----------------------------------------------------------

test('summarise excludes upcoming, due and skipped from adherence', () => {
  const occ = [
    { status: 'taken' },
    { status: 'taken' },
    { status: 'missed' },
    { status: 'skipped' },
    { status: 'due' },
    { status: 'upcoming' }
  ];
  const s = summarize(occ);

  assert.equal(s.taken, 2);
  assert.equal(s.missed, 1);
  assert.equal(s.skipped, 1);
  assert.equal(s.due, 1);
  assert.equal(s.upcoming, 1);
  assert.equal(s.decided, 3, 'only taken + missed are decided');
  assert.equal(s.adherence_rate, 2 / 3);
});

test('summarise on an empty window returns a null rate, not NaN', () => {
  const s = summarize([]);
  assert.equal(s.adherence_rate, null);
  assert.equal(s.decided, 0);
  assert.equal(s.total, 0);
});

test('perfect adherence is 1', () => {
  const s = summarize([{ status: 'taken' }, { status: 'taken' }]);
  assert.equal(s.adherence_rate, 1);
});

// --- missedByMedicine ----------------------------------------------------

test('missed doses are grouped by medicine, most frequent first', () => {
  const occ = [
    { status: 'missed', medicine_id: 1, medicine_name: 'Metformin', color: '#a', occurrence: 'o1' },
    { status: 'missed', medicine_id: 1, medicine_name: 'Metformin', color: '#a', occurrence: 'o2' },
    { status: 'missed', medicine_id: 2, medicine_name: 'VitD', color: '#b', occurrence: 'o3' },
    { status: 'taken', medicine_id: 3, medicine_name: 'Ignored', color: '#c', occurrence: 'o4' }
  ];
  const rows = missedByMedicine(occ);

  assert.equal(rows.length, 2, 'taken doses must not appear');
  assert.equal(rows[0].medicine_name, 'Metformin');
  assert.equal(rows[0].count, 2);
  assert.equal(rows[1].count, 1);
  assert.deepEqual(rows[0].occurrences, ['o1', 'o2']);
});

// --- date helpers --------------------------------------------------------

test('addDays crosses month and year boundaries', () => {
  assert.equal(addDays('2026-10-01', -1), '2026-09-30');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(addDays('2026-10-04', 0), '2026-10-04');
});
