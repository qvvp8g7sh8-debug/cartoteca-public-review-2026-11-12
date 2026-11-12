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
const command = (revision, values) => ({
  expectedRevision: revision,
  requestId: randomUUID(),
  reason: 'Синтетическая локальная речь',
  ...values,
});
function wav(rate = 16000) {
  const bytes = Buffer.alloc(44 + Math.floor(rate / 10) * 2);
  bytes.write('RIFF');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(bytes.length - 44, 40);
  return { audioBase64: bytes.toString('base64'), mimeType: 'audio/wav' };
}
function fixtureApi(f, localSpeech, codex) {
  return createAssistant(
    { ...f.database, organizationTimeZone: f.store.organizationTimeZone },
    {
      directory: f.platformDirectory,
      localSpeech,
      codex: codex || {
        available: true,
        async run() {
          return { text: '{"intent":"calendar","date":"2099-01-05"}' };
        },
      },
      fetchImpl: () => assert.fail('No Timeweb fallback or network'),
    },
  );
}
function enable(f, api, limits = {}) {
  const view = api.admin.view(f.admin.accountId);
  const saved = api.admin.settings(
    f.admin.accountId,
    command(view.revision, {
      policy: { mode: 'selected', limits },
      providers: {
        stt: { provider: 'local' },
        tts: { provider: 'local' },
        llm: { provider: 'codex' },
      },
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
function context(f) {
  const current = f.store.session(f.ownerSession.token);
  return {
    current,
    platform: f.store,
    assertCurrent() {
      const fresh = f.store.session(f.ownerSession.token);
      if (!fresh || fresh.organizationId !== current.organizationId || fresh.role !== current.role)
        throw Object.assign(Error('Synthetic scope changed'), { status: 403 });
    },
    tenantStore() {
      assert.fail('No clinical read for voice');
    },
  };
}
test('local is STT/TTS only, model and voice switches round-trip and encrypted settings/history validate', () => {
  const state = initialState();
  patchSettings(state, {
    providers: {
      stt: { provider: 'local' },
      tts: { provider: 'local' },
      llm: { provider: 'codex' },
    },
    timewebApiKey: 'synthetic-retained-timeweb-key',
  });
  assert.deepEqual(state.providers.stt, { provider: 'local', model: 'whisper-base' });
  assert.deepEqual(state.providers.tts, {
    provider: 'local',
    model: 'system-ru',
    voice: 'ru-local',
  });
  assert.equal(state.providers.llm.provider, 'codex');
  state.history.push({
    revision: 0,
    time: Date.now(),
    policy: structuredClone(state.policy),
    providers: structuredClone(state.providers),
    rates: structuredClone(state.rates),
  });
  assert.equal(validateState(state), state);
  for (const providers of [
    { llm: { provider: 'local' } },
    { stt: { provider: 'local', model: 'whisper-base.en' } },
    { tts: { provider: 'local', voice: 'alloy' } },
    { tts: { provider: 'local', model: 'openai/gpt-4o-mini-tts' } },
  ])
    assert.throws(() => patchSettings(structuredClone(state), { providers }), { status: 400 });
  patchSettings(state, {
    providers: { stt: { provider: 'timeweb' }, tts: { provider: 'timeweb' } },
  });
  assert.equal(state.providers.stt.model, 'openai/gpt-4o-mini-transcribe');
  assert.deepEqual(state.providers.tts, {
    provider: 'timeweb',
    model: 'openai/gpt-4o-mini-tts',
    voice: 'alloy',
  });
  assert.equal(state.credentials.timeweb, 'synthetic-retained-timeweb-key');
  patchSettings(state, { providers: { stt: { provider: 'local' }, tts: { provider: 'local' } } });
  assert.equal(validateState(state), state);
});
test('local capability is distinct from demo and TTS remains ready without an installed whisper model', async (t) => {
  const f = await adminFixture(t);
  const api = fixtureApi(f, {
    available: true,
    sttAvailable: false,
    ttsAvailable: true,
    async run() {
      return { text: 'Синтетика', audioBase64: null, mimeType: null, local: true };
    },
  });
  const revision = enable(f, api);
  const scope = api.access(context(f).current);
  assert.deepEqual(scope.capabilities.stt, {
    demo: false,
    contextHints: true,
    availabilityTurn: true,
    ready: false,
    local: true,
  });
  assert.deepEqual(scope.capabilities.tts, { demo: false, ready: true, local: true });
  assert.equal(scope.capabilities.llm.ready, true);
  assert.equal(scope.ready, false);
  const status = api.admin.view(f.admin.accountId).providerStatus.local;
  assert.deepEqual(status, {
    available: true,
    localOnly: true,
    billing: 'local',
    stt: { available: false },
    tts: { available: true },
  });
  assert.equal(
    (await api.speak(context(f), { text: 'Ответ', policyVersion: revision })).local,
    true,
  );
  const unavailable = fixtureApi(f);
  assert.equal(unavailable.access(context(f).current).capabilities.tts.ready, false);
});
test('local STT, Codex command and browser TTS share the daily quota but never debit Timeweb rubles', async (t) => {
  const f = await adminFixture(t),
    calls = [];
  const api = fixtureApi(f, {
    available: true,
    sttAvailable: true,
    ttsAvailable: true,
    async run(options) {
      calls.push(options.kind);
      options.guard();
      options.onOutbound();
      return options.kind === 'stt'
        ? { text: 'Календарь', local: true }
        : { text: options.payload.input, audioBase64: null, mimeType: null, local: true };
    },
  });
  const revision = enable(f, api, { monthlyBudgetRub: 0, dailyRequests: 3 });
  const transcribed = await api.transcribe(context(f), { ...wav(), policyVersion: revision });
  assert.equal(transcribed.demo, false);
  assert.equal(transcribed.local, true);
  assert.deepEqual(transcribed.usage, {
    estimatedRub: 0,
    estimated: true,
    kind: 'stt',
    billing: 'local',
  });
  assert.equal(
    (await api.turn(context(f), { text: transcribed.text, policyVersion: revision })).action.type,
    'calendar',
  );
  const spoken = await api.speak(context(f), {
    text: 'Синтетический ответ',
    policyVersion: revision,
  });
  assert.equal(spoken.demo, false);
  assert.equal(spoken.local, true);
  assert.equal(spoken.audioBase64, null);
  assert.equal(spoken.mimeType, null);
  assert.equal(spoken.usage.billing, 'local');
  assert.equal(spoken.usage.estimatedRub, 0);
  assert.equal(api.admin.view(f.admin.accountId).usage.spentRub, 0);
  await assert.rejects(api.speak(context(f), { text: 'Ещё ответ', policyVersion: revision }), {
    status: 429,
  });
  assert.deepEqual(calls, ['stt', 'tts']);
});
test('unsupported sample rate is rejected before quota reservation and a valid subsequent local request still works', async (t) => {
  const f = await adminFixture(t);
  let calls = 0;
  const api = fixtureApi(f, {
    available: true,
    sttAvailable: true,
    ttsAvailable: true,
    async run() {
      calls++;
      return { text: 'Синтетика', local: true };
    },
  });
  const revision = enable(f, api, { dailyRequests: 1 });
  await assert.rejects(api.transcribe(context(f), { ...wav(44100), policyVersion: revision }), {
    status: 400,
  });
  assert.equal(calls, 0);
  assert.equal(
    (await api.transcribe(context(f), { ...wav(), policyVersion: revision })).text,
    'Синтетика',
  );
  assert.equal(calls, 1);
});
test('a local provider failure spends only a daily attempt and cannot fall back to configured Timeweb', async (t) => {
  const f = await adminFixture(t);
  let calls = 0;
  const api = fixtureApi(f, {
    available: true,
    sttAvailable: true,
    ttsAvailable: true,
    async run() {
      calls++;
      throw Object.assign(Error('Synthetic local failure'), { status: 504 });
    },
  });
  const revision = enable(f, api, { monthlyBudgetRub: 0, dailyRequests: 1 });
  await assert.rejects(api.transcribe(context(f), { ...wav(), policyVersion: revision }), {
    status: 504,
  });
  await assert.rejects(api.transcribe(context(f), { ...wav(), policyVersion: revision }), {
    status: 429,
  });
  assert.equal(calls, 1);
  assert.equal(api.admin.view(f.admin.accountId).usage.spentRub, 0);
  assert.equal(api.admin.view(f.admin.accountId).credentialStatus.timeweb.configured, true);
});
