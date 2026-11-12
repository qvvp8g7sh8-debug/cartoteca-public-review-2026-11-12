const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { createPaidBookingFixture } = require('./helpers/assistant-paid-booking-fixture.cjs');
const {
  continuationExample,
} = require('../src/server/modules/assistant/dialogue/continuation/continuation-contract.cjs');
const {
  continuationOperation,
} = require('../src/server/modules/assistant/dialogue/continuation/continuation-operation.cjs');
const { zonedClock } = require('../src/shared/time-zone.cjs');
const { nextDate } = require('../src/shared/work-schedule.cjs');
const { defaults } = require('../src/server/modules/workspace/policy.cjs');
const variants = [
  {
    first: 'Никита',
    last: 'Соколов',
    spoken: 'Никиту Соколова',
    service: 'Люменконтур',
    noun: 'Векторин',
  },
  {
    first: 'Алина',
    last: 'Туманова',
    spoken: 'Алину Туманову',
    service: 'Плазмавектор',
    noun: 'Фокусалин',
  },
];
const clientValue = (reply) => reply.dialogue?.fields.find((row) => row.key === 'client')?.value;
const fields = (reply) =>
  Object.fromEntries((reply.dialogue?.fields || []).map((row) => [row.key, row.value]));
async function setup(t, step = 'date', variant = 0, early = false) {
  const f = await createPaidBookingFixture();
  t.after(() => f.close());
  assert.equal(f.scope.capabilities.tts.directPcm, false);
  const v = variants[variant],
    date = nextDate(zonedClock(new Date(), 'Europe/Moscow').date);
  Object.assign(f.synthetic.patients[0], {
    firstName: v.first,
    lastName: v.last,
    name: v.first + ' ' + v.last,
  });
  f.synthetic.patients.push({
    id: randomUUID(),
    firstName: 'Ольга',
    lastName: 'Новикова',
    name: 'Ольга Новикова',
    createdBy: f.context.current.accountId,
    appointments: [],
    phone: '',
  });
  f.synthetic.services[0].name = v.service;
  f.synthetic.changed();
  f.context.platform.workspaceSettings = () => defaults(f.context.current.accountId);
  f.context.platform.workSchedules = {
    view: () => ({
      days: { [date]: { status: 'working', intervals: [['09:00', '18:00']] } },
      closures: {},
    }),
  };
  let reply = await f.api.turn(f.context, {
    text: 'Запиши клиента ' + v.spoken + (early ? ' на ' + date + ' в 11:00' : ''),
    policyVersion: f.scope.policyVersion,
    taskRequestId: randomUUID(),
  });
  const body = (text, source = reply) => ({
    text,
    policyVersion: source.policyVersion,
    dialogueId: source.dialogue.id,
    dialogueVersion: source.dialogue.version,
    taskRequestId: source.taskRequestId,
  });
  if (early) {
    reply = await f.api.turn(f.context, body('Время 11:00'));
    assert.equal(fields(reply).time, '11:00', 'time is actually proven before choosing a service');
    assert.equal(fields(reply).date, date, 'date is actually proven before choosing a service');
  }
  if (step !== 'service') reply = await f.api.turn(f.context, body(v.service));
  if (step === 'time') reply = await f.api.turn(f.context, body(date));
  assert.equal(reply.dialogue.step, step);
  const before = fields(reply),
    clinicBefore = JSON.stringify(f.synthetic.patients);
  async function answer(text, proposal) {
    f.fixture.hooks.stt = async () => ({ text });
    f.fixture.hooks.llm = async () => ({
      text: typeof proposal === 'string' ? proposal : JSON.stringify(continuationExample(proposal)),
    });
    const request = body(text);
    const asr = await f.api.transcribe(f.context, {
      ...f.fixture.wav(),
      policyVersion: request.policyVersion,
      dialogueId: request.dialogueId,
      dialogueVersion: request.dialogueVersion,
      taskRequestId: request.taskRequestId,
    });
    request.text = asr.text;
    const next = await f.api.turn(f.context, request);
    assert.equal(f.packages.status(f.context.current.organizationId).usedTasks, 1);
    assert.equal(
      JSON.stringify(f.synthetic.patients) === clinicBefore,
      true,
      'no clinical mutations',
    );
    return { reply: next, request };
  }
  return { ...f, v, date, reply, before, body, answer };
}
for (const [step, field, variant] of [
  ['date', 'client', 0],
  ['date', 'client', 1],
  ['time', 'client', 0],
  ['date', 'staff', 0],
  ['time', 'staff', 1],
  ['date', 'service', 1],
  ['time', 'service', 0],
])
  test(
    'known entity survives unlabelled model reassignment: step=' +
      step +
      ', field=' +
      field +
      ', rename=' +
      variant,
    async (t) => {
      const f = await setup(t, step, variant);
      const { reply } = await f.answer(f.v.noun, {
        operation: 'patch',
        fields: { [field]: f.v.noun },
      });
      assert.equal(reply.dialogue.step, step);
      assert.equal(reply.dialogue.id === f.reply.dialogue.id, true);
      const retained = fields(reply);
      for (const key of ['client', 'staff', 'service', 'date', 'time'])
        if (Object.hasOwn(f.before, key))
          assert.equal(retained[key] === f.before[key], true, key + ' retained');
      assert.equal(reply.action, null);
      assert.equal(f.fixture.calls.llm, 1);
    },
  );
