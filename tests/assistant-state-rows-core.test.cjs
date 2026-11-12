const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { createWalletStore } = require('../src/server/modules/billing/wallet-store.cjs');
const { rowsFixture } = require('./helpers/assistant-rows-core-fixture.cjs');
const { validate } = require('../src/server/modules/assistant/access/row-schema.cjs');
const {
  validateSnapshot,
  resetRestoredRows,
} = require('../src/server/modules/assistant/access/row-store.cjs');
const {
  assertAssistantStateBackend,
  createAssistantFileStore,
} = require('../src/server/modules/assistant/access/store.cjs');
const command = (revision, extra = {}) => ({
  expectedRevision: revision,
  requestId: randomUUID(),
  reason: 'Синтетическая проверка SQL помощника',
  ...extra,
});

for (const version of [19, 20])
  test(
    'rows component on platform' +
      version +
      ' preserves version and rejects changed metadata/cipher scope',
    async (t) => {
      const f = await rowsFixture(t, { version });
      assert.equal(f.context.db.prepare('PRAGMA user_version').get().user_version, version);
      assert.equal(validate(f.context.db).version, 1);
      assert.equal(validateSnapshot(f.context).enabledGrants, 1);
      assert.throws(
        () =>
          assertAssistantStateBackend(f.context, {
            directory: f.platformDirectory,
            backend: 'file',
          }),
        /rows-v1/,
      );
      const file = createAssistantFileStore({ ...f.context, directory: f.platformDirectory });
      assert.throws(() => file.read(), /Invalid encrypted/);
      let callback = false;
      assert.throws(
        () =>
          file.update(() => {
            callback = true;
          }),
        /Invalid encrypted/,
      );
      assert.equal(callback, false);
      f.context.db.exec('CREATE TABLE ASSISTANT_unrecognized(id TEXT)');
      assert.throws(() => validate(f.context.db), /schema mismatch/);
      f.context.db.exec('DROP TABLE ASSISTANT_unrecognized');
      f.context.db.exec(
        'DROP INDEX assistant_reservations_expiry; CREATE INDEX assistant_reservations_expiry ON assistant_reservations(expires_at DESC,id)',
      );
      assert.throws(() => validate(f.context.db), /schema mismatch/);
    },
  );

test('scope reads only current policy and one fresh grant, with no global state file IO or administrative materialization', async (t) => {
  const f = await rowsFixture(t),
    current = f.current();
  const original = f.context.open;
  let decrypted = 0;
  f.context.open = (value) => {
    decrypted++;
    return original(value);
  };
  for (const name of ['readFileSync', 'statSync', 'writeFileSync', 'fsyncSync']) {
    const method = fs[name];
    t.mock.method(fs, name, (...args) => {
      assert.ok(
        typeof args[0] !== 'string' || !args[0].includes('assistant-state'),
        'Hot path read global file',
      );
      return method(...args);
    });
  }
  f.repository.adminSnapshot = () => {
    throw Error('Hot path materialized administrative state');
  };
  for (let i = 0; i < 100; i++) assert.equal(f.policy.access(current).enabled, true);
  assert.ok(decrypted <= 101, 'Decryption should be bounded current policy + one grant per scope');
  f.context.db
    .prepare('UPDATE memberships SET status=? WHERE organization_id=? AND account_id=?')
    .run('suspended', current.organizationId, current.accountId);
  assert.equal(f.policy.access(current).enabled, false);
});

test('concurrent pilot reservations share atomic day/month limits, settle idempotently and keep uncertain cost', async (t) => {
  const f = await rowsFixture(t, {
    initial(state) {
      state.policy.limits.dailyRequests = 2;
    },
  });
  const values = await Promise.allSettled(
    Array.from({ length: 3 }, () => f.budget.reserve(f.current(), 3, 'llm', 0.2)),
  );
  const accepted = values
    .filter((value) => value.status === 'fulfilled')
    .map((value) => value.value);
  assert.equal(accepted.length, 2);
  assert.equal(values.find((value) => value.status === 'rejected').reason.status, 429);
  assert.equal(f.repository.day(f.date, f.membershipId), 2);
  assert.equal(f.repository.month(f.month).reservedMicrorub, 400000);
  await f.budget.markOutbound(accepted[0]);
  await Promise.all([f.budget.settle(accepted[0], 0.1), f.budget.settle(accepted[1], null)]);
  await f.budget.settle(accepted[0], null);
  assert.deepEqual(f.repository.month(f.month), {
    month: f.month,
    spentRub: 0.3,
    reservedRub: 0,
    spentMicrorub: 300000,
    reservedMicrorub: 0,
    calls: 2,
    uncertainCalls: 1,
  });
  assert.equal(validateSnapshot(f.context).reservations, 0);
});

