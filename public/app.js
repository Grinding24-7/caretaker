'use strict';

/* Caretaker — single-page medicine reminder dashboard.
   No framework, no build step. CSP forbids inline scripts/styles, so every
   listener is attached via addEventListener and every dynamic colour is set
   through the CSSOM rather than a style attribute. */

// ---------------------------------------------------------------- helpers

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

async function api(path, { method = 'GET', body } = {}) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON response */
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Occurrence keys are "YYYY-MM-DDTHH:MM:SSZ". We slice the components rather
// than round-tripping through Date, so displayed times never shift by a
// timezone offset relative to what the schedule intended.
const occDate = (occ) => String(occ).slice(0, 10);
const occTime = (occ) => String(occ).slice(11, 16);
const todayISO = () => new Date().toISOString().slice(0, 10);

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_ORDER = [0, 1, 2, 3, 4, 5, 6];

const PALETTE = ['#4f8ef7', '#e06a6a', '#f7b24f', '#4fd7c1', '#b46af7', '#42c76b', '#7c8aa5'];

function prettyDate(dateISO, today) {
  if (dateISO === today) return 'Today';
  if (dateISO === shiftDays(today, -1)) return 'Yesterday';
  if (dateISO === shiftDays(today, 1)) return 'Tomorrow';
  const d = new Date(`${dateISO}T00:00:00Z`);
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC'
  });
}

function shiftDays(dateISO, days) {
  const d = new Date(`${dateISO}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function pct(rate) {
  return rate === null || rate === undefined ? '—' : `${Math.round(rate * 100)}%`;
}

function ringColour(rate) {
  if (rate === null || rate === undefined) return 'var(--accent)';
  if (rate >= 0.85) return 'var(--green)';
  if (rate >= 0.6) return 'var(--amber)';
  return 'var(--red)';
}

// The adherence ring is driven by custom properties, which must be written
// through the CSSOM — a style attribute would be blocked by our CSP.
function applyRing(el, rate) {
  if (!el) return;
  const p = rate === null || rate === undefined ? 0 : Math.round(rate * 100);
  el.style.setProperty('--pct', String(p));
  el.style.setProperty('--ring-color', ringColour(rate));
}

const STATUS_LABEL = {
  taken: 'Taken',
  missed: 'Missed',
  due: 'Due now',
  upcoming: 'Upcoming',
  skipped: 'Skipped'
};

const STATUS_PILL = {
  taken: 'st-taken',
  missed: 'st-missed',
  due: 'st-due',
  upcoming: 'st-upcoming',
  skipped: 'st-skipped'
};

// ---------------------------------------------------------------- toasts

function toast(title, body = '', kind = '') {
  const stack = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind ? `t-${kind}` : ''}`;
  el.innerHTML = `<div class="t-title">${esc(title)}</div>${
    body ? `<div class="t-body">${esc(body)}</div>` : ''
  }`;
  stack.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .3s';
    setTimeout(() => el.remove(), 320);
  }, kind === 'reminder' ? 9000 : 4200);
}

function alertBox(message) {
  return `<div class="alert alert-danger"><div>${esc(message)}</div></div>`;
}

// ---------------------------------------------------------------- state

const state = {
  user: null,
  patientDetail: null,
  rangeDays: 7,
  doctorTab: 'patients',
  doses: null,
  medicines: [],
  pollTimer: null
};

// ---------------------------------------------------------------- auth

async function boot() {
  bindLogin();
  bindLogout();
  bindDemoChips();
  registerServiceWorker();

  try {
    const { user } = await api('/api/me');
    await enterApp(user);
  } catch {
    showLogin();
  }
}

function showLogin() {
  $('#view-login').hidden = false;
  $('#view-app').hidden = true;
}

async function enterApp(user) {
  state.user = user;
  $('#view-login').hidden = true;
  $('#view-app').hidden = false;
  $('#who-name').textContent = user.full_name;
  $('#who-role').textContent = user.role === 'doctor' ? 'Doctor' : 'Patient';

  if (user.role === 'patient') {
    await renderPatient();
    startReminders();
  } else {
    stopReminders();
    await renderDoctor();
  }
}

