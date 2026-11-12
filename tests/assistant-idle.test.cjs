const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function fixture() {
  let now = 0,
    id = 0;
  const tasks = new Map(),
    closed = [],
    document = { hidden: false };
  const source = fs.readFileSync(
    path.join(__dirname, '../src/client/modules/assistant-idle.js'),
    'utf8',
  );
  const factory = vm.runInNewContext(source + '\ncreateAssistantIdle', {
    document,
    setTimeout(fn, delay) {
      const value = ++id;
      tasks.set(value, { fn, due: now + delay });
      return value;
    },
    clearTimeout(value) {
      tasks.delete(value);
    },
  });
  const api = factory().assistantIdleTimer((owner) => closed.push(owner));
  const value = {
    active: true,
    voice: true,
    busy: false,
    recording: false,
    turnPending: false,
    owner: 1,
  };
  return {
    api,
    tasks,
    document,
    closed,
    value,
    advance(ms) {
      now += ms;
      for (const [key, task] of [...tasks])
        if (task.due <= now) {
          tasks.delete(key);
          task.fn();
        }
    },
  };
}
test('inactive assistant owns no timer; an idle voice picker returns after thirty seconds', () => {
  const f = fixture();
  assert.equal(f.tasks.size, 0);
  f.api.update(f.value);
  f.advance(29999);
  assert.deepEqual(f.closed, []);
  f.advance(1);
  assert.deepEqual(f.closed, [1]);
  assert.equal(f.tasks.size, 0);
});
test('listening, processing, saving turn or hidden page cancels idle expiry', () => {
  for (const blocked of [
    { active: false },
    { voice: false },
    { busy: true },
    { recording: true },
    { turnPending: true },
  ]) {
    const f = fixture();
    f.api.update(f.value);
    f.api.update({ ...f.value, ...blocked });
    f.advance(60000);
    assert.deepEqual(f.closed, []);
    assert.equal(f.tasks.size, 0);
  }
  const f = fixture();
  f.api.update(f.value);
  f.document.hidden = true;
  f.api.update(f.value);
  f.advance(60000);
  assert.deepEqual(f.closed, []);
});
test('old session expiry cannot close a newer dialog and repeated renders do not postpone inactivity forever', () => {
  const f = fixture();
  f.api.update(f.value);
  const old = [...f.tasks.values()][0].fn;
  f.advance(10000);
  f.api.update({ ...f.value, owner: 2 });
  old();
  assert.deepEqual(f.closed, []);
  for (let i = 0; i < 3; i++) {
    f.advance(9000);
    f.api.update({ ...f.value, owner: 2 });
  }
  assert.deepEqual(f.closed, []);
  f.advance(3000);
  assert.deepEqual(f.closed, [2]);
  f.api.stop();
  assert.equal(f.tasks.size, 0);
});

test('a draft, exact unknown retry, execute handoff or recoverable pause never expires as an empty idle session', () => {
  for (const protectedState of [
    { hasDialogue: true },
    { pendingTurn: true },
    { pendingHandoff: true },
    { recoverable: true },
  ]) {
    const f = fixture();
    f.api.update(f.value);
    const staleExpiry = [...f.tasks.values()][0].fn;
    f.api.update({ ...f.value, ...protectedState });
    f.advance(60000);
    staleExpiry();
    assert.deepEqual(f.closed, []);
    assert.equal(f.tasks.size, 0, 'paused state has no idle callback or microphone loop');
  }
});

test('only an explicitly cleared draft returns to the ordinary thirty second idle deadline', () => {
  const f = fixture();
  f.api.update({ ...f.value, hasDialogue: true, recoverable: true });
  f.advance(90000);
  assert.deepEqual(f.closed, []);
  f.api.update(f.value);
  f.advance(29999);
  assert.deepEqual(f.closed, []);
  f.advance(1);
  assert.deepEqual(f.closed, [1]);
});