test('legacy orphan debt is preserved and expiry cleanup is bounded32 before another reserve', async (t) => {
  const f = await rowsFixture(t, {
    initial(state, { month }) {
      for (let i = 0; i < 40; i++)
        state.reservations['orphan-' + i] = {
          month,
          amount: 0.1,
          kind: 'llm',
          createdAt: Date.now() - 121000,
        };
    },
  });
  assert.equal(f.imported.orphanReservations, 40);
  const first = f.context.db
    .prepare('SELECT * FROM assistant_reservations ORDER BY id LIMIT 1')
    .get();
  assert.equal(first.scope_kind, 'legacy');
  assert.equal(first.organization_id, null);
  assert.equal(f.repository.month(f.month).reservedMicrorub, 4000000);
  const reserved = await f.budget.reserve(f.current(), 3, 'llm', 0);
  assert.equal(f.context.db.prepare('SELECT count(*) n FROM assistant_reservations').get().n, 9);
  assert.equal(f.repository.month(f.month).uncertainCalls, 32);
  assert.equal(f.repository.month(f.month).reservedMicrorub, 800000);
  await f.budget.settle(reserved, 0);
  assert.equal(validateSnapshot(f.context).reservations, 8);
});

test('revocation prevents outbound but cannot erase already reserved debt and restored reset conserves usage', async (t) => {
  const f = await rowsFixture(t),
    reserved = await f.budget.reserve(f.current(), 3, 'llm', 2.5);
  f.context.db
    .prepare('UPDATE memberships SET status=? WHERE organization_id=? AND account_id=?')
    .run('suspended', f.owner.organizationId, f.owner.accountId);
  await assert.rejects(f.budget.markOutbound(reserved), { status: 403 });
  await f.budget.settle(reserved, null);
  assert.equal(f.repository.month(f.month).spentMicrorub, 2500000);
  f.context.transaction(() => resetRestoredRows(f.context));
  assert.equal(f.repository.readPolicy().policy.mode, 'off');
  assert.equal(f.repository.month(f.month).spentMicrorub, 2500000);
  assert.equal(f.repository.day(f.date, f.membershipId), 1);
  assert.equal(validateSnapshot(f.context).enabledGrants, 0);
});

test('rare administrative transactions preserve replay/conflict/behavior state and do not rewrite accounting', async (t) => {
  const f = await rowsFixture(t),
    api = f.api(),
    actor = f.admin.accountId;
  const body = command(3, { policy: { commands: { clients: false } } });
  assert.equal(api.admin.settings(actor, body).revision, 4);
  assert.equal(api.admin.settings(actor, body).revision, 4);
  assert.throws(() => api.admin.settings(actor, { ...body, reason: 'Другой запрос' }), {
    status: 409,
  });
  assert.throws(() => api.admin.settings(actor, command(3)), { status: 409 });
  const reserved = await f.budget.reserve(f.current(), 4, 'llm', 0.5);
  const before = f.repository.month(f.month);
  assert.throws(
    () =>
      f.context.transaction(() =>
        f.repository.updateAdmin((state) => {
          state.usage[f.month] = { spentRub: 1, calls: 0, uncertainCalls: 0 };
          state.reservations = {};
        }),
      ),
    /cannot rewrite/,
  );
  assert.deepEqual(f.repository.month(f.month), before);
  await f.budget.settle(reserved, 0);
  assert.equal(api.admin.view(actor).usage.spentRub, 0);
});

