const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const { Client } = require('pg');
const { queueFixture } = require('./postgres-queue134-fixture.cjs');
const { createPlatformDatabase } = require('../../src/server/infrastructure/platform-database.cjs');
const { createStorage } = require('../../src/server/infrastructure/cabinet-storage.cjs');
const {
  createPostgresReadOperations,
} = require('../../src/server/infrastructure/postgres/read-operations145.cjs');
const {
  createNativeQueryKernel,
} = require('../../src/server/infrastructure/native-query-kernel.cjs');
const {
  createAppointmentConfirmations,
} = require('../../src/server/modules/cabinet/confirmations.cjs');

const {
  prepareReadScopes163,
} = require('../../src/server/infrastructure/postgres/read-scope-prepare163.cjs');
const {
  prepareHotMetadata169,
} = require('../../src/server/infrastructure/postgres/hot-metadata-prepare169.cjs');
const {
  preparePatientCapsule197,
} = require('../../src/server/infrastructure/postgres/patient-capsule-prepare197.cjs');

async function patientCapsulePGFixture197(t) {
  let dir,
    database,
    storage,
    closed = false;
  const kernels = [];
  t.after(() => close());
  const f = await queueFixture(t, {
    cabinetVersion: 2,
    cabinetComponents: { patientHistory: true },
  });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-patient197-'));
  fs.mkdirSync(path.join(dir, 'platform'));
  fs.writeFileSync(path.join(dir, 'postgresql-runtime.json'), JSON.stringify(f.identity.lineage));
  fs.writeFileSync(path.join(dir, 'platform/platform.key'), randomBytes(32));
  fs.writeFileSync(path.join(dir, 'encryption.key'), randomBytes(32));
  database = createPlatformDatabase(path.join(dir, 'platform'), {
    notificationSchema: 19,
    databaseOwner: f.a.owner,
    sharedCabinetWrites: true,
  });
  const actors = ['owner', 'cosmetologist', 'salon_admin'].map((role, i) => ({
    role,
    accountId: randomUUID(),
    organizationId: f.organizations[0],
    token: 'synthetic-patient165-' + i,
  }));
  const now = Date.now();
  f.a.p
    .prepare('UPDATE organizations SET value=? WHERE id=?')
    .run(
      database.seal({ name: 'Synthetic165', legacyData: true, timeZone: 'Europe/Moscow' }),
      f.organizations[0],
    );
  f.a.p
    .prepare(
      'INSERT INTO subscriptions(organization_id,plan,status,limits,changed_at)VALUES(?,?,?,?,?)',
    )
    .run(
      f.organizations[0],
      'paid',
      'active',
      database.seal({ automaticNotifications: true, patients: 20000, photos: 20000 }),
      now,
    );
  for (const a of actors) {
    f.a.p
      .prepare(
        'INSERT INTO accounts(id,email_hash,value,global_admin,status,created_at)VALUES(?,?,?,?,?,?)',
      )
      .run(
        a.accountId,
        'synthetic-' + a.accountId,
        database.seal({ displayName: 'Synthetic ' + a.role, email: 'synthetic@invalid.test' }),
        0,
        'active',
        now,
      );
    f.a.p
      .prepare(
        'INSERT INTO memberships(organization_id,account_id,role,status,created_at)VALUES(?,?,?,?,?)',
      )
      .run(a.organizationId, a.accountId, a.role, 'active', now);
    f.a.p
      .prepare(
        'INSERT INTO platform_sessions(token_hash,id,account_id,organization_id,value,expires_at)VALUES(?,?,?,?,?,?)',
      )
      .run(
        database.tokenHash(a.token),
        randomUUID(),
        a.accountId,
        a.organizationId,
        database.seal({}),
        now + 3600000,
      );
  }
  storage = createStorage(dir, {
    cabinetSchema: 2,
    databaseOwner: f.a.owner,
    databaseRoot: dir,
    photoOrganizationId: f.organizations[0],
  });
  const appointment = (id, staff, status = 'scheduled') => ({
    id,
    staffId: staff,
    status,
    date: '2035-01-02',
    time: '10:00',
    duration: 60,
    service: 'Synthetic',
  });
  storage.write({
    revision: 0,
    services: [],
    patients: ['empty', 'live'].map((id) => ({
      id,
      name: 'Synthetic ' + id,
      createdBy: actors[0].accountId,
      notes: 'Synthetic profile',
      visits: Array.from({ length: 113 }, (_, i) => ({
        id: id + '-visit-' + i,
        date: '2020-01-01',
        staffId: actors[i % 2].accountId,
        procedure: 'Synthetic',
        photos: [],
      })),
      appointments:
        id === 'empty'
          ? [appointment(id + '-closed', actors[1].accountId, 'cancelled')]
          : Array.from({ length: 113 }, (_, i) =>
              appointment(id + '-appointment-' + i, actors[i % 2].accountId),
            ),
    })),
  });
  const confirmations = createAppointmentConfirmations({
    ...require('../../src/server/infrastructure/platform-constants.cjs'),
    ...database,
  });
  f.a.p.exec('BEGIN IMMEDIATE');
  try {
    confirmations.set(
      f.organizations[0],
      'live',
      appointment('live-appointment-0', actors[0].accountId),
      'Europe/Moscow',
      actors[0].accountId,
      true,
      now,
    );
    f.a.p.exec('COMMIT');
  } catch (error) {
    f.a.p.exec('ROLLBACK');
    throw error;
  }
  let afterCommit = null;
  const config = {
    dataDir: dir,
    storageBackend: 'postgres',
    postgres: f.runtime.application,
    postgresRevisionProfile: 3,
    cabinetSchema: 2,
    notificationSchema: 19,
    origin: 'http://127.0.0.1:4174',
    host: '127.0.0.1',
    port: 4174,
    production: false,
    sharedCabinetWrites: true,
    commonNotificationsEnabled: true,
    maxEnabled: false,
    pushEnabled: false,
  };
  async function kernel(native = true, readViewsEnabled = true) {
    const owner = await f.open(),
      selected = { ...config, databaseOwner: owner.owner },
      trace = [];
    const operations = native
      ? await createPostgresReadOperations(selected, {
          readViewsEnabled,
          createClient(options) {
            const c = new Client(options),
              query = c.query.bind(c);
            let pendingAfterCommit167 = null;
            c.query = (input, ...args) => {
              const text = typeof input === 'string' ? input : input.text;
              trace.push(text);
              if (pendingAfterCommit167 && /fence_locked/.test(text)) {
                const pending = pendingAfterCommit167;
                pendingAfterCommit167 = null;
                return pending.then(() => query(input, ...args));
              }
              const promise = query(input, ...args);
              if (text === 'COMMIT' && afterCommit) {
                const callback = afterCommit;
                afterCommit = null;
                pendingAfterCommit167 = promise.then(async (result) => {
                  await callback();
                  return result;
                });
                return pendingAfterCommit167;
              }
              return promise;
            };
            return c;
          },
        })
      : null;
    const value = {
      kernel: createNativeQueryKernel(selected, { readOperations: operations }),
      operations,
      trace,
    };
    kernels.push(value);
    return value;
  }
  function metadata(url, actor) {
    return {
      method: 'GET',
      url,
      headers: {
        host: '127.0.0.1:4174',
        cookie: 'cartoteca_v2_session=' + actor.token,
        'x-cartoteca-account-id': actor.accountId,
        'x-cartoteca-organization-id': actor.organizationId,
      },
      runtime: {
        timestamp: Date.now(),
        telegram: { configured: false, connected: false, botId: '' },
        providers: {
          telegram: { configured: false, connected: false, botId: '' },
          max: { configured: false, connected: false, botId: '' },
        },
      },
    };
  }
  async function response(k, url, actor = actors[0]) {
    const response = await k.kernel.run(metadata(url, actor), null, {
      memoryClass: 'query-probe',
      requestMemoryClass: async () => {},
    });
    const body = JSON.parse(Buffer.from(response.body).toString());
    return { status: response.status, body };
  }
  const normalize = (value) => {
    const copy = structuredClone(value);
    if (copy.nextCursor)
      copy.nextCursor = storage.decode(Buffer.from(copy.nextCursor, 'base64url'));
    for (const key of ['history', 'upcoming'])
      if (copy[key]?.nextCursor)
        copy[key].nextCursor = storage.decode(Buffer.from(copy[key].nextCursor, 'base64url'));
    return copy;
  };

  async function prepare({ capsule = true } = {}) {
    await f.admin.query('BEGIN');
    try {
      await prepareReadScopes163(f.admin, f.runtime.application.user);
      await prepareHotMetadata169(f.admin, f.runtime.application.user, {
        marker: f.identity.lineage,
      });
      if (capsule) await preparePatientCapsule197(f.admin, f.runtime.application.user);
      await f.admin.query('COMMIT');
    } catch (error) {
      await f.admin.query('ROLLBACK');
      throw error;
    }
  }
  async function close() {
    if (closed) return;
    closed = true;
    const errors = [];
    for (const callback of [
      ...kernels.map((k) => () => k.kernel.close()),
      () => storage?.close(),
      () => database?.closeWriter(),
      () => database?.db.close(),
    ]) {
      try {
        await callback();
      } catch (error) {
        errors.push(error);
      }
    }
    if (dir && fs.existsSync(dir)) {
      assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
      assert.ok(path.basename(dir).startsWith('cartoteca-patient197-'));
      fs.rmSync(dir, { recursive: true, force: true });
    }
    if (errors.length) throw errors[0];
  }
  return {
    ...f,
    dir,
    database,
    storage,
    actors,
    kernel,
    response,
    metadata,
    normalize,
    prepare,
    close,
    setAfterCommit(callback) {
      afterCommit = callback;
    },
  };
}
module.exports = { patientCapsulePGFixture197 };
