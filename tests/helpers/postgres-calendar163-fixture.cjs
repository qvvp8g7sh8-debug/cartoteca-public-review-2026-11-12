const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const { Client } = require('pg');
const { queueFixture } = require('./postgres-queue134-fixture.cjs');
const { createPlatformDatabase } = require('../../src/server/infrastructure/platform-database.cjs');
const { createStorage } = require('../../src/server/infrastructure/cabinet-storage.cjs');
const {
  prepareReadScopes163,
} = require('../../src/server/infrastructure/postgres/read-scope-prepare163.cjs');
const {
  createPostgresReadOperations,
} = require('../../src/server/infrastructure/postgres/read-operations145.cjs');
const {
  createNativeQueryKernel,
} = require('../../src/server/infrastructure/native-query-kernel.cjs');
async function calendarFixture163(t) {
  const f = await queueFixture(t, { cabinetVersion: 2 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-calendar163-'));
  fs.mkdirSync(path.join(dir, 'platform'));
  fs.writeFileSync(path.join(dir, 'postgresql-runtime.json'), JSON.stringify(f.identity.lineage));
  fs.writeFileSync(path.join(dir, 'platform/platform.key'), randomBytes(32));
  fs.writeFileSync(path.join(dir, 'encryption.key'), randomBytes(32));
  const database = createPlatformDatabase(path.join(dir, 'platform'), {
    notificationSchema: 19,
    databaseOwner: f.a.owner,
    sharedCabinetWrites: true,
  });
  const actors = [
    ['owner', 0],
    ['cosmetologist', 0],
    ['salon_admin', 0],
    ['owner', 1],
  ].map(([role, org], i) => ({
    role,
    org,
    accountId: randomUUID(),
    organizationId: f.organizations[org],
    token: 'synthetic-calendar163-' + i,
  }));
  const now = Date.now();
  for (const [i, org] of f.organizations.entries()) {
    f.a.p.prepare('UPDATE organizations SET value=? WHERE id=?').run(
      database.seal({
        name: 'Synthetic ' + i,
        legacyData: i === 0,
        timeZone: 'Europe/Moscow',
        personalEvents: { version: 1, revision: 0, events: [] },
      }),
      org,
    );
    f.a.p
      .prepare(
        'INSERT INTO subscriptions(organization_id,plan,status,limits,changed_at)VALUES(?,?,?,?,?)',
      )
      .run(
        org,
        'paid',
        'active',
        database.seal({ automaticNotifications: true, patients: 20000, photos: 20000 }),
        now,
      );
  }
  for (const a of actors) {
    f.a.p
      .prepare(
        'INSERT INTO accounts(id,email_hash,value,global_admin,status,created_at)VALUES(?,?,?,?,?,?)',
      )
      .run(
        a.accountId,
        'synthetic-email-' + a.accountId,
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
  const storage = createStorage(dir, {
    cabinetSchema: 2,
    databaseOwner: f.a.owner,
    databaseRoot: dir,
    photoOrganizationId: f.organizations[0],
  });
  storage.write({
    revision: 0,
    services: [],
    patients: [
      {
        id: 'patient',
        name: 'Synthetic Patient',
        createdBy: actors[0].accountId,
        notes: 'Synthetic',
        visits: [],
        appointments: [actors[0], actors[1]].map((a, i) => ({
          id: 'appointment-' + i,
          date: '2035-01-02',
          time: i ? '12:00' : '10:00',
          duration: 60,
          service: 'Synthetic',
          staffId: a.accountId,
          status: 'scheduled',
          notes: 'Synthetic',
        })),
      },
    ],
  });
  await f.admin.query('BEGIN');
  await prepareReadScopes163(f.admin, f.runtime.application.user);
  await f.admin.query('COMMIT');
  const base = {
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
  const opened = [];
  let afterCommit = null,
    afterCommitError = null;
  async function kernel(native = true) {
    const owner = await f.open(),
      trace = [];
    const config = { ...base, databaseOwner: owner.owner };
    const operations = native
      ? await createPostgresReadOperations(config, {
          createClient(options) {
            const c = new Client(options),
              query = c.query.bind(c);
            let pendingAfterCommit167 = null;
            c.query = (input, ...args) => {
              const text = typeof input === 'string' ? input : input.text;
              trace.push(text);
              // Keep the existing after-COMMIT revoke injection meaningful when
              // the runtime pipelines its fresh authority. Pause actual query
              // submission, rather than only delaying a result already read.
              if (pendingAfterCommit167 && /fence_locked/.test(text)) {
                const cutpoint = pendingAfterCommit167;
                pendingAfterCommit167 = null;
                return cutpoint.then(() => query(input, ...args));
              }
              const promise = query(input, ...args);
              if (text === 'COMMIT' && afterCommit) {
                const run = afterCommit;
                afterCommit = null;
                pendingAfterCommit167 = promise.then(async (result) => {
                  try {
                    await run();
                  } catch (error) {
                    afterCommitError = error;
                    throw error;
                  }
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
      kernel: createNativeQueryKernel(config, { readOperations: operations }),
      operations,
      trace,
    };
    opened.push(value);
    return value;
  }
  const metadata = (url, actor = actors[0]) => ({
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
  });
  const run = async (k, url, actor = actors[0], change) => {
    const m = metadata(url, actor);
    change?.(m);
    const reply = await k.kernel.run(m, null, {
      memoryClass: 'query-probe',
      requestMemoryClass: async () => {},
    });
    if (afterCommitError) throw afterCommitError;
    return { status: reply.status, body: JSON.parse(Buffer.from(reply.body).toString()) };
  };
  const url =
    '/api/cabinet/calendar?from=2035-01-01&to=2035-01-03&compact=1&monthFrom=2035-01-01&monthTo=2035-01-31&projection=details';
  const conditional = (body) =>
    url + '&version=' + encodeURIComponent(body.version) + '&until=' + body.validUntil;
  async function close() {
    for (const k of opened) await k.kernel.close();
    storage.close();
    database.closeWriter();
    database.db.close();
    if (fs.existsSync(dir)) {
      assertSafe();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  function assertSafe() {
    if (
      path.dirname(dir) !== path.resolve(os.tmpdir()) ||
      !path.basename(dir).startsWith('cartoteca-calendar163-')
    )
      throw Error('Unsafe synthetic cleanup');
  }
  return {
    ...f,
    dir,
    database,
    storage,
    actors,
    kernel,
    run,
    url,
    conditional,
    setAfterCommit(fn) {
      afterCommit = fn;
    },
    close,
  };
}
module.exports = { calendarFixture163 };
