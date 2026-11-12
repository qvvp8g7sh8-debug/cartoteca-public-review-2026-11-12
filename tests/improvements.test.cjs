// Prepared for the next explicitly requested verification; synthetic data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { adminFixture } = require('./helpers/admin-fixture.cjs');
const { routes } = require('../src/server/modules/support/routes.cjs');
const current = (f) => ({ accountId: f.owner.accountId, organizationId: f.owner.organizationId });
const proposal = (f, description = 'Сделать удобнее выбор даты') => ({
  requestId: f.database.id(),
  description,
  kind: 'improvement',
});
const create = (f, body = proposal(f), now = Date.now()) =>
  f.store.support.create(current(f), body, now, { deliveryEnabled: false });

test('proposal is encrypted, private and saved without operator delivery', async (t) => {
  const f = await adminFixture(t),
    body = proposal(f),
    receipt = create(f, body);
  assert.equal(receipt.improvementState, 'received');
  assert.deepEqual(receipt.deliveries, {});
  assert.equal(create(f, body).id, receipt.id);
  const own = f.store.support.improvements(current(f));
  assert.equal(own.items.length, 1);
  assert.deepEqual(Object.keys(own.items[0]).sort(), [
    'changedAt',
    'createdAt',
    'description',
    'id',
    'state',
  ]);
  for (const scope of [
    { accountId: f.other.accountId, organizationId: f.other.organizationId },
    { accountId: f.owner.accountId, organizationId: f.other.organizationId },
    { accountId: f.admin.accountId, organizationId: null },
  ])
    assert.equal(f.store.support.improvements(scope).items.length, 0);
  const encrypted = f.database.db
    .prepare('SELECT value FROM support_requests WHERE id=?')
    .get(receipt.id).value;
  assert.doesNotMatch(Buffer.from(encrypted).toString('utf8'), /Сделать удобнее|admin\.test/);
  assert.equal(f.database.db.prepare('SELECT count(*) n FROM support_deliveries').get().n, 0);
  f.reopen();
  assert.equal(f.store.support.improvements(current(f)).items[0].state, 'received');
});

test('proposal repeat validates text, category, scope, limits and unknown fields', async (t) => {
  const f = await adminFixture(t),
    body = proposal(f);
  create(f, body);
  assert.throws(() => create(f, { ...body, description: 'Другой текст' }), { status: 409 });
  assert.throws(() => create(f, { ...body, kind: 'support' }), { status: 409 });
  assert.throws(
    () => f.store.support.create({ ...current(f), organizationId: f.other.organizationId }, body),
    { status: 409 },
  );
  for (const invalid of [
    { ...proposal(f), kind: 'unknown' },
    { ...proposal(f), description: ' ' },
    { ...proposal(f), description: 'x'.repeat(1501) },
    { ...proposal(f), improvementState: 'done' },
    { ...proposal(f), accountId: f.other.accountId },
  ])
    assert.throws(() => create(f, invalid), { status: 400 });
  create(f);
  create(f);
  assert.throws(() => create(f), { status: 429 });
  assert.equal(create(f, body).improvementState, 'received');
});

