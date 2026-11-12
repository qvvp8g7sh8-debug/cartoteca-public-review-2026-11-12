const test = require('node:test');
const assert = require('node:assert/strict');
const { calendarFixture163 } = require('./helpers/postgres-calendar163-fixture.cjs');
const {
  createReadOperationClient,
} = require('../src/server/infrastructure/postgres/read-operation-client145.cjs');
test(
  '164 later small and repeated probes retain cumulative unique-source admission',
  { timeout: 120000 },
  async (t) => {
    const f = await calendarFixture163(t);
    try {
      const text = 'synthetic164'.repeat(100000),
        cipher = f.storage.encode({ text });
      f.a.c[0].prepare('INSERT INTO meta(key,value)VALUES(?,?)').run('phased164', cipher);
      const engine = await createReadOperationClient({
        dataDir: f.dir,
        postgres: f.runtime.application,
        postgresProfile: 'local',
      });
      const upgrades = [];
      try {
        await engine.run(
          {
            scope: f.cabinets[0],
            probeClass: true,
            assertActive() {},
            requestMemoryClass: async (value) => upgrades.push(value),
          },
          async (op) => {
            const source = {
              scope: op.scope,
              catalog: op.cabinetCatalog,
              table: 'meta',
              where: 's.key=$2',
              values: ['phased164'],
            };
            await op.probe([source]);
            const db = op.rows.store(op.scope, op.cabinetCatalog),
              first = db.prepare('SELECT value FROM meta WHERE key=?');
            await db.prefetchAll([first.readRequest('get', ['phased164'])]);
            assert.equal(first.get('phased164').value.length, cipher.length);
            await op.probe([{ ...source, values: ['revision'] }]);
            const second = db.prepare('SELECT key,value FROM meta WHERE key=?');
            await db.prefetchAll([second.readRequest('get', ['phased164'])]);
            assert.equal(second.get('phased164').value.length, cipher.length);
            await op.probe([source]);
            assert.deepEqual(upgrades, ['query']);
          },
        );
      } finally {
        await engine.close();
      }
    } finally {
      await f.close();
    }
  },
);
