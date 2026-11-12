function patientNameParts(patient = {}) {
  const clean = (value) => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '');
  const structured = ['firstName', 'lastName', 'middleName'].some(
    (key) => typeof patient[key] === 'string',
  );
  if (structured) {
    const first = clean(patient.firstName),
      last = clean(patient.lastName),
      middle = clean(patient.middleName);
    return {
      first,
      last,
      middle,
      full: [first, middle, last].filter(Boolean).join(' '),
      lastFirst: [last, first, middle].filter(Boolean).join(' '),
      structured: true,
    };
  }
  const full = clean(patient.name),
    parts = full.split(' ').filter(Boolean);
  // Old two-part cards used name + surname. Longer legacy names need human review,
  // rather than silently interpreting a patronymic as a surname.
  const first = parts.length <= 2 ? parts[0] || '' : full,
    last = parts.length === 2 ? parts[1] : '';
  return {
    first,
    last,
    middle: '',
    full,
    lastFirst: last ? [last, first].join(' ') : full,
    structured: false,
  };
}
function patientFullName(patient) {
  return patientNameParts(patient).full;
}
// Clipboard typography is safe to normalize; do not extract digits from arbitrary text.
function normalizePatientPhoneText(value) {
  const raw = String(value || '').trim();
  const plainPhone = /^\+?[\d ().-]*$/;
  if (plainPhone.test(raw)) return raw;
  const text = raw
    .replace(/[\u061c\u200e\u200f\u202a-\u202c\u2066-\u2069]/g, '')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\p{Zs}/gu, ' ')
    .trim();
  return plainPhone.test(text) ? text : null;
}
// Completeness is required only when the phone replaces an absent client identity.
// Existing named/designated cards retain their free-form contact field.
function isCompletePatientPhone(value) {
  const phone = normalizePatientPhoneText(value);
  if (!phone) return false;
  const digits = phone.replace(/\D/g, '');
  if (phone.startsWith('+7')) return /^7\d{10}$/.test(digits);
  if (phone.startsWith('+')) return /^[1-9]\d{7,14}$/.test(digits);
  return /^\d{10}$/.test(digits) || /^[78]\d{10}$/.test(digits);
}
function hasPatientIdentity(patient = {}) {
  return Boolean(
    String(patient.name || '').trim() ||
    String(patient.designation || '').trim() ||
    isCompletePatientPhone(patient.phone),
  );
}
function normalizePatientSearchQuery(query = '') {
  const text = String(query).trim().toLowerCase();
  const phone = normalizePatientPhoneText(text);
  return phone && /\d/.test(phone) ? phone.replace(/\D/g, '') : text;
}
function patientSearchText(patient = {}) {
  const phone = String(patient.phone || ''),
    digits = phone.replace(/\D/g, '');
  // Search aliases only: never rewrite the saved contact or guess foreign country codes.
  const aliases =
    /^[78]\d{10}$/.test(digits) && !/^\s*\+8/.test(normalizePatientPhoneText(phone) ?? phone)
      ? '7' + digits.slice(1) + ' 8' + digits.slice(1)
      : '';
  return `${patientFullName(patient)} ${patient.designation || ''} ${phone} ${digits} ${aliases}`.toLowerCase();
}
function patientMatchesSearch(patient, query) {
  const text = patientSearchText(patient);
  return normalizePatientSearchQuery(query)
    .split(/\s+/)
    .every((part) => text.includes(part));
}
function createPatientNames() {
  return {
    patientNameParts,
    patientFullName,
    hasPatientIdentity,
    isCompletePatientPhone,
    normalizePatientPhoneText,
    patientSearchText,
    normalizePatientSearchQuery,
    patientMatchesSearch,
  };
}
if (typeof module !== 'undefined' && module.exports)
  module.exports = {
    patientNameParts,
    patientFullName,
    hasPatientIdentity,
    isCompletePatientPhone,
    normalizePatientPhoneText,
    patientSearchText,
    normalizePatientSearchQuery,
    patientMatchesSearch,
    createPatientNames,
  };
