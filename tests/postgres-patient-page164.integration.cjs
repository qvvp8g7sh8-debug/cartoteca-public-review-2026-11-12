const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const { Client } = require('pg');
const { queueFixture } = require('./helpers/postgres-queue134-fixture.cjs');
const { createPlatformDatabase } = require('../src/server/infrastructure/platform-database.cjs');
const { createStorage } = require('../src/server/infrastructure/cabinet-storage.cjs');
const {
  createPostgresReadOperations,
} = require('../src/server/infrastructure/postgres/read-operations145.cjs');
const { createNativeQueryKernel } = require('../src/server/infrastructure/native-query-kernel.cjs');
const {
  createAppointmentConfirmations,
} = require('../src/server/modules/cabinet/confirmations.cjs');

test(
  '164 patient page skips unrelated platform rows only after proving an empty canonical upcoming stream',
  { timeout: 120000 },
  async (t) => {
    const f = await queueFixture(t, {
      cabinetVersion: 2,
      cabinetComponents: { patientHistory: true },
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-patient164-'));
    fs.mkdirSync(path.join(dir, 'platform'));
    fs.writeFileSync(path.join(dir, 'postgresql-runtime.json'), JSON.stringify(f.identity.lineage));
    fs.writeFileSync(path.join(dir, 'platform/platform.key'), randomBytes(32));
    fs.writeFileSync(path.join(dir, 'encryption.key'), randomBytes(32));
    const database = createPlatformDatabase(path.join(dir, 'platform'), {
      notificationSchema: 19,
      databaseOwner: f.a.owner,
      sharedCabinetWrites: true,
    });
    const actors = ['owner', 'cosmetologist', 'salon_admin'].map((role, i) => ({
      role,
      accountId: randomUUID(),
      organizationId: f.organizations[0],
      token: 'synthetic-patient164-' + i,
    }));
    const now = Date.now();
    f.a.p
      .prepare('UPDATE organizations SET value=? WHERE id=?')
      .run(
        database.seal({ name: 'Synthetic164', legacyData: true, timeZone: 'Europe/Moscow' }),
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
    const storage = createStorage(dir, {
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
        visits: Array.from({ length: 111 }, (_, i) => ({
          id: id + '-visit-' + i,
          date: '2020-01-01',
          staffId: actors[i % 2].accountId,
          procedure: 'Synthetic',
          photos: [],
        })),
        appointments:
          id === 'empty'
            ? [appointment(id + '-closed', actors[1].accountId, 'cancelled')]
            : Array.from({ length: 61 }, (_, i) =>
                appointment(id + '-appointment-' + i, actors[i % 2].accountId),
              ),
      })),
    });
    const confirmations = createAppointmentConfirmations({
      ...require('../src/server/infrastructure/platform-constants.cjs'),
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
    const kernels = [];
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
    async function kernel(native) {
      const owner = await f.open(),
        selected = { ...config, databaseOwner: owner.owner },
        trace = [];
      const operations = native
        ? await createPostgresReadOperations(selected, {
            createClient(options) {
              const c = new Client(options),
                query = c.query.bind(c);
              c.query = (input, ...args) => {
                trace.push(typeof input === 'string' ? input : input.text);
                return query(input, ...args);
              };
              return c;
            },
          })
        : null;
      const value = {
        kernel: createNativeQueryKernel(selected, { readOperations: operations }),
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
    async function run(k, url, actor) {
      const response = await k.kernel.run(metadata(url, actor), null, {
        memoryClass: 'query-probe',
        requestMemoryClass: async () => {},
      });
      const body = JSON.parse(Buffer.from(response.body).toString());
      assert.equal(response.status, 200, JSON.stringify(body));
      return body;
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
    try {
      const native = await kernel(true),
        legacy = await kernel(false);
      for (const actor of actors)
        for (const id of ['empty', 'live'])
          for (const route of [
            '/api/cabinet/patient?id=' + id + '&view=card',
            '/api/cabinet/patient/upcoming?id=' + id,
            '/api/cabinet/patient/history?id=' + id,
          ]) {
            const old = await run(legacy, route, actor);
            native.trace.length = 0;
            const next = await run(native, route, actor);
            if (route.includes('view=card'))
              assert.ok(next.patient, 'the prepared fixture must exercise a real card');
            assert.deepEqual(normalize(next), normalize(old));
            if (id === 'empty' || route.includes('/history')) {
              assert.ok(
                !native.trace.some((sql) =>
                  /cartoteca_platform"?\."?(?:telegram_|notification_|booking_requests|max_client_links|subscriptions)/.test(
                    sql,
                  ),
                ),
                native.trace.join('\n'),
              );
              assert.ok(
                !native.trace.some((sql) => /booking-accepted:%/.test(sql)),
                native.trace.join('\n'),
              );
            }
            if (id === 'live' && !route.includes('/history')) {
              for (const table of [
                'telegram_links',
                'telegram_confirmations',
                'telegram_jobs',
                'appointment_manual_confirmations',
                'notification_confirmations',
                'notification_channel_jobs',
                'max_client_links',
              ]) {
                const selected = new RegExp(
                  'FROM "cartoteca_platform"\\."' +
                    table +
                    '" s WHERE s\\._store_id=\\$\\d+ AND \\(s\\.organization_id=\\$\\d+ AND s\\.patient_id=\\$\\d+\\)',
                );
                assert.ok(
                  native.trace.some((sql) => selected.test(sql)),
                  'Missing patient bound for ' + table,
                );
              }
            }
            if (id === 'live' && route.includes('view=card') && actor.role === 'owner') {
              assert.equal(next.upcoming.entries[0].manualConfirmedBy, 'Synthetic owner');
              assert.ok(next.upcoming.entries[0].confirmationKey);
            }
          }
      // A missing derived stream may hint empty, but its nonempty manifest and
      // canonical witness must still fail closed instead of returning no rows.
      f.a.c[0]
        .prepare("DELETE FROM cabinet_history_entries WHERE patient_id=? AND stream='upcoming'")
        .run('live');
      const invalid = await native.kernel.run(
        metadata('/api/cabinet/patient?id=live&view=card', actors[0]),
        null,
        { memoryClass: 'query-probe', requestMemoryClass: async () => {} },
      );
      assert.equal(invalid.status, 503, Buffer.from(invalid.body).toString());
    } finally {
      for (const k of kernels) await k.kernel.close();
      storage.close();
      database.closeWriter();
      database.db.close();
      assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
      assert.ok(path.basename(dir).startsWith('cartoteca-patient164-'));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
