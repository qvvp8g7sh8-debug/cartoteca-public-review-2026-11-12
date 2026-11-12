const test = require('node:test'),
  assert = require('node:assert/strict');
const { fixture, flush, deferred } = require('./helpers/assistant-voice-booking-fixture.cjs');

test('first hold reuses its pending scope check and listens only after approval', async (t) => {
  const f = fixture(t);
  const scope = deferred();
  const request = f.actions.request;
  let scopeReads = 0;
  f.actions.request = (route, options) => {
    if (route !== '/api/assistant/scope') return request(route, options);
    scopeReads++;
    return scope.promise;
  };
  await f.hold();
  assert.equal(scopeReads, 1);
  assert.equal(f.captures.length, 0);
  scope.resolve(f.scope);
  await flush();
  assert.equal(f.captures.length, 1);
  assert.equal(scopeReads, 1);
});
async function paused(t) {
  const f = fixture(t);
  await f.hold();
  assert.equal(f.captures.length, 1);
  await f.captures[0].error(
    Object.assign(Error('Synthetic microphone interrupted'), {
      code: 'ASSISTANT_MICROPHONE_INTERRUPTED',
    }),
  );
  await flush();
  assert.equal(f.$('[data-assistant-session-resume]').hidden, false);
  assert.equal(f.$('[data-assistant-voice]').getAttribute('aria-pressed'), 'true');
  return f;
}
test('second calendar hold resumes recoverably paused voice session', async (t) => {
  const f = await paused(t);
  /* Clear only the fixture call log so its first-hold helper can drive a second real pointer hold. */ f.captures.length = 0;
  await f.hold();
  assert.equal(f.captures.length, 1, 'new capture expected after second completed600ms hold');
});
test('Continue does resume the same paused voice session', async (t) => {
  const f = await paused(t);
  f.$('[data-assistant-session-resume]').click();
  await flush();
  assert.equal(f.captures.length, 2);
});
test('explicit Stop then fresh calendar hold starts again', async (t) => {
  const f = await paused(t);
  f.$('[data-assistant-session-stop]').click();
  await flush();
  /* Clear only the fixture call log so its first-hold helper can drive a second real pointer hold. */ f.captures.length = 0;
  await f.hold();
  assert.equal(f.captures.length, 1);
});
