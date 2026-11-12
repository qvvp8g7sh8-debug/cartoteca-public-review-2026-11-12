const test = require('node:test');
const assert = require('node:assert/strict');
const { bookingFixture } = require('./helpers/booking-fixture.cjs');
const { publicInfo, publicAvailability, publicSubmit } = require('../src/server/modules/booking/public-service.cjs');
const { assertPublicBookingAppend } = require('../src/server/modules/access/public-booking-policy.cjs');
const { createMultiServer } = require('../multi-server.cjs');

async function fixture(t, options) {
  const f = await bookingFixture(options); t.after(f.close); f.setMode('classic'); return f;
}
test('classic books immediately, shares lifecycle/plan checks, creates no visit or client-attendance confirmation', async t => {
  const f = await fixture(t), values = f.input();
  const result = publicSubmit(f.context, f.org, values, f.now);
  assert.deepEqual(result, { status: 'booked', date: f.date, time: '09:00', duration: 30, expiresAt: null });
  const patient = f.storage.read().patients[0], a = patient.appointments[0];
  assert.equal(patient.visits.length, 0); assert.equal(a.status, 'scheduled');
  for (const key of ['completedVisitId', 'manualConfirmedAt', 'telegramConfirmedAt', 'notificationConfirmedAt'])
    assert.ok(!(key in a));
  assert.equal(f.platform.bookingRequests.openCount(f.org), 0);
  assert.equal(f.platform.bookingRequests.byKey(f.org, values.key, f.now).status, 'accepted');
  assert.deepEqual(publicSubmit(f.context, f.org, values, f.now + 1000), result);
  assert.equal(f.storage.read().patients[0].appointments.length, 1);
  assert.deepEqual(Object.keys(result).sort(), ['date', 'duration', 'expiresAt', 'status', 'time']);
  assert.throws(() => publicSubmit(f.context, f.org, { ...values, time: '10:00' }, f.now + 1000), { status: 409 });
});
test('classic links one matching phone including 8/+7 without rewriting names, history or neighboring cards', async t => {
  const f = await fixture(t, { patients: 3, history: 2 });
  const before = f.storage.read(), p = before.patients[0];
  const result = publicSubmit(f.context, f.org, f.input({ phone: '8' + p.phone.slice(2), lastName: p.lastName }), f.now);
  assert.equal(result.status, 'booked');
  const after = f.storage.read(); assert.equal(after.patients.length, 3);
  assert.deepEqual({ ...after.patients[0], appointments: [] }, p);
  assert.deepEqual(after.patients.slice(1), before.patients.slice(1));
});
test('ambiguous or conflicting contact refuses booking without leaking contacts or leaving a request/card/hold', async t => {
  const f = await fixture(t, { patients: 2 });
  const state = f.storage.read(); state.patients[1].phone = state.patients[0].phone; f.storage.write(state);
  const values = f.input({ phone: state.patients[0].phone });
  assert.throws(() => publicSubmit(f.context, f.org, values, f.now), error =>
    error.status === 409 && !error.message.includes(state.patients[0].name));
  assert.equal(f.platform.bookingRequests.byKey(f.org, values.key, f.now), null);
  assert.equal(f.platform.bookingRequests.reserves(f.org, f.date, f.date, f.now).length, 0);
  state.patients[1].phone = '+79999990001'; state.revision = f.storage.read().revision; f.storage.write(state);
  assert.throws(() => publicSubmit(f.context, f.org, f.input({ phone: state.patients[0].phone, firstName: 'Другой' }), f.now), { status: 409 });
  assert.equal(f.storage.read().patients.length, 2);
});
test('stale form cannot silently switch behavior; legacy writes preserve classic and old requests keep approval semantics', async t => {
  const f = await fixture(t);
  assert.equal(publicInfo(f.context, f.org, f.now).bookingMode, 'classic');
  assert.throws(() => publicSubmit(f.context, f.org, f.input({ bookingMode: 'approval', phone: '+79999999991' }), f.now), { status: 409 });
  assert.throws(() => publicSubmit(f.context, f.org, f.input({ bookingMode: undefined, phone: '+79999999992' }), f.now), { status: 409 });
  assert.throws(() => publicSubmit(f.context, f.org, f.input({ kind: 'other-time', phone: '+79999999993' }), f.now), { status: 400 });
  assert.deepEqual(publicAvailability(f.context, f.org, { date: f.date, serviceIds: ['s'], staffId: f.owner.accountId }, f.now).requestedTimes, []);
  const values = f.input(); const booked = publicSubmit(f.context, f.org, values, f.now);
  f.setMode('approval'); assert.deepEqual(publicSubmit(f.context, f.org, values, f.now + 1000), booked);
  const pending = f.input({ time: '10:00', phone: '+79999999998' });
  assert.equal(publicSubmit(f.context, f.org, pending, f.now).status, 'pending');
  f.setMode('classic'); assert.equal(publicSubmit(f.context, f.org, pending, f.now + 1000).status, 'pending');
  const { bookingMode, members, canManage, canManageOwnRequests, ...saved } = f.platform.onlineBooking.view(f.token);
  f.platform.onlineBooking.save(f.token, saved, new Set(['s']));
  assert.equal(f.platform.onlineBooking.view(f.token).bookingMode, 'classic');
});
test('classic recovery covers cabinet commit/platform rollback and never resurrects a deleted card', async t => {
  const f = await fixture(t), values = f.input(), finish = f.platform.bookingRequests.finish;
  f.platform.bookingRequests.finish = () => { throw Error('Synthetic platform crash gap'); };
  assert.throws(() => publicSubmit(f.context, f.org, values, f.now), /Synthetic platform crash gap/);
  f.platform.bookingRequests.finish = finish;
  assert.equal(f.platform.bookingRequests.byKey(f.org, values.key, f.now), null);
  assert.equal(f.storage.read().patients.length, 1);
  assert.equal(publicSubmit(f.context, f.org, values, f.now + 1000).status, 'booked');
  const state = f.storage.read(); f.storage.write({ ...state, patients: [] });
  assert.equal(publicSubmit(f.context, f.org, values, f.now + 2000).status, 'booked');
  assert.equal(f.storage.read().patients.length, 0);
});
test('classic refuses occupied/broken schedule, revoked publication and invalid consent; public cannot submit clinical fields', async t => {
  const f = await fixture(t), values = f.input();
  assert.throws(() => publicSubmit(f.context, f.org, { ...values, consent: false }, f.now), { status: 400 });
  assert.throws(() => publicSubmit(f.context, f.org, { ...values, patientId: 'guessed' }, f.now), { status: 400 });
  publicSubmit(f.context, f.org, values, f.now);
  assert.throws(() => publicSubmit(f.context, f.org, f.input({ phone: '+79999999998' }), f.now), { status: 409 });
  assert.throws(() => publicSubmit(f.context, f.org, f.input({ time: '12:00', phone: '+79999999997' }), f.now), { status: 409 });
  f.platform.bookingPublication.save(f.token, { enabled: false, revision: 1 });
  assert.throws(() => publicSubmit(f.context, f.org, values, f.now + 1000), { status: 404 });
});
test('public append authority cannot change a card, visit, other appointment or service', () => {
  const current = { role: 'public_booking', organizationId: 'o', accountId: 'staff', appointmentId: 'new' };
  const patient = { id: 'p', name: 'Тестовый', visits: [], appointments: [] };
  const before = { patients: [patient], services: [] };
  const next = { patients: [{ ...patient, appointments: [{ id: 'new', staffId: 'staff', status: 'scheduled' }] }], services: [] };
  assert.doesNotThrow(() => assertPublicBookingAppend(current, before, next));
  for (const change of [
    n => n.patients[0].name = 'Changed', n => n.patients[0].visits.push({ id: 'visit' }),
    n => n.patients[0].appointments[0].staffId = 'other', n => n.services.push({ id: 's' }),
    n => n.patients[0].appointments.push({ id: 'more', staffId: 'staff', status: 'scheduled' }),
  ]) { const bad = structuredClone(next); change(bad); assert.throws(() => assertPublicBookingAppend(current, before, bad), { status: 403 }); }
});
test('HTTP classic works anonymously with origin/CSRF guard and returns no card identifiers', async t => {
  const f = await fixture(t);
  const server = createMultiServer({ dataDir: f.dir, telegramBot: null, supportBot: null,
    telegramAutostart: false, supportAutostart: false, sendMail: null });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
  const url = name => `${base}/api/public-booking/${name}?organization=${f.org}`;
  const info = await (await fetch(url('info'))).json();
  const values = f.input({ key: info.challenge });
  const headers = { 'Content-Type': 'application/json', 'X-Cartoteca-Request': '1', Origin: base };
  const forbidden = await fetch(url('requests'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values) });
  assert.equal(forbidden.status, 403);
  const response = await fetch(url('requests'), { method: 'POST', headers, body: JSON.stringify(values) });
  assert.equal(response.status, 200); assert.equal((await response.json()).status, 'booked');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('classic respects client limit and disabled service/provider without partial writes', async t => {
  const f = await fixture(t, { patients: 10 });
  const before = f.storage.read();
  assert.throws(() => publicSubmit(f.context, f.org, f.input(), f.now), { status: 402 });
  assert.deepEqual(f.storage.read(), before);
  assert.equal(f.platform.bookingRequests.openCount(f.org), 0);
  const p = before.patients[0];
  assert.equal(publicSubmit(f.context, f.org, f.input({ phone: p.phone, lastName: p.lastName }), f.now).status, 'booked');
  const saved = f.platform.onlineBooking.view(f.token);
  const { revision, mode, minimumLeadMinutes, reservationMinutes, showPrices, services } = saved;
  f.platform.onlineBooking.save(f.token, { revision, mode, bookingMode: 'classic', minimumLeadMinutes,
    reservationMinutes, showPrices, services, staff: { [f.owner.accountId]: { enabled: false, manageOwnRequests: true } } }, new Set(['s']));
  assert.throws(() => publicSubmit(f.context, f.org, f.input({ time: '10:00', phone: '+79999999994' }), f.now));
  assert.equal(f.storage.read().patients.flatMap(p => p.appointments).length, 1);
});

test('classic retires expired form receipts but retains all still-valid retries', async t => {
  const f = await fixture(t), first = f.input();
  const result = publicSubmit(f.context, f.org, first, f.now);
  assert.deepEqual(publicSubmit(f.context, f.org, first, f.now + 29 * 60000), result);
  const now = f.now + 32 * 60000;
  const next = f.input({ key: publicInfo(f.context, f.org, now).challenge, time: '10:00', phone: '+79999999998' });
  assert.equal(publicSubmit(f.context, f.org, next, now).status, 'booked');
  assert.equal(f.storage.get('booking-classic-receipt-index').length, 1);
  assert.equal(f.storage.db.prepare("SELECT COUNT(*) n FROM meta WHERE key GLOB 'booking-classic:*'").get().n, 1);
  assert.throws(() => publicSubmit(f.context, f.org, first, now), { status: 400 });
  assert.equal(f.storage.read().patients.flatMap(p => p.appointments).length, 2);
});
