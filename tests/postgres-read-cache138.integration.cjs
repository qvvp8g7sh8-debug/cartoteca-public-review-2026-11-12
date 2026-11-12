const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { postgresBusinessFixture } = require('./helpers/postgres-business133-fixture.cjs');
const { initializePostgresOwner } = require('../src/server/infrastructure/postgres/initialize.cjs');
const { createStorage } = require('../src/server/infrastructure/cabinet-storage.cjs');
const { directoryPage } = require('../src/server/modules/cabinet/directory.cjs');
const { createReadCacheBudget } = require('../src/server/infrastructure/read-cache-budget.cjs');

test(
  'PostgreSQL byte-backed directory/service/calendar caches retain fresh snapshots, rollback and authority',
  { timeout: 180000 },
  async (t) => {
    const f = await postgresBusinessFixture(t),
      budget = createReadCacheBudget({ maxBytes: 65536 });
    const options = await initializePostgresOwner({
      dataDir: f.destination,
      storageBackend: 'postgres',
      postgres: f.runtime.application,
      notificationSchema: 18,
      processRole: 'command',
    });
    const shadow = createStorage(path.join(f.destination, 'tenants', f.org), {
      databaseOwner: options.databaseOwner,
      databaseRoot: f.destination,
      photoOrganizationId: f.org,
      readCacheBudget: budget,
    });
    t.after(async () => {
      shadow.close();
      await options.databaseOwner.close();
    });
    const url = new URL('http://synthetic/?today=' + f.date + '&limit=20');
    const current = () => {
      const value = f.platform.session(f.token);
      assert.ok(value, 'fresh session authority is required before each read');
      return value;
    };
    const page = () => directoryPage(shadow, current(), url);
    const first = page(),
      patient = first.directory[0];
    assert.ok(patient);
    const originalName = patient.name;
    patient.name = 'Unsaved mutation';
    assert.equal(page().directory[0].name, originalName);
    const before = f.storage.read();
    const next = structuredClone(before);
    Object.assign(next.patients[0], {
      firstName: 'Committed',
      middleName: 'external',
      lastName: 'change',
      name: 'Committed external change',
    });
    next.services[0].name = 'Committed external service';
    f.storage.write(next);
    assert.equal(page().directory[0].name, 'Committed external change');
    const service = shadow.readServices();
    service[0].name = 'Unsaved service';
    assert.equal(shadow.readServices()[0].name, 'Committed external service');
    assert.throws(
      () =>
        f.storage.transaction(() => {
          const draft = f.storage.read();
          Object.assign(draft.patients[0], {
            firstName: 'Rolled',
            middleName: '',
            lastName: 'back',
            name: 'Rolled back',
          });
          f.storage.write(draft, { insideTransaction: true });
          throw Error('Synthetic rollback');
        }),
      /Synthetic rollback/,
    );
    assert.equal(page().directory[0].name, 'Committed external change');
    const calendar = shadow.calendarSnapshot(f.date, f.date, {
      overview: { from: f.date, to: f.date },
      projection: 'overview',
    });
    const repeated = shadow.calendarSnapshot(f.date, f.date, {
      overview: { from: f.date, to: f.date },
      projection: 'overview',
    });
    assert.deepEqual(calendar.overview, repeated.overview);
    assert.notEqual(calendar.overview, repeated.overview);
    f.database.transaction(() =>
      f.database.db
        .prepare("UPDATE memberships SET status='revoked' WHERE organization_id=? AND account_id=?")
        .run(f.org, f.owner.accountId),
    );
    assert.throws(page, /fresh session authority/);
    assert.ok(budget.stats().bytes <= budget.stats().maxBytes);
    shadow.close();
    assert.equal(
      budget.stats().bytes,
      0,
      'closing the connection releases all derived byte entries',
    );
  },
);