test('operator product states use CAS and ordinary authors cannot change them', async (t) => {
  const f = await adminFixture(t),
    receipt = create(f),
    actor = f.admin.accountId;
  const stale = f.command('support', receipt.id, { state: 'new', improvementState: 'discussion' });
  const command = f.command('support', receipt.id, { state: 'new', improvementState: 'planned' });
  const result = f.store.admin.support.update(actor, receipt.id, command);
  assert.deepEqual(f.store.admin.support.update(actor, receipt.id, command), result);
  assert.equal(f.store.support.improvements(current(f)).items[0].state, 'planned');
  assert.equal(f.store.support.receipt(f.owner.accountId, receipt.id).state, 'in_progress');
  assert.throws(() => f.store.admin.support.update(actor, receipt.id, stale), { status: 409 });
  assert.throws(
    () =>
      f.store.admin.support.update(
        f.owner.accountId,
        receipt.id,
        f.command('support', receipt.id, { state: 'new', improvementState: 'done' }),
      ),
    { status: 403 },
  );
  for (const state of ['received', 'discussion', 'done', 'declined']) {
    f.store.admin.support.update(
      actor,
      receipt.id,
      f.command('support', receipt.id, { state: 'new', improvementState: state }),
    );
    assert.equal(f.store.support.improvements(current(f)).items[0].state, state);
  }
  f.store.admin.support.message(
    actor,
    receipt.id,
    f.command('support', receipt.id, { kind: 'internal', text: 'Внутренняя заметка' }),
  );
  assert.doesNotMatch(
    JSON.stringify(f.store.support.improvements(current(f))),
    /Внутренняя|assignedTo|email/,
  );
  assert.throws(
    () =>
      f.store.admin.support.update(
        actor,
        receipt.id,
        f.command('support', receipt.id, { state: 'new', improvementState: 'unknown' }),
      ),
    { status: 400 },
  );
  const ordinary = f.store.support.create(current(f), { ...proposal(f), kind: 'support' });
  assert.throws(
    () =>
      f.store.admin.support.update(
        actor,
        ordinary.id,
        f.command('support', ordinary.id, { state: 'new', improvementState: 'planned' }),
      ),
    { status: 400 },
  );
});

test('bounded proposal cursor advances through pages of ordinary support cases', async (t) => {
  const f = await adminFixture(t),
    now = Date.now();
  const expected = [];
  for (let i = 0; i < 53; i++) {
    const id = f.database.id(),
      kind = i < 51 ? 'support' : 'improvement';
    f.database.db
      .prepare('INSERT INTO support_requests VALUES(?,?,?,?,?,?)')
      .run(
        id,
        f.owner.accountId,
        f.owner.organizationId,
        f.database.id(),
        now - i,
        f.database.seal({
          kind,
          description: 'Синтетическое предложение',
          improvementState: 'received',
        }),
      );
    f.database.db
      .prepare('INSERT INTO support_cases(request_id,changed_at) VALUES(?,?)')
      .run(id, now - i);
    if (kind === 'improvement') expected.push(id);
  }
  const first = f.store.support.improvements(current(f));
  assert.equal(first.items.length, 0);
  assert.ok(first.next);
  const second = f.store.support.improvements(current(f), first.next);
  assert.deepEqual(
    second.items.map((x) => x.id),
    expected,
  );
  assert.equal(second.next, null);
  assert.throws(() => f.store.support.improvements(current(f), { before: 'no', beforeId: 'id' }), {
    status: 400,
  });
});

test('HTTP proposal route enforces organization scope and rechecks session before writing', async (t) => {
  const f = await adminFixture(t),
    post = routes.find((x) => x.method === 'POST' && x.path === '/api/support/improvements');
  const get = routes.find((x) => x.method === 'GET' && x.path === post.path);
  assert.equal(post.access, 'organization');
  assert.equal(get.access, 'organization');
  let checked = false,
    response;
  await post.handle({
    req: {},
    res: {},
    current: current(f),
    platform: f.store,
    support: { status: () => ({ available: false, emailEnabled: false }) },
    readBody: async () => {
      assert.equal(checked, false);
      return proposal(f);
    },
    assertCurrent: () => {
      checked = true;
    },
    json: (_, status, body) => {
      response = { status, body };
    },
  });
  assert.ok(checked);
  assert.equal(response.status, 202);
  assert.equal(response.body.receipt.improvementState, 'received');
  assert.deepEqual(response.body.receipt.deliveries, {});
  await assert.rejects(
    post.handle({
      req: {},
      readBody: async () => proposal(f),
      assertCurrent: () => {
        const error = new Error('Revoked');
        error.status = 401;
        throw error;
      },
    }),
    { status: 401 },
  );
  assert.equal(f.store.support.improvements(current(f)).items.length, 1);
});
