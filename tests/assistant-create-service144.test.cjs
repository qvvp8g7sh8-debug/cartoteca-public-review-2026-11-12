const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  availabilityFixture,
  day,
} = require('./helpers/assistant-availability-native-fixture99.cjs');
const { createAssistant } = require('../src/server/modules/assistant/service.cjs');
const {
  intentEnvelope,
} = require('../src/server/modules/assistant/interpretation/intent-contract.cjs');
async function fixture(t, options) {
  const f = await availabilityFixture(t, options),
    value = f.clinic.read();
  Object.assign(value.patients[0], {
    firstName: 'Анна',
    lastName: 'Иванова',
    name: 'Анна Иванова',
  });
  f.clinic.write(value);
  return f;
}
function domain(value) {
  return JSON.parse(
    JSON.stringify(value, (key, item) => {
      if (key === 'usage') return undefined;
      if (['id', 'executionId', 'expiresAt'].includes(key)) return '<opaque>';
      return item;
    }),
  );
}
const text = `Запиши Анну Иванову на ${day} в 14:00 на 30 минут`;
test('covered initial creates bypass every model without provider budgets or implicit clinical writes', async (t) => {
  const f = await fixture(t, { dailyRequests: 1 });
  f.hooks.llm = () => assert.fail('Whole literal booking must not wait for an LLM');
  const beforeClinical = f.clinic.read();
  for (const provider of ['codex', 'timeweb', 'demo']) {
    f.settings({ providers: { llm: { provider } }, policy: { limits: { monthlyBudgetRub: 0 } } });
    const before = f.readState();
    for (const command of [
      text,
      'Создай новую запись',
      'Запиши Иванову завтра',
      'Запиши Анны Ивановой завтра',
      'Запиши Ивановой Анне завтра',
    ]) {
      const reply = await f.turn(command);
      assert.equal(reply.intent, 'prepareAppointment');
      assert.ok(reply.dialogue || reply.action, 'existing dialogue/form flow owns the proposal');
      assert.equal(reply.usage, undefined);
      assert.equal(reply.demo, provider === 'demo');
      assert.deepEqual(f.clinic.read(), beforeClinical, '/turn cannot save or execute a booking');
    }
    for (const key of ['daily', 'usage', 'reservations'])
      assert.deepEqual(f.readState()[key], before[key]);
  }
  assert.deepEqual(f.calls, { llm: 0, stt: 0, tts: 0 });
  assert.equal(f.api.runtimeStats().turns.localPrepareAppointment, 15);
});
test('local creates equal canonical model-intent domain results under both existing saving flags', async (t) => {
  const f = await fixture(t);
  f.hooks.llm = () => ({
    text: JSON.stringify(
      intentEnvelope({
        intent: 'prepareAppointment',
        query: 'Анну Иванову',
        date: day,
        time: '14:00',
        duration: 30,
      }),
    ),
  });
  for (const enabled of [false, true]) {
    const api = createAssistant(
      { ...f.database, organizationTimeZone: f.store.organizationTimeZone },
      { directory: f.platformDirectory, ...f.ports, appointmentSavingEnabled: enabled },
    );
    const before = f.clinic.read(),
      calls = f.calls.llm;
    const canonical = await f.turn('Прошу, ' + text.toLowerCase(), {}, 'owner', api);
    assert.equal(f.calls.llm, calls + 1);
    const local = await f.turn(text, {}, 'owner', api);
    assert.equal(f.calls.llm, calls + 1, 'exactly one model call was removed');
    assert.deepEqual(domain(local), domain(canonical));
    assert.deepEqual(f.clinic.read(), before);
    assert.notEqual(local.action?.type, 'createAppointment');
    assert.notEqual(local.action?.type, 'execute');
    if (local.dialogue?.options?.length) {
      const next = await api.turn(f.context(), {
        policyVersion: f.revision(),
        dialogueId: local.dialogue.id,
        dialogueVersion: local.dialogue.version,
        choice: local.dialogue.options[0].id,
      });
      assert.ok(next.dialogue || next.action);
      assert.deepEqual(
        f.clinic.read(),
        before,
        'explicit dialogue choice still does not commit through /turn',
      );
    }
  }
});
test('unsupported whole tails keep their single model call and fresh access/category guards stay authoritative', async (t) => {
  const f = await fixture(t);
  f.hooks.llm = () => ({ text: 'Synthetic invalid JSON' });
  for (const command of [
    'Запиши Иванову завтра у Петровой',
    'Запиши Иванову ботокс завтра',
    'Запиши ботокс',
    'Запиши Анну чистку завтра',
    'Запиши Иванову на чистку',
    'Не записывай Иванову',
    'Запиши Иванову, если свободно',
    'Запиши Иванову и сохрани',
    'Запиши Иванову завтра в 14:00 в 15:00',
    'Запиши клиента Иванову на час',
    'Запиши клиента Иванову завтра на час',
  ]) {
    const before = f.calls.llm;
    await assert.rejects(f.turn(command), { status: 502 });
    assert.equal(f.calls.llm, before + 1, command);
  }
  const calls = f.calls.llm;
  f.settings({ policy: { commands: { prepareAppointment: false } } });
  await assert.rejects(f.turn(text), { status: 403 });
  f.settings({ policy: { commands: { prepareAppointment: true } } });
  await assert.rejects(f.turn(text, { policyVersion: f.revision() - 1 }), { status: 409 });
  const c = f.context(),
    original = c.assertCurrent;
  let checks = 0;
  c.assertCurrent = () => {
    original();
    if (++checks === 3) f.grant('owner', false);
  };
  await assert.rejects(f.api.turn(c, { text, policyVersion: f.revision() }), { status: 403 });
  assert.equal(f.calls.llm, calls);
});
test('a paid local create retains one package admission and scoped speech proof without provider reservation', async (t) => {
  const f = await fixture(t),
    request = randomUUID(),
    events = [];
  let accepted = false,
    ticket;
  const packages = {
    reserveTask(input) {
      assert.equal(input.requestId, request);
      events.push('reserve');
      return (ticket = { id: randomUUID(), grantId: randomUUID(), requestId: request, attempt: 1 });
    },
    acceptTask(value, proof) {
      assert.equal(value, ticket);
      assert.equal(proof.outbound, undefined);
      accepted = true;
      events.push('accept');
    },
    requireAcceptedTask({ requestId }) {
      assert.equal(accepted, true);
      assert.equal(requestId, request);
      return ticket;
    },
    rejectTask() {
      events.push('reject');
    },
  };
  const api = createAssistant(
    {
      ...f.database,
      organizationTimeZone: f.store.organizationTimeZone,
      billing: {
        hasServiceConnection: () => true,
        isServiceEnabled: () => true,
        packages,
        wallet: {
          reserve() {
            assert.fail('No provider money for a local proposal');
          },
        },
      },
    },
    { directory: f.platformDirectory, ...f.ports, appointmentSavingEnabled: true },
  );
  const before = f.clinic.read();
  const reply = await f.turn(text, { taskRequestId: request }, 'owner', api);
  assert.equal(reply.intent, 'prepareAppointment');
  assert.equal(reply.taskRequestId, request);
  assert.ok(reply.speechPermit.token);
  assert.deepEqual(events, ['reserve', 'accept', 'accept']);
  assert.equal(
    events.filter((event) => event === 'reserve').length,
    1,
    'dialogue binding updates the same package task; it never reserves twice',
  );
  assert.deepEqual(f.calls, { llm: 0, stt: 0, tts: 0 });
  assert.deepEqual(f.clinic.read(), before);
  await assert.rejects(
    api.speak(f.context(), {
      text: 'Посторонняя команда',
      policyVersion: f.revision(),
      taskRequestId: request,
      speechToken: reply.speechPermit.token,
    }),
    { code: 'ASSISTANT_SPEECH_PROOF_REQUIRED' },
  );
});
