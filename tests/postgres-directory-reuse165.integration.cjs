const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHmac } = require('node:crypto');
const { Client } = require('pg');
const { calendarFixture163 } = require('./helpers/postgres-calendar163-fixture.cjs');
const {
  prepareDirectory164,
} = require('../src/server/infrastructure/postgres/directory-component164.cjs');

test(
  '165 fullsummary reuse follows exact current provenance, keeps admission, raw reuse, eviction and large fallback',
  { timeout: 180000 },
  async (t) => {
    const fullQueries = [],
      original = Client.prototype.query;
    t.mock.method(Client.prototype, 'query', function (input, ...args) {
      const text = typeof input === 'string' ? input : input.text;
      if (
        text.startsWith('SELECT patient_id AS id,value FROM cartoteca_cabinet.cabinet_summaries') &&
        typeof input.on === 'function'
      ) {
        const row = { ids: [...input.values[2]], rows: 0, bytes: 0 };
        fullQueries.push(row);
        input.on('row', (value) => {
          row.rows++;
          row.bytes += value[1].byteLength;
        });
      }
      return original.call(this, input, ...args);
    });
    const f = await calendarFixture163(t);
    try {
      const owner = f.actors[0],
        first = f.storage.read().patients[0];
      first.name = 'Alpha Small';
      const second = {
        id: 'two',
        name: 'Beta Small',
        phone: '+79001234567',
        createdBy: owner.accountId,
        visits: [],
        appointments: [],
      };
      const large = {
        id: 'large',
        name: 'Zulu Large',
        phone: '89001112233',
        createdBy: owner.accountId,
        visits: [],
        appointments: Array.from({ length: 520 }, (_, i) => ({
          id: 'large-' + i,
          date: '2035-01-02',
          time: '10:00',
          duration: 60,
          staffId: owner.accountId,
          service: 'Synthetic large service '.repeat(65),
        })),
      };
      f.storage.write({
        revision: f.storage.get('revision'),
        patients: [first, second, large],
        services: [],
      });
      const key = fs.readFileSync(path.join(f.dir, 'encryption.key'));
      const ciphers = {
        encode: f.storage.encode,
        decode: f.storage.decode,
        hash: (value) => createHmac('sha256', key).update(value).digest('hex'),
      };
      await f.admin.query('BEGIN');
      await prepareDirectory164(f.admin, f.runtime.application.user, {
        stores: [{ storeId: f.cabinets[0].storeId, ciphers }],
      });
      await f.admin.query('COMMIT');
      const n = await f.kernel(),
        legacy = await f.kernel(false),
        url = '/api/cabinet/directory?today=2035-01-03&q=Small&limit=2';
      const normalize = (reply) => ({
        ...reply.body,
        nextCursor: reply.body.nextCursor
          ? f.storage.decode(Buffer.from(reply.body.nextCursor, 'base64url'))
          : null,
      });
      const read = async (target = n, path = url) => {
        const reply = await f.run(target, path);
        assert.equal(reply.status, 200, JSON.stringify(reply.body));
        return reply;
      };
      fullQueries.length = 0;
      const cold = await read();
      assert.deepEqual(
        cold.body.directory.map((row) => row.id),
        ['patient', 'two'],
      );
      assert.equal(fullQueries.length, 1);
      assert.deepEqual(fullQueries[0].ids, ['patient', 'two']);
      const coldRows = fullQueries[0].rows;
      assert.equal(coldRows, 2);
      n.trace.length = 0;
      fullQueries.length = 0;
      //170 canonicalizes q case for wire reuse. A different valid limit keeps
      // these same two rows but misses the wire key, isolating fullsummary reuse.
      const warm = await read(n, url.replace('q=Small', 'q=small').replace('limit=2', 'limit=3'));
      assert.deepEqual(normalize(warm), normalize(cold));
      assert.equal(fullQueries.length, 0, 'warm unchanged page fetches no full summary');
      assert.ok(
        n.trace.some((sql) => sql.includes('octet_length') && sql.includes('cabinet_summaries')),
        'full selected source remains byte-probed before cache JSON copy',
      );
      warm.body.directory[0].phone = 'Mutated only in returned draft';
      assert.notEqual((await read()).body.directory[0].phone, 'Mutated only in returned draft');
      const before = f.storage.db
        .prepare("SELECT value FROM cabinet_summaries WHERE patient_id='two' AND audience='*'")
        .get().value;
      const changed = { ...f.storage.decode(before), phone: '+79007654321' };
      const cipher = f.storage.encode(changed);
      f.storage.db
        .prepare("UPDATE cabinet_summaries SET value=? WHERE patient_id='two' AND audience='*'")
        .run(cipher);
      // Picker obtains the current raw fallback but intentionally cannot retain a
      // public full summary in its compact base index. The following page should
      // fetch only this changed source; the other row's HMAC still matches its cache.
      await read(n, '/api/cabinet/directory?today=2035-01-03&picker=1');
      fullQueries.length = 0;
      const changedPage = await read();
      assert.equal(fullQueries.length, 1);
      assert.deepEqual(fullQueries[0].ids, ['two']);
      assert.equal(fullQueries[0].rows, 1);
      assert.equal(changedPage.body.directory[1].phone, changed.phone);
      assert.deepEqual(normalize(changedPage), normalize(await read(legacy)));
      const rawChanged = { ...changed, phone: '+79009998877' };
      f.storage.db
        .prepare("UPDATE cabinet_summaries SET value=? WHERE patient_id='two' AND audience='*'")
        .run(f.storage.encode(rawChanged));
      fullQueries.length = 0;
      const rawPage = await read();
      assert.equal(
        fullQueries.length,
        0,
        'a full raw source already fetched in this RR is not selected again',
      );
      assert.equal(rawPage.body.directory[1].phone, rawChanged.phone);
      // Legacy directory's revision-only warm cache is not a raw-DML oracle.
      // A fresh legacy reader supplies the same established DTO from current SQL.
      const rawLegacy = await f.kernel(false);
      assert.deepEqual(normalize(rawPage), normalize(await read(rawLegacy)));
      const beforeEviction = n.operations.readCacheBudget.stats().evictions;
      n.operations.readCacheBudget.clear();
      assert.ok(n.operations.readCacheBudget.stats().evictions > beforeEviction);
      fullQueries.length = 0;
      const evicted = await read();
      assert.equal(fullQueries.length, 1);
      assert.deepEqual(
        fullQueries[0].ids,
        ['patient'],
        'raw missing sidecar is reused and only the other evicted full row is fetched',
      );
      assert.deepEqual(normalize(evicted), normalize(rawPage));
      const largeUrl = '/api/cabinet/directory?today=2035-01-03&q=Zulu&limit=1';
      fullQueries.length = 0;
      const largeCold = await read(n, largeUrl);
      const largeColdBytes = fullQueries.reduce((sum, row) => sum + row.bytes, 0);
      assert.ok(largeColdBytes > 512 * 1024);
      fullQueries.length = 0;
      const largeAgain = await read(n, largeUrl);
      assert.equal(
        fullQueries.length,
        1,
        'large summary bypasses bounded row cache and retains ordinary fetch',
      );
      assert.equal(fullQueries[0].rows, 1);
      assert.deepEqual(normalize(largeAgain), normalize(largeCold));
      assert.deepEqual(normalize(largeAgain), normalize(await read(legacy, largeUrl)));
      t.diagnostic(
        JSON.stringify({
          coldPageFullRows: coldRows,
          warmPageFullSelects: 0,
          changedOneFullRows: 1,
          rawAlreadyFetchedFullSelects: 0,
          evictedCurrentRawReused: true,
          largeCipherBytes: largeColdBytes,
          largeRepeatFullRows: 1,
          byteProbePreserved: true,
        }),
      );
    } finally {
      await f.close();
    }
  },
);