function bindLogin() {
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#login-btn');
    const box = $('#login-error');
    box.hidden = true;
    btn.disabled = true;
    btn.textContent = 'Signing in…';

    try {
      const { user } = await api('/api/auth/login', {
        method: 'POST',
        body: {
          email: $('#email').value.trim(),
          password: $('#password').value
        }
      });
      await enterApp(user);
    } catch (err) {
      box.textContent = err.message;
      box.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  });
}

function bindDemoChips() {
  $$('.chip[data-demo]').forEach((chip) => {
    chip.addEventListener('click', () => {
      $('#email').value = chip.dataset.demo;
      $('#password').value = 'password123';
      $('#password').focus();
    });
  });
}

function bindLogout() {
  $('#logout-btn').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    stopReminders();
    state.user = null;
    state.patientDetail = null;
    showLogin();
  });
}

// ---------------------------------------------------------------- patient

async function renderPatient() {
  const main = $('#main');
  main.innerHTML = '<div class="empty">Loading your schedule…</div>';

  try {
    const [doseData, medData] = await Promise.all([
      api('/api/doses'),
      api('/api/medicines')
    ]);
    state.doses = doseData;
    state.medicines = medData.medicines;
    paintPatient();
  } catch (err) {
    main.innerHTML = alertBox(err.message);
  }
}

function paintPatient() {
  const main = $('#main');
  const { occurrences, summary } = state.doses;
  const today = todayISO();

  const todays = occurrences.filter((o) => occDate(o.occurrence) === today);
  const pastMissed = occurrences.filter(
    (o) => o.status === 'missed' && occDate(o.occurrence) < today
  );
  const dueNow = todays.filter((o) => o.status === 'due');
  const missedToday = todays.filter((o) => o.status === 'missed');

  main.innerHTML = `
    ${renderPatientAlerts(dueNow, missedToday, pastMissed.length)}
    <div class="grid grid-main">
      <div>
        ${renderAdherenceCard(summary)}
        ${renderMedicinesCard()}
      </div>
      <div>
        ${renderDoseCard(todays, today)}
        ${renderMissedCard(pastMissed)}
      </div>
    </div>
  `;

  bindPatientActions();
  applyRing($('#main .ring'), summary.adherence_rate);
}

function renderPatientAlerts(dueNow, missedToday, pastMissedCount) {
  if (dueNow.length > 0) {
    const first = dueNow[0];
    return `<div class="alert alert-warn pulse">
      <div><strong>${dueNow.length} dose${dueNow.length > 1 ? 's' : ''} due right now</strong>
      ${esc(first.medicine_name)} ${esc(first.dosage)} — scheduled ${occTime(first.occurrence)}</div>
    </div>`;
  }
  if (missedToday.length > 0) {
    const names = [...new Set(missedToday.map((o) => o.medicine_name))].join(', ');
    return `<div class="alert alert-danger">
      <div><strong>${missedToday.length} dose${missedToday.length > 1 ? 's' : ''} missed today</strong>
      ${esc(names)}</div>
    </div>`;
  }
  if (pastMissedCount > 0) {
    return `<div class="alert alert-warn">
      <div><strong>You missed ${pastMissedCount} dose${pastMissedCount > 1 ? 's' : ''} earlier this week</strong>
      Review them below and catch up where you can.</div>
    </div>`;
  }
  return `<div class="alert alert-ok"><div><strong>Everything on track</strong>No missed doses in this window.</div></div>`;
}

function renderAdherenceCard(summary) {
  const rate = summary.adherence_rate;
  const p = rate === null ? 0 : Math.round(rate * 100);
  const notified = notificationsGranted();
  const wantsNotif = localStorage.getItem('notifications') !== 'off';

  return `<div class="card">
    <div class="card-head">
      <h2>Adherence</h2>
      <span class="hint">last 7 days</span>
    </div>
    <div class="adherence">
      <div class="ring">
        <div class="ring-inner">
          <div class="pct">${pct(rate)}</div>
          <div class="pct-label">taken on time</div>
        </div>
      </div>
      <div class="stat-row">
        <div class="stat is-taken"><div class="n">${summary.taken}</div><div class="l">Taken</div></div>
        <div class="stat is-missed"><div class="n">${summary.missed}</div><div class="l">Missed</div></div>
        <div class="stat is-due"><div class="n">${summary.due + summary.upcoming}</div><div class="l">Remaining</div></div>
      </div>
    </div>
    <div class="mt-14">
      <button class="btn ${notified && wantsNotif ? 'btn-ghost' : ''} btn-block btn-sm"
              id="notif-btn" type="button">
        ${notified && wantsNotif ? '🔔 Reminders on — click to mute' : '🔔 Enable browser reminders'}
      </button>
    </div>
  </div>`;
}

