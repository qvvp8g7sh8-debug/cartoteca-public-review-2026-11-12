const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

// Each value owns a flat string. Shared repeat strings hide the live graph cost.
function largePatient(id = 'synthetic-large-card', fields = {}, visitCount = 800) {
  assert.ok(Number.isSafeInteger(visitCount) && visitCount >= 1 && visitCount <= 800);
  const flat = (index, kind) => {
    const bytes = Buffer.alloc(20000, 97 + (index % 26));
    bytes.write(String(index).padStart(4, '0') + ':' + kind + ':', 0, 'ascii');
    return bytes.toString('ascii');
  };
  return {
    ...fields,
    id,
    name: fields.name || 'Synthetic memory card',
    visits: Array.from({ length: visitCount }, (_, index) => ({
      id: 'large-visit-' + index,
      date: '2026-10-01',
      notes: flat(index, 'notes'),
      recommendations: flat(index, 'recommendations'),
      photos: [],
    })),
    appointments: [],
  };
}
function textFingerprint(patient) {
  const hash = createHash('sha256');
  for (const visit of patient.visits) hash.update(visit.notes).update(visit.recommendations);
  return hash.digest('hex');
}
// Hash normal JSON values incrementally; do not allocate a second 32 MB string.
function jsonFingerprint(value) {
  const hash = createHash('sha256');
  let bytes = 0;
  const write = (part) => {
    hash.update(part);
    bytes += Buffer.byteLength(part);
  };
  const visit = (item) => {
    if (item === null || typeof item !== 'object') {
      const encoded = JSON.stringify(item);
      assert.equal(typeof encoded, 'string');
      write(encoded);
    } else if (Array.isArray(item)) {
      write('[');
      item.forEach((entry, index) => {
        if (index) write(',');
        visit(entry === undefined ? null : entry);
      });
      write(']');
    } else {
      const entries = Object.entries(item).filter(([, entry]) => entry !== undefined);
      write('{');
      entries.forEach(([key, entry], index) => {
        if (index) write(',');
        write(JSON.stringify(key));
        write(':');
        visit(entry);
      });
      write('}');
    }
  };
  visit(value);
  return { bytes, sha256: hash.digest('hex') };
}
module.exports = { largePatient, textFingerprint, jsonFingerprint };
