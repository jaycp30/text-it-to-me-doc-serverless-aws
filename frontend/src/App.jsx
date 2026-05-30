import React, { useState, useEffect, useRef } from 'react';
import Icon from './Icons';

/* ─────────────────────────────────────────────────────────────────────────────
   GLOBAL STYLES
   Injected once at mount. CSS variables drive all theming + dark mode.
───────────────────────────────────────────────────────────────────────────── */
const GLOBAL_CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    /* Palette */
    --bg:          #FAFFC7;
    --bg2:         #F2F6B4;
    --bg3:         #E8EE9E;
    --blossom:     #F9A8BB;
    --sage:        #5E7E68;
    --sage-dk:     #4A6652;
    --sage-lt:     #EBF1ED;
    --lav:         #9B8EC4;
    --lav-dk:      #7B6EA4;
    --lav-lt:      #F0EDF8;
    --peach:       #E8927C;
    --peach-dk:    #C87660;
    --peach-lt:    #FDF0EC;
    --text:        #2C2C2C;
    --text2:       #6B6B6B;
    --text3:       #AAAAAA;
    --white:       #FFFFFF;
    --danger:      #E85C5C;
    --danger-lt:   #FFF2F2;
    /* Glass */
    --card:        rgba(255,255,255,0.68);
    --card-hov:    rgba(255,255,255,0.88);
    --card-bdr:    rgba(255,255,255,0.82);
    --glass-line:  rgba(94,126,104,0.13);
    /* Shadows */
    --sh-card:     0 1px 2px rgba(44,44,44,0.04), 0 6px 16px -6px rgba(94,126,104,0.14), 0 12px 32px -12px rgba(94,126,104,0.10);
    --sh-hov:      0 2px 4px rgba(44,44,44,0.05), 0 10px 24px -8px rgba(94,126,104,0.20), 0 20px 48px -16px rgba(94,126,104,0.14);
    --sh-btn-sage: 0 4px 18px rgba(94,126,104,0.36);
    --sh-btn-lav:  0 4px 18px rgba(155,142,196,0.36);
    --sh-draw:     0 -8px 48px rgba(0,0,0,0.12);
    /* Radius */
    --r-xs:   8px;
    --r-sm:   12px;
    --r-md:   16px;
    --r-lg:   20px;
    --r-xl:   24px;
    --r-2xl:  32px;
    --r-full: 999px;
    /* Typography */
    --font-head: 'Poppins', sans-serif;
    --font-body: 'DM Sans', sans-serif;
    --font-mono: 'DM Mono', monospace;
    /* Transitions */
    --tr:      0.22s ease;
    --tr-slow: 0.42s cubic-bezier(0.16, 1, 0.3, 1);
  }

  /* ── Dark mode ── */
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:        #1A1825;
      --bg2:       #231F33;
      --bg3:       #2C2740;
      --blossom:   rgba(249,168,187,0.16);
      --card:      rgba(255,255,255,0.06);
      --card-hov:  rgba(255,255,255,0.10);
      --card-bdr:  rgba(255,255,255,0.09);
      --glass-line:rgba(155,142,196,0.22);
      --text:      #F0EDE8;
      --text2:     #9A9A9A;
      --text3:     #5A5A5A;
      --sage-lt:   rgba(94,126,104,0.18);
      --lav-lt:    rgba(155,142,196,0.16);
      --peach-lt:  rgba(232,146,124,0.14);
      --danger-lt: rgba(232,92,92,0.14);
    }
  }

  /* ── Base ── */
  html { -webkit-text-size-adjust: 100%; scroll-behavior: smooth; }

  body {
    background: var(--bg);
    font-family: var(--font-body);
    color: var(--text);
    min-height: 100dvh;
    overflow-x: hidden;
    -webkit-font-smoothing: antialiased;
  }

  #root {
    width: 100%;
    min-height: 100dvh;
    position: relative;
    overflow-x: hidden;
  }

  /* ── Responsive shell (desktop ≥ 900px) ── */
  .app-shell {
    display: flex;
    min-height: 100dvh;
    background:
      radial-gradient(55vw 55vw at 100% -5%, var(--blossom), transparent 55%),
      radial-gradient(48vw 48vw at -5% 105%, rgba(249,168,187,0.45), transparent 55%),
      var(--bg);
  }
  .app-sidebar {
    width: 264px; flex-shrink: 0;
    height: 100dvh; position: sticky; top: 0;
    padding: 26px 18px 22px;
    display: flex; flex-direction: column; gap: 6px;
    background: var(--card);
    border-right: 1px solid var(--glass-line);
    backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
  }
  .app-main {
    flex: 1; min-width: 0; min-height: 100dvh;
    padding: 30px 28px 48px;
  }
  .wrap-narrow { width: 100%; max-width: 480px; margin: 0 auto; }
  .wrap-wide   { width: 100%; max-width: 940px; margin: 0 auto; }

  .today-wrap { width: 100%; }
  @media (min-width: 900px) { .today-wrap { max-width: 620px; } }

  /* Responsive card grids — 1 col phone, 2 col tablet, 3 col wide */
  .card-grid { display: flex; flex-direction: column; gap: 12px; }
  @media (min-width: 900px) {
    .card-grid {
      display: grid; grid-template-columns: repeat(2, 1fr);
      gap: 16px; align-items: start;
    }
  }
  @media (min-width: 1280px) {
    .card-grid       { grid-template-columns: repeat(3, 1fr); }
    .card-grid--two  { grid-template-columns: repeat(2, 1fr); }
  }

  /* Sidebar nav item */
  .nav-item {
    display: flex; align-items: center; gap: 11px;
    width: 100%; padding: 11px 13px; border-radius: var(--r-md);
    font-family: var(--font-head); font-weight: 600; font-size: 14px;
    color: var(--text2); text-align: left;
    transition: background var(--tr), color var(--tr);
  }
  .nav-item:hover   { background: var(--bg2); color: var(--text); }
  .nav-item.active  { background: var(--sage); color: #fff; }

  /* ── Tablet rail: collapse sidebar to icons-only (900–1100px) ── */
  @media (min-width: 900px) and (max-width: 1100px) {
    .app-sidebar {
      width: 76px;
      padding: 26px 12px 22px;
      align-items: center;
    }
    .sidebar-brand   { justify-content: center; padding: 4px 0 18px !important; }
    .sidebar-wordmark,
    .sidebar-hint,
    .sidebar-label   { display: none; }
    .sidebar-divider { width: 32px; align-self: center; }
    .nav-item {
      justify-content: center;
      gap: 0;
      padding: 11px 0;
      width: 44px; height: 44px;
      border-radius: var(--r-md);
    }
    /* Main content reclaims the freed space */
    .app-main { padding: 30px 24px 48px; }
  }

  ::-webkit-scrollbar { width: 0; height: 0; }
  button  { cursor: pointer; border: none; background: none; }
  button:focus-visible { outline: 2px solid var(--lav); outline-offset: 2px; border-radius: 8px; }
  input, textarea, select { font-family: var(--font-body); border: none; outline: none; background: none; color: var(--text); }

  /* ── Keyframes ── */
  @keyframes fadeUp {
    from { opacity: 0; transform: translateY(20px); }
    to   { opacity: 1; transform: translateY(0);    }
  }
  @keyframes fadeIn {
    from { opacity: 0; }
    to   { opacity: 1; }
  }
  @keyframes drawerUp {
    from { transform: translateX(-50%) translateY(100%); }
    to   { transform: translateX(-50%) translateY(0);    }
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  @keyframes float {
    0%, 100% { transform: translateY(0px);  }
    50%      { transform: translateY(-8px); }
  }
  @keyframes pulse-btn {
    0%, 100% { transform: scale(1);    box-shadow: var(--sh-btn-sage); }
    50%      { transform: scale(1.03); box-shadow: 0 6px 28px rgba(94,126,104,0.48); }
  }
  @keyframes pulse-fab {
    0%, 100% { transform: scale(1);    box-shadow: var(--sh-btn-lav); }
    50%      { transform: scale(1.05); box-shadow: 0 6px 28px rgba(155,142,196,0.52); }
  }
  @keyframes shimmer {
    0%   { background-position: -600px 0; }
    100% { background-position:  600px 0; }
  }
  @keyframes dot-bounce {
    0%, 80%, 100% { transform: scale(0.7); opacity: 0.4; }
    40%           { transform: scale(1.0); opacity: 1.0; }
  }
  @keyframes bar-grow {
    from { width: 0; }
    to   { width: var(--bar-w, 100%); }
  }
  @keyframes pop {
    0%   { opacity: 0; transform: scale(0.6); }
    100% { opacity: 1; transform: scale(1);   }
  }

  /* ── Reusable animation classes ── */
  .anim-fade-up  { animation: fadeUp 0.48s ease both; }
  .anim-fade-in  { animation: fadeIn 0.38s ease both; }
  .anim-float    { animation: float 3.2s ease-in-out infinite; }
  .anim-pop      { animation: pop 0.4s cubic-bezier(0.34,1.56,0.64,1) both; }

  /* Tactile press feedback on every interactive control */
  button:active { transform: scale(0.95); }

  /* Soft tinted container that holds a line-icon */
  .icon-well {
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
    transition: transform var(--tr), background var(--tr);
  }
  .icon-well-pressable:active { transform: scale(0.92); }

  /* ── Glass card utility ── */
  .glass {
    background:           var(--card);
    border:               1px solid var(--card-bdr);
    backdrop-filter:      blur(16px);
    -webkit-backdrop-filter: blur(16px);
    box-shadow:           var(--sh-card);
    transition: background var(--tr), box-shadow var(--tr);
  }
  .glass:hover { background: var(--card-hov); box-shadow: var(--sh-hov); }
`;

function GlobalStyles() {
  useEffect(() => {
    const el = document.createElement('style');
    el.setAttribute('data-rxreader', '1');
    el.textContent = GLOBAL_CSS;
    document.head.insertBefore(el, document.head.firstChild);
    return () => el.remove();
  }, []);
  return null;
}

/* ─────────────────────────────────────────────────────────────────────────────
   RESPONSIVE HOOK
   Tracks viewport width so the shell can switch between mobile and desktop.
───────────────────────────────────────────────────────────────────────────── */
function useIsDesktop(breakpoint = 900) {
  const query = `(min-width: ${breakpoint}px)`;
  const [isDesktop, setIsDesktop] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches
  );

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = (e) => setIsDesktop(e.matches);
    mql.addEventListener('change', onChange);
    setIsDesktop(mql.matches);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return isDesktop;
}

/* ─────────────────────────────────────────────────────────────────────────────
   CONSTANTS
───────────────────────────────────────────────────────────────────────────── */
const API_BASE    = import.meta.env.VITE_API_BASE_URL || '';
const ANTH_KEY    = import.meta.env.VITE_ANTHROPIC_KEY || '';
const PREVIEW     = !API_BASE;
const GITHUB_URL  = 'https://github.com/jaycp30/text-it-to-me-doc-serverless-aws';
const MAX_UPLOAD_IMAGES = 5;

const PARSE_SYSTEM = `You are an expert medical prescription parser. You know all medical shorthand, ditto marks, tapering regimens, and handwritten notation.

Parse the prescription image and return ONLY a valid JSON object — no markdown fences, no explanation:
{
  "patientName": "string or null",
  "prescribedDate": "YYYY-MM-DD or null",
  "prescriber": "Dr. Name or null",
  "medications": [
    {
      "id": "med0",
      "name": "Medication Name",
      "dose": "500mg",
      "frequency": "Three times daily",
      "frequencyCode": "TID",
      "duration": "10 days",
      "durationDays": 10,
      "times": ["8:00 AM","2:00 PM","8:00 PM"],
      "prn": false,
      "prnMaxPerDay": null,
      "taper": null,
      "instructions": "Take with food",
      "refills": 0,
      "color": "sage"
    }
  ],
  "notes": "any extra notes or null"
}

For tapering meds set taper to an array: [{ "label": "Days 1-2", "dose": "40mg", "durationDays": 2 }, ...]
Assign colors cyclically: sage → lav → peach → sage ...
FrequencyCode values: QD BID TID QID PRN other`;

const chatSystem = (rx) => `You are a friendly medication helper for Text it To Me Doc. Be warm, clear, and concise — write at an 8th-grade level.

Current prescription:
${JSON.stringify(rx, null, 2)}

Rules:
• Only discuss medications in this prescription.
• Never recommend dose changes or stopping medication.
• Never diagnose.
• Emergency symptoms (chest pain, severe allergic reaction, loss of consciousness) → respond ONLY: "Please stop and call emergency services (911) or go to the nearest ER immediately."
• Off-topic → "I can only help with questions about your current prescription."
• Max ~3 short paragraphs per reply.
• You are not a doctor — always remind users to verify with their pharmacist or prescriber.`;

/* ── Mock data (used only in explicit demo mode) ── */
const MOCK_RX = {
  patientName: 'Alex',
  prescribedDate: new Date().toISOString().slice(0, 10),
  prescriber: 'Dr. Rivera',
  medications: [
    {
      id: 'med0', name: 'Prednisone', dose: '40mg → 10mg',
      frequency: 'Once daily (tapering)', frequencyCode: 'QD',
      duration: '7 days', durationDays: 7,
      times: ['8:00 AM'], prn: false, prnMaxPerDay: null,
      taper: [
        { label: 'Days 1–2', dose: '40mg', durationDays: 2 },
        { label: 'Days 3–4', dose: '30mg', durationDays: 2 },
        { label: 'Days 5–6', dose: '20mg', durationDays: 2 },
        { label: 'Day 7',    dose: '10mg', durationDays: 1 },
      ],
      instructions: 'Take with breakfast',
      refills: 0, color: 'sage',
    },
    {
      id: 'med1', name: 'Amoxicillin', dose: '500mg',
      frequency: 'Three times daily', frequencyCode: 'TID',
      duration: '10 days', durationDays: 10,
      times: ['8:00 AM', '2:00 PM', '8:00 PM'],
      prn: false, prnMaxPerDay: null, taper: null,
      instructions: 'Complete the full course',
      refills: 0, color: 'lav',
    },
    {
      id: 'med2', name: 'Ibuprofen', dose: '400mg',
      frequency: 'As needed', frequencyCode: 'PRN',
      duration: null, durationDays: null,
      times: [], prn: true, prnMaxPerDay: 3, taper: null,
      instructions: 'Take with food, max 3× daily',
      refills: 2, color: 'peach',
    },
  ],
  notes: 'Return for follow-up in 2 weeks.',
};

const QUICK_QS = [
  'Can I take Amoxicillin with food?',
  'What if I miss a Prednisone dose?',
  'Can I drink alcohol with these meds?',
  'What side effects should I watch for?',
  'Can I take all of them at the same time?',
];

/* ─────────────────────────────────────────────────────────────────────────────
   UTILS
───────────────────────────────────────────────────────────────────────────── */
function fileToBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload  = () => res(r.result.split(',')[1]);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

function getFileContentType(file) {
  if (file.type) return file.type === 'image/jpg' ? 'image/jpeg' : file.type;

  const ext = file.name.split('.').pop()?.toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'heic' || ext === 'heif') return 'image/heic';
  return 'image/jpeg';
}

const COLOR_VAR  = { sage: 'var(--sage)', lav: 'var(--lav)',  peach: 'var(--peach)' };
const COLOR_LT   = { sage: 'var(--sage-lt)', lav: 'var(--lav-lt)', peach: 'var(--peach-lt)' };
const COLOR_DARK = { sage: 'var(--sage-dk)', lav: 'var(--lav-dk)', peach: 'var(--peach-dk)' };

const cv  = (c) => COLOR_VAR[c]  || 'var(--sage)';
const clt = (c) => COLOR_LT[c]   || 'var(--sage-lt)';
const cdk = (c) => COLOR_DARK[c] || 'var(--sage-dk)';

function formatDay(d = new Date()) {
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function getBrowserTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Manila';
  } catch {
    return 'Asia/Manila';
  }
}

function getStoredUserId() {
  const storageKey = 'rxreader.userId';
  try {
    const existing = localStorage.getItem(storageKey);
    if (existing) return existing;
    const id = `local-${globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : Date.now()}`;
    localStorage.setItem(storageKey, id);
    return id;
  } catch {
    return `local-${Date.now()}`;
  }
}

function getStoredReminderDetails() {
  const fallback = {
    userId: getStoredUserId(),
    notificationMethod: 'email',
    contactInfo: '',
    userTimezone: getBrowserTimezone(),
  };

  try {
    return {
      ...fallback,
      ...JSON.parse(localStorage.getItem('rxreader.reminderDetails') || '{}'),
      userId: fallback.userId,
    };
  } catch {
    return fallback;
  }
}

function saveReminderDetails(details) {
  try {
    localStorage.setItem('rxreader.reminderDetails', JSON.stringify({
      notificationMethod: details.notificationMethod,
      contactInfo: details.contactInfo,
      userTimezone: details.userTimezone,
    }));
  } catch {
    // Storage is a convenience only; uploading should still work if blocked.
  }
}

function validateReminderDetails(details) {
  const contact = details.contactInfo.trim();
  if (!contact) return 'Enter where reminders should be sent.';
  if (details.notificationMethod === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) {
    return 'Enter a valid email address.';
  }
  if (details.notificationMethod === 'sms' && !/^\+[1-9]\d{7,14}$/.test(contact)) {
    return 'Use E.164 phone format, for example +639171234567.';
  }
  if (!details.userTimezone) return 'Choose your timezone.';
  return '';
}

function formatDoseTime(time) {
  if (!time) return null;
  const [hourText, minute = '00'] = time.split(':');
  const hour = Number(hourText);
  if (Number.isNaN(hour)) return time;
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const h12 = hour % 12 || 12;
  return `${h12}:${minute.padStart(2, '0')} ${suffix}`;
}

function describeFrequency(med, times) {
  if (med.schedule_type === 'prn') return 'As needed';
  if (med.schedule_type === 'taper') return 'Tapering schedule';
  if (times.length === 1) return 'Once daily';
  if (times.length === 2) return 'Twice daily';
  if (times.length === 3) return 'Three times daily';
  if (times.length === 4) return 'Four times daily';
  if (times.length > 4) return `${times.length} times daily`;
  return med.schedule_type || 'Scheduled';
}

function normalizePrescriptionResponse(payload) {
  const source = payload?.prescription || payload || {};
  const allDoseDates = (source.medications || [])
    .flatMap(med => med.doses || [])
    .map(dose => dose.date)
    .filter(Boolean)
    .sort();

  const medications = (source.medications || []).map((med, i) => {
    const rawDoses = med.doses || [];
    const times = [...new Set(rawDoses.map(d => formatDoseTime(d.time)).filter(Boolean))];
    const dose = med.dose_mg
      ? `${med.dose_mg}mg`
      : rawDoses[0]?.amount
        ? `${rawDoses[0].amount} ${rawDoses[0].unit || ''}`.trim()
        : med.dose || '';

    return {
      id: med.id || `med${i}`,
      name: med.name || med.brand || `Medication ${i + 1}`,
      dose,
      frequency: med.frequency || describeFrequency(med, times),
      frequencyCode: med.frequencyCode || (med.schedule_type || 'other').toUpperCase(),
      duration: med.duration || (med.duration_days ? `${med.duration_days} days` : med.end_date ? `Until ${med.end_date}` : null),
      durationDays: med.durationDays || med.duration_days || null,
      times,
      doses: rawDoses,
      prn: med.prn ?? med.schedule_type === 'prn',
      prnMaxPerDay: med.prnMaxPerDay || null,
      taper: med.taper || null,
      instructions: med.instructions || med.special_instructions || rawDoses[0]?.instruction || '',
      refills: med.refills || 0,
      color: med.color || ['sage', 'lav', 'peach'][i % 3],
    };
  });

  return {
    ...source,
    patientName: source.patientName || source.patient || null,
    prescribedDate: source.prescribedDate || source.prescription_date || null,
    originalScheduleStartDate: source.originalScheduleStartDate || allDoseDates[0] || source.prescribedDate || source.prescription_date || null,
    scheduleStartDate: source.scheduleStartDate || allDoseDates[0] || source.prescribedDate || source.prescription_date || null,
    prescriber: source.prescriber || source.doctor || null,
    medications,
    notes: source.notes || payload?.message || null,
  };
}

function errorFromPayload(payload, fallback) {
  if (!payload || typeof payload !== 'object') return fallback;
  return [payload.error, payload.detail].filter(Boolean).join(' — ') || fallback;
}

function timeSortValue(time) {
  const match = String(time || '').match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!match) return 9999;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const period = match[3].toUpperCase();
  if (period === 'PM' && hour !== 12) hour += 12;
  if (period === 'AM' && hour === 12) hour = 0;
  return hour * 60 + minute;
}

function dateFromYmd(value) {
  if (!value) return null;
  const [year, month, day] = String(value).split('-').map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day);
}

function ymdFromDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function daysBetween(startDate, targetDate) {
  const start = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
  const target = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate());
  return Math.floor((target - start) / 86400000);
}

function addDaysYmd(value, days) {
  const date = dateFromYmd(value);
  if (!date) return null;
  date.setDate(date.getDate() + days);
  return ymdFromDate(date);
}

function defaultScheduleStartDate(rx) {
  return rx?.scheduleStartDate || rx?.prescribedDate || ymdFromDate();
}

function taperDoseForDay(taper = [], dayIndex = 0) {
  let cursor = 0;
  for (const step of taper) {
    const length = Number(step.durationDays || 1);
    if (dayIndex >= cursor && dayIndex < cursor + length) return step.dose;
    cursor += length;
  }
  return null;
}

function doseForMedOnDay(med, dayIndex) {
  if (dayIndex < 0) return null;
  if (med.taper?.length) return taperDoseForDay(med.taper, dayIndex);
  if (med.durationDays && dayIndex >= Number(med.durationDays)) return null;
  return med.dose || '';
}

function doseLabelFromRawDose(dose, med) {
  if (dose.amount) return `${dose.amount} ${dose.unit || ''}`.trim();
  return med.dose || '';
}

function buildDosesForDate(rx, targetDate = new Date(), scheduleStartDate = defaultScheduleStartDate(rx)) {
  const startDate = dateFromYmd(scheduleStartDate) || new Date();
  const dayIndex = daysBetween(startDate, targetDate);
  const originalStartDate = rx?.originalScheduleStartDate || rx?.prescribedDate || scheduleStartDate;
  const shiftedSourceDate = addDaysYmd(originalStartDate, dayIndex);

  return (rx?.medications || [])
    .flatMap((med, medIndex) => {
      if (med.prn) return [];

      const datedDoses = (med.doses || []).filter(dose => dose.date && !dose.as_needed);
      if (datedDoses.length && shiftedSourceDate) {
        return datedDoses
          .filter(dose => dose.date === shiftedSourceDate && dose.time)
          .map((dose, doseIndex) => ({
            id: `${ymdFromDate(targetDate)}-${med.id || medIndex}-${dose.time}-${doseIndex}`,
            time: formatDoseTime(dose.time),
            med: med.name,
            dose: doseLabelFromRawDose(dose, med),
            color: med.color || ['sage', 'lav', 'peach'][medIndex % 3],
            taken: false,
          }));
      }

      const times = med.times?.length ? med.times : [];
      const dose = doseForMedOnDay(med, dayIndex);
      if (!times.length || dose === null) return [];

      return times.map((time, timeIndex) => ({
        id: `${ymdFromDate(targetDate)}-${med.id || medIndex}-${time}-${timeIndex}`,
        time,
        med: med.name,
        dose,
        color: med.color || ['sage', 'lav', 'peach'][medIndex % 3],
        taken: false,
      }));
    })
    .sort((a, b) => timeSortValue(a.time) - timeSortValue(b.time));
}

function offsetDay(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d;
}

/* ─────────────────────────────────────────────────────────────────────────────
   SPINNER
───────────────────────────────────────────────────────────────────────────── */
function Spinner({ size = 20, color = 'var(--sage)' }) {
  return (
    <div style={{
      width: size, height: size, flexShrink: 0,
      border: `2.5px solid transparent`,
      borderTopColor: color,
      borderRightColor: color,
      borderRadius: '50%',
      animation: 'spin 0.65s linear infinite',
    }} />
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   NAVBAR
───────────────────────────────────────────────────────────────────────────── */
function NavBar({ screen, onBack }) {
  return (
    <nav style={{
      position: 'sticky', top: 0, zIndex: 100,
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '12px 20px',
      background: 'var(--card)',
      borderBottom: '1px solid var(--card-bdr)',
      backdropFilter: 'blur(20px)',
      WebkitBackdropFilter: 'blur(20px)',
    }}>
      {/* Left — back or spacer */}
      {screen !== 'home' ? (
        <button
          onClick={onBack}
          aria-label="Back"
          className="icon-well-pressable"
          style={{
            width: 38, height: 38, borderRadius: '50%',
            background: 'var(--sage-lt)', color: 'var(--sage)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'all var(--tr)',
          }}
        ><Icon name="chevronLeft" size={20} strokeWidth={2.2} /></button>
      ) : (
        <div style={{ width: 38 }} />
      )}

      {/* Centre — brand */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{
          width: 34, height: 34, borderRadius: 11, flexShrink: 0,
          background: 'linear-gradient(135deg, var(--sage), var(--lav))',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#fff', boxShadow: '0 3px 10px -2px rgba(94,126,104,0.45)',
        }}><Icon name="logo" size={19} strokeWidth={1.9} /></div>
        <span style={{
          fontFamily: 'var(--font-head)', fontWeight: 700, fontSize: 13,
          letterSpacing: '-0.2px', color: 'var(--text)',
        }}>Text it To Me Doc</span>
      </div>

      {/* Right — GitHub contact/source */}
      <a
        href={GITHUB_URL}
        target="_blank"
        rel="noreferrer"
        aria-label="Open project on GitHub"
        title="Questions? Open the GitHub repo"
        className="icon-well-pressable"
        style={{
          width: 38, height: 38, borderRadius: '50%',
          background: 'var(--card)', border: '1px solid var(--glass-line)',
          color: 'var(--text2)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          transition: 'all var(--tr)',
        }}
      ><Icon name="github" size={18} /></a>
    </nav>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   SIDEBAR  (desktop only)
   Replaces the mobile top-nav + FAB. Holds brand, primary navigation
   (schedule tabs), quick actions, and settings.
───────────────────────────────────────────────────────────────────────────── */
function Sidebar({ screen, tab, setTab, onNewRx, onChat }) {
  const tabs = [
    { id: 'today',    label: 'Today',       icon: 'sun'      },
    { id: 'upcoming', label: 'Upcoming',    icon: 'calendar' },
    { id: 'meds',     label: 'Medications', icon: 'pill'     },
  ];

  return (
    <aside className="app-sidebar">
      {/* Brand */}
      <div className="sidebar-brand" style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '4px 8px 18px' }}>
        <div style={{
          width: 38, height: 38, borderRadius: 12, flexShrink: 0,
          background: 'linear-gradient(135deg, var(--sage), var(--lav))',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#fff', boxShadow: '0 3px 10px -2px rgba(94,126,104,0.45)',
        }}><Icon name="logo" size={22} strokeWidth={1.9} /></div>
        <span className="sidebar-wordmark" style={{
          fontFamily: 'var(--font-head)', fontWeight: 700, fontSize: 16,
          letterSpacing: '-0.3px', color: 'var(--text)', lineHeight: 1.15,
        }}>Text it<br />To Me Doc</span>
      </div>

      {/* Schedule navigation */}
      {screen === 'schedule' && (
        <>
          <nav style={{ display: 'flex', flexDirection: 'column', gap: 4, width: '100%', alignItems: 'center' }}>
            {tabs.map(t => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                title={t.label}
                aria-label={t.label}
                className={`nav-item${tab === t.id ? ' active' : ''}`}
              >
                <Icon name={t.icon} size={18} strokeWidth={2} />
                <span className="sidebar-label">{t.label}</span>
              </button>
            ))}
          </nav>

          <div className="sidebar-divider" style={{ height: 1, background: 'var(--glass-line)', margin: '14px 6px' }} />

          <button onClick={onNewRx} className="nav-item" title="New prescription" aria-label="New prescription">
            <Icon name="camera" size={18} strokeWidth={2} />
            <span className="sidebar-label">New prescription</span>
          </button>
          <button onClick={onChat} className="nav-item" title="Ask AI" aria-label="Ask AI">
            <Icon name="message" size={18} strokeWidth={2} />
            <span className="sidebar-label">Ask AI</span>
          </button>
        </>
      )}

      {/* Home hint */}
      {screen !== 'schedule' && (
        <p className="sidebar-hint" style={{
          padding: '4px 10px', fontSize: 13, color: 'var(--text2)', lineHeight: 1.6,
        }}>
          Upload a prescription photo and we'll build your medication schedule.
        </p>
      )}

      {/* Project link pinned to bottom */}
      <div style={{ marginTop: 'auto', width: '100%', display: 'flex', justifyContent: 'center', flexDirection: 'column', gap: 8 }}>
        <a
          className="nav-item"
          href={GITHUB_URL}
          target="_blank"
          rel="noreferrer"
          title="Questions? Open the GitHub repo"
          aria-label="Open project on GitHub"
          style={{
            textDecoration: 'none',
            background: 'rgba(155,142,196,0.18)',
            color: 'var(--text)',
            border: '1px solid rgba(155,142,196,0.28)',
          }}
        >
          <Icon name="github" size={18} strokeWidth={2} />
          <span className="sidebar-label">Questions?</span>
        </a>
        <span className="sidebar-label" style={{
          padding: '0 13px', fontSize: 11, color: 'var(--text2)', lineHeight: 1.35,
          wordBreak: 'break-word',
        }}>
          github.com/jaycp30/text-it-to-me-doc-serverless-aws
        </span>
      </div>
    </aside>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   HOME SCREEN
───────────────────────────────────────────────────────────────────────────── */
function HomeScreen({ onUpload }) {
  const fileRef   = useRef();
  const [files, setFiles]       = useState([]);
  const [previews, setPreviews] = useState([]);
  const [dragOver, setDragOver] = useState(false);
  const [loading, setLoading]   = useState(false);
  const [reminderDetails, setReminderDetails] = useState(getStoredReminderDetails);
  const [formError, setFormError] = useState('');

  const timezoneOptions = [
    getBrowserTimezone(),
    'Asia/Manila',
    'Europe/London',
    'Asia/Tokyo',
    'America/New_York',
    'America/Los_Angeles',
  ].filter((tz, index, all) => tz && all.indexOf(tz) === index);

  useEffect(() => {
    return () => previews.forEach(previewUrl => URL.revokeObjectURL(previewUrl));
  }, [previews]);

  function updateReminderDetail(key, value) {
    setReminderDetails(prev => {
      const next = { ...prev, [key]: value };
      saveReminderDetails(next);
      return next;
    });
    setFormError('');
  }

  function clearFiles() {
    previews.forEach(previewUrl => URL.revokeObjectURL(previewUrl));
    setFiles([]);
    setPreviews([]);
  }

  function pickFiles(fileList) {
    const selected = Array.from(fileList || []).filter(f => f.type.startsWith('image/'));
    if (!selected.length) return;

    previews.forEach(previewUrl => URL.revokeObjectURL(previewUrl));
    const limited = selected.slice(0, MAX_UPLOAD_IMAGES);
    setFiles(limited);
    setPreviews(limited.map(f => URL.createObjectURL(f)));
    setFormError(selected.length > MAX_UPLOAD_IMAGES ? `Using the first ${MAX_UPLOAD_IMAGES} images.` : '');
  }

  function handleDrop(e) {
    e.preventDefault();
    setDragOver(false);
    pickFiles(e.dataTransfer.files);
  }

  async function handleSubmit() {
    if (!files.length) return;
    const error = validateReminderDetails(reminderDetails);
    if (error) {
      setFormError(error);
      return;
    }

    setLoading(true);
    await onUpload(files, {
      ...reminderDetails,
      contactInfo: reminderDetails.contactInfo.trim(),
    });
    setLoading(false);
  }

  const steps = [
    { icon: 'camera',   label: 'Snap or upload',   desc: 'Take a photo of your prescription',   bg: 'var(--sage-lt)',  fg: 'var(--sage)'  },
    { icon: 'scan',     label: 'AI reads it',       desc: 'Claude vision extracts every detail', bg: 'var(--lav-lt)',   fg: 'var(--lav)'   },
    { icon: 'calendar', label: 'Get your schedule', desc: 'Personalised dose timeline, ready',   bg: 'var(--peach-lt)', fg: 'var(--peach)' },
  ];

  return (
    <div style={{ padding: '24px 20px 40px' }}>

      {/* Welcome heading */}
      <div className="anim-fade-up" style={{ marginBottom: 26 }}>
        <p style={{
          fontFamily: 'var(--font-head)', fontWeight: 600, fontSize: 12,
          color: 'var(--lav)', textTransform: 'uppercase', letterSpacing: '0.09em', marginBottom: 6,
        }}>Welcome back</p>
        <h1 style={{
          fontFamily: 'var(--font-head)', fontWeight: 700, fontSize: 28,
          lineHeight: 1.2, color: 'var(--text)', marginBottom: 8,
        }}>
          Let's decode<br />your prescription
        </h1>
        <p style={{ fontSize: 15, color: 'var(--text2)', lineHeight: 1.65 }}>
          Upload a photo and we'll build your
          medication schedule automatically.
        </p>
      </div>

      {/* Upload zone */}
      <div
        className="glass anim-fade-up"
        style={{
          borderRadius: 'var(--r-xl)',
          border: `2px dashed ${dragOver ? 'var(--sage)' : previews.length ? 'var(--lav)' : 'var(--glass-line)'}`,
          cursor: previews.length ? 'default' : 'pointer',
          overflow: 'hidden', marginBottom: 14,
          minHeight: 200,
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          transition: 'border-color var(--tr)',
          animationDelay: '0.08s',
        }}
        onClick={() => !previews.length && fileRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
      >
        {previews.length ? (
          <div style={{ position: 'relative', width: '100%', padding: 12 }}>
            <p style={{
              fontFamily: 'var(--font-head)', fontWeight: 600, fontSize: 13,
              color: 'var(--text2)', marginBottom: 9, textAlign: 'center',
            }}>
              {files.length} of {MAX_UPLOAD_IMAGES} page{files.length > 1 ? 's' : ''} selected
            </p>
            <div style={{
              display: 'grid',
              gridTemplateColumns: previews.length === 1 ? '1fr' : 'repeat(2, minmax(0, 1fr))',
              gap: 8,
            }}>
              {previews.map((preview, index) => (
                <div key={preview} style={{
                  position: 'relative',
                  borderRadius: 'var(--r-md)',
                  overflow: 'hidden',
                  background: 'var(--bg2)',
                  border: '1px solid var(--glass-line)',
                }}>
                  <img
                    src={preview}
                    alt={`Prescription page ${index + 1}`}
                    style={{
                      width: '100%',
                      height: previews.length === 1 ? 260 : 138,
                      objectFit: 'cover',
                      display: 'block',
                    }}
                  />
                  <span style={{
                    position: 'absolute', left: 8, bottom: 8,
                    padding: '3px 8px', borderRadius: 'var(--r-full)',
                    background: 'rgba(0,0,0,0.55)', color: '#fff',
                    fontFamily: 'var(--font-mono)', fontSize: 11,
                  }}>
                    Page {index + 1}
                  </span>
                </div>
              ))}
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); clearFiles(); }}
              style={{
                position: 'absolute', top: 10, right: 10,
                width: 30, height: 30, borderRadius: '50%',
                background: 'rgba(0,0,0,0.55)', color: '#fff',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            ><Icon name="close" size={16} strokeWidth={2.2} /></button>
          </div>
        ) : (
          <div className="anim-float" style={{ textAlign: 'center', padding: '32px 20px' }}>
            <div className="icon-well" style={{
              width: 64, height: 64, borderRadius: 'var(--r-xl)', margin: '0 auto 14px',
              background: 'linear-gradient(135deg, var(--sage-lt), var(--lav-lt))',
              color: 'var(--sage)',
            }}><Icon name="camera" size={30} strokeWidth={1.6} /></div>
            <p style={{
              fontFamily: 'var(--font-head)', fontWeight: 600, fontSize: 15,
              color: 'var(--text)', marginBottom: 4,
            }}>Tap to upload prescription pages</p>
            <p style={{ fontSize: 12, color: 'var(--text3)' }}>or drag &amp; drop up to {MAX_UPLOAD_IMAGES} JPEG, PNG, or WebP images</p>
          </div>
        )}
      </div>

      <input
        ref={fileRef} type="file" accept="image/*" multiple
        style={{ display: 'none' }}
        onChange={(e) => pickFiles(e.target.files)}
      />

      {/* Reminder details — required for real scheduling */}
      {files.length > 0 && (
        <div
          className="glass anim-fade-up"
          style={{
            borderRadius: 'var(--r-xl)', padding: 16, marginBottom: 14,
            animationDelay: '0.1s',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
            <div className="icon-well" style={{
              width: 38, height: 38, borderRadius: 'var(--r-md)',
              background: 'var(--sage-lt)', color: 'var(--sage)',
            }}><Icon name="sliders" size={19} /></div>
            <div>
              <p style={{ fontFamily: 'var(--font-head)', fontWeight: 700, fontSize: 15, color: 'var(--text)' }}>
                Reminder details
              </p>
              <p style={{ fontSize: 12, color: 'var(--text2)', marginTop: 1 }}>
                Used to schedule notifications after the prescription is read.
              </p>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
            {[
              { id: 'email', label: 'Email' },
              { id: 'sms', label: 'SMS' },
            ].map(option => (
              <button
                key={option.id}
                type="button"
                onClick={() => updateReminderDetail('notificationMethod', option.id)}
                style={{
                  padding: '11px 12px', borderRadius: 'var(--r-md)',
                  background: reminderDetails.notificationMethod === option.id ? 'var(--sage)' : 'var(--bg2)',
                  color: reminderDetails.notificationMethod === option.id ? '#fff' : 'var(--text2)',
                  fontFamily: 'var(--font-head)', fontWeight: 600, fontSize: 13,
                  transition: 'all var(--tr)',
                }}
              >
                {option.label}
              </button>
            ))}
          </div>

          <label style={{ display: 'block', marginBottom: 10 }}>
            <span style={{
              display: 'block', fontFamily: 'var(--font-head)', fontWeight: 600,
              fontSize: 12, color: 'var(--text2)', marginBottom: 6,
            }}>
              {reminderDetails.notificationMethod === 'email' ? 'Email address' : 'Phone number'}
            </span>
            <input
              value={reminderDetails.contactInfo}
              onChange={e => updateReminderDetail('contactInfo', e.target.value)}
              inputMode={reminderDetails.notificationMethod === 'sms' ? 'tel' : 'email'}
              placeholder={reminderDetails.notificationMethod === 'email' ? 'you@example.com' : '+639171234567'}
              style={{
                width: '100%', padding: '12px 13px', borderRadius: 'var(--r-md)',
                background: 'var(--bg2)', border: '1px solid var(--glass-line)',
                fontSize: 14,
              }}
            />
          </label>

          <label style={{ display: 'block' }}>
            <span style={{
              display: 'block', fontFamily: 'var(--font-head)', fontWeight: 600,
              fontSize: 12, color: 'var(--text2)', marginBottom: 6,
            }}>
              Timezone
            </span>
            <select
              value={reminderDetails.userTimezone}
              onChange={e => updateReminderDetail('userTimezone', e.target.value)}
              style={{
                width: '100%', padding: '12px 13px', borderRadius: 'var(--r-md)',
                background: 'var(--bg2)', border: '1px solid var(--glass-line)',
                fontSize: 14,
              }}
            >
              {timezoneOptions.map(tz => <option key={tz} value={tz}>{tz}</option>)}
            </select>
          </label>

          {formError && (
            <p style={{ color: 'var(--danger)', fontSize: 12, marginTop: 10, lineHeight: 1.45 }}>
              {formError}
            </p>
          )}
        </div>
      )}

      {/* Primary CTA — only when file selected */}
      {files.length > 0 && (
        <button
          onClick={handleSubmit}
          disabled={loading}
          style={{
            width: '100%', padding: '16px', borderRadius: 'var(--r-full)',
            background: loading ? 'var(--text3)' : 'linear-gradient(135deg, var(--sage), var(--sage-dk))',
            color: '#fff',
            fontFamily: 'var(--font-head)', fontWeight: 600, fontSize: 16,
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
            boxShadow: loading ? 'none' : 'var(--sh-btn-sage)',
            animation: loading ? 'none' : 'pulse-btn 2.6s ease-in-out infinite',
            transition: 'all var(--tr)',
            marginBottom: 12,
          }}
        >
          {loading
            ? <><Spinner size={18} color="#fff" /> Reading prescription…</>
            : <><Icon name="scan" size={19} strokeWidth={2} /> Read {files.length > 1 ? `${files.length} Pages` : 'My Prescription'}</>}
        </button>
      )}

      {/* Demo CTA */}
      {!files.length && (
        <button
          onClick={() => onUpload(null)}
          className="anim-fade-up"
          style={{
            width: '100%', padding: '14px', borderRadius: 'var(--r-full)',
            background: 'var(--lav-lt)', color: 'var(--lav)',
            fontFamily: 'var(--font-head)', fontWeight: 600, fontSize: 15,
            border: '1px solid rgba(155,142,196,0.25)',
            transition: 'all var(--tr)',
            animationDelay: '0.14s', marginBottom: 14,
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          }}
        ><Icon name="sparkles" size={17} /> Try with sample prescription</button>
      )}

      {/* How it works */}
      <div className="anim-fade-up" style={{ animationDelay: '0.18s', marginBottom: 20 }}>
        <p style={{
          fontFamily: 'var(--font-head)', fontWeight: 600, fontSize: 12,
          color: 'var(--text2)', textTransform: 'uppercase',
          letterSpacing: '0.08em', marginBottom: 12,
        }}>How it works</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
          {steps.map((s, i) => (
            <div
              key={i}
              className="glass"
              style={{
                borderRadius: 'var(--r-lg)', padding: '13px 15px',
                display: 'flex', alignItems: 'center', gap: 13,
              }}
            >
              <div className="icon-well" style={{
                width: 42, height: 42, borderRadius: 'var(--r-md)',
                background: s.bg, color: s.fg,
              }}><Icon name={s.icon} size={21} /></div>
              <div>
                <p style={{ fontFamily: 'var(--font-head)', fontWeight: 600, fontSize: 14, color: 'var(--text)', marginBottom: 1 }}>
                  {s.label}
                </p>
                <p style={{ fontSize: 12, color: 'var(--text2)' }}>{s.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Disclaimer */}
      <div
        className="anim-fade-up"
        style={{
          padding: '13px 15px', borderRadius: 'var(--r-lg)',
          background: 'var(--peach-lt)', border: '1px solid rgba(232,146,124,0.22)',
          animationDelay: '0.24s',
          display: 'flex', alignItems: 'flex-start', gap: 11,
        }}
      >
        <div className="icon-well" style={{
          width: 26, height: 26, borderRadius: 8, marginTop: 1,
          background: 'rgba(232,146,124,0.18)', color: 'var(--peach)',
        }}><Icon name="alert" size={15} strokeWidth={2} /></div>
        <p style={{ fontSize: 12, color: 'var(--text2)', lineHeight: 1.65 }}>
          <strong style={{ color: 'var(--peach)' }}>Heads up:</strong> Text it To Me Doc helps you
          understand your prescription but does <em>not</em> replace professional medical advice.
          Always follow your doctor's or pharmacist's instructions.
        </p>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   PROCESSING SCREEN
───────────────────────────────────────────────────────────────────────────── */
function ProcessingScreen() {
  const [step, setStep] = useState(0);
  const steps = [
    { icon: 'camera',   text: 'Analysing prescription image…' },
    { icon: 'scan',     text: 'Reading medication names…'      },
    { icon: 'cpu',      text: 'Understanding dosing schedule…' },
    { icon: 'calendar', text: 'Building your timeline…'        },
  ];

  useEffect(() => {
    const id = setInterval(() => setStep(s => Math.min(s + 1, steps.length - 1)), 1900);
    return () => clearInterval(id);
  }, [steps.length]);

  return (
    <div
      className="anim-fade-in"
      style={{
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        minHeight: 'calc(100dvh - 62px)', padding: '32px 24px',
      }}
    >
      <div
        className="anim-float"
        style={{
          width: 88, height: 88, borderRadius: 'var(--r-2xl)',
          background: 'linear-gradient(135deg, var(--sage), var(--lav))',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#fff', marginBottom: 28,
          boxShadow: '0 12px 32px -8px rgba(94,126,104,0.5)',
        }}
      ><Icon name="logo" size={42} strokeWidth={1.7} /></div>

      <h2 style={{
        fontFamily: 'var(--font-head)', fontWeight: 700, fontSize: 22,
        color: 'var(--text)', marginBottom: 6, textAlign: 'center',
      }}>Reading your prescription</h2>
      <p style={{ fontSize: 14, color: 'var(--text2)', marginBottom: 32, textAlign: 'center' }}>
        Usually takes about 10 seconds
      </p>

      <div style={{ width: '100%', maxWidth: 340 }}>
        {steps.map((s, i) => (
          <div
            key={i}
            style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '11px 15px', borderRadius: 'var(--r-lg)', marginBottom: 8,
              background: i === step ? 'var(--sage-lt)' : 'transparent',
              opacity: i > step ? 0.3 : 1,
              transition: 'all 0.4s ease',
            }}
          >
            <div style={{
              width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
              background: i < step ? 'var(--sage)' : i === step ? 'var(--lav)' : 'var(--bg3)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: i <= step ? '#fff' : 'var(--text3)',
              transition: 'background 0.3s ease',
            }}>
              <Icon name={i < step ? 'check' : s.icon} size={15} strokeWidth={2} />
            </div>
            <span style={{
              fontSize: 14, color: 'var(--text)',
              fontWeight: i === step ? 600 : 400,
              flex: 1,
            }}>{s.text}</span>
            {i === step && <Spinner size={15} color="var(--lav)" />}
          </div>
        ))}
      </div>
    </div>
  );
}

function ProcessingErrorScreen({ error, onTryAgain }) {
  return (
    <div style={{ padding: '24px 20px 40px' }}>
      <div
        className="glass anim-fade-up"
        style={{
          borderRadius: 'var(--r-xl)',
          padding: '24px 20px',
          border: '1px solid rgba(232,92,92,0.28)',
          background: 'var(--danger-lt)',
        }}
      >
        <div className="icon-well" style={{
          width: 52, height: 52, borderRadius: 'var(--r-lg)',
          background: 'rgba(232,92,92,0.14)', color: 'var(--danger)',
          marginBottom: 16,
        }}><Icon name="alert" size={25} strokeWidth={2} /></div>

        <p style={{
          fontFamily: 'var(--font-head)', fontWeight: 700,
          fontSize: 20, color: 'var(--text)', marginBottom: 8,
        }}>
          I couldn't read that prescription
        </p>
        <p style={{ fontSize: 14, color: 'var(--text2)', lineHeight: 1.65, marginBottom: 14 }}>
          The app did not create a schedule from this upload. Try clearer screenshots, fewer pages, or check the backend logs if this keeps happening.
        </p>

        {error && (
          <p style={{
            fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.55,
            color: '#fff', background: 'rgba(124,34,48,0.72)',
            border: '1px solid rgba(255,255,255,0.18)',
            borderRadius: 'var(--r-md)', padding: '10px 12px', marginBottom: 16,
            wordBreak: 'break-word',
          }}>
            {error}
          </p>
        )}

        <button
          onClick={onTryAgain}
          style={{
            width: '100%', padding: '14px', borderRadius: 'var(--r-full)',
            background: 'var(--sage)', color: '#fff',
            fontFamily: 'var(--font-head)', fontWeight: 600, fontSize: 15,
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            boxShadow: 'var(--sh-btn-sage)',
          }}
        >
          <Icon name="camera" size={18} strokeWidth={2} /> Try another upload
        </button>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   TAPER CHART
───────────────────────────────────────────────────────────────────────────── */
function TaperChart({ taper, color }) {
  const maxDose = Math.max(...taper.map(t => parseFloat(t.dose)));
  const accent  = cv(color);

  return (
    <div style={{ marginTop: 14 }}>
      <p style={{
        fontSize: 11, fontWeight: 600, color: 'var(--text2)',
        textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 9,
      }}>Tapering schedule</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        {taper.map((t, i) => {
          const pct = (parseFloat(t.dose) / maxDose) * 100;
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <span style={{
                fontFamily: 'var(--font-mono)', fontSize: 11,
                color: 'var(--text2)', width: 58, flexShrink: 0,
              }}>{t.label}</span>

              <div style={{
                flex: 1, height: 8, borderRadius: 'var(--r-full)',
                background: 'var(--bg3)', overflow: 'hidden',
              }}>
                <div style={{
                  height: '100%', borderRadius: 'var(--r-full)',
                  background: accent,
                  width: `${pct}%`,
                  animation: `bar-grow 0.9s ${i * 0.08}s cubic-bezier(0.16,1,0.3,1) both`,
                  '--bar-w': `${pct}%`,
                }} />
              </div>

              <span style={{
                fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600,
                color: accent, width: 38, textAlign: 'right', flexShrink: 0,
              }}>{t.dose}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   INFO PILL
───────────────────────────────────────────────────────────────────────────── */
function InfoPill({ label, value }) {
  return (
    <div style={{
      padding: '6px 12px', borderRadius: 'var(--r-full)',
      background: 'var(--bg2)',
    }}>
      <p style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 1 }}>{label}</p>
      <p style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text)', fontWeight: 500 }}>{value}</p>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   MED CARD  (Medications tab)
───────────────────────────────────────────────────────────────────────────── */
function MedCard({ med }) {
  const [open, setOpen] = useState(false);
  const accent = cv(med.color);
  const lt     = clt(med.color);

  const doseLabel = med.taper
    ? `${med.taper[0].dose} → ${med.taper[med.taper.length - 1].dose}`
    : med.dose;

  return (
    <div
      className="glass"
      style={{
        borderRadius: 'var(--r-xl)',
        borderLeft: `4px solid ${accent}`,
        overflow: 'hidden',
      }}
    >
      {/* Header row */}
      <div style={{ padding: '16px 16px 14px', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Badge */}
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            padding: '3px 10px', borderRadius: 'var(--r-full)',
            background: lt, color: accent,
            fontFamily: 'var(--font-head)', fontSize: 11, fontWeight: 600,
            marginBottom: 5,
          }}>
            <Icon name="pill" size={13} strokeWidth={2} /> {med.prn ? 'As Needed' : med.frequencyCode}
          </span>

          <h3 style={{
            fontFamily: 'var(--font-head)', fontWeight: 700,
            fontSize: 18, color: 'var(--text)', marginBottom: 2,
          }}>{med.name}</h3>

          <p style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: accent, fontWeight: 500 }}>
            {doseLabel}
          </p>

          {med.refills > 0 && (
            <p style={{ fontSize: 11, color: 'var(--text3)', marginTop: 3, fontFamily: 'var(--font-mono)' }}>
              +{med.refills} refill{med.refills !== 1 ? 's' : ''}
            </p>
          )}
        </div>

        {/* Expand toggle */}
        <button
          onClick={() => setOpen(v => !v)}
          style={{
            width: 30, height: 30, borderRadius: '50%', flexShrink: 0,
            background: lt, color: accent,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'transform var(--tr)',
            transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
          }}
          aria-label={open ? 'Collapse' : 'Expand'}
        ><Icon name="chevronDown" size={17} strokeWidth={2.2} /></button>
      </div>

      {/* Expanded details */}
      {open && (
        <div style={{
          padding: '0 16px 16px',
          borderTop: '1px solid var(--glass-line)',
          paddingTop: 14,
          animation: 'fadeUp 0.3s ease both',
        }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
            {med.frequency  && <InfoPill label="Frequency" value={med.frequency} />}
            {med.duration   && <InfoPill label="Duration"  value={med.duration}  />}
            {med.times?.length > 0 && (
              <InfoPill label="Times" value={med.times.join(' · ')} />
            )}
            {med.prnMaxPerDay && (
              <InfoPill label="Max / day" value={`${med.prnMaxPerDay}×`} />
            )}
          </div>

          {med.instructions && (
            <div style={{
              padding: '10px 12px', borderRadius: 'var(--r-sm)',
              background: lt,
              display: 'flex', alignItems: 'flex-start', gap: 9,
            }}>
              <span style={{ color: accent, marginTop: 1 }}>
                <Icon name="bulb" size={15} strokeWidth={1.9} />
              </span>
              <p style={{ fontSize: 13, color: 'var(--text2)', lineHeight: 1.6 }}>
                {med.instructions}
              </p>
            </div>
          )}

          {med.taper && <TaperChart taper={med.taper} color={med.color} />}
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   DOSE CARD  (Today timeline)
───────────────────────────────────────────────────────────────────────────── */
function DoseCard({ dose, onToggle, isLast }) {
  const accent = cv(dose.color);

  // Determine if this dose time is in the past
  const [hStr, mStr, period] = (dose.time.match(/(\d+):(\d+)\s*(AM|PM)/i) || []).slice(1);
  const h24 = hStr
    ? parseInt(hStr) + (period?.toUpperCase() === 'PM' && parseInt(hStr) !== 12 ? 12 : 0)
    : 0;
  const now = new Date();
  const isPast    = h24 < now.getHours() || (h24 === now.getHours() && parseInt(mStr || '0') <= now.getMinutes());
  const isOverdue = isPast && !dose.taken;

  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
      {/* Time label */}
      <div style={{ width: 52, flexShrink: 0, textAlign: 'right', paddingTop: 6 }}>
        <span style={{
          fontFamily: 'var(--font-mono)', fontSize: 11,
          color: dose.taken ? 'var(--text3)' : isOverdue ? 'var(--danger)' : 'var(--text2)',
          display: 'block', lineHeight: 1,
        }}>
          {dose.time.replace(':00 ', ' ')}
        </span>
      </div>

      {/* Vertical line + dot */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 6 }}>
        <div style={{
          width: 10, height: 10, borderRadius: '50%', flexShrink: 0,
          background: dose.taken ? 'var(--sage)' : isOverdue ? 'var(--danger)' : accent,
          border: '2px solid var(--bg)',
          transition: 'background var(--tr)',
        }} />
        {!isLast && (
          <div style={{ width: 2, flex: 1, minHeight: 36, background: 'var(--glass-line)', marginTop: 4 }} />
        )}
      </div>

      {/* Card */}
      <div
        className="glass"
        style={{
          flex: 1, borderRadius: 'var(--r-lg)', padding: '13px 13px',
          marginBottom: isLast ? 0 : 10,
          opacity: dose.taken ? 0.65 : 1,
          border: isOverdue ? '1px solid rgba(232,92,92,0.28)' : undefined,
          transition: 'opacity var(--tr)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{
              fontFamily: 'var(--font-head)', fontWeight: 600, fontSize: 14,
              color: 'var(--text)', marginBottom: 2,
              textDecoration: dose.taken ? 'line-through' : 'none',
            }}>{dose.med}</p>
            <p style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: accent }}>
              {dose.dose}
            </p>
            {isOverdue && (
              <p style={{
                fontSize: 11, color: 'var(--danger)', marginTop: 3, fontWeight: 600,
                display: 'inline-flex', alignItems: 'center', gap: 4,
              }}>
                <Icon name="alert" size={12} strokeWidth={2.2} /> Overdue
              </p>
            )}
          </div>

          {/* Check button */}
          <button
            onClick={() => onToggle(dose.id)}
            aria-label={dose.taken ? 'Mark as not taken' : 'Mark as taken'}
            style={{
              width: 30, height: 30, borderRadius: 9, flexShrink: 0,
              background: dose.taken ? 'var(--sage)' : 'var(--card)',
              border: `2px solid ${dose.taken ? 'var(--sage)' : 'var(--glass-line)'}`,
              color: dose.taken ? '#fff' : 'var(--text3)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'all var(--tr)',
            }}
          >{dose.taken && <Icon name="check" size={16} strokeWidth={2.4} className="anim-pop" />}</button>
        </div>
      </div>
    </div>
  );
}

function Notice({ icon = 'alert', title = 'Reminder', children, tone = 'peach', style }) {
  const accent = tone === 'sage' ? 'var(--sage)' : 'var(--peach)';
  const bg = tone === 'sage' ? 'rgba(94,126,104,0.24)' : 'rgba(232,146,124,0.22)';

  return (
    <div style={{
      padding: '12px 14px', borderRadius: 'var(--r-lg)',
      background: bg,
      border: `1px solid ${tone === 'sage' ? 'rgba(94,126,104,0.42)' : 'rgba(232,146,124,0.42)'}`,
      display: 'flex', alignItems: 'flex-start', gap: 11,
      boxShadow: 'var(--sh-card)',
      ...style,
    }}>
      <div className="icon-well" style={{
        width: 28, height: 28, borderRadius: 9, marginTop: 1,
        background: 'rgba(255,255,255,0.14)', color: accent,
      }}><Icon name={icon} size={16} strokeWidth={2} /></div>
      <p style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.6, fontWeight: 500 }}>
        {title && <strong style={{ color: accent }}>{title}: </strong>}
        {children}
      </p>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   UPCOMING TAB
───────────────────────────────────────────────────────────────────────────── */
function UpcomingTab({ rx, scheduleStartDate }) {
  const dayLabels = [
    'Today', 'Tomorrow', 'In 2 days', 'In 3 days', 'In 4 days', 'In 5 days', 'In 6 days',
  ];

  return (
    <div>
      {/* Disclaimer */}
      <Notice style={{ marginBottom: 20 }}>
        Always take medications exactly as prescribed. Contact your doctor if anything seems off.
      </Notice>

      <div className="card-grid card-grid--two" style={{ marginBottom: 16 }}>
      {dayLabels.map((label, i) => {
        const date = offsetDay(i);
        const doses = buildDosesForDate(rx, date, scheduleStartDate);
        return (
          <div key={i}>
            {/* Day header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <span style={{
                fontFamily: 'var(--font-head)', fontWeight: 600, fontSize: 14,
                color: i === 0 ? 'var(--sage)' : 'var(--text)', flexShrink: 0,
              }}>{label}</span>
              <div style={{ flex: 1, height: 1, background: 'var(--glass-line)' }} />
              <span style={{
                fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text3)', flexShrink: 0,
              }}>
                {date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              </span>
            </div>

            {/* Med rows */}
            {doses.length > 0 ? doses.map(dose => (
              <div
                key={dose.id}
                className="glass"
                style={{
                  borderRadius: 'var(--r-lg)', padding: '11px 13px',
                  marginBottom: 8, display: 'flex', alignItems: 'center', gap: 11,
                }}
              >
                <div style={{
                  width: 9, height: 9, borderRadius: '50%',
                  background: cv(dose.color), flexShrink: 0,
                }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{
                    fontFamily: 'var(--font-head)', fontWeight: 600,
                    fontSize: 13, color: 'var(--text)', marginBottom: 1,
                  }}>{dose.med}</p>
                  <p style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: cv(dose.color) }}>
                    {dose.dose}{dose.time && ` · ${dose.time}`}
                  </p>
                </div>
              </div>
            )) : (
              <p style={{
                fontSize: 12, color: 'var(--text2)', lineHeight: 1.5,
                padding: '8px 2px 12px',
              }}>
                No timed doses.
              </p>
            )}
          </div>
        );
      })}
      </div>

      <Notice style={{ marginTop: 4 }}>
        Schedule generated from your prescription. Verify with your pharmacist.
      </Notice>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   SCHEDULE SCREEN
───────────────────────────────────────────────────────────────────────────── */
function ScheduleScreen({ rx, tab, setTab, showTabBar = true }) {
  const [scheduleStartDate, setScheduleStartDate] = useState(() => defaultScheduleStartDate(rx));
  const [doses, setDoses] = useState(() => buildDosesForDate(rx, new Date(), defaultScheduleStartDate(rx)));

  const tabs = [
    { id: 'today',    label: 'Today',       icon: 'sun'      },
    { id: 'upcoming', label: 'Upcoming',    icon: 'calendar' },
    { id: 'meds',     label: 'Medications', icon: 'pill'     },
  ];

  useEffect(() => {
    setScheduleStartDate(defaultScheduleStartDate(rx));
  }, [rx]);

  useEffect(() => {
    setDoses(buildDosesForDate(rx, new Date(), scheduleStartDate));
  }, [rx, scheduleStartDate]);

  const doneCt  = doses.filter(d => d.taken).length;
  const totalCt = doses.length;
  const allDone = totalCt > 0 && doneCt === totalCt;

  function toggle(id) {
    setDoses(ds => ds.map(d => d.id === id ? { ...d, taken: !d.taken } : d));
  }

  return (
    <div style={{ paddingBottom: 110 }}>

      {/* Greeting / progress card */}
      <div
        className="anim-fade-up"
        style={{
          margin: '16px 20px',
          borderRadius: 'var(--r-xl)',
          background: 'linear-gradient(135deg, var(--sage) 0%, var(--sage-dk) 100%)',
          padding: '20px',
          color: '#fff',
        }}
      >
        <p style={{
          fontFamily: 'var(--font-head)', fontSize: 12, fontWeight: 600,
          opacity: 0.78, marginBottom: 3,
        }}>
          {greeting()}, {rx?.patientName || 'there'}
        </p>
        <p style={{
          fontFamily: 'var(--font-head)', fontWeight: 700, fontSize: 15, marginBottom: 18,
        }}>
          {formatDay()}
        </p>

        {/* Progress bar */}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
            <span style={{ fontSize: 13, opacity: 0.82 }}>Today's doses</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600 }}>
              {doneCt}/{totalCt}
            </span>
          </div>
          <div style={{
            height: 8, borderRadius: 'var(--r-full)',
            background: 'rgba(255,255,255,0.22)',
          }}>
            <div style={{
              height: '100%', borderRadius: 'var(--r-full)',
              background: '#fff',
              width: `${totalCt ? (doneCt / totalCt) * 100 : 0}%`,
              transition: 'width 0.65s cubic-bezier(0.16,1,0.3,1)',
            }} />
          </div>
          <p style={{
            fontSize: 12, opacity: 0.82, marginTop: 7,
            display: 'inline-flex', alignItems: 'center', gap: 5,
          }}>
            {allDone
              ? <><Icon name="check" size={14} strokeWidth={2.4} /> All done for today — great job!</>
              : totalCt === 0
                ? 'No timed doses for today'
              : `${totalCt - doneCt} dose${totalCt - doneCt !== 1 ? 's' : ''} left`}
          </p>
        </div>
      </div>

      {/* Timetable adjustment */}
      <div
        className="glass anim-fade-up"
        style={{
          margin: '0 20px 18px',
          borderRadius: 'var(--r-lg)',
          padding: '14px',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ flex: '1 1 220px', minWidth: 0 }}>
          <p style={{
            fontFamily: 'var(--font-head)', fontWeight: 700,
            fontSize: 14, color: 'var(--text)', marginBottom: 2,
          }}>
            Adjust timetable
          </p>
          <p style={{ fontSize: 12, color: 'var(--text2)', lineHeight: 1.45 }}>
            Change the date you actually started taking these meds.
          </p>
        </div>
        <label style={{ display: 'block', flex: '0 0 180px' }}>
          <span style={{
            display: 'block', fontFamily: 'var(--font-head)', fontWeight: 600,
            fontSize: 11, color: 'var(--text2)', marginBottom: 5,
          }}>
            Started on
          </span>
          <input
            type="date"
            value={scheduleStartDate}
            onChange={e => setScheduleStartDate(e.target.value || ymdFromDate())}
            style={{
              width: '100%', padding: '10px 11px',
              borderRadius: 'var(--r-md)',
              background: 'var(--bg2)',
              border: '1px solid var(--glass-line)',
              fontSize: 13,
            }}
          />
        </label>
      </div>

      {/* Tab bar — mobile only; desktop uses the sidebar nav */}
      {showTabBar && (
      <div style={{
        margin: '0 20px 18px',
        background: 'var(--card)',
        borderRadius: 'var(--r-full)',
        border: '1px solid var(--card-bdr)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        padding: 4,
        display: 'flex',
      }}>
        {tabs.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              flex: 1, padding: '9px 6px',
              borderRadius: 'var(--r-full)',
              fontFamily: 'var(--font-head)', fontWeight: 600, fontSize: 12,
              background: tab === t.id ? 'var(--sage)' : 'transparent',
              color: tab === t.id ? '#fff' : 'var(--text2)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
              transition: 'all var(--tr)',
            }}
          >
            <Icon name={t.icon} size={15} strokeWidth={2} />
            <span>{t.label}</span>
          </button>
        ))}
      </div>
      )}

      {/* Tab content */}
      <div style={{ padding: '0 20px' }}>
        {tab === 'today' && (
          <div className="anim-fade-up today-wrap">
            {doses.length > 0 ? (
              doses.map((d, i) => (
                <DoseCard
                  key={d.id}
                  dose={d}
                  onToggle={toggle}
                  isLast={i === doses.length - 1}
                />
              ))
            ) : (
              <Notice icon="calendar" title="No timed doses" tone="sage" style={{ marginTop: 6 }}>
                This prescription did not produce fixed dose times for today.
              </Notice>
            )}
            <Notice style={{ marginTop: 16 }}>
              Schedule generated from your prescription image. Always verify with your pharmacist.
            </Notice>
          </div>
        )}

        {tab === 'upcoming' && (
          <div className="anim-fade-up">
            <UpcomingTab rx={rx} scheduleStartDate={scheduleStartDate} />
          </div>
        )}

        {tab === 'meds' && (
          <div className="anim-fade-up card-grid">
            {(rx?.medications || MOCK_RX.medications).map(m => (
              <MedCard key={m.id} med={m} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   CHAT FAB
───────────────────────────────────────────────────────────────────────────── */
function ChatFab({ onClick }) {
  return (
    <button
      onClick={onClick}
      aria-label="Open AI chat"
      style={{
        position: 'fixed', bottom: 28, right: 20,
        width: 58, height: 58, borderRadius: '50%',
        background: 'linear-gradient(135deg, var(--lav), var(--lav-dk))',
        color: '#fff',
        boxShadow: 'var(--sh-btn-lav)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        animation: 'pulse-fab 2.8s ease-in-out infinite',
        zIndex: 90,
        transition: 'all var(--tr)',
      }}
    ><Icon name="message" size={25} strokeWidth={1.9} /></button>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   CHAT BUBBLE
───────────────────────────────────────────────────────────────────────────── */
function ChatBubble({ msg }) {
  const isUser = msg.role === 'user';
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: isUser ? 'flex-end' : 'flex-start',
        alignItems: 'flex-end',
        gap: 8,
        animation: 'fadeUp 0.28s ease both',
      }}
    >
      {/* AI avatar */}
      {!isUser && (
        <div style={{
          width: 26, height: 26, borderRadius: '50%', flexShrink: 0,
          background: 'linear-gradient(135deg, var(--lav), var(--lav-dk))',
          color: '#fff',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}><Icon name="sparkles" size={14} strokeWidth={2} /></div>
      )}

      {/* Bubble */}
      <div style={{
        maxWidth: '76%',
        padding: '10px 14px',
        borderRadius: isUser
          ? '18px 18px 4px 18px'
          : '18px 18px 18px 4px',
        background: isUser
          ? 'linear-gradient(135deg, var(--sage), var(--sage-dk))'
          : 'var(--card)',
        color: isUser ? '#fff' : 'var(--text)',
        fontSize: 14, lineHeight: 1.6,
        border: isUser ? 'none' : '1px solid var(--card-bdr)',
        boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
        wordBreak: 'break-word',
      }}>
        {msg.text}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   TYPING INDICATOR
───────────────────────────────────────────────────────────────────────────── */
function TypingIndicator() {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
      <div style={{
        width: 26, height: 26, borderRadius: '50%', flexShrink: 0,
        background: 'linear-gradient(135deg, var(--lav), var(--lav-dk))',
        color: '#fff',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}><Icon name="sparkles" size={14} strokeWidth={2} /></div>
      <div style={{
        padding: '12px 16px', borderRadius: '18px 18px 18px 4px',
        background: 'var(--card)', border: '1px solid var(--card-bdr)',
        display: 'flex', alignItems: 'center', gap: 5,
      }}>
        {[0, 1, 2].map(i => (
          <div key={i} style={{
            width: 7, height: 7, borderRadius: '50%',
            background: 'var(--lav)',
            animation: `dot-bounce 1.3s ease-in-out ${i * 0.18}s infinite`,
          }} />
        ))}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   CHAT DRAWER
───────────────────────────────────────────────────────────────────────────── */
function ChatDrawer({ open, onClose, rx, isDesktop = false }) {
  const initMsg = {
    id: 'init', role: 'assistant',
    text: `Hi! I'm here to help you understand your prescription. What questions do you have?`,
  };

  const [messages, setMessages] = useState([initMsg]);
  const [input,    setInput]    = useState('');
  const [loading,  setLoading]  = useState(false);
  const listRef  = useRef();
  const inputRef = useRef();

  // Scroll to bottom on new messages
  useEffect(() => {
    if (open && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages, open, loading]);

  // Focus input when drawer opens
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 420);
  }, [open]);

  async function send(text) {
    const trimmed = text.trim();
    if (!trimmed || loading) return;

    const userMsg = { id: Date.now(), role: 'user', text: trimmed };
    setMessages(ms => [...ms, userMsg]);
    setInput('');
    setLoading(true);

    // Reset textarea height
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
    }

    try {
      const prescription = rx || MOCK_RX;
      // Keep last 6 messages for context window management
      const history = [...messages.slice(-6), userMsg];

      let reply;

      if (PREVIEW && ANTH_KEY) {
        // Preview mode — call Anthropic API directly from browser
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': ANTH_KEY,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 512,
            system: chatSystem(prescription),
            messages: history.map(m => ({ role: m.role, content: m.text })),
          }),
        });
        const data = await res.json();
        reply = data.content?.[0]?.text || 'Sorry, I could not get a response.';

      } else if (!PREVIEW) {
        // Production mode — call backend Lambda
        const res = await fetch(`${API_BASE}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: trimmed, history, prescription: rx || MOCK_RX }),
        });
        const data = await res.json();
        reply = data.reply || 'Sorry, something went wrong.';

      } else {
        // No key, no backend — friendly message
        reply = "I'd need an API key to answer live questions. In demo mode, I can only show you the interface. Add VITE_ANTHROPIC_KEY to your .env to enable the AI chat.";
      }

      setMessages(ms => [...ms, { id: Date.now() + 1, role: 'assistant', text: reply }]);
    } catch {
      setMessages(ms => [...ms, {
        id: Date.now() + 1, role: 'assistant',
        text: 'Something went wrong. Please check your connection and try again.',
      }]);
    } finally {
      setLoading(false);
    }
  }

  const showQuickReplies = messages.length === 1 && !loading;

  return (
    <>
      {/* Backdrop */}
      {open && (
        <div
          className="anim-fade-in"
          onClick={onClose}
          style={{
            position: 'fixed', inset: 0, zIndex: 110,
            background: 'rgba(26, 24, 37, 0.45)',
            backdropFilter: 'blur(4px)',
            WebkitBackdropFilter: 'blur(4px)',
          }}
        />
      )}

      {/* Drawer panel — bottom sheet on mobile, right-docked panel on desktop */}
      <div
        style={isDesktop ? {
          position: 'fixed', top: 0, right: 0,
          transform: `translateX(${open ? '0' : '100%'})`,
          width: 408, maxWidth: '92vw', height: '100dvh',
          borderLeft: '1px solid var(--glass-line)',
          background: 'var(--bg)',
          boxShadow: 'var(--sh-draw)',
          zIndex: 120,
          display: 'flex', flexDirection: 'column',
          transition: 'transform 0.42s cubic-bezier(0.16,1,0.3,1)',
          overflow: 'hidden',
        } : {
          position: 'fixed',
          bottom: 0, left: '50%',
          transform: `translateX(-50%) translateY(${open ? '0' : '100%'})`,
          width: '100%', maxWidth: 480,
          height: '84dvh',
          borderRadius: '28px 28px 0 0',
          background: 'var(--bg)',
          boxShadow: 'var(--sh-draw)',
          zIndex: 120,
          display: 'flex', flexDirection: 'column',
          transition: 'transform 0.42s cubic-bezier(0.16,1,0.3,1)',
          overflow: 'hidden',
        }}
      >
        {/* Drag handle — mobile only */}
        {!isDesktop && (
          <div style={{ padding: '10px 0 4px', display: 'flex', justifyContent: 'center', flexShrink: 0 }}>
            <div style={{ width: 36, height: 4, borderRadius: 'var(--r-full)', background: 'var(--glass-line)' }} />
          </div>
        )}

        {/* Header */}
        <div style={{
          padding: '8px 18px 12px',
          borderBottom: '1px solid var(--glass-line)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{
              width: 38, height: 38, borderRadius: '50%',
              background: 'linear-gradient(135deg, var(--lav), var(--lav-dk))',
              color: '#fff',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 3px 10px -2px rgba(155,142,196,0.5)',
            }}><Icon name="sparkles" size={19} strokeWidth={1.9} /></div>
            <div>
              <p style={{ fontFamily: 'var(--font-head)', fontWeight: 700, fontSize: 15, color: 'var(--text)' }}>
                Text it To Me Doc AI
              </p>
              <p style={{ fontSize: 11, color: 'var(--text3)' }}>Session only · not saved</p>
            </div>
          </div>

          <button
            onClick={onClose}
            style={{
              width: 30, height: 30, borderRadius: '50%',
              background: 'var(--bg2)', color: 'var(--text2)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          ><Icon name="close" size={16} strokeWidth={2.2} /></button>
        </div>

        {/* Message list */}
        <div
          ref={listRef}
          style={{
            flex: 1, overflowY: 'auto',
            padding: '16px 16px 8px',
            display: 'flex', flexDirection: 'column', gap: 10,
          }}
        >
          {messages.map(msg => (
            <ChatBubble key={msg.id} msg={msg} />
          ))}
          {loading && <TypingIndicator />}
        </div>

        {/* Quick reply chips — visible only before first user message */}
        {showQuickReplies && (
          <div style={{
            padding: '4px 14px 8px',
            display: 'flex', gap: 8, overflowX: 'auto',
            WebkitOverflowScrolling: 'touch',
            flexShrink: 0,
          }}>
            {QUICK_QS.slice(0, 4).map((q, i) => (
              <button
                key={i}
                onClick={() => send(q)}
                style={{
                  flexShrink: 0,
                  padding: '7px 13px', borderRadius: 'var(--r-full)',
                  background: 'var(--lav-lt)', color: 'var(--lav)',
                  fontFamily: 'var(--font-body)', fontWeight: 500, fontSize: 12,
                  border: '1px solid rgba(155,142,196,0.22)',
                  whiteSpace: 'nowrap', transition: 'all var(--tr)',
                }}
              >{q}</button>
            ))}
          </div>
        )}

        {/* Input bar */}
        <div style={{
          padding: '10px 14px',
          paddingBottom: `max(14px, env(safe-area-inset-bottom, 14px))`,
          borderTop: '1px solid var(--glass-line)',
          display: 'flex', gap: 10, alignItems: 'flex-end',
          flexShrink: 0,
        }}>
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => {
              setInput(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
            }}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
            placeholder="Ask about your meds…"
            rows={1}
            style={{
              flex: 1,
              padding: '10px 14px',
              borderRadius: 20,
              border: '1px solid var(--glass-line)',
              background: 'var(--card)',
              color: 'var(--text)', fontSize: 14, lineHeight: 1.5,
              resize: 'none', maxHeight: 120,
              overflowY: 'auto',
            }}
          />
          <button
            onClick={() => send(input)}
            disabled={!input.trim() || loading}
            aria-label="Send"
            style={{
              width: 42, height: 42, borderRadius: '50%', flexShrink: 0,
              background: input.trim() && !loading
                ? 'linear-gradient(135deg, var(--lav), var(--lav-dk))'
                : 'var(--bg3)',
              color: input.trim() && !loading ? '#fff' : 'var(--text3)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'all var(--tr)',
            }}
          >
            {loading ? <Spinner size={16} color="var(--lav)" /> : <Icon name="arrowUp" size={20} strokeWidth={2.2} />}
          </button>
        </div>
      </div>
    </>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   ROOT APP
───────────────────────────────────────────────────────────────────────────── */
export default function App() {
  const [screen, setScreen] = useState('home');    // 'home' | 'processing' | 'schedule' | 'error'
  const [rx,     setRx]     = useState(null);
  const [processingError, setProcessingError] = useState('');
  const [chatOpen, setChatOpen] = useState(false);
  const [tab,    setTab]    = useState('today');    // schedule tab, lifted so sidebar can drive it
  const isDesktop = useIsDesktop();

  async function handleUpload(filesOrFile, reminderDetails = getStoredReminderDetails()) {
    const files = Array.isArray(filesOrFile) ? filesOrFile : filesOrFile ? [filesOrFile] : [];

    // Demo mode — skip processing
    if (!files.length) {
      setRx(MOCK_RX);
      setScreen('schedule');
      return;
    }

    setScreen('processing');
    setProcessingError('');

    try {
      let parsed;

      if (PREVIEW && ANTH_KEY) {
        /* ── Preview mode: call Anthropic vision API directly ── */
        const images = await Promise.all(files.map(async (file) => ({
          type: 'image',
          source: {
            type: 'base64',
            media_type: getFileContentType(file),
            data: await fileToBase64(file),
          },
        })));

        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': ANTH_KEY,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: 'claude-opus-4-7',
            max_tokens: 2048,
            system: PARSE_SYSTEM,
            messages: [{
              role: 'user',
              content: [
                ...images,
                { type: 'text',  text: files.length > 1 ? 'Parse these prescription pages together and return the JSON.' : 'Parse this prescription and return the JSON.' },
              ],
            }],
          }),
        });

        const data = await res.json();
        const raw  = data.content?.[0]?.text || '{}';
        // Strip markdown fences if present
        const clean = raw.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
        parsed = JSON.parse(clean);

      } else if (!PREVIEW) {
        /* ── Production mode: upload to S3, call backend Lambda ── */
        const uploadContext = {
          userId: reminderDetails.userId,
          userTimezone: reminderDetails.userTimezone,
          notificationMethod: reminderDetails.notificationMethod,
          contactInfo: reminderDetails.contactInfo,
        };
        const uploadId = `rx-upload-${globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : Date.now()}`;

        const uploaded = await Promise.all(files.map(async (file, index) => {
          const urlRes = await fetch(`${API_BASE}/upload-url`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              userId: uploadContext.userId,
              uploadId,
              pageNumber: index + 1,
              contentType: getFileContentType(file),
            }),
          });
          const urlPayload = await urlRes.json();
          if (!urlRes.ok) throw new Error(errorFromPayload(urlPayload, 'Could not create upload URL'));
          const { uploadUrl, imageKey } = urlPayload;

          const putRes = await fetch(uploadUrl, {
            method: 'PUT', body: file,
            headers: { 'Content-Type': getFileContentType(file) },
          });
          if (!putRes.ok) throw new Error(`Could not upload page ${index + 1}`);

          return imageKey;
        }));

        const procRes = await fetch(`${API_BASE}/process`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            imageKey: uploaded[0],
            imageKeys: uploaded,
            uploadId,
            ...uploadContext,
          }),
        });
        const processPayload = await procRes.json();
        if (!procRes.ok) throw new Error(errorFromPayload(processPayload, 'Could not process prescription'));
        parsed = normalizePrescriptionResponse(processPayload);

      } else {
        // No key and no backend — fall back to mock
        parsed = MOCK_RX;
      }

      // Ensure IDs and colors are set
      parsed.medications = (parsed.medications || []).map((m, i) => ({
        ...m,
        id:    m.id    || `med${i}`,
        color: m.color || ['sage', 'lav', 'peach'][i % 3],
      }));

      setRx(parsed);
      setScreen('schedule');

    } catch (err) {
      console.error('Prescription parse error:', err);
      setRx(null);
      setProcessingError(err.message || 'Unexpected prescription processing error');
      setScreen('error');
    }
  }

  function handleBack() {
    setScreen('home');
    setRx(null);
    setProcessingError('');
    setChatOpen(false);
    setTab('today');
  }

  // Screen content — shared between the mobile and desktop shells
  const screenContent = (
    <>
      {screen === 'home'       && <HomeScreen onUpload={handleUpload} />}
      {screen === 'processing' && <ProcessingScreen />}
      {screen === 'error'      && <ProcessingErrorScreen error={processingError} onTryAgain={handleBack} />}
      {screen === 'schedule'   && (
        <ScheduleScreen
          rx={rx}
          tab={tab}
          setTab={setTab}
          showTabBar={!isDesktop}
        />
      )}
    </>
  );

  /* ── Desktop: sidebar + centered main + right-docked chat ── */
  if (isDesktop) {
    return (
      <>
        <GlobalStyles />
        <div className="app-shell">
          <Sidebar
            screen={screen}
            tab={tab}
            setTab={setTab}
            onNewRx={handleBack}
            onChat={() => setChatOpen(true)}
          />
          <main className="app-main">
            <div className={screen === 'schedule' ? 'wrap-wide' : 'wrap-narrow'}>
              {screenContent}
            </div>
          </main>
        </div>

        <ChatDrawer
          open={chatOpen}
          onClose={() => setChatOpen(false)}
          rx={rx}
          isDesktop
        />
      </>
    );
  }

  /* ── Mobile: top nav + full-width content + floating chat ── */
  return (
    <>
      <GlobalStyles />

      <NavBar screen={screen} onBack={handleBack} />

      {screenContent}

      {screen === 'schedule' && <ChatFab onClick={() => setChatOpen(true)} />}

      <ChatDrawer
        open={chatOpen}
        onClose={() => setChatOpen(false)}
        rx={rx}
        isDesktop={false}
      />
    </>
  );
}
