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

for (const [step, text, proposal] of [
  ['date', 'Какая погода завтра?', { operation: 'clarify', field: 'date' }],
  ['date', 'Какое событие завтра?', { operation: 'patch', fields: { date: '2099-01-05' } }],
  ['time', 'Почему часы показывают 12:30?', { operation: 'patch', fields: { time: '12:30' } }],
  ['time', 'Сколько минут в 12:30?', { operation: 'clarify', field: 'time' }],
])
  test(
    'information question keeps actual paid draft: ' + step + ' ' + proposal.operation,
    async (t) => {
      const f = await setup(t, step);
      const effective = proposal.fields?.date
        ? { ...proposal, fields: { date: f.date } }
        : proposal;
      const { reply } = await f.answer(text, effective);
      assert.equal(reply.action, null);
      assert.equal(reply.dialogue.step, step);
      assert.equal(isDeepStrictEqual(fields(reply), f.before), true, 'all filled fields retained');
    },
  );
for (const [step, text, field, value] of [
  ['date', 'Какое событие завтра?', 'date', '2099-01-06'],
  ['time', 'Почему часы показывают 12:30?', 'time', '12:30'],
  ['duration', 'Почему ожидание длится 45 минут?', 'duration', 45],
])
  for (const operation of ['patch', 'clarify'])
    test('information question cannot mutate continuation: ' + step + ' ' + operation, () => {
      const entry = {
        step,
        data: {
          patient: { id: 'synthetic' },
          staff: { id: 'synthetic-staff' },
          serviceChosen: true,
          date: step === 'date' ? null : '2099-01-05',
          time: null,
        },
        options: new Map(),
      };
      const proposal = continuationExample(
        operation === 'patch' ? { operation, fields: { [field]: value } } : { operation, field },
      );
      const result = continuationOperation(proposal, { text }, entry, {
        date: '2099-01-05',
        hour: 8,
        minute: 0,
      });
      assert.equal(result.kind, 'modelClarify');
      assert.equal(result.field, step);
      assert.equal(
        Boolean(
          result.edits && Object.values(result.edits).some((v) => v !== null && v !== undefined),
        ),
        false,
      );
    });

test('exact current service catalog title takes precedence over question morphology', async (t) => {
  const f = await setup(t, 'service');
  const title = 'Какое завтра';
  f.synthetic.services[0].name = title;
  f.synthetic.changed();
  const { reply } = await f.answer(title, { operation: 'clarify', field: 'service' });
  assert.equal(reply.dialogue.step, 'date');
  assert.equal(clientValue(reply) === f.before.client, true);
  assert.equal(fields(reply).service === title, true);
  assert.equal(reply.action, null);
});
