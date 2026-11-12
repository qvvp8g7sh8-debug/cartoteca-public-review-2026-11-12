const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStorage } = require('../storage.cjs');
const { directoryPage } = require('../src/server/modules/cabinet/directory.cjs');

test('directory reuses unchanged ciphertext across revisions, scopes staff and prepares both sort orders', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-search-cache-'));
  const storage = createStorage(dir);
  t.after(() => { storage.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const patients = Array.from({ length: 100 }, (_, i) => ({
    id: 'p' + String(i).padStart(3, '0'), name: `Имя${i} Фамилия${99-i}`,
    phone: '+7 918 000 00 ' + String(i).padStart(2, '0'),
    designation: i === 12 ? 'тренер по фитнесу' : '',
    createdBy: i % 2 ? 'a' : 'b', visits: [], appointments: [],
  }));
  storage.write({ revision: 0, patients, services: [] });
  let decodes = 0;
  const tracked = { ...storage, decode(value) { decodes++; return storage.decode(value); } };
  const owner = { accountId: 'owner', organizationId: 'org', role: 'owner' };
  const url = (values = {}) => new URL('http://test/?' + new URLSearchParams({ today: '2030-01-01', limit: 20, ...values }));
  const page = (user = owner, values) => directoryPage(tracked, user, url(values));
  assert.equal(page().total, 100); assert.equal(decodes, 100);
  page(owner, { q: 'тренер' }); page(owner, { sort: 'last', limit: 10 });
  assert.equal(decodes, 100);
  assert.equal(page(owner, { q: '8 918 000 00 12' }).directory[0].id, 'p012');
  assert.equal(page(owner, { q: 'тренер фитнесу' }).matched, 1);
  page({ ...owner, accountId: 'other-owner' }); assert.equal(decodes, 100);
  const changed = structuredClone(patients[12]); changed.designation = 'новая отметка';
  storage.write({ revision: 1, patients: [changed], services: [] }, { changedIds: { patients: ['p012'], services: [] } });
  assert.equal(page(owner, { q: 'новая отметка' }).matched, 1);
  assert.equal(decodes, 101, 'only changed summary is decoded after a write');
  assert.equal(page(owner, { q: 'тренер' }).matched, 0);
  const a = { ...owner, role: 'cosmetologist', accountId: 'a' };
  const b = { ...a, accountId: 'b' };
  assert.equal(page(a).total, 50); assert.equal(page(b).total, 50);
  assert.equal(page(a, { q: 'новая отметка' }).matched, 0);
  assert.equal(page(b, { q: 'новая отметка' }).matched, 1);
  const first = page(owner), next = page(owner, { cursor: first.nextCursor });
  assert.equal(new Set([...first.directory, ...next.directory].map((p) => p.id)).size, 40);
  assert.throws(() => page({ ...owner, accountId: 'different' }, { cursor: first.nextCursor }), (e) => e.status === 400);
  // Small per-staff projections must not churn merely because 200 people are active.
  const fanout = Array.from({ length: 200 }, (_, i) => ({
    ...patients[0], id: 'fanout-' + i, name: 'Тестовый клиент', phone: '', createdBy: 'staff-' + i,
  }));
  storage.write({ revision: 2, patients: fanout, services: [] }, { changedIds: { patients: fanout.map(p => p.id), services: [] } });
  const actors = fanout.map(p => ({ ...a, accountId: p.createdBy }));
  for (const actor of actors) assert.equal(page(actor).total, 1);
  const warmed = decodes;
  for (const actor of actors) assert.equal(page(actor).total, 1);
  assert.equal(decodes, warmed, '200 bounded staff datasets survive the second pass');
});
