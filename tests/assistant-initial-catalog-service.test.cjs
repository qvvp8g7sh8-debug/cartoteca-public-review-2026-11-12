const test = require('node:test'),
  assert = require('node:assert/strict'),
  { randomUUID } = require('node:crypto');
const { createPaidBookingFixture } = require('./helpers/assistant-paid-booking-fixture.cjs');
const {
  appointmentCreateServiceIntent,
} = require('../src/server/modules/assistant/actions/appointment-create-service-request.cjs');
const clock = { date: '2099-01-05', hour: 8, minute: 0 };
const service = (name) => ({ id: randomUUID(), name, staffId: 'synthetic' });
test('typed catalog service consumes full clauses, labels temporal titles, and rejects ambiguity', async () => {
  for (const [text, title, expected] of [
    ['Запиши на Люменконтур', 'Люменконтур', true],
    ['Запиши клиента Никиту Соколова на Люменконтур завтра', 'Люменконтур', true],
    ['Запиши на Люменконтур клиента Никиту Соколова завтра', 'Люменконтур', true],
    ['Запиши на услугу Завтра', 'Завтра', true],
    ['Запиши на Завтра', 'Завтра', false],
    ['Запиши на Завтра утром', 'Завтра утром', false],
    ['Запиши на услугу Завтра утром', 'Завтра утром', true],
    ['Запиши на День красоты', 'День красоты', false],
    ['Запиши на услугу День красоты', 'День красоты', true],
    ['Запиши на Люменконтур если будет время', 'Люменконтур', false],
    ['Запиши на Люменконтур или другое', 'Люменконтур', false],
    ['Не записывай на Люменконтур', 'Люменконтур', false],
    ['Запиши и отмени запись на Люменконтур', 'Люменконтур', false],
  ]) {
    const result = await appointmentCreateServiceIntent(
      text,
      clock,
      () => true,
      () => [service(title)],
    );
    assert.equal(Boolean(result), expected, 'whole clause result');
    if (result) assert.equal(result.serviceQuery === title, true);
  }
  assert.equal(
    await appointmentCreateServiceIntent(
      'Запиши на Люменконтур',
      clock,
      () => true,
      () => [service('Люменконтур'), service('Люменконтур')],
    ),
    null,
  );
  assert.equal(
    await appointmentCreateServiceIntent(
      'Запиши на Неизвестную',
      clock,
      () => true,
      () => [service('Люменконтур')],
    ),
    null,
  );
  assert.equal(
    await appointmentCreateServiceIntent(
      'Запиши на Уход лица',
      clock,
      () => true,
      () => [service('Уход'), service('Уход лица')],
    ),
    null,
    'multiple full interpretations abstain',
  );
  assert.equal(
    await appointmentCreateServiceIntent(
      'Запиши Иванову на завтра у Петровой',
      clock,
      () => true,
      () => assert.fail('temporal framing must not read the new service catalog'),
    ),
    null,
  );
});
test('repeated catalog titles prove a literal identity once and remain ambiguous', async () => {
  for (const known of [true, false]) {
    const queries = [];
    const result = await appointmentCreateServiceIntent(
      'Запиши Никиту Соколова на Люменконтур завтра',
      clock,
      async (query) => {
        queries.push(query);
        return known;
      },
      () => [service('Люменконтур'), service('Люменконтур'), service('Люменконтур')],
    );
    assert.equal(result, null);
    assert.deepEqual(queries, ['Никиту Соколова']);
  }
});
for (const [variant, title] of [
  [0, 'Люменконтур'],
  [1, 'Никита Соколов'],
])
  test(
    'actual paid initial catalog route is provider-free and retains fields: rename' + variant,
    async (t) => {
      const f = await createPaidBookingFixture();
      t.after(() => f.close());
      Object.assign(f.synthetic.patients[0], {
        firstName: 'Никита',
        lastName: 'Соколов',
        name: 'Никита Соколов',
      });
      f.synthetic.services[0].name = title;
      f.synthetic.changed();
      const fields = (r) =>
        Object.fromEntries((r.dialogue?.fields || []).map((x) => [x.key, x.value]));
      async function turn(text, proposal, api = f.api) {
        const before = f.fixture.calls.llm;
        f.fixture.hooks.llm = async () => ({ text: JSON.stringify(proposal) });
        const result = await api.turn(f.context, {
          text,
          newCommand: true,
          policyVersion: f.scope.policyVersion,
          taskRequestId: randomUUID(),
          speech: { format: 'pcm', stream: true, mode: 'answerable' },
        });
        return { result, llm: f.fixture.calls.llm - before };
      }
      const text = 'Запиши клиента Никиту Соколова на ' + title,
        proposal = { intent: 'prepareAppointment', query: 'Никиту Соколова', serviceQuery: title };
      const next = await turn(text, proposal);
      assert.equal(next.llm, 0);
      assert.equal(next.result.dialogue.step, 'date');
      assert.equal(fields(next.result).client === 'Никита Соколов', true);
      assert.equal(fields(next.result).service === title, true);
      assert.equal(next.result.action, null);
      assert.ok(next.result.speechPermit);
      assert.ok(next.result.speech);
      const only = await turn('Запиши на ' + title, {
        intent: 'prepareAppointment',
        serviceQuery: title,
      });
      assert.equal(only.llm, 0);
      assert.equal(only.result.dialogue.step, 'client');
      assert.equal(fields(only.result).service === title, true);
      const beforeTemporal = f.fixture.calls.llm,
        temporal = await turn(
          'Запиши клиента Никиту Соколова на ' + title + ' завтра в 10:00',
          proposal,
        );
      assert.equal(f.fixture.calls.llm, beforeTemporal);
      assert.equal(fields(temporal.result).time, '10:00');
      assert.ok(fields(temporal.result).date);
      assert.equal(temporal.result.action, null, 'no implicit save');
      const fallback = await turn('Запиши на ' + title + ' если будет время', proposal);
      assert.equal(fallback.llm, 1);
      assert.equal(f.packages.status(f.context.current.organizationId).usedTasks, 4);
      assert.equal(f.pcmCalls(), 0);
    },
  );
