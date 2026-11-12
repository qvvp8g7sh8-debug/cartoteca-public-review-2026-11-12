const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createContinuationRuntime,
} = require('../src/server/modules/assistant/dialogue/continuation/continuation-runtime.cjs');
const { initialState } = require('../src/server/modules/assistant/access/defaults.cjs');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');

function runtimeFixture(text = 'два часа тридцать минут дня', expected = '14:30') {
  const f = dialogueFixture(),
    config = initialState();
  f.state.policy = { ...config.policy, ...f.state.policy, limits: config.policy.limits };
  f.state.providers = { ...config.providers, llm: { provider: 'codex', model: 'codex-default' } };
  f.state.rates = config.rates;
  const initial = f.start({ query: 'Анна Семёнова', serviceQuery: 'Чистка', date: day });
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
      return {
        text: JSON.stringify({
          operation: 'patch',
          fields: {
            client: null,
            staff: null,
            service: null,
            date: null,
            time: expected,
            duration: null,
          },
          choice: null,
          field: null,
        }),
      };
    },
  });
  const body = {
    policyVersion: f.state.revision,
    dialogueId: initial.dialogue.id,
    dialogueVersion: initial.dialogue.version,
    text,
  };
  return { ...f, initial, body, runtime, calls: () => calls };
}

for (const [text, expected] of [
  ['в два часа дня', '14:00'],
  ['два часа тридцать минут дня', '14:30'],
  ['в шестнадцать тридцать', '16:30'],
  ['на два часа тридцать минут', '14:30'],
  ['в половину третьего дня', '14:30'],
  ['без четверти три дня', '14:45'],
  ['в девять ноль пять', '09:05'],
])
  test('whole runtime handles spoken clock locally without saving: ' + text, async () => {
    const f = runtimeFixture(text, expected);
    assert.equal(f.initial.dialogue.step, 'time');
    const before = structuredClone(f.patients);
    const result = await f.runtime.run(f.c, f.body, f.state, f.member);
    assert.equal(f.calls(), 0, 'a fully understood spoken clock must not call the model');
    const current = f.flow.get(f.c, f.member, f.state, result.dialogue.id);
    assert.equal(current.data.time, expected);
    assert.equal(current.data.date, day);
    assert.equal(current.data.duration, 30);
    assert.equal(result.dialogue.step, 'review');
    assert.equal(result.action, null);
    assert.deepEqual(f.patients, before);
    assert.deepEqual(await f.runtime.run(f.c, f.body, f.state, f.member), result);
    assert.equal(f.calls(), 0);
  });

test('spoken clock optimization keeps revoked access and stale dialogue rejection', async () => {
  for (const revoke of [false, true]) {
    const f = runtimeFixture(),
      before = structuredClone(f.patients);
    if (revoke)
      f.c.assertCurrent = () => {
        throw Object.assign(Error('Synthetic revoked access'), { status: 403 });
      };
    else f.body.dialogueVersion++;
    await assert.rejects(f.runtime.run(f.c, f.body, f.state, f.member), {
      status: revoke ? 403 : 409,
    });
    assert.equal(f.calls(), 0);
    assert.deepEqual(f.patients, before);
  }
});