function renderMedicinesCard() {
  const meds = state.medicines;
  return `<div class="card mt-18">
    <div class="card-head">
      <h2>My medicines</h2>
      <button class="btn btn-sm" id="add-med-btn" type="button">+ Add</button>
    </div>
    ${
      meds.length === 0
        ? `<div class="empty"><span class="big">💊</span>No medicines yet.<br>Add your first one to start getting reminders.</div>`
        : meds
            .map(
              (m) => `<div class="med" data-med="${m.id}">
        <div class="med-swatch" data-color="${esc(m.color)}"></div>
        <div class="med-body">
          <div class="med-name">${esc(m.name)} <span class="time-tag">${esc(m.dosage)}</span></div>
          ${m.instructions ? `<div class="med-sub">${esc(m.instructions)}</div>` : ''}
          <div class="med-times">${renderScheduleTags(m.schedules)}</div>
        </div>
        <button class="icon-btn" data-stop="${m.id}" type="button" title="Stop this medicine">✕</button>
      </div>`
            )
            .join('')
    }
  </div>`;
}

// Turn a bitmask into a short label like "weekdays" / "daily" / "Mon, Wed".
function describeDays(mask) {
  if (mask === 127) return '<span class="time-tag">daily</span>';
  const days = DAY_ORDER.filter((d) => mask & (1 << d));
  if (days.length === 5 && !days.includes(0) && !days.includes(6)) {
    return '<span class="time-tag">weekdays</span>';
  }
  if (days.length === 2 && days.includes(0) && days.includes(6)) {
    return '<span class="time-tag">weekends</span>';
  }
  return days.map((d) => `<span class="time-tag">${DAY_NAMES[d]}</span>`).join('');
}

// Times as tags, with the repeat pattern shown once when it is shared by
// every time on the medicine (the common case: "08:00 20:00 · daily").
function renderScheduleTags(schedules) {
  if (!schedules || schedules.length === 0) return '<span class="time-tag">no times</span>';

  const times = schedules
    .map((s) => `<span class="time-tag">${esc(s.time_of_day)}</span>`)
    .join('');

  const masks = new Set(schedules.map((s) => s.days_of_week));
  if (masks.size === 1) {
    return `${times}${describeDays(schedules[0].days_of_week)}`;
  }
  return schedules
    .map(
      (s) =>
        `<span class="time-tag">${esc(s.time_of_day)}</span>${describeDays(s.days_of_week)}`
    )
    .join('');
}

function renderDoseCard(todays, today) {
  return `<div class="card">
    <div class="card-head">
      <h2>Today’s doses</h2>
      <span class="hint">${prettyDate(today, today)} · ${todays.length} scheduled</span>
    </div>
    ${
      todays.length === 0
        ? `<div class="empty"><span class="big">✅</span>Nothing scheduled for today.</div>`
        : todays.map(renderDoseRow).join('')
    }
  </div>`;
}

