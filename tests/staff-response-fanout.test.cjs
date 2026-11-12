const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { bookingFixture } = require('./helpers/booking-fixture.cjs');
const { createPlatformDatabase } = require('../src/server/infrastructure/platform-database.cjs');
const { submitRequest } = require('../src/server/modules/booking/requests.cjs');
const { propose, respondProposal } = require('../src/server/modules/booking/proposals.cjs');
for (const decision of ['agree', 'decline']) {
  test(
    'a real client ' + decision + ' atomically reaches both staff channels exactly once',
    async (t) => {
      const f = await bookingFixture({ notificationSchema: 18 });
      t.after(f.close);
      const stores = [f.platform.staffNotifications, f.platform.staffMaxNotifications];
      const telegram = stores[0].issue(f.token, f.now);
      stores[0].consume(telegram.token, '100001', f.now);
      const max = stores[1].issue(f.token, '123', f.now);
      stores[1].consume(max.token, '123', '100002', f.now, f.now);
      const record = submitRequest(
        f.platform,
        f.token,
        f.storage,
        f.input({ kind: 'other-time', comment: 'PRIVATE STAFF FANOUT NOTE' }),
        f.now,
      );
      for (const store of stores) {
        const initial = store.claim(f.now);
        assert.equal(initial.decoded.event, 'new-request');
        assert.equal(store.finish(initial, 'sent'), true);
      }
      const context = {
        ...f.context,
        token: f.token,
        current: f.platform.session(f.token),
        assertCurrent() {},
      };
      const offer = propose(
        context,
        { id: record.id, revision: record.revision, date: f.date, time: '10:00' },
        f.now,
      );
      const secret = offer.path.split('#reply=')[1];
      const first = respondProposal(context, { secret, decision }, f.now);
      assert.deepEqual(respondProposal(context, { secret, decision }, f.now), first);
      const raw = createPlatformDatabase(path.join(f.dir, 'platform'), { notificationSchema: 18 });
      try {
        for (const [index, table] of ['staff_notification_jobs', 'staff_max_jobs'].entries()) {
          const rows = raw.db.prepare(`SELECT * FROM ${table}`).all();
          assert.equal(rows.length, 2);
          assert.equal(rows.filter((row) => row.status === 'pending').length, 1);
          assert.ok(rows.every((row) => row.account_id === f.owner.accountId));
          for (const row of rows)
            assert.doesNotMatch(
              Buffer.from(row.value).toString(),
              /PRIVATE STAFF FANOUT NOTE|79999999999/,
            );
          const job = stores[index].claim(f.now);
          assert.equal(
            job.decoded.event,
            decision === 'agree' ? 'client-agreed' : 'client-declined',
          );
          assert.ok(stores[index].valid(job, f.now));
          assert.equal(
            job.decoded.revision,
            f.platform.bookingRequests.get(f.org, record.id, f.now).revision,
          );
        }
      } finally {
        raw.db.close();
      }
    },
  );
}
