const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createRequestMetrics } = require('../src/server/infrastructure/request-metrics.cjs');
const { noAssistantTiming } = require('../src/server/infrastructure/assistant-timing.cjs');
function response() {
  return Object.assign(new EventEmitter(), {
    setHeader() {},
    statusCode: 200,
    writableFinished: false,
  });
}
function timers(t) {
  const timeouts = new Map(),
    intervals = new Map();
  let sequence = 0,
    unrefs = 0;
  const schedule = (target) => (callback, delay) => {
    const handle = {
      id: ++sequence,
      unref() {
        unrefs++;
      },
    };
    target.set(handle, { callback, delay });
    return handle;
  };
  t.mock.method(global, 'setTimeout', schedule(timeouts));
  t.mock.method(global, 'clearTimeout', (handle) => timeouts.delete(handle));
  t.mock.method(global, 'setInterval', schedule(intervals));
  t.mock.method(global, 'clearInterval', (handle) => intervals.delete(handle));
  return {
    timeouts,
    intervals,
    unrefs: () => unrefs,
    fire() {
      const [handle, item] = timeouts.entries().next().value;
      timeouts.delete(handle);
      item.callback();
    },
  };
}
test('assistant observation remains library-default OFF and unrelated requests share the disabled observer', (t) => {
  const timer = timers(t);
  const metrics = createRequestMetrics({
    assistantNow() {
      assert.fail('disabled clock');
    },
  });
  t.after(() => metrics.close());
  const a = metrics.track({ method: 'POST', url: '/api/assistant/turn?private' }, response());
  const b = metrics.track({ method: 'GET', url: '/api/calendar?private' }, response());
  assert.equal(a, b);
  assert.equal(a.assistant, noAssistantTiming);
  assert.equal(timer.timeouts.size + timer.intervals.size, 0);
});
test('assistant-only mode observes only four registered method/path combinations without HTTP maps or response listeners', (t) => {
  const timer = timers(t);
  let clock = 0,
    reads = 0;
  const metrics = createRequestMetrics({
    enabled: false,
    assistantEnabled: true,
    assistantNow: () => {
      reads++;
      return clock;
    },
  });
  t.after(() => metrics.close());
  const allowed = [
    ['POST', '/api/assistant/turn'],
    ['POST', '/api/assistant/transcribe'],
    ['POST', '/api/assistant/speak'],
    ['GET', '/api/assistant/speak-audio?ticket=private&accountContext=private'],
  ];
  for (const [method, url] of allowed) {
    const res = response(),
      m = metrics.track({ method, url, headers: { cookie: 'private-cookie' } }, res);
    assert.notEqual(m.assistant, noAssistantTiming);
    assert.equal(res.listenerCount('finish') + res.listenerCount('close'), 0);
    m.route('private-route');
    m.phase('save-write', 100);
    m.failure(Error('private'), 503);
    const end = m.assistant.begin('domain', 'turn', 'none');
    clock += 7;
    end();
  }
  const before = reads;
  for (const [method, url] of [
    ['GET', '/api/assistant/turn'],
    ['POST', '/api/assistant/speak-audio'],
    ['GET', '/api/admin/system'],
    ['POST', '/api/assistant/turn-more'],
    ['POST', '/api/assistant/turn/private'],
    ['POST', '/api/assistant/scope'],
  ])
    assert.equal(metrics.track({ method, url }, response()).assistant, noAssistantTiming);
  assert.equal(reads, before, 'unrelated requests never start a timing observer');
  assert.equal(timer.intervals.size, 0);
  const snapshot = metrics.assistantSnapshot();
  assert.deepEqual(Object.keys(snapshot), ['event', 'assistantPhases']);
  assert.equal(snapshot.assistantPhases.length, 1);
  assert.equal(snapshot.assistantPhases[0].count, 4);
  assert.equal(snapshot.assistantPhases[0].totalMs, 28);
  const full = metrics.snapshot();
  assert.equal(full.routes.length + full.phases.length + full.failures.length, 0);
  assert.equal(full.active + full.peak, 0);
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    /private|cookie|ticket|accountContext|routes|pid|rss/,
  );
});
test('first actual phase arms one unref sixty-second timeout; phase-only emission has no probes or idle reschedule', (t) => {
  const timer = timers(t),
    emitted = [];
  let clock = 0,
    resourceCalls = 0;
  const metrics = createRequestMetrics({
    assistantEnabled: true,
    emit: (raw) => emitted.push(JSON.parse(raw)),
    assistantNow: () => clock,
    resourceStats() {
      resourceCalls++;
      throw Error('No probes');
    },
  });
  t.after(() => metrics.close());
  const m = metrics.track({ method: 'POST', url: '/api/assistant/speak' }, response());
  assert.equal(timer.timeouts.size, 0, 'an observer or a begin is not recorded data');
  const first = m.assistant.begin('provider-headers', 'tts', 'timeweb');
  assert.equal(timer.timeouts.size, 0);
  clock = 12;
  first();
  first();
  assert.equal(timer.timeouts.size, 1);
  assert.equal([...timer.timeouts.values()][0].delay, 60000);
  assert.equal(timer.unrefs(), 1);
  const second = m.assistant.begin('provider-first-byte', 'tts', 'timeweb');
  clock = 20;
  second();
  assert.equal(timer.timeouts.size, 1);
  const memory = t.mock.method(process, 'memoryUsage', () => assert.fail('No memory probe'));
  const cpu = t.mock.method(process, 'cpuUsage', () => assert.fail('No CPU probe'));
  assert.doesNotThrow(() => timer.fire());
  assert.equal(resourceCalls, 0);
  assert.equal(
    timer.timeouts.size + timer.intervals.size,
    0,
    'empty periods schedule no further work',
  );
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].event, 'assistant_metrics');
  assert.equal(emitted[0].assistantPhases.length, 2);
  assert.equal(metrics.assistantSnapshot().assistantPhases.length, 0);
  memory.mock.restore();
  cpu.mock.restore();
  const third = m.assistant.begin('domain', 'turn', 'none');
  clock += 2;
  third();
  assert.equal(timer.timeouts.size, 1, 'a later real phase starts a new bounded window');
});
test('reset and close cancel the flush; late cancelled operations cannot revive a closed collector', (t) => {
  const timer = timers(t);
  let clock = 0;
  const metrics = createRequestMetrics({ assistantEnabled: true, assistantNow: () => clock });
  const m = metrics.track({ method: 'POST', url: '/api/assistant/transcribe' }, response());
  const one = m.assistant.begin('provider-complete', 'stt', 'timeweb');
  clock = 8;
  one('cancelled');
  assert.equal(metrics.assistantSnapshot({ reset: true }).assistantPhases[0].outcome, 'cancelled');
  assert.equal(timer.timeouts.size, 0);
  const late = m.assistant.begin('settlement', 'stt', 'timeweb');
  const two = m.assistant.begin('admission', 'stt', 'timeweb');
  clock = 9;
  two();
  assert.equal(timer.timeouts.size, 1);
  metrics.close();
  clock = 40;
  late('cancelled');
  assert.equal(timer.timeouts.size + timer.intervals.size, 0);
  assert.deepEqual(metrics.assistantSnapshot().assistantPhases, []);
  assert.equal(
    metrics.track({ method: 'POST', url: '/api/assistant/turn' }, response()).assistant,
    noAssistantTiming,
  );
});
test('unknown labels and observer/sink failures never change a provider result or repeat work', async (t) => {
  const timer = timers(t);
  let clock = 0,
    calls = 0;
  const metrics = createRequestMetrics({
    assistantEnabled: true,
    assistantNow: () => clock,
    emit() {
      throw Error('private-sink');
    },
  });
  t.after(() => metrics.close());
  const m = metrics.track({ method: 'POST', url: '/api/assistant/turn' }, response());
  for (let i = 0; i < 1000; i++)
    m.assistant.begin('private-stage-' + i, 'turn', 'private-provider')();
  assert.equal(timer.timeouts.size, 0);
  const end = m.assistant.begin('interpretation', 'turn', 'none');
  const result = await Promise.resolve().then(() => {
    calls++;
    return 42;
  });
  clock = 4;
  end();
  assert.doesNotThrow(() => timer.fire());
  assert.equal(result, 42);
  assert.equal(calls, 1);
  const broken = createRequestMetrics({
    assistantEnabled: true,
    assistantNow() {
      throw Error('private-clock');
    },
  });
  t.after(() => broken.close());
  assert.equal(
    broken.track({ method: 'POST', url: '/api/assistant/turn' }, response()).assistant,
    noAssistantTiming,
  );
});
test('global metrics reuse their original interval and emit assistant phases exactly once without an extra timeout', (t) => {
  const timer = timers(t),
    emitted = [];
  let clock = 0;
  const metrics = createRequestMetrics({
    enabled: true,
    assistantEnabled: true,
    assistantNow: () => clock,
    emit: (raw) => emitted.push(JSON.parse(raw)),
  });
  t.after(() => metrics.close());
  const res = response(),
    m = metrics.track({ method: 'POST', url: '/api/assistant/turn' }, res);
  m.route('assistant.turn');
  const end = m.assistant.begin('domain', 'turn', 'none');
  clock = 8;
  end();
  res.emit('finish');
  assert.equal(timer.timeouts.size, 0);
  assert.equal(timer.intervals.size, 1);
  [...timer.intervals.values()][0].callback();
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].event, 'request_metrics');
  assert.equal(emitted[0].assistantPhases[0].count, 1);
  [...timer.intervals.values()][0].callback();
  assert.equal(emitted[1].assistantPhases.length, 0);
});

test('explicitly disabled assistant timing preserves all ordinary HTTP metrics when global metrics are enabled', (t) => {
  const timer = timers(t);
  const metrics = createRequestMetrics({
    enabled: true,
    assistantEnabled: false,
    assistantNow() {
      assert.fail('Assistant observer is disabled');
    },
  });
  t.after(() => metrics.close());
  const res = response();
  const m = metrics.track({ method: 'POST', url: '/api/assistant/turn' }, res);
  assert.equal(m.assistant, noAssistantTiming);
  m.route('assistant.turn');
  m.assistant.begin('domain', 'turn', 'none')();
  res.writableFinished = true;
  res.emit('finish');
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.routes.length, 1);
  assert.equal(snapshot.routes[0].route, 'assistant.turn');
  assert.equal(snapshot.routes[0].count, 1);
  assert.equal(snapshot.active, 0);
  assert.equal(snapshot.peak, 1);
  assert.deepEqual(snapshot.assistantPhases, []);
  assert.equal(timer.intervals.size, 1);
  assert.equal(timer.timeouts.size, 0);
});