function renderDoseRow(o) {
  const interactive = o.status === 'due' || o.status === 'upcoming' || o.status === 'missed';
  const actions = interactive
    ? `<div class="dose-actions">
         <button class="btn btn-sm btn-take" data-log="taken"
                 data-med="${o.medicine_id}" data-occ="${esc(o.occurrence)}">Take</button>
         <button class="btn btn-sm btn-skip" data-log="skipped"
                 data-med="${o.medicine_id}" data-occ="${esc(o.occurrence)}">Skip</button>
       </div>`
    : `<div class="dose-actions"><span class="status-pill ${STATUS_PILL[o.status]}">${STATUS_LABEL[o.status]}</span>
         <button class="icon-btn" data-undo="${o.medicine_id}" data-occ="${esc(o.occurrence)}"
                 type="button" title="Undo">↺</button></div>`;

  return `<div class="dose ${o.status === 'due' ? 'is-due' : ''} ${o.status === 'missed' ? 'is-missed' : ''}">
    <div class="dose-time">${occTime(o.occurrence)}</div>
    <div class="dose-bar" data-color="${esc(o.color)}"></div>
    <div class="dose-body">
      <div class="dose-name">
        <span class="badge-dot" data-color="${esc(o.color)}"></span>
        ${esc(o.medicine_name)} <span class="time-tag">${esc(o.dosage)}</span>
        ${o.status === 'due' ? '<span class="status-pill st-due pulse">Due now</span>' : ''}
      </div>
      ${o.instructions ? `<div class="dose-meta">${esc(o.instructions)}</div>` : ''}
      ${o.note ? `<div class="dose-note">Note: ${esc(o.note)}</div>` : ''}
    </div>
    ${actions}
  </div>`;
}

function renderMissedCard(pastMissed) {
  if (pastMissed.length === 0) return '';

  const byMed = new Map();
  for (const o of pastMissed) {
    const row = byMed.get(o.medicine_id) || { name: o.medicine_name, color: o.color, occ: [] };
    row.occ.push(o.occurrence);
    byMed.set(o.medicine_id, row);
  }

  return `<div class="card mt-18">
    <div class="card-head">
      <h2>Missed this week</h2>
      <span class="hint">${pastMissed.length} dose${pastMissed.length > 1 ? 's' : ''}</span>
    </div>
    <table class="missed-table">
      <thead><tr><th>Medicine</th><th>Missed at</th></tr></thead>
      <tbody>
        ${[...byMed.values()]
          .map(
            (r) => `<tr>
          <td><strong>${esc(r.name)}</strong></td>
          <td><div class="occ-list">${r.occ
            .map((o) => `<span class="occ-tag">${prettyDate(occDate(o), todayISO())} ${occTime(o)}</span>`)
            .join('')}</div></td>
        </tr>`
          )
          .join('')}
      </tbody>
    </table>
    <p class="hint mt-10">Your doctor sees this same record on their dashboard.</p>
  </div>`;
}

function bindPatientActions() {
  applySwatchColours();

  $('#add-med-btn')?.addEventListener('click', openMedicineModal);

  $('#notif-btn')?.addEventListener('click', toggleNotifications);

  $$('[data-stop]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.stop;
      const med = state.medicines.find((m) => String(m.id) === id);
      if (!confirm(`Stop ${med ? med.name : 'this medicine'}? Its history is kept.`)) return;
      try {
        await api(`/api/medicines/${id}`, { method: 'DELETE' });
        toast('Medicine stopped', med ? med.name : '');
        await renderPatient();
      } catch (err) {
        toast('Could not update', err.message, 'error');
      }
    });
  });

  bindDoseActions();
}

function bindDoseActions() {
  $$('[data-log]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await api('/api/doses/log', {
          method: 'POST',
          body: {
            medicine_id: Number(btn.dataset.med),
            occurrence: btn.dataset.occ,
            status: btn.dataset.log
          }
        });
        const label = btn.dataset.log === 'taken' ? 'Dose recorded' : 'Marked as skipped';
        toast(label, '', btn.dataset.log === 'taken' ? '' : 'error');
        await renderPatient();
      } catch (err) {
        toast('Could not save', err.message, 'error');
        btn.disabled = false;
      }
    });
  });

  $$('[data-undo]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await api(
          `/api/doses/log?medicine_id=${btn.dataset.undo}&occurrence=${encodeURIComponent(btn.dataset.occ)}`,
          { method: 'DELETE' }
        );
        toast('Entry removed');
        await renderPatient();
      } catch (err) {
        toast('Could not undo', err.message, 'error');
      }
    });
  });
}

// Colours arrive as data attributes rather than inline styles so the
// Content-Security-Policy can stay strict. Applied through the CSSOM.
function applySwatchColours(root = document) {
  $$('[data-color]', root).forEach((el) => {
    const c = el.dataset.color;
    if (c) el.style.backgroundColor = c;
  });
}

// ---------------------------------------------------------------- doctor