test('row encrypted identities reject grant enabling/version forgery and reservation scope swaps', async (t) => {
  const f = await rowsFixture(t),
    row = f.context.db.prepare('SELECT * FROM assistant_grants').get();
  f.context.db.exec('UPDATE assistant_grants SET grant_version=grant_version+1');
  assert.throws(() => f.policy.access(f.current()), /binding mismatch/);
  f.context.db.prepare('UPDATE assistant_grants SET grant_version=?').run(row.grant_version);
  const reservation = await f.budget.reserve(f.current(), 3, 'llm', 1);
  f.context.db
    .prepare('UPDATE assistant_reservations SET organization_id=? WHERE id=?')
    .run(f.other.organizationId, reservation.id);
  const poisoned = f.context.db
      .prepare('SELECT * FROM assistant_reservations WHERE id=?')
      .get(reservation.id),
    beforeUsage = f.repository.month(f.month);
  assert.throws(() => validateSnapshot(f.context), /scope binding/);
  await assert.rejects(async () => f.budget.settle(reservation, 0), /scope binding/);
  assert.deepEqual(f.repository.month(f.month), beforeUsage);
  assert.deepEqual(
    f.context.db.prepare('SELECT * FROM assistant_reservations WHERE id=?').get(reservation.id),
    poisoned,
  );
});

test('import reports upward microrub differences and retains exact original amounts encrypted', async (t) => {
  const f = await rowsFixture(t, {
    initial(state, { month }) {
      state.usage[month] = { spentRub: 0.0000001, calls: 1, uncertainCalls: 0 };
      state.reservations.old = { month, amount: 0.0000001, kind: 'llm', createdAt: Date.now() };
    },
  });
  assert.equal(f.imported.rounding.roundedUpValues, 2);
  assert.ok(f.imported.rounding.adjustmentRub > 0);
  assert.equal(f.repository.month(f.month).spentMicrorub, 1);
  assert.equal(f.repository.month(f.month).reservedMicrorub, 1);
  const row = f.context.db
    .prepare('SELECT value FROM assistant_reservations WHERE id=?')
    .get('old');
  assert.equal(f.context.open(row.value).value.reservation.amount, 0.0000001);
  assert.equal(validateSnapshot(f.context).reservations, 1);
  f.context.db.prepare('UPDATE assistant_usage_months SET value=? WHERE month=?').run(
    f.context.seal({
      format: 1,
      storeId: f.registration.store_id,
      table: 'assistant_usage_months',
      key: [f.month],
      value: { original: { spentRub: 0, calls: 'invalid', uncertainCalls: 0 } },
    }),
    f.month,
  );
  assert.throws(() => validateSnapshot(f.context), { status: 400 });
});

test('500 distinct orphan months keep debt and administrative access after expiry and disaster reset; strict export rejects unrepresentable history', async (t) => {
  const f = await rowsFixture(t, {
    initial(state) {
      for (let i = 0; i < 24; i++)
        state.usage[new Date(Date.UTC(2000, i, 1)).toISOString().slice(0, 7)] = {
          spentRub: 0.000001,
          calls: 1,
          uncertainCalls: 0,
        };
      for (let i = 0; i < 500; i++) {
        const month = new Date(Date.UTC(1950, i, 1)).toISOString().slice(0, 7);
        state.reservations['orphan-' + i] = {
          month,
          amount: 0.01,
          kind: 'llm',
          createdAt: Date.now() - 121000,
        };
      }
    },
  });
  assert.equal(validateSnapshot(f.context).reservations, 500);
  const reserved = await f.budget.reserve(f.current(), 3, 'llm', 0);
  assert.equal(validateSnapshot(f.context).months, 525);
  assert.ok(Object.keys(f.repository.adminSnapshot().usage).length <= 24);
  assert.equal(f.api().admin.view(f.admin.accountId).revision, 3);
  assert.throws(() => f.repository.exportLegacyState(), /Invalid encrypted/);
  await f.budget.settle(reserved, 0);
  f.context.transaction(() => resetRestoredRows(f.context));
  assert.equal(validateSnapshot(f.context).reservations, 0);
  assert.equal(f.repository.adminSnapshot().policy.mode, 'off');
  assert.equal(
    f.context.db.prepare('SELECT sum(spent_microrub) n FROM assistant_usage_months').get().n,
    5000024,
  );
  assert.equal(
    f.context.db.prepare('SELECT sum(uncertain_calls) n FROM assistant_usage_months').get().n,
    500,
  );
  assert.throws(() => f.repository.exportLegacyState(), /Invalid encrypted/);
});

