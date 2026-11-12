const test = require('node:test');
const assert = require('node:assert/strict');
const {
  availabilityFixture,
  day,
} = require('./helpers/assistant-availability-native-fixture99.cjs');
const {
  intentEnvelope,
} = require('../src/server/modules/assistant/interpretation/intent-contract.cjs');
const {
  availabilityAction,
} = require('../src/server/modules/assistant/actions/availability-action.cjs');
const command = 'Найди свободные окна на ' + day + ' на 30 минут';
const { wav } = require('./helpers/assistant-boundaries-fixture.cjs');
const { routes } = require('../src/server/modules/assistant/routes.cjs');
const modelReply = (intent) => ({
  text: JSON.stringify(intentEnvelope({ intent: 'availability', ...intent })),
});
function readonlySlots(result) {
  return result.slots.map(({ date, time, endTime, duration, staffName }) => ({
    date,
    time,
    endTime,
    duration,
    staffName,
  }));
}

test('one transcription HTTP handler can return the exact local availability result', async (t) => {
  const f = await availabilityFixture(t);
  f.settings({ policy: { commands: { prepareAppointment: false } } });
  const expected = await f.turn(command);
  const clinical = f.clinic.read();
  const route = routes.find(({ path }) => path === '/api/assistant/transcribe');
  const send = (body) =>
    route.handle({
      ...f.context(),
      platform: { ...f.store, assistant: f.api },
      readBody: async () => ({ ...wav(), policyVersion: f.revision(), ...body }),
      json: (_res, status, value) => {
        assert.equal(status, 200);
        return value;
      },
    });
  f.hooks.stt = () => ({ text: command });
  const reply = await send({ availabilityTurn: 'plain' });
  assert.equal(reply.text, command);
  assert.deepEqual(reply.availabilityReply, expected);
  assert.deepEqual(f.calls, { llm: 0, stt: 1, tts: 0 });
  f.hooks.stt = () => ({ text: 'Покажи свободное время' });
  assert.equal((await send({ availabilityTurn: 'plain' })).availabilityReply, undefined);
  assert.equal(f.api.runtimeStats().turns.localAvailability, 2);
  await assert.rejects(send({ availabilityTurn: 'plain', dialogueId: 'stale' }), { status: 400 });
  assert.deepEqual(f.calls, { llm: 0, stt: 2, tts: 0 });
  assert.deepEqual(f.clinic.read(), clinical);
});

test('strict free-window reads use native schedules and room occupancy without providers, budgets or clinical writes', async (t) => {
  const f = await availabilityFixture(t, { dailyRequests: 1 });
  f.settings({ policy: { commands: { prepareAppointment: false } } });
  const clinicalBefore = f.clinic.read();
  f.hooks.llm = () => assert.fail('A whole explicit day and duration cannot call a model');
  let local = 0;
  for (const provider of ['codex', 'timeweb', 'demo']) {
    f.settings({ providers: { llm: { provider } }, policy: { limits: { monthlyBudgetRub: 0 } } });
    const before = f.readState();
    for (const role of ['owner', 'salon_admin', 'cosmetologist']) {
      const result = await f.turn(command, {}, role);
      local++;
      assert.equal(result.intent, 'availability');
      assert.equal(result.action, null);
      assert.equal(result.dialogue, undefined);
      assert.equal(result.slots, undefined);
      assert.ok(result.readOnlySlots.length > 0 && result.readOnlySlots.length <= 12);
      assert.ok(result.readOnlySlots.every((slot) => slot.date === day && slot.time >= '09:30'));
      assert.equal(result.availability.duration, 30);
      assert.equal(result.availability.from, day);
      assert.equal(result.availability.to, day);
      const direct = availabilityAction(
        f.context(role),
        { intent: 'availability', date: day, endDate: day, duration: 30 },
        f.clock,
      );
      assert.deepEqual(result.availability, direct.availability);
      assert.deepEqual(result.readOnlySlots, readonlySlots(direct));
      if (role === 'cosmetologist') {
        const ownName = f.store
          .workspaceMembers(f.owner.organizationId)
          .find((member) => member.accountId === f.staffId).displayName;
        assert.ok(result.readOnlySlots.every((slot) => slot.staffName === ownName));
      }
      assert.equal(result.demo, provider === 'demo');
      assert.equal(result.usage, undefined);
      assert.doesNotMatch(
        JSON.stringify(result),
        /synthetic-patient99|79990009900|Synthetic occupancy proof/,
      );
    }
    assert.deepEqual(f.readState(), before);
  }
  assert.deepEqual(f.clinic.read(), clinicalBefore);
  assert.deepEqual(f.calls, { llm: 0, stt: 0, tts: 0 });
  assert.equal(f.api.runtimeStats().turns.localAvailability, local);
  assert.equal(f.api.runtimeStats().turns.model, 0);
});