async function renderDoctor() {
  const main = $('#main');

  if (state.patientDetail) {
    await renderDoctorDetail();
    return;
  }

  main.innerHTML = `
    <div class="card-head">
      <div>
        <h2 class="h-lg">Patient overview</h2>
        <span class="hint">Adherence over the last 7 days</span>
      </div>
      <div class="range-tabs">
        <button type="button" data-tab="patients" class="${state.doctorTab === 'patients' ? 'on' : ''}">Patients</button>
        <button type="button" data-tab="missed" class="${state.doctorTab === 'missed' ? 'on' : ''}">All missed doses</button>
      </div>
    </div>
    <div id="doctor-body"><div class="empty">Loading…</div></div>
  `;

  $$('[data-tab]', main).forEach((btn) => {
    btn.addEventListener('click', () => {
      state.doctorTab = btn.dataset.tab;
      renderDoctor();
    });
  });

  if (state.doctorTab === 'missed') {
    await renderAllMissed();
  } else {
    await renderPatientCards();
  }
}

async function renderPatientCards() {
  const body = $('#doctor-body');
  try {
    const data = await api('/api/doctor/patients');
    const active = data.patients.filter((p) => p.contract_active);
    const inactive = data.patients.filter((p) => !p.contract_active);

    if (active.length === 0) {
      body.innerHTML = `<div class="empty"><span class="big">🩺</span>No active patient contracts.</div>`;
      return;
    }

    body.innerHTML = `<div class="patient-grid">
      ${active
        .map((p) => {
          const s = p.summary;
          const last = p.last_dose ? `${prettyDate(occDate(p.last_dose.occurrence), todayISO())} ${occTime(p.last_dose.occurrence)}` : '—';
          return `<button class="patient-card" type="button" data-patient="${p.patient_id}">
            <div class="pname">${esc(p.full_name)}</div>
            <div class="pmeta">${esc(p.email)}${p.phone ? ' · ' + esc(p.phone) : ''}</div>
            <div class="mini-stats">
              <div class="mini ${s.adherence_rate >= 0.8 ? 'good' : 'warn'}">
                <div class="n">${pct(s.adherence_rate)}</div><div class="l">Adherence</div></div>
              <div class="mini ${s.missed > 0 ? 'warn' : 'good'}">
                <div class="n">${s.missed}</div><div class="l">Missed 7d</div></div>
              <div class="mini"><div class="n n-sm">${esc(last)}</div><div class="l">Last taken</div></div>
            </div>
            <div class="pmeta mt-10">${esc(p.notes || 'View full report →')}</div>
          </button>`;
        })
        .join('')}
    </div>
    ${
      inactive.length
        ? `<p class="hint mt-16">${inactive.length} contract(s) ended — no access to their records.</p>`
        : ''
    }`;

    $$('[data-patient]', body).forEach((btn) => {
      btn.addEventListener('click', () => {
        state.patientDetail = Number(btn.dataset.patient);
        state.rangeDays = 7;
        renderDoctorDetail();
      });
    });
  } catch (err) {
    body.innerHTML = alertBox(err.message);
  }
}

