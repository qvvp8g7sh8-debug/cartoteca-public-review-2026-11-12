const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { adminFixture } = require('./helpers/admin-fixture.cjs');
const { createAssistant } = require('../src/server/modules/assistant/service.cjs');
const {
  initialState,
  patchSettings,
  validateState,
} = require('../src/server/modules/assistant/access/defaults.cjs');

function command(revision, values = {}) {
  return {
    expectedRevision: revision,
    requestId: randomUUID(),
    reason: 'Синтетический Codex-провайдер',
    ...values,
  };
}
function actor(f) {
  return f.store.session(f.ownerSession.token);
}
function context(f) {
  const current = actor(f);
  return {
    current,
    platform: f.store,
    assertCurrent() {
      const fresh = actor(f);
      if (!fresh || fresh.organizationId !== current.organizationId || fresh.role !== current.role)
        throw Object.assign(Error('Synthetic scope changed'), { status: 403 });
    },
    tenantStore() {
      throw Error('Unexpected clinical read');
    },
  };
}
function assistant(
  f,
  codex,
  fetchImpl = async () => {
    throw Error('Unexpected Timeweb fallback');
  },
) {
  return createAssistant(
    { ...f.database, organizationTimeZone: f.store.organizationTimeZone },
    {
      directory: f.platformDirectory,
      codex,
      fetchImpl,
    },
  );
}
function enable(f, api, limits = {}) {
  const view = api.admin.view(f.admin.accountId);
  const saved = api.admin.settings(
    f.admin.accountId,
    command(view.revision, {
      policy: { mode: 'selected', limits },
      providers: { llm: { provider: 'codex' } },
      timewebApiKey: 'synthetic-retained-timeweb-key',
    }),
  );
  return api.admin.setMember(
    f.admin.accountId,
    command(saved.revision, {
      organizationId: f.owner.organizationId,
      accountId: f.owner.accountId,
      enabled: true,
    }),
  ).revision;
}

test('Codex is LLM-only and changing LLM preserves independent voice providers and Timeweb key', () => {
  const state = initialState();
  assert.equal(state.policy.mode, 'off');
  assert.deepEqual(state.grants, []);
  patchSettings(state, {
    providers: {
      stt: { provider: 'timeweb' },
      llm: { provider: 'timeweb' },
      tts: { provider: 'timeweb' },
    },
    timewebApiKey: 'synthetic-retained-timeweb-key',
  });
  const voice = structuredClone({ stt: state.providers.stt, tts: state.providers.tts });
  patchSettings(state, { providers: { llm: { provider: 'codex' } } });
  assert.deepEqual(state.providers.llm, { provider: 'codex', model: 'codex-default' });
  assert.deepEqual({ stt: state.providers.stt, tts: state.providers.tts }, voice);
  assert.equal(state.credentials.timeweb, 'synthetic-retained-timeweb-key');
  assert.equal(validateState(state), state);
  for (const kind of ['stt', 'tts'])
    assert.throws(
      () =>
        patchSettings(structuredClone(state), {
          providers: { [kind]: { provider: 'codex' } },
        }),
      { status: 400 },
    );
  patchSettings(state, { providers: { llm: { provider: 'timeweb', model: 'codex-default' } } });
  assert.equal(state.providers.llm.model, 'deepseek/deepseek-flash');
  patchSettings(state, { providers: { llm: { provider: 'codex' } } });
  patchSettings(state, {
    providers: { llm: { provider: 'timeweb', model: 'vendor/explicit-model' } },
  });
  assert.equal(state.providers.llm.model, 'vendor/explicit-model');
});

test('Codex readiness is runtime-only and independent of the retained Timeweb credential', async (t) => {
  const f = await adminFixture(t);
  const unavailable = assistant(f);
  enable(f, unavailable);
  assert.equal(unavailable.access(actor(f)).capabilities.llm.ready, false);
  assert.deepEqual(unavailable.admin.view(f.admin.accountId).providerStatus.codex, {
    available: false,
    localOnly: true,
    billing: 'codex-subscription',
  });
  assert.equal(unavailable.admin.view(f.admin.accountId).credentialStatus.timeweb.configured, true);
  const available = assistant(f, {
    available: true,
    async run() {
      throw Error('Must not run on read');
    },
  });
  assert.equal(available.access(actor(f)).ready, true);
  assert.equal(available.access(actor(f)).capabilities.stt.demo, true);
  assert.equal(available.admin.view(f.admin.accountId).providerStatus.codex.available, true);
  f.reopen();
  assert.equal(f.store.assistant.admin.view(f.admin.accountId).providers.llm.provider, 'codex');
  assert.equal(f.store.assistant.access(actor(f)).capabilities.llm.ready, false);
});

