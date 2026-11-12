const test = require('node:test');
const assert = require('node:assert/strict');
const { bookingFixture } = require('./helpers/booking-fixture.cjs');
const { matchingContacts } = require('../src/server/modules/booking/contacts.cjs');
const { startsAt } = require('../src/shared/time-zone-instant.cjs');
const { availableSlots } = require('../src/server/modules/booking/availability.cjs');

test('civil cache separates zones, does not retain appointment data, and rejects DST gaps', () => {
  const a = { date: '2030-01-01', time: '09:00' };
  assert.equal(startsAt(a, 'Europe/Moscow'), Date.parse('2030-01-01T06:00Z'));
  assert.equal(startsAt(a, 'Asia/Yerevan'), Date.parse('2030-01-01T05:00Z'));
  a.time = '10:00';
  assert.equal(startsAt(a, 'Europe/Moscow'), Date.parse('2030-01-01T07:00Z'));
  for (let i = 0; i < 4200; i++) {
    const date = new Date(Date.UTC(2031, 0, 1) + i * 86400000).toISOString().slice(0, 10);
    assert.equal(startsAt({ date, time: '09:00' }, 'UTC'), Date.parse(date + 'T09:00Z'));
  }
  assert.equal(startsAt({ date: '2030-01-01', time: '09:00' }, 'Europe/Moscow'), Date.parse('2030-01-01T06:00Z'));
  assert.ok(Number.isNaN(startsAt({ date: '2030-03-31', time: '02:30' }, 'Europe/Berlin')));
  assert.throws(() => startsAt(a, 'invalid/time-zone'), RangeError);
  const slots = availableSlots({ date: '2030-03-31', duration: 30, staff: [{ accountId: 's' }],
    dayAt: () => ({ status: 'working', intervals: [['01:00', '04:00']] }),
    workspace: { enabled: false, rooms: [{ id: 'r', active: true, staffIds: ['s'] }] },
    timeZone: 'Europe/Berlin', now: Date.parse('2030-03-30T00:00Z'), minimumLeadMinutes: 0 });
  assert.ok(slots.length); assert.ok(slots.every(s => !s.time.startsWith('02:')));
});

test('phone cache reflects edits/deletions immediately and never reuses another storage connection', async t => {
  const f = await bookingFixture({ patients: 2 }); t.after(f.close);
  const phone = f.storage.read().patients[0].phone;
  assert.equal(matchingContacts(f.storage, phone, f.org).length, 1);
  const state = f.storage.read(); state.patients[0].phone = '+79999999990'; f.storage.write(state);
  assert.equal(matchingContacts(f.storage, phone, f.org).length, 0);
  assert.equal(matchingContacts(f.storage, '+79999999990', f.org).length, 1);
  const next = f.storage.read(); next.patients = []; f.storage.write(next);
  assert.equal(matchingContacts(f.storage, '+79999999990', f.org).length, 0);
  const shadow = { filename: f.storage.filename, encode: () => {}, get: () => next.revision + 1,
    indexes: { summaryRows: () => [{ patient_id: 'other', value: Buffer.from('different') }] },
    decode: () => ({ id: 'other', phone }) };
  assert.equal(matchingContacts(shadow, phone, f.org)[0].id, 'other');
  assert.equal(matchingContacts(f.storage, phone, f.org).length, 0);
});

test('occupancy projection preserves blocking values without decoding contact summaries', async t => {
  const f = await bookingFixture({ patients: 10, history: 30, appointments: 10 }); t.after(f.close);
  const full = f.storage.indexes.appointments(f.date, f.date);
  const narrow = f.storage.indexes.appointments(f.date, f.date, { includeNames: false });
  assert.equal(narrow.length, full.length);
  for (let i = 0; i < full.length; i++) {
    assert.deepEqual(narrow[i], Object.fromEntries(['id', 'date', 'time', 'duration', 'staffId', 'roomId', 'status']
      .filter(k => full[i][k] !== undefined).map(k => [k, full[i][k]])));
    assert.ok(!('patientName' in narrow[i]) && !('patientId' in narrow[i]));
  }
});
