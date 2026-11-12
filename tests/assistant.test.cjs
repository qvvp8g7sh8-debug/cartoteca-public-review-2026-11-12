const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { adminFixture } = require('./helpers/admin-fixture.cjs');
const { createAssistant } = require('../src/server/modules/assistant/service.cjs');
const { callTimeweb } = require('../src/server/modules/assistant/providers/timeweb/timeweb.cjs');
const { wavAudio, providerWavDuration } = require('../src/server/modules/assistant/speech/audio.cjs');
const { normalizeIntent } = require('../src/server/modules/assistant/interpretation/intents.cjs');
const { validateState } = require('../src/server/modules/assistant/access/defaults.cjs');

function command(revision, values = {}) {
  return { expectedRevision: revision, requestId: randomUUID(), reason: 'Синтетическая настройка пилота', ...values };
}
function current(f) { return f.store.session(f.ownerSession.token); }
function enable(f, providers) {
  const assistant = f.store.assistant, actor = f.admin.accountId;
  const view = assistant.admin.view(actor);
  const updated = assistant.admin.settings(actor, command(view.revision, {
    policy: { mode: 'selected' }, ...(providers ? { providers,
      timewebApiKey: 'synthetic-provider-secret-2026' } : {}) }));
  return assistant.admin.setMember(actor, command(updated.revision, {
    organizationId: f.owner.organizationId, accountId: f.owner.accountId, enabled: true }));
}
function c(f, actor = current(f)) {
  return { current: actor, platform: f.store,
    assertCurrent() {
      const fresh = f.store.session(f.ownerSession.token);
      if (!fresh || fresh.role !== actor.role || fresh.organizationId !== actor.organizationId)
        throw Object.assign(Error('Synthetic scope changed'), { status: 403 });
    },
    tenantStore() { throw Error('Unexpected clinical read'); } };
}
function wav(seconds = 1) {
  const dataSize = Math.round(seconds * 16000) * 2;
  const bytes = Buffer.alloc(44 + dataSize);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36);
  bytes.writeUInt32LE(dataSize, 40); return bytes;
}

test('assistant is default off, creates no state on read, and adds no identity lookup while off', async (t) => {
  const f = await adminFixture(t);
  assert.equal(f.store.assistant.access(current(f)).enabled, false);
  assert.equal(fs.existsSync(path.join(f.platformDirectory, 'assistant-state.enc')), false);
  const admin = f.store.session(f.adminSession.token);
  assert.equal(f.store.assistant.access(admin).enabled, false);
});

test('only global operator changes encrypted settings; keys and clinical data stay out of metadata', async (t) => {
  const f = await adminFixture(t), api = f.store.assistant.admin;
  const body = command(0, { timewebApiKey: 'synthetic-provider-secret-2026' });
  assert.throws(() => api.settings(f.owner.accountId, body), { status: 403 });
  const value = api.settings(f.admin.accountId, body);
  assert.equal(value.credentialStatus.timeweb.configured, true);
  assert.doesNotMatch(JSON.stringify(value), /synthetic-provider-secret|patients|allergies|visits/);
  assert.doesNotMatch(fs.readFileSync(path.join(f.platformDirectory, 'assistant-state.enc')).toString(),
    /synthetic-provider-secret/);
  assert.equal(api.settings(f.admin.accountId, body).revision, 1);
  assert.throws(() => api.settings(f.admin.accountId, { ...body, policy: { mode: 'selected' } }), { status: 409 });
});

test('pilot grant binds one active membership and does not follow same account into another organization', async (t) => {
  const f = await adminFixture(t); enable(f);
  assert.equal(f.store.assistant.access(current(f)).enabled, true);
  f.database.db.prepare('INSERT INTO memberships VALUES(?,?,?,?,?)').run(
    f.other.organizationId, f.owner.accountId, 'cosmetologist', 'active', Date.now());
  const another = { ...current(f), organizationId: f.other.organizationId, role: 'cosmetologist' };
  assert.equal(f.store.assistant.access(another).enabled, false);
  f.database.db.prepare('UPDATE memberships SET status=? WHERE organization_id=? AND account_id=?')
    .run('suspended', f.owner.organizationId, f.owner.accountId);
  assert.equal(f.store.assistant.access(current(f)).enabled, false);
});

test('demo navigates calendar without network or clinical reads and never reports appointment committed', async (t) => {
  const f = await adminFixture(t); enable(f);
  const scope = f.store.assistant.access(current(f));
  const result = await f.store.assistant.turn(c(f), { text: 'Покажи расписание на завтра', policyVersion: scope.policyVersion });
  assert.equal(result.action.type, 'calendar'); assert.equal(result.demo, true);
  assert.match(result.action.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(f.store.assistant.admin.view(f.admin.accountId).usage.spentRub, 0);
  await assert.rejects(f.store.assistant.transcribe(c(f), { policyVersion: scope.policyVersion }), { status: 400 });
});

test('revoked command and stale policy cannot be executed, including after await', async (t) => {
  const f = await adminFixture(t); enable(f, { llm: { provider: 'timeweb' } });
  let release, calls = 0;
  let started;
  const dispatched = new Promise((resolve) => { started = resolve; });
  const api = createAssistant({ ...f.database, organizationTimeZone: f.store.organizationTimeZone }, {
    directory: f.platformDirectory,
    fetchImpl: async () => { calls++; await new Promise((resolve) => { release = resolve; started(); });
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"intent":"calendar"}' } }] }),
        { headers: { 'content-type': 'application/json' } }); },
  });
  const scope = api.access(current(f));
  const pending = api.turn(c(f), { text: 'Календарь', policyVersion: scope.policyVersion });
  await dispatched;
  assert.equal(typeof release, 'function');
  f.store.assistant.admin.settings(f.admin.accountId, command(scope.policyVersion, { policy: { mode: 'off' } }));
  release(); await assert.rejects(pending, { status: 403 });
  assert.equal(calls, 1);
  assert.ok(f.store.assistant.admin.view(f.admin.accountId).usage.spentRub > 0);
});

