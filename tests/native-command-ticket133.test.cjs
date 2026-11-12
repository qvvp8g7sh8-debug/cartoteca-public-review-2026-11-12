const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  createCommandTicketState,
} = require('../src/server/infrastructure/native-command-ticket.cjs');
test('canceling an unstarted private ticket disarms late HTTP before any handler can begin', () => {
  const finished = [],
    state = createCommandTicketState((ticket) => finished.push(ticket)),
    ticket = randomUUID();
  assert.equal(state.reserve(ticket), true);
  state.cancel(ticket);
  assert.deepEqual(finished, [ticket]);
  assert.equal(state.begin(ticket), null);
  const next = randomUUID();
  assert.equal(state.reserve(next), true);
  assert.equal(state.begin(ticket), null, 'a stale ticket cannot consume a later reservation');
  state.cancel(next);
});
test('cancel and duplicate HTTP cannot release an executing handler; only its actual finally can complete once', () => {
  const finished = [],
    state = createCommandTicketState((ticket) => finished.push(ticket)),
    ticket = randomUUID();
  assert.equal(state.reserve('malformed'), false);
  assert.equal(state.reserve(ticket), true);
  assert.equal(state.reserve(randomUUID()), false);
  assert.equal(state.begin(randomUUID()), null);
  const complete = state.begin(ticket);
  assert.equal(typeof complete, 'function');
  assert.equal(state.begin(ticket), null);
  state.cancel(ticket);
  assert.deepEqual(finished, []);
  assert.equal(state.reserve(randomUUID()), false);
  complete();
  complete();
  assert.deepEqual(finished, [ticket]);
  const next = randomUUID();
  assert.equal(state.reserve(next), true);
  state.cancel(next);
});