async function renderAllMissed() {
  const body = $('#doctor-body');
  try {
    const data = await api('/api/doctor/missed?days=7');
    const withMissed = data.patients.filter((p) => p.missed_count > 0);

    if (withMissed.length === 0) {
      body.innerHTML = `<div class="card"><div class="empty"><span class="big">🎉</span>
        No missed doses across your contracted patients this week.</div></div>`;
      return;
    }

    body.innerHTML = `<div class="card">
      <table class="missed-table">
        <thead><tr><th>Patient</th><th>Adherence</th><th>Missed</th><th>Detail</th></tr></thead>
        <tbody>
          ${withMissed
            .map(
              (p) => `<tr>
              <td><strong>${esc(p.full_name)}</strong></td>
              <td>${pct(p.summary.adherence_rate)}</td>
              <td><span class="status-pill st-missed">${p.missed_count} missed</span></td>
              <td>
                <div class="occ-list">
                  ${p.missed_by_medicine
                    .map(
                      (m) =>
                        `<span class="occ-tag" title="${m.occurrences.join(', ')}">${esc(m.medicine_name)} ×${m.count}</span>`
                    )
                    .join('')}
                </div>
                <button class="back-link mt-6" data-open="${p.patient_id}" type="button">
                  Open report →</button>
              </td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
    </div>`;

    $$('[data-open]', body).forEach((btn) => {
      btn.addEventListener('click', () => {
        state.patientDetail = Number(btn.dataset.open);
        state.doctorTab = 'patients';
        renderDoctorDetail();
      });
    });
  } catch (err) {
    body.innerHTML = alertBox(err.message);
  }
}

async function renderDoctorDetail() {
  const main = $('#main');
  main.innerHTML = '<div class="empty">Loading report…</div>';

  try {
    const data = await api(
      `/api/doctor/patients/${state.patientDetail}?days=${state.rangeDays}`
    );
    const { patient, summary, occurrences, missed_doses, missed_by_medicine, medicines, days } = data;
    const today = todayISO();

    const byDay = new Map();
    for (const o of occurrences) {
      const d = occDate(o.occurrence);
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(o);
    }
    const dayKeys = [...byDay.keys()].sort().reverse();

    main.innerHTML = `
      <button class="back-link" id="back-btn" type="button">← All patients</button>

      <div class="grid grid-main">
        <div>
          <div class="card">
            <div class="card-head">
              <div>
                <h2>${esc(patient.full_name)}</h2>
                <span class="hint">${esc(patient.email)}${patient.phone ? ' · ' + esc(patient.phone) : ''}</span>
              </div>
            </div>
            <div class="adherence">
              <div class="ring">
                <div class="ring-inner">
                  <div class="pct">${pct(summary.adherence_rate)}</div>
                  <div class="pct-label">taken on time</div>
                </div>
              </div>
              <div class="stat-row">
                <div class="stat is-taken"><div class="n">${summary.taken}</div><div class="l">Taken</div></div>
                <div class="stat is-missed"><div class="n">${summary.missed}</div><div class="l">Missed</div></div>
                <div class="stat"><div class="n">${summary.skipped}</div><div class="l">Skipped</div></div>
              </div>
            </div>
          </div>

          <div class="card mt-18">
            <div class="card-head"><h2>Medicines</h2></div>
            ${
              medicines.length === 0
                ? '<div class="empty">No medicines.</div>'
                : medicines
                    .map(
                      (m) => `<div class="med">
                  <div class="med-swatch" data-color="${esc(m.color)}"></div>
                  <div class="med-body">
                    <div class="med-name">${esc(m.name)} <span class="time-tag">${esc(m.dosage)}</span></div>
                    ${m.instructions ? `<div class="med-sub">${esc(m.instructions)}</div>` : ''}
                    <div class="med-times">${m.schedules
                      .map((s) => `<span class="time-tag">${esc(s.time_of_day)}</span>`)
                      .join('')}</div>
                  </div>
                  ${m.active ? '' : '<span class="status-pill st-skipped">Stopped</span>'}
                </div>`
                    )
                    .join('')
            }
          </div>
        </div>

        <div>
          <div class="card">
            <div class="card-head">
              <h2>Missed doses</h2>
              <div class="range-tabs">
                ${[7, 30, 90]
                  .map(
                    (d) =>
                      `<button type="button" data-range="${d}" class="${d === days ? 'on' : ''}">${d}d</button>`
                  )
                  .join('')}
              </div>
            </div>
            ${
              missed_doses.length === 0
                ? `<div class="empty"><span class="big">✅</span>No missed doses in the last ${days} days.</div>`
                : `<table class="missed-table">
                <thead><tr><th>Medicine</th><th>Count</th><th>When</th></tr></thead>
                <tbody>
                  ${missed_by_medicine
                    .map(
                      (m) => `<tr>
                    <td><strong>${esc(m.medicine_name)}</strong></td>
                    <td><span class="status-pill st-missed">${m.count}</span></td>
                    <td><div class="occ-list">${m.occurrences
                      .map(
                        (o) =>
                          `<span class="occ-tag">${prettyDate(occDate(o), today)} ${occTime(o)}</span>`
                      )
                      .join('')}</div></td>
                  </tr>`
                    )
                    .join('')}
                </tbody>
              </table>`
            }
          </div>

          <div class="card mt-18">
            <div class="card-head">
              <h2>Dose history</h2>
              <span class="hint">read-only</span>
            </div>
            ${
              dayKeys.length === 0
                ? '<div class="empty">No doses in this window.</div>'
                : dayKeys
                    .map(
                      (d) => `<div class="day-group">
                <div class="day-label">${prettyDate(d, today)}</div>
                ${byDay.get(d)
                  .map(
                    (o) => `<div class="dose ${o.status === 'missed' ? 'is-missed' : ''}">
                  <div class="dose-time">${occTime(o.occurrence)}</div>
                  <div class="dose-bar" data-color="${esc(o.color)}"></div>
                  <div class="dose-body">
                    <div class="dose-name"><span class="badge-dot" data-color="${esc(o.color)}"></span>
                      ${esc(o.medicine_name)} <span class="time-tag">${esc(o.dosage)}</span></div>
                  </div>
                  <span class="status-pill ${STATUS_PILL[o.status]}">${STATUS_LABEL[o.status]}</span>
                </div>`
                  )
                  .join('')}
              </div>`
                    )
                    .join('')
            }
          </div>
        </div>
      </div>
    `;

    applySwatchColours();
    applyRing($('#main .ring'), summary.adherence_rate);

    $('#back-btn').addEventListener('click', () => {
      state.patientDetail = null;
      renderDoctor();
    });

    $$('[data-range]', main).forEach((btn) => {
      btn.addEventListener('click', () => {
        state.rangeDays = Number(btn.dataset.range);
        renderDoctorDetail();
      });
    });
  } catch (err) {
    main.innerHTML = `<button class="back-link" id="back-btn" type="button">← All patients</button>${alertBox(err.message)}`;
    $('#back-btn').addEventListener('click', () => {
      state.patientDetail = null;
      renderDoctor();
    });
  }
}

// ---------------------------------------------------------------- modal

function openMedicineModal() {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <form class="modal" id="med-form" novalidate>
      <h2>Add a medicine</h2>

      <div class="field">
        <label for="m-name">Name</label>
        <input id="m-name" name="name" required placeholder="Metformin" />
      </div>

      <div class="field">
        <label for="m-dose">Dosage</label>
        <input id="m-dose" name="dosage" required placeholder="500 mg" />
      </div>

      <div class="field">
        <label for="m-instr">Instructions (optional)</label>
        <input id="m-instr" name="instructions" placeholder="Take with food" />
      </div>

      <div class="field">
        <label>Colour</label>
        <div class="chip-row" id="colour-row">
          ${PALETTE.map(
            (c, i) =>
              `<button type="button" class="chip" data-colour="${c}" ${i === 0 ? 'data-on="1"' : ''}></button>`
          ).join('')}
        </div>
      </div>

      <div class="field">
        <label>Reminder times</label>
        <div id="time-rows"></div>
        <button type="button" class="btn btn-ghost btn-sm" id="add-time">+ Another time</button>
      </div>

      <div class="field">
        <label>Repeat on</label>
        <div class="day-picker" id="day-picker">
          ${DAY_ORDER.map(
            (d) => `<input type="checkbox" id="d${d}" name="days" value="${d}" checked />
                    <label for="d${d}">${DAY_NAMES[d][0]}</label>`
          ).join('')}
        </div>
      </div>

      <div class="error-box" id="med-error" hidden></div>

      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="cancel-med">Cancel</button>
        <button type="submit" class="btn">Save medicine</button>
      </div>
    </form>
  `;

  document.body.appendChild(backdrop);
  applySwatchColours(backdrop);

  let colour = PALETTE[0];
  const colourBtns = $$('[data-colour]', backdrop);

  const paintColours = () => {
    colourBtns.forEach((b) => {
      b.style.backgroundColor = b.dataset.colour;
      const on = b.dataset.colour === colour;
      b.style.borderColor = on ? b.dataset.colour : '';
      b.style.borderWidth = on ? '2px' : '';
      b.style.background = on ? b.dataset.colour : 'var(--surface-2)';
    });
  };
  paintColours();

  colourBtns.forEach((b) =>
    b.addEventListener('click', () => {
      colour = b.dataset.colour;
      paintColours();
    })
  );

  const rows = $('#time-rows', backdrop);
  const addTime = (value = '08:00') => {
    const row = document.createElement('div');
    row.className = 'schedule-row';
    row.innerHTML = `<input type="time" value="${value}" required />
                     <button type="button" class="icon-btn" data-rm>✕</button>`;
    $('[data-rm]', row).addEventListener('click', () => row.remove());
    rows.appendChild(row);
  };
  addTime('08:00');
  $('#add-time', backdrop).addEventListener('click', () => addTime('20:00'));

  const close = () => backdrop.remove();
  $('#cancel-med', backdrop).addEventListener('click', close);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  document.addEventListener('keydown', function onEsc(e) {
    if (e.key === 'Escape') {
      close();
      document.removeEventListener('keydown', onEsc);
    }
  });

  $('#med-form', backdrop).addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = $('#med-error', backdrop);
    errBox.hidden = true;

    const days = $$('input[name="days"]:checked', backdrop).map((i) => Number(i.value));
    const times = $$('#time-rows input[type="time"]', backdrop).map((i) => i.value);

    const payload = {
      name: $('#m-name', backdrop).value.trim(),
      dosage: $('#m-dose', backdrop).value.trim(),
      instructions: $('#m-instr', backdrop).value.trim(),
      color: colour,
      schedules: times.filter(Boolean).map((time) => ({ time, days }))
    };

    if (days.length === 0) {
      errBox.textContent = 'Pick at least one day of the week.';
      errBox.hidden = false;
      return;
    }

    try {
      await api('/api/medicines', { method: 'POST', body: payload });
      close();
      toast('Medicine added', payload.name);
      await renderPatient();
    } catch (err) {
      errBox.textContent = err.message;
      errBox.hidden = false;
    }
  });

  $('#m-name', backdrop).focus();
}

