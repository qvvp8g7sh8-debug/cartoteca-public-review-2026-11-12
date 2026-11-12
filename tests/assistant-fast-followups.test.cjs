const test = require('node:test');
const assert = require('node:assert/strict');
const { isFastContinuation } = require('../src/server/modules/assistant/dialogue/dialogue-input.cjs');
const {
  createContinuationRuntime,
} = require('../src/server/modules/assistant/dialogue/continuation/continuation-runtime.cjs');
const { initialState } = require('../src/server/modules/assistant/access/defaults.cjs');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const clock = { date: day, hour: 8, minute: 0 };
const entryFor = (step) => ({ step, data: {}, options: new Map() });

for (const text of [
  'Подбери свободное время.',
  'найди окно',
  'предложи ближайшее время',
  'покажи подходящие окна',
  'любое время',
  'когда есть свободное время',
])
  test('whole slot request bypasses model preparation: ' + text, () => {
    assert.equal(isFastContinuation(text, entryFor('time'), clock), true);
  });

for (const text of [
  'подбери окно завтра',
  'найди окно или консультацию',
  'не подбирай свободное время',
  'найди окно и поменяй клиента',
  'если можно подбери время',
  'найди окно в 12:30',
  'подбери ' + ' '.repeat(150) + 'окно',
])
  test('mixed, negative or oversized request still requires a model: ' + text, () => {
    assert.equal(isFastContinuation(text, entryFor('time'), clock), false);
  });

for (const text of [
  'сорок пять минут',
  'полчаса',
  'на час',
  '1,5 часа',
  'час двадцать',
  'пять минут',
])
  test('a whole duration answer is local only at the duration step: ' + text, () => {
    assert.equal(isFastContinuation(text, entryFor('duration'), clock), true);
    for (const step of ['client', 'staff', 'service', 'date', 'time', 'review'])
      assert.equal(isFastContinuation(text, entryFor(step), clock), false, step);
  });

for (const text of [
  'сорок пять или шестьдесят минут',
  'примерно сорок пять минут',
  'семь минут',
  'сорок пять минут и завтра',
  'не полчаса',
  '0 минут',
  '1445 минут',
  '45 минут 10 секунд',
])
  test('invalid or partial duration stays outside the fast path: ' + text, () => {
    assert.equal(isFastContinuation(text, entryFor('duration'), clock), false);
  });

function fixture({ durationRequired = false } = {}) {
  const f = dialogueFixture(),
    config = initialState();
  f.state.policy = { ...config.policy, ...f.state.policy, limits: config.policy.limits };
  f.state.providers = { ...config.providers, llm: { provider: 'codex', model: 'codex-default' } };
  f.state.rates = config.rates;
  const initial = f.flow.start(
    f.c,
    { intent: 'prepareAppointment', query: 'Анна Семёнова', serviceQuery: 'Чистка', date: day },
    f.state,
    f.member,
    f.clock,
    f.flow.beginCommand(f.c, f.member, f.state),
    durationRequired ? { requireDuration: true } : {},
  );
  let calls = 0;
  const runtime = createContinuationRuntime({
    dialogues: f.flow,
    scope(c, version) {
      c.assertCurrent();
      if (version !== f.state.revision)
        throw Object.assign(Error('Synthetic stale policy'), { status: 409 });
      return { state: f.state, member: f.member };
    },
    timeZone: () => 'Europe/Moscow',
    now: () => Date.parse(day + 'T05:00:00Z'),
    async invoke() {
      calls++;
      throw Error('This strict local follow-up must never invoke a provider');
    },
  });
  const body = (text) => ({
    policyVersion: f.state.revision,
    dialogueId: initial.dialogue.id,
    dialogueVersion: initial.dialogue.version,
    text,
  });
  return { ...f, initial, runtime, body, calls: () => calls };
}

test('slot-request continuation makes no model call, rereads changed occupancy and preserves selected fields', async () => {
  const f = fixture();
  const entry = f.flow.get(f.c, f.member, f.state, f.initial.dialogue.id);
  const selected = structuredClone({
    patient: entry.data.patient,
    staff: entry.data.staff,
    service: entry.data.service,
    date: entry.data.date,
    duration: entry.data.duration,
  });
  f.busy.push({ date: day, time: '09:00', duration: 60, staffId: 'owner', status: 'scheduled' });
  const request = f.body('подбери свободное время');
  const reply = await f.runtime.run(f.c, request, f.state, f.member);
  assert.equal(f.calls(), 0);
  assert.equal(reply.dialogue.phase, 'slots');
  assert.ok(reply.dialogue.options.length > 0);
  assert.match(reply.dialogue.options[0].label, /10:00/u);
  assert.ok(reply.dialogue.options.every((row) => !/09:[0-5]\d/u.test(row.label)));
  assert.doesNotMatch(reply.dialogue.prompt, /Весь рабочий день свободен/u);
  assert.deepEqual(
    {
      patient: entry.data.patient,
      staff: entry.data.staff,
      service: entry.data.service,
      date: entry.data.date,
      duration: entry.data.duration,
    },
    selected,
  );
  const replay = await f.runtime.run(f.c, request, f.state, f.member);
  assert.deepEqual(replay, reply);
  await assert.rejects(f.runtime.run(f.c, { ...request, text: 'найди окно' }, f.state, f.member), {
    status: 409,
  });
  assert.equal(f.calls(), 0);
  assert.equal(f.patients[0].appointments.length, 0);
});

test('duration continuation makes no model call and preserves the existing client, service and date', async () => {
  const f = fixture({ durationRequired: true });
  assert.equal(f.initial.dialogue.step, 'duration');
  const entry = f.flow.get(f.c, f.member, f.state, f.initial.dialogue.id);
  const selected = structuredClone({
    patient: entry.data.patient,
    staff: entry.data.staff,
    service: entry.data.service,
    date: entry.data.date,
  });
  const reply = await f.runtime.run(f.c, f.body('сорок пять минут'), f.state, f.member);
  assert.equal(f.calls(), 0);
  assert.equal(entry.data.duration, 45);
  assert.equal(entry.data.durationSource, 'manual');
  assert.equal(reply.action, null);
  assert.deepEqual(
    {
      patient: entry.data.patient,
      staff: entry.data.staff,
      service: entry.data.service,
      date: entry.data.date,
    },
    selected,
  );
  assert.equal(f.patients[0].appointments.length, 0);
});

test('fast answers still reject revoked scope and stale policy before touching dialogue state', async () => {
  for (const options of [{ text: 'найди окно' }, { text: 'полчаса', durationRequired: true }]) {
    const f = fixture(options);
    const entry = f.flow.get(f.c, f.member, f.state, f.initial.dialogue.id);
    const before = structuredClone(entry.data),
      request = f.body(options.text);
    f.state.revision++;
    await assert.rejects(f.runtime.run(f.c, request, f.state, f.member), { status: 409 });
    f.state.revision--;
    f.c.assertCurrent = () => {
      throw Object.assign(Error('Synthetic revoked scope'), { status: 403 });
    };
    await assert.rejects(f.runtime.run(f.c, request, f.state, f.member), { status: 403 });
    assert.deepEqual(entry.data, before);
    assert.equal(f.calls(), 0);
    assert.equal(f.patients[0].appointments.length, 0);
  }
});
