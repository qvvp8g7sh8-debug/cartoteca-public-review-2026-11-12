const { validateLifecycle } = require('./lifecycle.cjs');
const { validAppointmentTime } = require('../../../shared/appointment-time.cjs');
const { patientNameParts, hasPatientIdentity } = require('../../../shared/patient-names.cjs');
const invalid = (message, code) => {
  throw Object.assign(new Error(message), { status: 400, ...(code ? { code } : {}) });
};
const object = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
function text(x, key, max = 2000, required = false) {
  const v = x[key];
  if (v === undefined && !required) return;
  if (typeof v !== 'string' || v.length > max || (required && !v.trim()))
    invalid('Некорректное текстовое поле: ' + key + '.');
}
function date(x, key, required = false) {
  if (!required && (x[key] === undefined || x[key] === '')) return;
  const v = x[key];
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || v < '0001-01-01')
    invalid('Некорректная дата.');
  const d = new Date(v + 'T00:00:00Z');
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== v)
    invalid('Некорректная дата.');
}
function collection(items, max, seen = new Set()) {
  if (!Array.isArray(items) || items.length > max)
    invalid('Некорректный список или превышено число записей.');
  for (const x of items) {
    if (!object(x)) invalid('Запись должна быть объектом.');
    text(x, 'id', 120, true);
    if (seen.has(x.id)) invalid('Идентификаторы записей должны быть уникальными.');
    seen.add(x.id);
  }
}
function duration(value) {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return NaN;
  const match = value.trim().match(/^(\d+)(?:\s*(мин(?:ут(?:а|ы)?)?|м|час(?:а|ов)?|ч))?$/i);
  return match ? Number(match[1]) * (/^(час|ч)/i.test(match[2] || '') ? 60 : 1) : NaN;
}
function checkDuration(value) {
  const n = duration(value);
  if (!Number.isSafeInteger(n) || n < 5 || n > 1440 || n % 5)
    invalid('Длительность должна быть от 5 до 1440 минут с шагом 5 минут.');
}
function safeTree(value, depth = 0, budget = { n: 0 }) {
  if (++budget.n > 500000 || depth > 12) invalid('Слишком сложная структура данных.');
  if (typeof value === 'string') {
    if (value.length > 14 * 1024 * 1024) invalid('Слишком длинное значение.');
    return;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) invalid('Некорректное число.');
  if (value && typeof value === 'object') {
    if (Array.isArray(value) && value.length > 20000) invalid('Слишком длинный список.');
    if (!Array.isArray(value) && Object.keys(value).length > 100) invalid('Слишком много полей.');
    for (const [k, v] of Object.entries(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(k) || k.length > 120)
        invalid('Недопустимое поле.');
      if (typeof v === 'string' && k !== 'data' && v.length > 20000)
        invalid('Слишком длинное текстовое поле.');
      safeTree(v, depth + 1, budget);
    }
  } else if (!['string', 'number', 'boolean', 'undefined'].includes(typeof value) && value !== null)
    invalid('Недопустимое значение.');
}
function validateState(payload) {
  if (!object(payload)) invalid('Неверный формат картотеки.');
  safeTree(payload);
  if (!Number.isSafeInteger(payload.revision) || payload.revision < 0)
    invalid('Некорректная версия картотеки.');
  collection(payload.patients, 20000);
  collection(payload.services, 2000);
  const visitIds = new Set(),
    appointmentIds = new Set();
  for (const p of payload.patients) {
    text(p, 'name', 500);
    if (typeof p.name !== 'string') invalid('Некорректное имя клиента.');
    text(p, 'phone', 100);
    date(p, 'birth');
    text(p, 'allergies', 20000);
    text(p, 'notes', 20000);
    text(p, 'createdBy', 120);
    for (const key of ['firstName', 'lastName', 'middleName']) text(p, key, 500);
    text(p, 'designation', 200);
    text(p, 'clientMarkNote', 200);
    if (p.clientMark !== undefined && !['none', 'star', 'attention', 'flag'].includes(p.clientMark))
      invalid('Выберите допустимую метку клиента.');
    if ((!p.clientMark || p.clientMark === 'none') && p.clientMarkNote)
      invalid('Уберите пояснение или выберите метку клиента.');
    if (!hasPatientIdentity(p))
      invalid('Укажите ФИО, обозначение или полный номер телефона клиента.');
    if (p.videoConsent !== undefined && !['unknown', 'granted', 'refused'].includes(p.videoConsent))
      invalid('Некорректная отметка согласия на видеосъёмку.');
    const names = patientNameParts(p);
    if (names.structured && p.name !== names.full)
      invalid('Проверьте имя, фамилию и отчество клиента.');
    collection(p.visits, 10000, visitIds);
    collection(p.appointments, 10000, appointmentIds);
    for (const v of p.visits) {
      date(v, 'date', true);
      for (const k of ['type', 'procedure', 'product', 'amount', 'zones', 'reaction']) text(v, k);
      text(v, 'notes', 20000);
      text(v, 'recommendations', 20000);
      text(v, 'staffId', 120);
      if (v.photos !== undefined) {
        if (!Array.isArray(v.photos) || v.photos.length > 6)
          invalid('Допускается до шести фотографий на посещение.');
        for (const ph of v.photos) {
          if (!object(ph)) invalid('Некорректная фотография.');
          text(ph, 'data', 14 * 1024 * 1024, true);
          text(ph, 'caption', 2000);
        }
      }
    }
    for (const a of p.appointments) {
      date(a, 'date', true);
      if (!validAppointmentTime(a.time))
        invalid('Время записи должно быть с шагом 5 минут.', 'APPOINTMENT_TIME_STEP');
      text(a, 'service', 2000);
      text(a, 'notes', 20000);
      text(a, 'staffId', 120);
      text(a, 'roomId', 120);
      if (a.duration !== undefined) {
        if (typeof a.duration !== 'number') invalid('Длительность записи должна быть числом.');
        checkDuration(a.duration);
      }
    }
    validateLifecycle(p);
  }
  for (const s of payload.services) {
    text(s, 'staffId', 120);
    text(s, 'name', 500, true);
    text(s, 'product', 2000);
    text(s, 'description', 2000);
    text(s, 'category', 100);
    if (s.duration !== undefined) {
      text(s, 'duration', 100);
      checkDuration(s.duration);
    }
    if (typeof s.price !== 'number' || !Number.isFinite(s.price) || s.price < 0 || s.price > 1e9)
      invalid('Стоимость должна быть числом от 0 до 1 000 000 000.');
  }
  return payload;
}
module.exports = { validateState, duration };