test('old fully covered date path does not read new catalog callback; explicit service label disambiguates', async (t) => {
  const f = await createPaidBookingFixture();
  t.after(() => f.close());
  f.synthetic.services[0].name = 'Завтра';
  f.synthetic.changed();
  let reads = 0;
  const original = f.clinic.readServices.bind(f.clinic);
  f.clinic.readServices = () => {
    reads++;
    return original();
  };
  const text = 'Запиши на завтра';
  f.fixture.hooks.llm = async () => assert.fail('covered initial needs no model');
  const reply = await f.api.turn(f.context, {
    text,
    policyVersion: f.scope.policyVersion,
    taskRequestId: randomUUID(),
  });
  assert.equal(f.fixture.calls.llm, 0);
  assert.ok(reply.dialogue.fields.find((x) => x.key === 'date'));
  assert.equal(
    reply.dialogue.fields.some((x) => x.key === 'service'),
    false,
  );
  // One ordinary domain context read; no extra new-parser catalog read.
  assert.equal(reads, 1);
  const explicit = await f.api.turn(f.context, {
    text: 'Запиши на услугу Завтра',
    policyVersion: f.scope.policyVersion,
    taskRequestId: randomUUID(),
  });
  assert.equal(f.fixture.calls.llm, 0);
  assert.equal(explicit.dialogue.fields.find((x) => x.key === 'service')?.value, 'Завтра');
  assert.equal(explicit.dialogue.step, 'client');
  assert.equal(explicit.action, null);
});
test('fresh catalog proof refuses revoked actor before any model or dialogue commit', async (t) => {
  const f = await createPaidBookingFixture();
  t.after(() => f.close());
  f.synthetic.services[0].name = 'Люменконтур';
  f.synthetic.changed();
  const original = f.context.platform.workspaceMembers;
  // Paid scope does not use test grants; revoke actual membership rather than the test switch.
  f.context.platform.workspaceMembers = (...args) => {
    f.fixture.database.db
      .prepare("UPDATE memberships SET status='suspended' WHERE organization_id=? AND account_id=?")
      .run(f.context.current.organizationId, f.context.current.accountId);
    return original(...args);
  };
  await assert.rejects(
    f.api.turn(f.context, {
      text: 'Запиши на Люменконтур',
      policyVersion: f.scope.policyVersion,
      taskRequestId: randomUUID(),
    }),
    { status: 401 },
  );
  assert.equal(f.fixture.calls.llm, 0);
  assert.equal(f.pcmCalls(), 0);
  assert.equal(f.packages.status(f.context.current.organizationId).usedTasks, 0);
});
