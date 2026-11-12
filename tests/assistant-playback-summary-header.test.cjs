const test = require('node:test'),
  assert = require('node:assert/strict');
const { fixture, reply, flush } = require('./helpers/assistant-voice-booking-fixture.cjs');
const tuple = () => [1, 0, 1, 1, 1, 250, 2, 1, 280, 1, 1, 5, 80, 25, 4, 0, 0, 0, 0, 0];
const tupleV2 = (format = 2) => [2, ...tuple().slice(1), format, 126, 201, 301];
async function send(f) {
  await f.keyboard();
  f.$('[data-assistant-text]').value = 'Синтетическая команда';
  f.$('[data-assistant-send]').click();
  await flush();
}
test('one valid previous playback tuple piggybacks only on existing turn headers, never JSON', async (t) => {
  const f = fixture(t);
  let calls = 0;
  f.actions.takeAssistantPlaybackSummary = () => {
    calls++;
    return calls === 1 ? tuple() : null;
  };
  await send(f);
  const turn = f.turns()[0];
  assert.equal(turn.options.headers['X-Assistant-Audio-Summary'], tuple().join(','));
  assert.equal(Object.hasOwn(turn.body, 'playback'), false);
  assert.equal(f.calls.filter((c) => c.options.headers?.['X-Assistant-Audio-Summary']).length, 1);
  assert.equal(calls, 1);
});
test('unknown-outcome retry keeps byte-exact original header without consuming a newer summary', async (t) => {
  const f = fixture(t, { scope: { billing: { paid: true } } });
  let taken = 0,
    attempt = 0;
  f.actions.takeAssistantPlaybackSummary = () => {
    taken++;
    return tuple();
  };
  f.control.turn = async () => {
    if (++attempt === 1)
      throw Object.assign(Error('Synthetic outcome unknown'), { outcomeUnknown: true });
    return reply(1);
  };
  await send(f);
  assert.equal(f.$('[data-assistant-retry]').hidden, false);
  f.$('[data-assistant-retry]').click();
  await flush();
  assert.equal(f.turns().length, 2);
  assert.equal(
    f.turns()[0].options.headers['X-Assistant-Audio-Summary'],
    f.turns()[1].options.headers['X-Assistant-Audio-Summary'],
  );
  assert.equal(JSON.stringify(f.turns()[0].body), JSON.stringify(f.turns()[1].body));
  assert.equal(taken, 1);
});
test('cross-format v2 summary keeps its offsets on an unknown-outcome retry, with no new request', async (t) => {
  const f = fixture(t, { scope: { billing: { paid: true } } });
  let taken = 0,
    attempt = 0;
  f.actions.takeAssistantPlaybackSummary = () => {
    taken++;
    return tupleV2();
  };
  f.control.turn = async () => {
    if (++attempt === 1)
      throw Object.assign(Error('Synthetic outcome unknown'), { outcomeUnknown: true });
    return reply(1);
  };
  await send(f);
  f.$('[data-assistant-retry]').click();
  await flush();
  assert.equal(f.turns().length, 2);
  for (const turn of f.turns())
    assert.equal(turn.options.headers['X-Assistant-Audio-Summary'], tupleV2().join(','));
  assert.equal(taken, 1);
  assert.equal(f.calls.filter((c) => c.options.headers?.['X-Assistant-Audio-Summary']).length, 2);
  assert.equal(Object.hasOwn(f.turns()[0].body, 'playback'), false);
});
for (const format of [1, 2, 3])
  test(
    'v2 fixed format ' + format + ' and maximum absent/zero/capped offsets are accepted',
    async (t) => {
      const f = fixture(t);
      const values = [...tupleV2(format).slice(0, 21), 0, 1, 150001];
      f.actions.takeAssistantPlaybackSummary = () => values;
      await send(f);
      assert.equal(f.turns()[0].options.headers['X-Assistant-Audio-Summary'], values.join(','));
    },
  );
for (const [name, modify] of [
  ['count overflow', (a) => (a[3] = 101)],
  ['negative', (a) => (a[6] = -1)],
  ['float', (a) => (a[5] = 0.5)],
  ['extra', (a) => a.push(0)],
  ['version', (a) => (a[0] = 2)],
  ['time overflow', (a) => (a[12] = 150001)],
  ['non-numeric', (a) => (a[8] = '280')],
])
  test('invalid ' + name + ' summary is omitted', async (t) => {
    const f = fixture(t);
    f.actions.takeAssistantPlaybackSummary = () => {
      const a = tuple();
      modify(a);
      return a;
    };
    await send(f);
    assert.equal(f.turns()[0].options.headers?.['X-Assistant-Audio-Summary'], undefined);
  });
for (const [name, modify] of [
  ['unknown format', (a) => (a[20] = 0)],
  ['format overflow', (a) => (a[20] = 4)],
  ['offset overflow', (a) => (a[21] = 150002)],
  ['negative offset', (a) => (a[22] = -1)],
  ['floating offset', (a) => (a[23] = 1.5)],
  ['truncated v2', (a) => a.pop()],
  ['extended v2', (a) => a.push(0)],
  ['unknown version', (a) => (a[0] = 3)],
  ['v1 with v2 fields', (a) => (a[0] = 1)],
])
  test('invalid v2 ' + name + ' summary is omitted without blocking the turn', async (t) => {
    const f = fixture(t);
    f.actions.takeAssistantPlaybackSummary = () => {
      const values = tupleV2();
      modify(values);
      return values;
    };
    await send(f);
    assert.equal(f.turns().length, 1);
    assert.equal(f.turns()[0].options.headers?.['X-Assistant-Audio-Summary'], undefined);
  });