for (const kind of ['grant', 'operation', 'root-field'])
  test(
    'import rejects ambiguous or unsupported legacy ' + kind + ' without partial component',
    async (t) => {
      let original;
      await assert.rejects(
        rowsFixture(t, {
          initial(state, { f }) {
            original = f;
            if (kind === 'grant')
              state.grants.push({ ...state.grants[0], limits: { dailyRequests: 2 } });
            else if (kind === 'operation') {
              const operation = {
                actorId: f.admin.accountId,
                requestId: randomUUID(),
                kind: 'assistant_settings_changed',
                fingerprint: 'b'.repeat(64),
                revision: 3,
              };
              state.operations = [operation, { ...operation, fingerprint: 'c'.repeat(64) }];
            } else state.unsupportedLegacyRoot = { preserved: true };
          },
        }),
        /Ambiguous duplicate|Unsupported/,
      );
      assert.equal(
        original.database.db
          .prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'assistant_%'")
          .get().n,
        0,
      );
    },
  );

test('SQL rows keep reviewed behavior approval, exact retry, restore and grant version revocation semantics', async (t) => {
  const f = await rowsFixture(t),
    api = f.api(),
    actor = f.admin.accountId,
    behavior = api.admin.behavior;
  const original = behavior.view(actor);
  const review = behavior.preview(actor, {
    expectedRevision: 3,
    rules: { ...original.rules, dictionary: 'Синтетический словарь' },
  });
  const body = command(3, { rules: review.rules, reviewHash: review.reviewHash, confirmed: true });
  assert.throws(() => behavior.approve(f.owner.accountId, body), { status: 403 });
  assert.equal(behavior.approve(actor, body).revision, 4);
  assert.equal(behavior.approve(actor, body).revision, 4);
  assert.equal(behavior.view(actor).version, original.version + 1);
  const restore = behavior.preview(actor, { expectedRevision: 4, sourceVersion: original.version });
  assert.equal(
    behavior.restore(
      actor,
      command(4, {
        sourceVersion: original.version,
        reviewHash: restore.reviewHash,
        confirmed: true,
      }),
    ).revision,
    5,
  );
  assert.equal(behavior.view(actor).rules.dictionary, original.rules.dictionary);
  assert.equal(f.policy.access(f.current()).enabled, true);
  const grant = f.context.db.prepare('SELECT grant_version FROM assistant_grants').get();
  api.admin.setMember(
    actor,
    command(5, {
      organizationId: f.owner.organizationId,
      accountId: f.owner.accountId,
      enabled: false,
    }),
  );
  assert.equal(f.policy.access(f.current()).enabled, false);
  assert.equal(
    f.context.db.prepare('SELECT grant_version FROM assistant_grants').get().grant_version,
    grant.grant_version + 1,
  );
  assert.equal(validateSnapshot(f.context).enabledGrants, 0);
});

test('row budget preserves existing paid wallet history and combines exact legacy attempts and monthly reservations', async (t) => {
  const f = await rowsFixture(t, {
    initial(state, { date, month, membershipId }) {
      state.policy.limits.dailyRequests = 2;
      state.policy.limits.monthlyBudgetRub = 2;
      state.daily[date + ':' + membershipId] = 1;
      state.usage[month] = { spentRub: 0.1, calls: 1, uncertainCalls: 0 };
      state.reservations.orphan = { month, amount: 0.2, kind: 'llm', createdAt: Date.now() };
    },
  });
  const wallet = createWalletStore(f.context);
  let paid = true;
  f.context.billing = { wallet, hasServiceConnection: () => true, isServiceEnabled: () => paid };
  const reserved = await f.budget.reserve(f.current(), 3, 'llm', 1.7);
  assert.equal(reserved.paid, true);
  assert.equal(f.repository.month(f.month).reservedMicrorub, 200000);
  await assert.rejects(async () => f.budget.reserve(f.current(), 3, 'stt', 0), { status: 429 });
  await f.budget.markOutbound(reserved);
  paid = false;
  await f.budget.settle(reserved, 0.4);
  assert.equal(wallet.getWallet(f.owner.organizationId).providerCostMicrorub, 400000);
  assert.equal(wallet.getWallet(f.owner.organizationId).chargedMicrorub, 0);
  assert.equal(f.repository.month(f.month).spentMicrorub, 100000);
  assert.equal(f.repository.day(f.date, f.membershipId), 1);
  assert.equal(validateSnapshot(f.context).reservations, 1);
});