test('expected service answer keeps prefilled date and time while permitting current-field proposal', async (t) => {
  const f = await setup(t, 'service', 1, true);
  const { reply } = await f.answer(f.v.noun, { operation: 'patch', fields: { service: f.v.noun } });
  assert.equal(reply.dialogue.step, 'service');
  const retained = fields(reply);
  for (const key of ['client', 'staff', 'date', 'time'])
    assert.equal(retained[key] === f.before[key], true, key + ' retained');
  assert.equal(reply.action, null);
});
test('explicit mixed free-order client service and date correction remains atomic', async (t) => {
  const f = await setup(t, 'date', 1);
  const { reply } = await f.answer('Клиент Ольга Новикова завтра на ' + f.v.service, {
    operation: 'patch',
    fields: { client: 'Ольга Новикова', service: f.v.service, date: f.date },
  });
  assert.equal(f.fixture.calls.llm, 1);
  t.diagnostic(
    JSON.stringify({
      stage: reply.dialogue?.step || null,
      actionType: reply.action?.type || null,
      clientStillOriginal: clientValue(reply) === f.before.client,
      clientReplacedInFields: clientValue(reply) === 'Ольга Новикова',
      dateFieldPresent: Boolean(reply.dialogue?.fields.some((row) => row.key === 'date')),
      timeFieldPresent: Boolean(reply.dialogue?.fields.some((row) => row.key === 'time')),
    }),
  );
  assert.equal(reply.dialogue?.step, 'time');
  assert.equal(clientValue(reply) === 'Ольга Новикова', true, 'explicit replacement selected');
  assert.ok(reply.dialogue.fields.some((row) => row.key === 'service'));
  assert.ok(reply.dialogue.fields.some((row) => row.key === 'date'));
  assert.equal(reply.action, null);
});
test('early proven date and time plus spoken exact service prepare only the existing manual form', async (t) => {
  const f = await setup(t, 'service', 0, true);
  let { reply } = await f.answer(f.v.service, { operation: 'repeat' });
  t.diagnostic(
    JSON.stringify({
      stage: reply.dialogue?.step || null,
      phase: reply.dialogue?.phase || null,
      actionType: reply.action?.type || null,
      fieldKeys: (reply.dialogue?.fields || []).map((row) => row.key),
    }),
  );
  if (reply.dialogue?.phase === 'closedDay')
    reply = await f.api.turn(f.context, {
      text: 'да',
      policyVersion: reply.policyVersion,
      dialogueId: reply.dialogue.id,
      dialogueVersion: reply.dialogue.version,
      taskRequestId: reply.taskRequestId,
    });
  assert.equal(f.fixture.calls.llm, 0);
  assert.equal(reply.action?.type, 'prepareAppointment');
  assert.equal(
    reply.action.patientId === f.synthetic.patients[0].id,
    true,
    'original person selected',
  );
  assert.equal(reply.action.serviceIds.includes(f.synthetic.services[0].id), true);
  assert.equal(reply.action.date, f.date);
  assert.equal(reply.action.time, '11:00');
  assert.equal(reply.saved === true, false);
});
test('malformed model response recovery and exact retry retain fields without another model call', async (t) => {
  const f = await setup(t, 'date');
  const result = await f.answer('Разберём другое значение', '{invalid');
  assert.equal(result.reply.dialogue.step, 'date');
  assert.equal(isDeepStrictEqual(fields(result.reply), f.before), true, 'known fields retained');
  assert.equal(f.fixture.calls.llm, 1);
  const retried = await f.api.turn(f.context, result.request);
  assert.equal(retried.dialogue.id === result.reply.dialogue.id, true);
  assert.equal(retried.dialogue.version, result.reply.dialogue.version);
  assert.equal(
    isDeepStrictEqual(fields(retried), f.before),
    true,
    'known fields retained on exact retry',
  );
  assert.equal(f.fixture.calls.llm, 1);
  assert.equal(f.packages.status(f.context.current.organizationId).usedTasks, 1);
});
test('one bad entity does not discard source-proven temporals or silently complete the draft', async (t) => {
  const f = await setup(t, 'date');
  const llmBefore = f.fixture.calls.llm;
  const { reply } = await f.answer(f.v.noun + ', дата завтра, время 12:30', {
    operation: 'patch',
    fields: { client: f.v.noun, date: f.date, time: '12:30' },
  });
  assert.equal(f.fixture.calls.llm - llmBefore, 1, 'adversarial proposal was actually observed');
  assert.equal(reply.action, null, 'unresolved assignment requires clarification');
  assert.ok(reply.dialogue);
  const retained = fields(reply);
  for (const key of ['client', 'staff', 'service'])
    assert.equal(retained[key] === f.before[key], true, key + ' retained');
  assert.equal(retained.date, f.date);
  assert.equal(retained.time, '12:30');
  const continued = await f.api.turn(f.context, {
    text: 'Открой форму',
    policyVersion: reply.policyVersion,
    dialogueId: reply.dialogue.id,
    dialogueVersion: reply.dialogue.version,
    taskRequestId: reply.taskRequestId,
  });
  assert.equal(continued.action?.type, 'prepareAppointment');
  assert.equal(
    continued.action.patientId === f.synthetic.patients[0].id,
    true,
    'original person retained',
  );
  assert.equal(continued.action.date, f.date);
  assert.equal(continued.action.time, '12:30');
  assert.equal(continued.saved === true, false);
  assert.equal(f.packages.status(f.context.current.organizationId).usedTasks, 1);
});
test('source-proven repetition of selected entities is a no-op while a new date is retained', async (t) => {
  const f = await setup(t, 'date');
  const name = f.v.first + ' ' + f.v.last;
  const { reply } = await f.answer(name + ' ' + f.v.service + ' завтра', {
    operation: 'patch',
    fields: { client: name, service: f.v.service, date: f.date },
  });
  assert.equal(reply.dialogue.step, 'time');
  const retained = fields(reply);
  for (const key of ['client', 'staff', 'service'])
    assert.equal(retained[key] === f.before[key], true, key + ' retained');
  assert.equal(retained.date, f.date);
  assert.equal(reply.action, null);
});
test('model-only wrong-field clarification targets current question but explicit refocus is still allowed', async (t) => {
  const f = await setup(t, 'date');
  const llmBefore = f.fixture.calls.llm;
  const { reply } = await f.answer('Что дальше?', { operation: 'clarify', field: 'client' });
  assert.equal(reply.dialogue.step, 'date');
  assert.equal(isDeepStrictEqual(fields(reply), f.before), true, 'known fields retained');
  assert.equal(f.fixture.calls.llm - llmBefore, 1, 'adversarial clarify was actually observed');
  const explicit = await f.api.turn(f.context, {
    text: 'Уточни клиента',
    policyVersion: reply.policyVersion,
    dialogueId: reply.dialogue.id,
    dialogueVersion: reply.dialogue.version,
    taskRequestId: reply.taskRequestId,
  });
  assert.equal(explicit.dialogue.step, 'client');
  assert.equal(
    clientValue(explicit) === f.before.client,
    true,
    'explicit refocus retains chosen person',
  );
});
test('pure clarification operation cannot redirect an unrelated model field away from the expected question', () => {
  const entry = {
    step: 'date',
    data: {
      patient: { id: 'synthetic-known' },
      staff: { id: 'synthetic-staff' },
      serviceChosen: true,
      date: null,
      time: null,
    },
    options: new Map(),
  };
  const proposal = continuationExample({ operation: 'clarify', field: 'client' });
  const result = continuationOperation(proposal, { text: 'Что дальше?' }, entry, {
    date: '2099-01-05',
    hour: 8,
    minute: 0,
  });
  assert.equal(result.kind, 'modelClarify');
  assert.equal(result.field, 'date');
});
