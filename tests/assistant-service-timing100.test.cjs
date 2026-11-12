const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createRequestMetrics } = require('../src/server/infrastructure/request-metrics.cjs');
const {
  availabilityFixture,
  day,
} = require('./helpers/assistant-availability-native-fixture99.cjs');
const {
  intentEnvelope,
} = require('../src/server/modules/assistant/interpretation/intent-contract.cjs');
function sample(metrics, c) {
  const res = Object.assign(new EventEmitter(), {
    setHeader() {},
    statusCode: 200,
    writableFinished: true,
  });
  return { ...c, assistantTiming: metrics.track({}, res).assistant };
}
test('real local/model service paths preserve domain DTOs, counts, budgets and writes with observation enabled', async (t) => {
  const f = await availabilityFixture(t);
  const metrics = createRequestMetrics({ enabled: true, intervalMs: 0 });
  t.after(() => metrics.close());
  f.settings({ policy: { commands: { prepareAppointment: false } } });
  const before = f.readState(),
    clinical = f.clinic.read();
  const localBody = {
    text: 'Найди свободные окна на ' + day + ' на 30 минут',
    policyVersion: f.revision(),
  };
  const observed = await f.api.turn(sample(metrics, f.context()), localBody);
  const plain = await f.api.turn(f.context(), localBody);
  assert.deepEqual(observed, plain);
  assert.deepEqual(f.readState(), before);
  assert.deepEqual(f.clinic.read(), clinical);
  assert.deepEqual(f.calls, { llm: 0, stt: 0, tts: 0 });
  assert.deepEqual(
    metrics
      .snapshot()
      .assistantPhases.filter(({ stage }) => stage !== 'access')
      .map(({ stage, kind, provider, outcome, count }) => ({
        stage,
        kind,
        provider,
        outcome,
        count,
      })),
    [
      { stage: 'interpretation', kind: 'turn', provider: 'none', outcome: 'completed', count: 1 },
      { stage: 'domain', kind: 'turn', provider: 'none', outcome: 'completed', count: 1 },
    ],
  );
  const access = metrics.snapshot().assistantPhases.find(({ stage }) => stage === 'access');
  assert.ok(access.count > 0);
  assert.equal(access.outcome, 'completed');
  metrics.snapshot({ reset: true });
  f.hooks.llm = () => ({
    text: JSON.stringify(
      intentEnvelope({
        intent: 'availability',
        date: day,
        endDate: day,
        duration: 30,
      }),
    ),
  });
  const modelBody = {
    text: 'Свободное время на ' + day + ' на 30 минут',
    policyVersion: f.revision(),
  };
  const model = await f.api.turn(sample(metrics, f.context()), modelBody);
  const { usage, ...domain } = model;
  assert.deepEqual(domain, observed);
  assert.equal(usage.billing, 'codex-subscription');
  assert.equal(f.calls.llm, 1);
  const rows = metrics.snapshot().assistantPhases;
  for (const stage of [
    'admission',
    'provider-prepare',
    'outbound-mark',
    'provider-complete',
    'settlement',
  ])
    assert.equal(
      rows.find((row) => row.stage === stage && row.provider === 'codex')?.count,
      1,
      stage,
    );
  assert.equal(rows.filter((row) => row.stage === 'interpretation').length, 2);
  assert.ok(rows.every((row) => row.outcome === 'completed'));
  assert.deepEqual(f.clinic.read(), clinical);
  assert.deepEqual(f.api.runtimeStats().turns, {
    localCalendar: 0,
    localAvailability: 2,
    localClients: 0,
    localClientCard: 0,
    localPrepareAppointment: 0,
    localHelp: 0,
    model: 1,
  });
  assert.doesNotMatch(
    JSON.stringify(rows),
    /synthetic|2099|accountId|organizationId|sessionId|text|token/,
  );
});
test('observer failures do not bypass fresh native ACL or turn malformed model content into a completed interpretation', async (t) => {
  const f = await availabilityFixture(t),
    metrics = createRequestMetrics({ enabled: true, intervalMs: 0 });
  t.after(() => metrics.close());
  f.hooks.llm = () => ({ text: 'private invalid model content' });
  const c = sample(metrics, f.context());
  await assert.rejects(f.api.turn(c, { text: 'Свободное время', policyVersion: f.revision() }), {
    status: 502,
  });
  const rows = metrics.snapshot().assistantPhases;
  assert.equal(rows.find((row) => row.stage === 'provider-complete').outcome, 'completed');
  assert.equal(rows.find((row) => row.stage === 'settlement').outcome, 'completed');
  assert.equal(
    rows.find((row) => row.stage === 'interpretation' && row.provider === 'codex').outcome,
    'failed',
  );
  assert.ok(!rows.some((row) => row.stage === 'domain'));
  f.grant('owner', false);
  await assert.rejects(
    f.api.turn(
      {
        ...f.context(),
        assistantTiming: {
          begin() {
            throw Error('Sink outage');
          },
        },
      },
      { text: 'Найди свободные окна на ' + day + ' на 30 минут', policyVersion: f.revision() },
    ),
    { status: 403 },
  );
  assert.equal(f.calls.llm, 1);
});
