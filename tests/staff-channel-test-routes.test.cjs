const test = require('node:test');
const assert = require('node:assert/strict');
for (const [channel, filename] of [
  ['telegram', 'staff-routes'],
  ['max', 'staff-max-routes'],
]) {
  const route = require('../src/server/modules/notifications/' + filename + '.cjs').routes.find(
    (item) => item.path === '/api/' + channel + '/staff/test',
  );
  test(
    channel + ' test endpoint queues only the current account through its durable store',
    async () => {
      const calls = [],
        body = { bindingId: 'synthetic-own-binding' };
      const store = {
        test(token, value) {
          calls.push({ token, value });
          return { queued: true };
        },
      };
      let checked = false,
        response;
      const context = {
        req: {},
        res: {},
        token: 'synthetic-current-session',
        readBody: async () => body,
        assertCurrent() {
          checked = true;
        },
        platform: { staffNotifications: store, staffMaxNotifications: store },
        telegram: { status: () => ({ connected: true }) },
        staffMax: {
          status(token) {
            assert.equal(token, context.token);
            return { compatible: true, bot: { connected: true } };
          },
        },
        json(res, status, value) {
          assert.equal(checked, true);
          response = { status, value };
          return response;
        },
      };
      assert.equal(route.method, 'POST');
      assert.equal(route.access, 'organization');
      await route.handle(context);
      assert.deepEqual(calls, [{ token: context.token, value: body }]);
      assert.deepEqual(response, { status: 202, value: { queued: true } });
    },
  );
  test(
    channel + ' test endpoint rechecks access after reading the body before any queue write',
    async () => {
      let writes = 0;
      const store = {
        test() {
          writes++;
        },
      };
      const context = {
        req: {},
        token: 'synthetic-current-session',
        readBody: async () => ({ bindingId: 'synthetic-own-binding' }),
        assertCurrent() {
          throw Object.assign(Error('Synthetic access revoked'), { status: 403 });
        },
        platform: { staffNotifications: store, staffMaxNotifications: store },
      };
      await assert.rejects(route.handle(context), { status: 403 });
      assert.equal(writes, 0);
    },
  );
}