test('the fully specified local response equals the canonical model-intent response for every real actor', async (t) => {
  const f = await availabilityFixture(t);
  f.settings({ policy: { commands: { prepareAppointment: false } } });
  f.hooks.llm = () => modelReply({ date: day, endDate: day, duration: 30 });
  for (const role of ['owner', 'salon_admin', 'cosmetologist']) {
    const calls = f.calls.llm;
    const canonical = await f.turn('Свободное время на ' + day + ' на 30 минут', {}, role);
    assert.equal(f.calls.llm, calls + 1);
    const local = await f.turn(command, {}, role);
    assert.equal(f.calls.llm, calls + 1);
    const { usage, ...canonicalDomain } = canonical;
    assert.equal(usage.kind, 'llm');
    assert.equal(usage.billing, 'codex-subscription');
    assert.equal(local.usage, undefined, 'No invented provider usage for the local branch');
    assert.deepEqual(local, canonicalDomain);
    const spoken = await f.turn('Покажи свободное время на ' + day + ' на 30 минут', {}, role);
    assert.equal(f.calls.llm, calls + 1);
    assert.deepEqual(spoken, canonicalDomain);
  }
});

test('supported model modifiers, ranges and missing-field defaults retain the prior model path and domain results', async (t) => {
  const f = await availabilityFixture(t);
  f.settings({ policy: { commands: { prepareAppointment: false } } });
  const ownerName = f.store
    .workspaceMembers(f.owner.organizationId)
    .find((m) => m.accountId === f.ownerId).displayName;
  const cases = [
    [
      'Найди свободные окна на ' + day + ' на 30 минут у ' + ownerName,
      { date: day, duration: 30, staffQuery: ownerName },
    ],
    [
      'Найди свободные окна на ' + day + ' для услуги Тестовая чистка',
      { date: day, serviceQuery: 'Тестовая чистка' },
    ],
    [
      'Найди свободные окна с ' + day + ' по 2099-01-06 на 30 минут',
      { date: day, endDate: '2099-01-06', duration: 30 },
    ],
    [
      'Найди свободные окна на ' + day + ' с 10:00 до 11:00 на 30 минут',
      { date: day, time: '10:00', endTime: '11:00', duration: 30 },
    ],
    ['Найди свободные окна на ' + day, { date: day }],
    ['Найди свободные окна на 30 минут', { duration: 30 }],
    ['Найди свободные окна', {}],
  ];
  for (const [text, fields] of cases) {
    const calls = f.calls.llm;
    f.hooks.llm = () => modelReply(fields);
    const result = await f.turn(text);
    assert.equal(f.calls.llm, calls + 1, text);
    assert.equal(result.intent, 'availability', text);
    const direct = availabilityAction(f.context(), { intent: 'availability', ...fields }, f.clock);
    assert.deepEqual(result.availability, direct.availability, text);
    if (direct.slots.length) assert.deepEqual(result.readOnlySlots, readonlySlots(direct), text);
    else assert.equal(result.readOnlySlots, undefined, text);
    assert.equal(result.action, null, text);
  }
  assert.equal(f.api.runtimeStats().turns.localAvailability, 0);
  assert.equal(f.api.runtimeStats().turns.model, cases.length);
});

