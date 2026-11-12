const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { adminFixture } = require('./admin-fixture.cjs');
const { createAssistant } = require('../../src/server/modules/assistant/service.cjs');
const { fail } = require('../../src/shared/errors.cjs');
const command = (revision, values) => ({
  expectedRevision: revision,
  requestId: randomUUID(),
  reason: 'Синтетические границы помощника',
  ...values,
});
function wav() {
  const bytes = Buffer.alloc(3244);
  bytes.write('RIFF');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24);
  bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(bytes.length - 44, 40);
  return { audioBase64: bytes.toString('base64'), mimeType: 'audio/wav' };
}
async function assistantBoundariesFixture(
  t,
  { grantRoles = ['owner', 'salon_admin', 'cosmetologist'], dailyRequests = 100 } = {},
) {
  const f = await adminFixture(t, { extraAccounts: 2 }),
    actor = f.admin.accountId;
  const actors = {
    owner: {
      accountId: f.owner.accountId,
      token: f.ownerSession.token,
      organizationId: f.owner.organizationId,
    },
  };
  for (const [index, role] of ['salon_admin', 'cosmetologist'].entries()) {
    const email = `extra-${index}@admin.test`;
    const accountId = f.database.db
      .prepare('SELECT id FROM accounts WHERE email_hash=?')
      .get(f.database.emailHash(email)).id;
    f.database.db
      .prepare('INSERT INTO memberships VALUES(?,?,?,?,?)')
      .run(f.owner.organizationId, accountId, role, 'active', Date.now() + index);
    const login = await f.store.login(email, f.password);
    actors[role] = { accountId, token: login.token, organizationId: f.owner.organizationId };
  }
  const admin = f.store.assistant.admin;
  admin.settings(
    actor,
    command(admin.view(actor).revision, {
      policy: { mode: 'selected', limits: { dailyRequests } },
      providers: {
        llm: { provider: 'codex', model: 'codex-default' },
        stt: { provider: 'local', model: 'whisper-base' },
        tts: { provider: 'local', model: 'system-ru', voice: 'ru-local' },
      },
    }),
  );
  const grant = (role, enabled = true) =>
    admin.setMember(
      actor,
      command(admin.view(actor).revision, {
        organizationId: actors[role].organizationId,
        accountId: actors[role].accountId,
        enabled,
      }),
    );
  for (const role of grantRoles) grant(role);
  const hooks = {},
    calls = { llm: 0, stt: 0, tts: 0 };
  async function dispatch(kind, call) {
    calls[kind]++;
    call.guard();
    await call.onOutbound();
    if (hooks[kind]) return hooks[kind](call);
    if (kind === 'llm') return { text: JSON.stringify({ intent: 'calendar' }) };
    if (kind === 'stt') return { text: 'Синтетический календарь', local: true };
    return { text: call.payload.input, audioBase64: null, mimeType: null, local: true };
  }
  const ports = {
    codex: { available: true, run: (call) => dispatch('llm', call) },
    localSpeech: {
      available: true,
      sttAvailable: true,
      ttsAvailable: true,
      run: (call) => dispatch(call.kind, call),
    },
  };
  const api = createAssistant(
    { ...f.database, organizationTimeZone: f.store.organizationTimeZone },
    {
      directory: f.platformDirectory,
      ...ports,
    },
  );
  const current = (role) => f.store.session(actors[role].token);
  function context(role = 'owner') {
    const original = current(role);
    return {
      current: original,
      platform: f.store,
      assertCurrent() {
        const fresh = current(role);
        if (!fresh) throw fail(401, 'Войдите в картотеку.');
        if (
          ['accountId', 'organizationId', 'role', 'globalAdmin'].some(
            (key) => fresh[key] !== original[key],
          )
        )
          throw fail(403, 'Доступ изменился. Повторите операцию.');
      },
      tenantStore() {
        throw Error('Calendar boundary must not read clinical records');
      },
    };
  }
  const revision = () => admin.view(actor).revision;
  const settings = (values) => admin.settings(actor, command(revision(), values));
  const readState = () =>
    f.database.open(fs.readFileSync(path.join(f.platformDirectory, 'assistant-state.enc')));
  function request(kind = 'llm', role = 'owner', values = {}) {
    const body = {
      policyVersion: revision(),
      ...(kind === 'stt' ? wav() : { text: 'Календарь' }),
      ...values,
    };
    return api[kind === 'llm' ? 'turn' : kind === 'stt' ? 'transcribe' : 'speak'](
      context(role),
      body,
    );
  }
  return {
    ...f,
    api,
    admin,
    actor,
    actors,
    hooks,
    calls,
    ports,
    current,
    context,
    revision,
    grant,
    settings,
    readState,
    request,
    wav,
  };
}
module.exports = { assistantBoundariesFixture, command, wav };
