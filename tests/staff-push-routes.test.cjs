const test = require('node:test'), assert = require('node:assert/strict');
const { routes } = require('../src/server/modules/notifications/push-routes.cjs');
test('push endpoints require organization access, reject target account and respect readiness', async () => {
  assert.equal(routes.length, 5); assert.ok(routes.every(r => r.access === 'organization'));
  let calls = 0;
  const c = { token: 'own', req: {}, res: {}, staffPush: { available: true }, assertCurrent: () => {},
    platform: { onlineBooking: { actor: () => ({}) }, staffPush: { connect: () => calls++, status: () => ({}) } },
    json: (res, status, value) => ({ status, value }), readBody: async () => ({ accountId: 'another' }) };
  for (const suffix of ['status', 'connect', 'test']) await assert.rejects(() => routes.find(r => r.path.endsWith('/' + suffix)).handle(c), { status: 400 });
  assert.equal(calls, 0);
  c.staffPush.available = false; c.readBody = async () => ({});
  await assert.rejects(() => routes.find(r => r.path.endsWith('/connect')).handle(c), { status: 503 });
});
test('push status when schema not prepared never touches signing keys or sends', async () => {
  const c = { token: 'own', req: {}, res: {}, assertCurrent: () => {}, platform: { onlineBooking: { actor: () => ({}) }, staffPush: null }, readBody: async () => ({}), json: (res, status, value) => value };
  const result = await routes[0].handle(c); assert.equal(result.prepared, false); assert.equal(result.available, false);
});
test('push writes recheck request access after asynchronous body read', async () => {
  for (const route of routes) {
    let revoked = false, writes = 0;
    const c = { token: 'own', req: {}, res: {}, staffPush: { available: true },
      assertCurrent: () => { if (revoked) throw Object.assign(Error('Revoked'), { status: 403 }); },
      platform: { onlineBooking: { actor: () => ({}) }, staffPush: { connect: () => writes++, update: () => writes++, test: () => writes++, status: () => writes++ } },
      readBody: async () => { revoked = true; return {}; }, json: () => {} };
    await assert.rejects(() => route.handle(c), { status: 403 }); assert.equal(writes, 0);
  }
});