test('unsupported local text still validates model wire and existing duration/write guards reject permissive model output', async (t) => {
  const f = await availabilityFixture(t);
  f.hooks.llm = () => ({ text: 'synthetic malformed model output' });
  for (const text of [
    'Найди свободные окна завтра на 30',
    'Найди свободные окна завтра на 30 минут в кабинете первом',
    'Найди свободные окна завтра на 30 минут, если нет клиентов',
    'Если нет клиентов, найди свободные окна завтра на 30 минут',
    'Не ищи свободные окна завтра на 30 минут',
    'Найди свободные окна завтра на 30 минут и запиши Иванову',
  ]) {
    const calls = f.calls.llm;
    await assert.rejects(f.turn(text), { status: 502 }, text);
    assert.equal(f.calls.llm, calls + 1, text);
  }
  f.hooks.llm = () => modelReply({ date: day, duration: 30 });
  for (const [text, status] of [
    ['Найди свободные окна на ' + day + ' на 7 минут', 400],
    ['Найди свободные окна на ' + day + ' на 30 или 60 минут', 400],
    ['Отмени запись Ивановой и найди свободные окна на ' + day + ' на 30 минут', 502],
    ['Не записывай Иванову и найди свободные окна на ' + day + ' на 30 минут', 400],
  ])
    await assert.rejects(f.turn(text), { status }, text);
  assert.equal(f.api.runtimeStats().turns.localAvailability, 0);
});

test('local free-window reads preserve scoped choice dialogue and never save an appointment', async (t) => {
  const f = await availabilityFixture(t);
  const before = f.clinic.read();
  const first = await f.turn(command);
  assert.equal(first.dialogue.step, 'availability');
  assert.ok(first.dialogue.options.length > 0);
  assert.equal(first.action, null);
  assert.equal(first.saved, undefined);
  const choice = first.dialogue.options[0].id;
  const next = await f.turn(undefined, {
    dialogueId: first.dialogue.id,
    dialogueVersion: first.dialogue.version,
    choice,
  });
  assert.equal(next.action, null);
  assert.equal(next.dialogue.step, 'client');
  assert.deepEqual(f.clinic.read(), before);
  assert.equal(f.calls.llm, 0);
  await assert.rejects(
    f.turn(
      undefined,
      { dialogueId: first.dialogue.id, dialogueVersion: first.dialogue.version, choice },
      'cosmetologist',
    ),
    { status: 409 },
  );
});

test('fast-window admission retains category, grant, policy, native membership and disconnected-scope guards', async (t) => {
  const f = await availabilityFixture(t);
  f.settings({ policy: { commands: { calendar: false } } });
  await assert.rejects(f.turn(command), { status: 403 });
  f.settings({ policy: { commands: { calendar: true } } });
  await assert.rejects(f.turn(command, { policyVersion: f.revision() - 1 }), { status: 409 });
  f.grant('owner', false);
  await assert.rejects(f.turn(command), { status: 403 });
  f.grant('owner');
  const c = f.context('cosmetologist');
  for (const forged of [{ role: 'owner' }, { organizationId: f.other.organizationId }])
    await assert.rejects(
      f.api.turn(
        { ...c, current: { ...c.current, ...forged } },
        { text: command, policyVersion: f.revision() },
      ),
      { status: 403 },
    );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    f.api.turn(
      { ...f.context(), transportAbortSignal: controller.signal },
      { text: command, policyVersion: f.revision() },
    ),
    { code: 'ASSISTANT_REQUEST_ABORTED' },
  );
  assert.equal(f.calls.llm, 0);
  assert.deepEqual(f.readState().reservations, {});
  const current = f.context(),
    schedules = current.platform.workSchedules;
  let revoked = false;
  const duringRead = {
    ...current,
    platform: {
      ...current.platform,
      workSchedules: {
        ...schedules,
        view(...args) {
          if (!revoked) {
            revoked = true;
            f.grant('owner', false);
          }
          return schedules.view(...args);
        },
      },
    },
  };
  await assert.rejects(f.api.turn(duringRead, { text: command, policyVersion: f.revision() }), {
    status: 403,
  });
  assert.equal(revoked, true, 'actual native schedule read reached the authority change');
  assert.equal(f.calls.llm, 0);
});

test('a local window request fences an older model command instead of reviving its reply', async (t) => {
  const f = await availabilityFixture(t);
  f.settings({ policy: { commands: { prepareAppointment: false } } });
  let finish, entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  f.hooks.llm = () =>
    new Promise((resolve) => {
      finish = resolve;
      entered();
    });
  const older = assert.rejects(f.turn('Свободное время на ' + day), { status: 409 });
  await started;
  const local = await f.turn(command);
  assert.equal(local.intent, 'availability');
  finish(modelReply({ date: day, duration: 30 }));
  await older;
  assert.equal(f.calls.llm, 1);
});