// ---------------------------------------------------------------- reminders

function notificationsGranted() {
  return typeof Notification !== 'undefined' && Notification.permission === 'granted';
}

function notifiedSet() {
  try {
    return new Set(JSON.parse(localStorage.getItem('notified') || '[]'));
  } catch {
    return new Set();
  }
}

function rememberNotified(keys) {
  const list = [...notifiedSet(), ...keys].slice(-500);
  localStorage.setItem('notified', JSON.stringify(list));
}

async function toggleNotifications() {
  if (typeof Notification === 'undefined') {
    toast('Not supported', 'This browser has no Notification API.', 'error');
    return;
  }

  if (localStorage.getItem('notifications') === 'off') {
    localStorage.setItem('notifications', 'on');
    toast('Reminders enabled');
    await renderPatient();
    return;
  }

  const perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    toast('Reminders blocked', 'Permission was not granted.', 'error');
    return;
  }
  localStorage.setItem('notifications', 'on');
  toast('Reminders enabled', 'You’ll be alerted when a dose is due.');
  await renderPatient();
}

function startReminders() {
  stopReminders();
  pollReminders();
  state.pollTimer = setInterval(pollReminders, 30000);
}

function stopReminders() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

async function pollReminders() {
  if (!state.user || state.user.role !== 'patient') return;
  if (localStorage.getItem('notifications') === 'off') return;

  let data;
  try {
    data = await api('/api/doses/upcoming');
  } catch {
    return; // transient; next tick will retry
  }

  const seen = notifiedSet();
  const fresh = data.pending.filter(
    (o) => o.status === 'due' && !seen.has(o.occurrence)
  );

  if (fresh.length === 0) return;

  rememberNotified(fresh.map((o) => o.occurrence));

  for (const o of fresh) {
    const title = `${o.medicine_name} ${o.dosage} — due now`;
    const body = `Scheduled for ${occTime(o.occurrence)}${o.instructions ? ` · ${o.instructions}` : ''}`;

    toast(title, body, 'reminder');

    if (notificationsGranted()) {
      try {
        new Notification(title, {
          body,
          tag: o.occurrence, // collapse repeats for the same dose
          icon: '/icon.svg'
        });
      } catch {
        /* notification construction can throw on some platforms */
      }
    }
  }

  // A dose crossing into "due" changes the dashboard too.
  if (state.user && state.user.role === 'patient' && !state.patientDetail) {
    await renderPatient();
  }
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').catch(() => {
    /* offline shell is a progressive enhancement */
  });
}

// ---------------------------------------------------------------- start

boot();