test('daily request counts persist and provider failures keep estimated reservations charged', async (t) => {
  const f = await adminFixture(t); enable(f, { llm: { provider: 'timeweb' } });
  let revision = f.store.assistant.admin.view(f.admin.accountId).revision;
  revision = f.store.assistant.admin.settings(f.admin.accountId,
    command(revision, { policy: { limits: { dailyRequests: 2 } } })).revision;
  let calls = 0;
  const api = createAssistant({ ...f.database, organizationTimeZone: f.store.organizationTimeZone }, {
    directory: f.platformDirectory, fetchImpl: async () => { calls++; return new Response('', { status: 503 }); },
  });
  for (let i = 0; i < 2; i++)
    await assert.rejects(api.turn(c(f), { text: 'Календарь', policyVersion: revision }), { status: 502 });
  await assert.rejects(api.turn(c(f), { text: 'Календарь', policyVersion: revision }), { status: 429 });
  assert.equal(calls, 2);
  assert.ok(api.admin.view(f.admin.accountId).usage.spentRub > 0);
  f.reopen();
  await assert.rejects(f.store.assistant.turn(c(f), { text: 'Календарь', policyVersion: revision }), { status: 429 });
});

test('policy restore creates a new revision while preserving grants and never restoring deleted credentials', async (t) => {
  const f = await adminFixture(t); enable(f);
  const api = f.store.assistant.admin, actor = f.admin.accountId;
  const original = api.view(actor);
  const changed = api.settings(actor, command(original.revision, {
    policy: { commands: { clients: false } }, timewebApiKey: 'synthetic-provider-secret-2026' }));
  const removed = api.settings(actor, command(changed.revision, { timewebApiKey: null }));
  const restored = api.restore(actor, command(removed.revision, { revision: original.revision }));
  assert.equal(restored.policy.commands.clients, true);
  assert.equal(restored.credentialStatus.timeweb.configured, false);
  assert.equal(restored.grants.length, 1); assert.equal(restored.revision, removed.revision + 1);
});

test('corrupt optional state hides only assistant without invalidating authenticated application session', async (t) => {
  const f = await adminFixture(t);
  fs.writeFileSync(path.join(f.platformDirectory, 'assistant-state.enc'), 'synthetic-corruption');
  assert.equal(f.store.assistant.access(current(f)).enabled, false);
  assert.ok(f.store.session(f.ownerSession.token));
});

test('WAV duration is verified from samples and cannot be overridden by caller metadata', () => {
  const bytes = wav(2);
  const result = wavAudio({ mimeType: 'audio/wav', audioBase64: bytes.toString('base64'), durationSeconds: 0.1 }, 3);
  assert.equal(result.seconds, 2);
  assert.throws(() => wavAudio({ mimeType: 'audio/wav', audioBase64: bytes.toString('base64') }, 1), { status: 400 });
  assert.equal(providerWavDuration(bytes), 2);
  assert.throws(() => normalizeIntent({ intent: 'prepareAppointment', patientId: 'invented' }), { status: 400 });
  assert.throws(() => normalizeIntent({ intent: 'deleteEverything' }), { status: 502 });
});

test('Timeweb TTS reconciles WAV seconds, uses fixed endpoint, and does not expose provider credentials', async () => {
  let target, options;
  const value = await callTimeweb({ kind: 'tts', provider: { model: 'openai/gpt-4o-mini-tts', voice: 'alloy' },
    key: 'synthetic-secret', payload: { input: 'Тестовый ответ.' }, timeoutMs: 3000, guard() {},
    fetchImpl: async (url, init) => { target = url; options = init;
      return new Response(wav(2), { headers: { 'content-type': 'audio/wav' } }); } });
  assert.equal(target, 'https://api.timeweb.ai/v1/audio/speech');
  assert.equal(options.redirect, 'error'); assert.equal(JSON.parse(options.body).response_format, 'wav');
  assert.equal(value.usage.output_tokens, 2); assert.equal(value.mimeType, 'audio/wav');
  assert.doesNotMatch(JSON.stringify(value), /synthetic-secret/);
});

test('durable state validation rejects oversized collections and malformed grants', async (t) => {
  const f = await adminFixture(t); enable(f);
  const bytes = fs.readFileSync(path.join(f.platformDirectory, 'assistant-state.enc'));
  const state = f.database.open(bytes);
  assert.throws(() => validateState({ ...state, grants: [{ accountId: 'wrong' }] }));
  assert.throws(() => validateState({ ...state, history: Array(11).fill({}) }));
});