test('Codex returns a validated calendar action with subscription billing and no Timeweb ruble charge', async (t) => {
  const f = await adminFixture(t);
  let calls = 0,
    received;
  const api = assistant(f, {
    available: true,
    async run(options) {
      received = options;
      calls++;
      options.guard();
      options.onOutbound();
      return {
        text: '{"intent":"calendar","date":"2026-10-16"}',
        usage: { input_tokens: 9000000, output_tokens: 900000 },
      };
    },
  });
  const revision = enable(f, api, { monthlyBudgetRub: 0, dailyRequests: 1 });
  const result = await api.turn(context(f), { text: 'Календарь', policyVersion: revision });
  assert.equal(calls, 1);
  assert.equal(received.provider.model, 'codex-default');
  assert.equal(received.payload.messages.at(-1).content, 'Календарь');
  assert.equal(received.timeoutMs, 20000);
  assert.equal(result.action.type, 'calendar');
  assert.equal(result.action.date, '2026-10-16');
  assert.equal(result.demo, false);
  assert.deepEqual(result.usage, {
    estimatedRub: 0,
    estimated: true,
    kind: 'llm',
    billing: 'codex-subscription',
  });
  assert.equal(api.admin.view(f.admin.accountId).usage.spentRub, 0);
  await assert.rejects(api.turn(context(f), { text: 'Календарь', policyVersion: revision }), {
    status: 429,
  });
  assert.equal(calls, 1);
});

test('unavailable Codex rejects before dispatch and never falls back to Timeweb', async (t) => {
  const f = await adminFixture(t);
  let codexCalls = 0,
    timewebCalls = 0;
  const api = assistant(
    f,
    {
      available: false,
      async run() {
        codexCalls++;
      },
    },
    async () => {
      timewebCalls++;
    },
  );
  const revision = enable(f, api);
  await assert.rejects(api.turn(context(f), { text: 'Календарь', policyVersion: revision }), {
    status: 503,
  });
  assert.equal(codexCalls, 0);
  assert.equal(timewebCalls, 0);
  assert.equal(api.admin.view(f.admin.accountId).usage.spentRub, 0);
});

test('failed Codex call uses the daily limit but never creates an estimated Timeweb charge or fallback', async (t) => {
  const f = await adminFixture(t);
  let calls = 0;
  const api = assistant(f, {
    available: true,
    async run({ onOutbound }) {
      calls++;
      onOutbound();
      throw Object.assign(Error('Synthetic Codex unavailable'), { status: 502 });
    },
  });
  const revision = enable(f, api, { dailyRequests: 1 });
  await assert.rejects(api.turn(context(f), { text: 'Календарь', policyVersion: revision }), {
    status: 502,
  });
  await assert.rejects(api.turn(context(f), { text: 'Календарь', policyVersion: revision }), {
    status: 429,
  });
  assert.equal(calls, 1);
  assert.equal(api.admin.view(f.admin.accountId).usage.spentRub, 0);
  assert.equal(api.admin.view(f.admin.accountId).usage.reservedRub, 0);
});

test('Codex result is discarded after access is revoked while its request is pending', async (t) => {
  const f = await adminFixture(t);
  let release;
  let started;
  const dispatched = new Promise((resolve) => { started = resolve; });
  const api = assistant(f, {
    available: true,
    async run({ onOutbound }) {
      onOutbound();
      await new Promise((resolve) => {
        release = resolve;
        started();
      });
      return { text: '{"intent":"calendar"}' };
    },
  });
  const revision = enable(f, api);
  const pending = api.turn(context(f), { text: 'Календарь', policyVersion: revision });
  await dispatched;
  assert.equal(typeof release, 'function');
  api.admin.settings(f.admin.accountId, command(revision, { policy: { mode: 'off' } }));
  release();
  await assert.rejects(pending, { status: 403 });
  assert.equal(api.admin.view(f.admin.accountId).usage.spentRub, 0);
});

test('Codex cannot add arbitrary actions or bypass a disabled command', async (t) => {
  const f = await adminFixture(t);
  let output = '{"intent":"deleteEverything"}';
  const api = assistant(f, {
    available: true,
    async run() {
      return { text: output };
    },
  });
  let revision = enable(f, api);
  await assert.rejects(api.turn(context(f), { text: 'Команда', policyVersion: revision }), {
    status: 502,
  });
  output = '{"intent":"calendar","patientId":"invented"}';
  await assert.rejects(api.turn(context(f), { text: 'Команда', policyVersion: revision }), {
    status: 502,
  });
  revision = api.admin.settings(
    f.admin.accountId,
    command(revision, {
      policy: { commands: { calendar: false } },
    }),
  ).revision;
  output = '{"intent":"calendar"}';
  await assert.rejects(api.turn(context(f), { text: 'Команда', policyVersion: revision }), {
    status: 403,
  });
});
