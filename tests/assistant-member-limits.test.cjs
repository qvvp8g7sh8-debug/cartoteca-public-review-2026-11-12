const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { adminFixture } = require('./helpers/admin-fixture.cjs');
const { createAssistant } = require('../src/server/modules/assistant/service.cjs');
const { initialState, validateState } = require('../src/server/modules/assistant/access/defaults.cjs');
const { normalizedLimits } = require('../src/server/modules/assistant/access/member-limits.cjs');
const maximum = Object.freeze({
  dailyRequests: 1000,
  maxAudioSeconds: 60,
  maxTextChars: 4000,
  maxReplyChars: 1000,
  maxOutputTokens: 1000,
  requestTimeoutMs: 30000,
});
const command = (revision, values) => ({
  expectedRevision: revision,
  requestId: randomUUID(),
  reason: 'Синтетическая проверка персональных лимитов',
  ...values,
});
function grant(f, target, limits) {
  const api = f.store.assistant.admin;
  const current = api.view(f.admin.accountId);
  return api.setMember(
    f.admin.accountId,
    command(current.revision, {
      organizationId: target.organizationId,
      accountId: target.accountId,
      enabled: true,
      ...(limits === undefined ? {} : { limits }),
    }),
  );
}
function selected(f, changes = {}) {
  const api = f.store.assistant.admin;
  return api.settings(
    f.admin.accountId,
    command(api.view(f.admin.accountId).revision, {
      policy: { mode: 'selected', ...changes },
    }),
  );
}
function context(f, session = f.ownerSession) {
  const current = f.store.session(session.token);
  return {
    current,
    platform: f.store,
    assertCurrent() {
      const fresh = f.store.session(session.token);
      if (!fresh || fresh.role !== current.role || fresh.organizationId !== current.organizationId)
        throw Object.assign(Error('Synthetic scope changed'), { status: 403 });
    },
    tenantStore() {
      throw Error('Unexpected clinical read');
    },
  };
}
function wav(seconds) {
  const bytes = Buffer.alloc(44 + seconds * 32000);
  bytes.write('RIFF');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVE', 8);
  bytes.write('fmt ', 12);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24);
  bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(bytes.length - 44, 40);
  return bytes.toString('base64');
}
test('personal overrides are membership-scoped, durable and leave the global paid budget unchanged', async (t) => {
  const f = await adminFixture(t);
  selected(f);
  grant(f, f.owner, maximum);
  grant(f, f.other);
  const before = f.store.assistant.admin.view(f.admin.accountId);
  const other = await f.store.login('other@admin.test', f.password);
  const own = f.store.assistant.access(context(f).current),
    second = f.store.assistant.access(context(f, other).current);
  for (const [key, value] of Object.entries(maximum)) assert.equal(own.limits[key], value);
  assert.deepEqual(second.limits, before.policy.limits);
  assert.deepEqual(before.policy.limits, initialState().policy.limits);
  assert.equal(own.limits.monthlyBudgetRub, 100);
  f.reopen();
  assert.equal(f.store.assistant.access(context(f).current).limits.maxAudioSeconds, 60);
  f.database.db
    .prepare('INSERT INTO memberships VALUES(?,?,?,?,?)')
    .run(f.other.organizationId, f.owner.accountId, 'cosmetologist', 'active', Date.now());
  assert.equal(
    f.store.assistant.access({
      ...context(f).current,
      organizationId: f.other.organizationId,
      role: 'cosmetologist',
    }).enabled,
    false,
  );
});
test('omission preserves overrides, null clears them, replay is idempotent and stale edits fail', async (t) => {
  const f = await adminFixture(t);
  selected(f);
  const enabled = grant(f, f.owner, maximum),
    api = f.store.assistant.admin;
  const body = command(enabled.revision, {
    organizationId: f.owner.organizationId,
    accountId: f.owner.accountId,
    enabled: true,
  });
  const first = api.setMember(f.admin.accountId, body);
  assert.deepEqual(first.limits, maximum);
  assert.equal(api.setMember(f.admin.accountId, body).revision, first.revision);
  assert.throws(() => api.setMember(f.admin.accountId, { ...body, requestId: randomUUID() }), {
    status: 409,
  });
  const cleared = grant(f, f.owner, null);
  assert.equal(cleared.limits, null);
  assert.deepEqual(cleared.effectiveLimits, initialState().policy.limits);
  const again = grant(f, f.owner, maximum);
  api.setMember(
    f.admin.accountId,
    command(again.revision, {
      organizationId: f.owner.organizationId,
      accountId: f.owner.accountId,
      enabled: false,
    }),
  );
  assert.equal(grant(f, f.owner).limits, null);
});
test('invalid overrides, paid budget overrides and non-administrator changes are denied', async (t) => {
  const f = await adminFixture(t);
  selected(f);
  const api = f.store.assistant.admin,
    revision = api.view(f.admin.accountId).revision;
  const body = command(revision, {
    organizationId: f.owner.organizationId,
    accountId: f.owner.accountId,
    enabled: true,
    limits: maximum,
  });
  assert.throws(() => api.setMember(f.owner.accountId, body), { status: 403 });
  for (const limits of [
    { monthlyBudgetRub: 100000 },
    { maxAudioSeconds: 61 },
    { dailyRequests: 1001 },
    { requestTimeoutMs: 30001 },
    { maxTextChars: 4001 },
    { maxReplyChars: 1001 },
    { maxOutputTokens: 1001 },
    { dailyRequests: NaN },
    { maxAudioSeconds: 1.5 },
    [],
    null,
  ]) {
    if (limits === null) continue;
    assert.throws(() => api.setMember(f.admin.accountId, { ...body, limits }), { status: 400 });
  }
  for (const [key, value] of Object.entries(maximum))
    assert.deepEqual(normalizedLimits({ [key]: value }, true), { [key]: value });
  assert.equal(api.view(f.admin.accountId).revision, revision);
  const state = initialState();
  state.grants = [
    {
      organizationId: 'org',
      accountId: 'account',
      membershipId: 'a'.repeat(43),
      limits: { monthlyBudgetRub: 1 },
    },
  ];
  assert.throws(() => validateState(state), { status: 400 });
});
test('personal daily limits count all calls while another granted member retains the smaller global limit', async (t) => {
  const f = await adminFixture(t);
  selected(f, { limits: { dailyRequests: 1 } });
  grant(f, f.owner, { dailyRequests: 3 });
  grant(f, f.other);
  const other = await f.store.login('other@admin.test', f.password),
    api = f.store.assistant;
  const revision = api.admin.view(f.admin.accountId).revision;
  for (let i = 0; i < 3; i++)
    await api.turn(context(f), { text: 'Календарь', policyVersion: revision });
  await assert.rejects(api.turn(context(f), { text: 'Календарь', policyVersion: revision }), {
    status: 429,
  });
  await api.turn(context(f, other), { text: 'Календарь', policyVersion: revision });
  await assert.rejects(
    api.turn(context(f, other), { text: 'Календарь', policyVersion: revision }),
    { status: 429 },
  );
  f.reopen();
  await assert.rejects(
    f.store.assistant.turn(context(f), { text: 'Календарь', policyVersion: revision }),
    { status: 429 },
  );
});
test('effective limits reach the real service payload, timeout, transcription and reply guards without network', async (t) => {
  const f = await adminFixture(t);
  selected(f);
  grant(f, f.owner, maximum);
  const apiAdmin = f.store.assistant.admin;
  apiAdmin.settings(
    f.admin.accountId,
    command(apiAdmin.view(f.admin.accountId).revision, {
      providers: {
        stt: { provider: 'local' },
        llm: { provider: 'codex' },
        tts: { provider: 'local' },
      },
    }),
  );
  const calls = [];
  const api = createAssistant(
    { ...f.database, organizationTimeZone: f.store.organizationTimeZone },
    {
      directory: f.platformDirectory,
      codex: {
        available: true,
        async run(options) {
          calls.push({ kind: 'llm', ...options });
          options.guard();
          options.onOutbound();
          return { text: '{"intent":"calendar"}' };
        },
      },
      localSpeech: {
        available: true,
        sttAvailable: true,
        ttsAvailable: true,
        async run(options) {
          calls.push(options);
          options.guard();
          options.onOutbound();
          return options.kind === 'stt'
            ? { text: 'Синтетическая команда' }
            : { text: options.payload.input, audioBase64: null, mimeType: null };
        },
      },
    },
  );
  const revision = api.access(context(f).current).policyVersion;
  await api.turn(context(f), { text: 'Календарь ' + 'а'.repeat(2500), policyVersion: revision });
  assert.equal(calls[0].timeoutMs, 30000);
  assert.equal(calls[0].payload.max_tokens, 1000);
  await api.transcribe(context(f), {
    audioBase64: wav(60),
    mimeType: 'audio/wav',
    policyVersion: revision,
  });
  assert.equal(calls[1].payload.seconds, 60);
  assert.equal(calls[1].timeoutMs, 30000);
  await api.speak(context(f), { text: 'а'.repeat(900), policyVersion: revision });
  assert.equal(calls[2].payload.input.length, 900);
  await assert.rejects(
    api.transcribe(context(f), {
      audioBase64: wav(61),
      mimeType: 'audio/wav',
      policyVersion: revision,
    }),
    { status: 400 },
  );
  await assert.rejects(api.turn(context(f), { text: 'а'.repeat(4001), policyVersion: revision }), {
    status: 400,
  });
  await assert.rejects(api.speak(context(f), { text: 'а'.repeat(1001), policyVersion: revision }), {
    status: 400,
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(api.admin.view(f.admin.accountId).policy.limits, initialState().policy.limits);
});
test('policy restore preserves personal overrides, recreated membership cannot inherit them', async (t) => {
  const f = await adminFixture(t);
  const initial = selected(f);
  grant(f, f.owner, maximum);
  const api = f.store.assistant.admin;
  const changed = api.settings(
    f.admin.accountId,
    command(api.view(f.admin.accountId).revision, { policy: { commands: { clients: false } } }),
  );
  api.restore(f.admin.accountId, command(changed.revision, { revision: initial.revision }));
  assert.deepEqual(
    api.member(f.admin.accountId, f.owner.organizationId, f.owner.accountId).limits,
    maximum,
  );
  f.database.db
    .prepare(
      'UPDATE memberships SET created_at=created_at+1 WHERE organization_id=? AND account_id=?',
    )
    .run(f.owner.organizationId, f.owner.accountId);
  assert.equal(f.store.assistant.access(context(f).current).enabled, false);
  assert.equal(
    api.member(f.admin.accountId, f.owner.organizationId, f.owner.accountId).limits,
    null,
  );
  assert.equal(grant(f, f.owner).limits, null);
});
