const test = require('node:test');
const assert = require('node:assert/strict');
const { patientCapsuleFixture197 } = require('./helpers/patient-capsule197-fixture.cjs');
const {
  prepareUnkeyedPatientSelection198,
  preparePatientCapsule197,
} = require('../src/server/infrastructure/postgres/read-patient-capsule197.cjs');

test('198 first/warm owner and admin selections match the canonical keyed selection without touching crypto', (t) => {
  const f = patientCapsuleFixture197(t);
  for (const role of ['owner', 'salon_admin']) {
    const current = Object.freeze({ ...f.current, role });
    for (const url of [
      f.url(),
      f.url('/api/cabinet/patient/history'),
      f.url('/api/cabinet/patient/upcoming'),
      f.url(undefined, { view: 'appointment', appointmentId: 'a-3' }),
    ]) {
      const options = {
        url,
        current,
        catalog: f.catalog,
        get crypto() {
          throw Error('unkeyed hint touched crypto');
        },
      };
      const first = prepareUnkeyedPatientSelection198(options);
      const warm = prepareUnkeyedPatientSelection198(options);
      assert.deepEqual(
        first,
        preparePatientCapsule197({ url, current, crypto: f, catalog: f.catalog }),
      );
      assert.deepEqual(warm, first);
      assert.notEqual(first, warm);
      first.cursor.visit = 7;
      assert.equal(warm.cursor.visit, 0);
    }
  }
});

test('198 staff/cursor/details/unsupported metadata remain on the existing keyed path', (t) => {
  const f = patientCapsuleFixture197(t);
  const base = { url: f.url(), current: f.current, catalog: f.catalog };
  for (const options of [
    { ...base, current: { ...f.current, role: 'cosmetologist' } },
    { ...base, current: { ...f.current, globalAdmin: true } },
    { ...base, url: f.url(undefined, { cursor: 'opaque-existing-cursor' }) },
    { ...base, url: f.url(undefined, { view: 'appointment', appointmentId: 'a-3', details: '1' }) },
    { ...base, url: new URL('/api/cabinet/patient?id=patient', 'http://local.test') },
    { ...base, catalog: { ...f.catalog, version: 1 } },
    { ...base, catalog: { version: 2, tables: {} } },
    { ...base, catalog: { version: 2, tables: { cabinet_history_entries: {} } } },
  ])
    assert.equal(prepareUnkeyedPatientSelection198(options), null);
  const emptyCursor = f.url(undefined, { cursor: '' });
  assert.equal(prepareUnkeyedPatientSelection198({ ...base, url: emptyCursor }).kind, 'card');
});

test('198 unkeyed preparation preserves ID, appointment and current-context validation without granting a response', (t) => {
  const f = patientCapsuleFixture197(t);
  const options = (url = f.url(), current = f.current) => ({ url, current, catalog: f.catalog });
  const unicode = '\u{1f4cb}'.repeat(60);
  const valid = f.url(undefined, { id: unicode });
  assert.equal(prepareUnkeyedPatientSelection198(options(valid)).id, unicode);
  assert.throws(
    () => prepareUnkeyedPatientSelection198(options(f.url(undefined, { id: 'a'.repeat(121) }))),
    { status: 400 },
  );
  assert.throws(
    () => prepareUnkeyedPatientSelection198(options(f.url(undefined, { view: 'appointment' }))),
    { status: 400 },
  );
  for (const name of ['sessionId', 'accountId', 'organizationId']) {
    assert.throws(
      () => prepareUnkeyedPatientSelection198(options(f.url(), { ...f.current, [name]: '' })),
      { status: 403 },
    );
  }
  const hint = prepareUnkeyedPatientSelection198(options());
  assert.deepEqual(Object.keys(hint).sort(), ['appointmentId', 'audience', 'cursor', 'id', 'kind']);
  assert.equal(hint.authority, undefined);
  assert.equal(hint.rows, undefined);
});
