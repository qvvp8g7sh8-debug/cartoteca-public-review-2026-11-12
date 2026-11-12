// Synthetic integration proposal; not executed until root applies Node169.
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { Client } = require('pg');
const { calendarFixture163 } = require('./postgres-calendar163-fixture.cjs');
const { createStorage } = require('../../src/server/infrastructure/cabinet-storage.cjs');
const {
  createPostgresReadOperations,
} = require('../../src/server/infrastructure/postgres/read-operations145.cjs');
const {
  createNativeQueryKernel,
} = require('../../src/server/infrastructure/native-query-kernel.cjs');
const {
  prepareHotMetadata169,
} = require('../../src/server/infrastructure/postgres/hot-metadata-prepare169.cjs');
const hotSQL169 = (text) =>
  text.startsWith('SELECT * FROM cartoteca_catalog.hot_read_metadata169(');
function deferred169() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function bounded169(promise, ms = 5000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('Synthetic169 integration barrier timeout')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function hotCalendarFixture169(t, { prepared = true, otherCabinet = true } = {}) {
  const f = await calendarFixture163(t),
    opened = [],
    allGates = [];
  let extra;
  const config = {
    dataDir: f.dir,
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
    tenantReadCacheBytes: 8 * 1024 * 1024,
  };
  try {
    await f.admin.query(
      "SELECT set_config('cartoteca.kind','platform',false),set_config('cartoteca.store_id',$1,false)",
      [f.platform.storeId],
    );
    if (otherCabinet) {
      const directory = path.join(f.dir, 'tenants', f.organizations[1]);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'encryption.key'), randomBytes(32), { flag: 'wx' });
      extra = createStorage(directory, {
        cabinetSchema: 2,
        databaseOwner: f.a.owner,
        databaseRoot: f.dir,
        photoOrganizationId: f.organizations[1],
      });
      extra.write({
        revision: 0,
        services: [],
        patients: [
          {
            id: 'other-patient',
            name: 'Synthetic Other',
            createdBy: f.actors[3].accountId,
            visits: [],
            appointments: [
              {
                id: 'other-appointment',
                date: '2035-01-02',
                time: '14:00',
                duration: 60,
                staffId: f.actors[3].accountId,
                status: 'scheduled',
                service: 'Synthetic',
              },
            ],
          },
        ],
      });
    }
    if (prepared) {
      await f.admin.query('BEGIN');
      try {
        await prepareHotMetadata169(f.admin, f.runtime.application.user, {
          marker: f.identity.lineage,
        });
        await f.admin.query('COMMIT');
      } catch (error) {
        await f.admin.query('ROLLBACK');
        throw error;
      }
    }
  } catch (error) {
    extra?.close();
    await f.close();
    throw error;
  }
  function metadata(url, actor = f.actors[0]) {
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
  async function make({ readViewsEnabled = true } = {}) {
    const base = await f.open(),
      clients = [],
      trace = [],
      events = [],
      pending = [];
    let failNextHot = false;
    function arm(phase, match = hotSQL169) {
      const entered = deferred169(),
        released = deferred169(),
        gate = {
          phase,
          match,
          entered: entered.promise,
          release: released.resolve,
          wait: released.promise,
          signal: entered.resolve,
        };
      pending.push(gate);
      allGates.push(gate);
      return gate;
    }
    function take(phase, text, index) {
      const at = pending.findIndex((g) => g.phase === phase && g.match(text, index));
      return at < 0 ? null : pending.splice(at, 1)[0];
    }
    const operations = await createPostgresReadOperations(
      { ...config, databaseOwner: base.owner },
      {
        readOwnerCapacity166: 2,
        readViewsEnabled,
        createClient(options) {
          const c = new Client(options),
            index = clients.length,
            query = c.query.bind(c),
            end = c.end.bind(c);
          clients.push(c);
          c.on('end', () => events.push({ index, event: 'physical-end' }));
          c.query = (input, ...args) => {
            const text = typeof input === 'string' ? input : input.text;
            trace.push({ index, text });
            const before = take('submit', text, index),
              after = take('result', text, index);
            const send = () => {
              if (failNextHot && hotSQL169(text)) {
                failNextHot = false;
                return query('SELECT 1/0');
              }
              return query(input, ...args);
            };
            if (before) before.signal({ index, client: c });
            const promise = before ? before.wait.then(send) : send();
            return after
              ? promise.then((result) => {
                  after.signal({ index, client: c });
                  return after.wait.then(() => result);
                })
              : promise;
          };
          c.end = () => {
            const gate = take('end', 'end', index);
            if (!gate) return end();
            gate.signal({ index, client: c });
            return gate.wait.then(() => end());
          };
          return c;
        },
      },
    );
    const kernel = createNativeQueryKernel(
      { ...config, databaseOwner: base.owner },
      { readOperations: operations },
    );
    const k = {
      operations,
      kernel,
      clients,
      trace,
      events,
      arm,
      clear() {
        trace.length = 0;
        events.length = 0;
      },
      faultNextHot() {
        failNextHot = true;
      },
      close: () => kernel.close(),
    };
    opened.push(k);
    return k;
  }
  async function run(k, url = f.url, actor = f.actors[0], { cancel = null, change } = {}) {
    const request = metadata(url, actor);
    change?.(request);
    const reply = await k.kernel.run(request, cancel, {
      memoryClass: 'query-probe',
      requestMemoryClass: async () => {},
    });
    return { status: reply.status, body: JSON.parse(Buffer.from(reply.body).toString()) };
  }
  async function cold(k, actor = f.actors[0]) {
    const reply = await run(k, f.url, actor);
    if (reply.status !== 200 || !String(reply.body.version).startsWith('c163.'))
      throw Error('Synthetic169 cold token unavailable');
    return { body: reply.body, url: f.conditional(reply.body) };
  }
  async function close() {
    for (const gate of allGates) gate.release();
    try {
      for (const k of opened) await k.close();
    } finally {
      extra?.close();
      await f.close();
    }
  }
  return { ...f, config, make, metadata, run, cold, close, hotSQL169 };
}
module.exports = { hotCalendarFixture169, hotSQL169, bounded169 };
