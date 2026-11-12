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
  '165 directory small response uses current RR clocks, raw changes and fresh ACL; failed COMMIT publishes nothing',
  { timeout: 120000 },
  async (t) => {
    const f = await calendarFixture163(t);
    try {
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
        url = '/api/cabinet/directory?q=Synthetic&today=2035-01-01&limit=1';
      n.trace.length = 0;
      const first = await f.run(n, url);
      assert.equal(first.status, 200, JSON.stringify(first.body));
      const coldCalls = n.trace.length;
      assert.equal(n.operations.viewStats().directoryResponses165.entries, 1);
      n.trace.length = 0;
      const second = await f.run(n, url);
      assert.deepEqual(second, first);
      const hotCalls = n.trace.length;
      assert.equal(n.operations.viewStats().directoryResponses165.hits, 1);
      assert.ok(!n.trace.some((sql) => sql.includes('cartoteca_cabinet.')), n.trace.join('\n'));
      assert.ok(n.trace.length < coldCalls);
      await f.admin.query(
        'UPDATE cartoteca_platform.organizations SET slug=slug WHERE _store_id=$1 AND id=$2',
        [f.platform.storeId, f.organizations[1]],
      );
      n.trace.length = 0;
      assert.deepEqual(await f.run(n, url), first);
      assert.ok(!n.trace.some((sql) => sql.includes('cartoteca_cabinet.')));
      const source = f.a.c[0]
        .prepare("SELECT value FROM cabinet_summaries WHERE patient_id='patient' AND audience='*'")
        .get().value;
      const changed = f.storage.encode({ ...f.storage.decode(source), visitCount: 123 });
      f.a.c[0].exec('BEGIN');
      f.a.c[0]
        .prepare("UPDATE cabinet_summaries SET value=? WHERE patient_id='patient' AND audience='*'")
        .run(changed);
      f.a.c[0].exec('ROLLBACK');
      n.trace.length = 0;
      assert.deepEqual(await f.run(n, url), first);
      assert.ok(!n.trace.some((sql) => sql.includes('cartoteca_cabinet.')));
      f.a.c[0]
        .prepare("UPDATE cabinet_summaries SET value=? WHERE patient_id='patient' AND audience='*'")
        .run(changed);
      const raw = await f.run(n, url);
      assert.equal(raw.status, 200, JSON.stringify(raw.body));
      assert.equal(raw.body.directory[0].visitCount, 123);
      const staff = await f.run(n, url, f.actors[1]);
      assert.equal(staff.status, 200, JSON.stringify(staff.body));
      assert.equal(staff.body.directory[0].visitCount, 0);
      assert.equal(staff.body.directory[0].appointments.length, 1);
      assert.ok(n.operations.viewStats().directoryResponses165.invalidated >= 1);
      let failCommit = true;
      const original = Client.prototype.query;
      const mocked = t.mock.method(Client.prototype, 'query', function (input, ...args) {
        const text = typeof input === 'string' ? input : input.text;
        if (failCommit && text === 'COMMIT' && this.user === f.runtime.application.user) {
          failCommit = false;
          return Promise.reject(
            Object.assign(Error('synthetic165 COMMIT failure'), { code: '08006' }),
          );
        }
        return original.call(this, input, ...args);
      });
      const failed = await f.kernel();
      try {
        const response = await f.run(failed, url);
        assert.ok([500, 503].includes(response.status), JSON.stringify(response));
        assert.equal(failed.operations.viewStats().directoryResponses165.entries, 0);
      } finally {
        mocked.mock.restore();
      }
      const refresh = await f.run(n, url);
      assert.equal(refresh.status, 200);
      f.setAfterCommit(() =>
        f.a.p
          .prepare(
            "UPDATE memberships SET status='inactive' WHERE organization_id=? AND account_id=?",
          )
          .run(f.organizations[0], f.actors[0].accountId),
      );
      const revoked = await f.run(n, url);
      assert.ok([401, 403, 428].includes(revoked.status), JSON.stringify(revoked));
      t.diagnostic(
        JSON.stringify({
          coldSqlCalls: coldCalls,
          hotSqlCalls: hotCalls,
          responseCache: n.operations.viewStats().directoryResponses165,
        }),
      );
    } finally {
      await f.close();
    }
  },
);
