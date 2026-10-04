'use strict';

// Dose occurrence derivation.
//
// Occurrences are derived on the fly from schedules rather than materialised
// into rows ahead of time. A dose is "missed" when it is past its grace window
// and nobody recorded it as taken or skipped. Absence of a log IS the missed
// signal, which means adherence cannot drift out of sync with reality.

const ALL_DAYS = 127;
const MS_PER_DAY = 86400000;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function toISODate(d) {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

// Build the canonical occurrence key for a schedule firing on a given date.
function occurrenceKey(dateISO, timeOfDay) {
  return `${dateISO}T${timeOfDay}:00Z`;
}

function dayOfWeekBit(dateISO) {
  const t = Date.parse(`${dateISO}T00:00:00Z`);
  return 1 << new Date(t).getUTCDay();
}

// Does `dateISO` fall inside [start, end] (either side optional)?
function within(dateISO, start, end) {
  if (start && dateISO < start) return false;
  if (end && dateISO > end) return false;
  return true;
}

/**
 * Derive every dose occurrence in [from, to] inclusive.
 *
 * @param {object}   input
 * @param {Array}    input.schedules   rows carrying medicine + schedule fields
 * @param {Array}    input.logs        dose_logs rows (raw)
 * @param {string}   input.from        YYYY-MM-DD inclusive
 * @param {string}   input.to          YYYY-MM-DD inclusive
 * @param {Date}     input.now
 * @param {number}   input.graceMinutes grace period before a dose counts as missed
 * @returns {Array<{occurrence, status, ...}>}
 */
function buildOccurrences({ schedules = [], logs = [], from, to, now = new Date(), graceMinutes = 60 }) {
  const nowMs = now.getTime();
  const graceMs = Math.max(0, graceMinutes) * 60000;

  const logByMed = new Map();
  for (const log of logs) {
    logByMed.set(`${log.medicine_id}|${log.occurrence}`, log);
  }

  const out = [];
  const seen = new Set();

  for (const s of schedules) {
    if (!s.active) continue;

    const medStart = s.med_start || s.start_date;
    const medEnd = s.med_end || s.end_date;
    const schedStart = s.start_date;
    const schedEnd = s.end_date;

    const rangeStart = maxDate(from, schedStart, medStart);
    const rangeEnd = minDate(to, schedEnd, medEnd);
    if (!rangeStart || !rangeEnd || rangeStart > rangeEnd) continue;

    let cursor = Date.parse(`${rangeStart}T00:00:00Z`);
    const endMs = Date.parse(`${rangeEnd}T00:00:00Z`);

    for (; cursor <= endMs; cursor += MS_PER_DAY) {
      const dateISO = toISODate(new Date(cursor));

      const bit = dayOfWeekBit(dateISO);
      if ((s.days_of_week & bit) === 0) continue;

      const occurrence = occurrenceKey(dateISO, s.time_of_day);
      const dedupeKey = `${s.medicine_id}|${occurrence}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const occMs = Date.parse(occurrence);
      const log = logByMed.get(dedupeKey);

      let status;
      if (log) {
        status = log.status;
      } else if (occMs > nowMs) {
        status = 'upcoming';
      } else if (nowMs - occMs <= graceMs) {
        status = 'due';
      } else {
        status = 'missed';
      }

      out.push({
        occurrence,
        occurrence_ms: occMs,
        status,
        schedule_id: s.id,
        medicine_id: s.medicine_id,
        medicine_name: s.name,
        dosage: s.dosage,
        instructions: s.instructions,
        color: s.color,
        time_of_day: s.time_of_day,
        note: log ? log.note : null,
        logged_at: log ? log.logged_at : null
      });
    }
  }

  out.sort((a, b) => a.occurrence_ms - b.occurrence_ms || a.medicine_name.localeCompare(b.medicine_name));
  return out;
}

function maxDate(...parts) {
  const vals = parts.filter(Boolean);
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => (a > b ? a : b));
}

function minDate(...parts) {
  const vals = parts.filter(Boolean);
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => (a < b ? a : b));
}

/**
 * Roll occurrences up into adherence numbers.
 *
 * "due" and "upcoming" are excluded from the denominator because the patient
 * has not yet had the chance to act. "skipped" is excluded because it is a
 * deliberate clinician-sanctioned deviation, not a lapse.
 */
function summarize(occurrences) {
  const counts = { taken: 0, missed: 0, skipped: 0, due: 0, upcoming: 0 };

  for (const o of occurrences) {
    if (counts[o.status] === undefined) counts[o.status] = 0;
    counts[o.status] += 1;
  }

  const decided = counts.taken + counts.missed;
  const adherence_rate = decided > 0 ? counts.taken / decided : null;

  return {
    ...counts,
    decided,
    adherence_rate,
    total: occurrences.length
  };
}

// Count missed doses per medicine, for the doctor's breakdown table.
function missedByMedicine(occurrences) {
  const map = new Map();
  for (const o of occurrences) {
    if (o.status !== 'missed') continue;
    const row = map.get(o.medicine_id) || {
      medicine_id: o.medicine_id,
      medicine_name: o.medicine_name,
      color: o.color,
      count: 0,
      occurrences: []
    };
    row.count += 1;
    row.occurrences.push(o.occurrence);
    map.set(o.medicine_id, row);
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

// Shift a YYYY-MM-DD string by a number of days (UTC, DST-proof).
function addDays(dateISO, days) {
  const t = Date.parse(`${dateISO}T00:00:00Z`) + days * MS_PER_DAY;
  return toISODate(new Date(t));
}

module.exports = {
  ALL_DAYS,
  buildOccurrences,
  summarize,
  missedByMedicine,
  occurrenceKey,
  dayOfWeekBit,
  toISODate,
  addDays
};
