const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { assistantBoundariesFixture } = require('./helpers/assistant-boundaries-fixture.cjs');

function pendingProvider(f, kind) {
  let release, entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  f.hooks[kind] = async (call) => {
    entered(call);
    await held;
    return kind === 'llm'
      ? { text: '{"intent":"calendar"}' }
      : kind === 'stt'
        ? { text: 'Синтетический ответ', local: true }
        : { text: call.payload.input, audioBase64: null, mimeType: null, local: true };
  };
  return { started, release: () => release() };
}
test('LLM, STT and TTS results are discarded after explicit grant revocation while the provider is pending', async (t) => {
  for (const kind of ['llm', 'stt', 'tts']) {
    const f = await assistantBoundariesFixture(t),
      pending = pendingProvider(f, kind);
    const request = f.request(kind, 'cosmetologist');
    await pending.started;
    f.grant('cosmetologist', false);
    pending.release();
    await assert.rejects(request, { status: 403 });
    assert.equal(f.calls[kind], 1);
    assert.equal(Object.keys(f.readState().reservations).length, 0);
    assert.equal(f.admin.view(f.actor).usage.spentRub, 0);
  }
});
test('logout during provider work invalidates the captured session and no result is returned to its replacement', async (t) => {
  const f = await assistantBoundariesFixture(t),
    pending = pendingProvider(f, 'llm');
  const result = f.request('llm', 'salon_admin');
  await pending.started;
  f.store.logout(f.actors.salon_admin.token);
  pending.release();
  await assert.rejects(result, { status: 401 });
  assert.equal(f.calls.llm, 1);
  assert.equal(Object.keys(f.readState().reservations).length, 0);
});
test('a provider or limit revision change fences all pending kinds and retains durable accounting', async (t) => {
  for (const kind of ['llm', 'stt', 'tts']) {
    const f = await assistantBoundariesFixture(t),
      pending = pendingProvider(f, kind);
    const result = f.request(kind);
    await pending.started;
    f.settings({ policy: { limits: { maxTextChars: 1800 } } });
    pending.release();
    await assert.rejects(result, { status: 409 });
    const state = f.readState();
    assert.equal(Object.keys(state.reservations).length, 0);
    assert.equal(
      Object.values(state.daily).reduce((sum, value) => sum + value, 0),
      1,
    );
    assert.equal(f.admin.view(f.actor).usage.spentRub, 0);
  }
});
test('suspending the account, organization or membership and changing role invalidate an in-flight staff context', async (t) => {
  for (const change of ['account', 'organization', 'membership', 'role']) {
    const f = await assistantBoundariesFixture(t),
      staff = f.actors.cosmetologist,
      pending = pendingProvider(f, 'llm');
    const result = f.request('llm', 'cosmetologist');
    await pending.started;
    if (change === 'account')
      f.database.db
        .prepare("UPDATE accounts SET status='suspended' WHERE id=?")
        .run(staff.accountId);
    if (change === 'organization')
      f.database.db
        .prepare("UPDATE organizations SET status='suspended' WHERE id=?")
        .run(staff.organizationId);
    if (change === 'membership')
      f.database.db
        .prepare(
          "UPDATE memberships SET status='suspended' WHERE organization_id=? AND account_id=?",
        )
        .run(staff.organizationId, staff.accountId);
    if (change === 'role')
      f.database.db
        .prepare(
          "UPDATE memberships SET role='salon_admin' WHERE organization_id=? AND account_id=?",
        )
        .run(staff.organizationId, staff.accountId);
    pending.release();
    await assert.rejects(result, { status: change === 'role' ? 403 : 401 });
    assert.equal(f.calls.llm, 1);
    assert.equal(Object.keys(f.readState().reservations).length, 0);
  }
});
test('a stale caller version is rejected before dispatch, daily accounting or reservation writes', async (t) => {
  const f = await assistantBoundariesFixture(t),
    version = f.revision();
  f.settings({ policy: { limits: { dailyRequests: 99 } } });
  const before = f.readState();
  for (const kind of ['llm', 'stt', 'tts'])
    await assert.rejects(f.request(kind, 'owner', { policyVersion: version }), { status: 409 });
  assert.deepEqual(f.readState(), before);
  assert.deepEqual(f.calls, { llm: 0, stt: 0, tts: 0 });
});

for (const mode of ['unreadable', 'missing'])
  test(
    mode + ' encrypted settings fail closed without invoking or recreating provider state',
    async (t) => {
      const f = await assistantBoundariesFixture(t),
        version = f.revision(),
        filename = path.join(f.platformDirectory, 'assistant-state.enc'),
        before = fs.readFileSync(filename),
        invalid = Buffer.from('synthetic-unreadable-state');
      try {
        if (mode === 'missing') fs.unlinkSync(filename);
        else fs.writeFileSync(filename, invalid);
        const current = f.current('owner');
        assert.equal(f.api.access(current).enabled, false);
        assert.equal(f.api.currentScope(f.context()).enabled, false);
        for (const [method, fields] of [
          ['turn', { text: 'Календарь' }],
          ['transcribe', f.wav()],
          ['speak', { text: 'Синтетика' }],
        ])
          await assert.rejects(
            f.api[method](f.context(), { policyVersion: version, ...fields }),
            (error) => {
              assert.equal(error.status, mode === 'missing' ? 403 : 503);
              assert.doesNotMatch(
                error.message,
                /decrypt|crypto|sqlite|synthetic-unreadable-state/i,
              );
              return true;
            },
          );
        assert.deepEqual(f.calls, { llm: 0, stt: 0, tts: 0 });
        if (mode === 'missing') assert.equal(fs.existsSync(filename), false);
        else assert.deepEqual(fs.readFileSync(filename), invalid);
      } finally {
        fs.writeFileSync(filename, before);
      }
      assert.equal((await f.request('llm')).action.type, 'calendar');
    },
  );

for (const change of ['session expiry', 'membership replacement', 'organization switch'])
  test(
    'a pending result cannot cross ' + change + ' even when the account remains unchanged',
    async (t) => {
      const f = await assistantBoundariesFixture(t),
        pending = pendingProvider(f, 'llm'),
        current = f.current('owner');
      t.after(pending.release);
      const result = f.request('llm');
      await pending.started;
      if (change === 'session expiry')
        f.database.db
          .prepare('UPDATE platform_sessions SET expires_at=? WHERE id=?')
          .run(Date.now() - 1, current.sessionId);
      if (change === 'membership replacement') {
        const prior = f.database.db
          .prepare('SELECT created_at FROM memberships WHERE organization_id=? AND account_id=?')
          .get(current.organizationId, current.accountId);
        f.database.db
          .prepare('DELETE FROM memberships WHERE organization_id=? AND account_id=?')
          .run(current.organizationId, current.accountId);
        f.database.db
          .prepare('INSERT INTO memberships VALUES(?,?,?,?,?)')
          .run(
            current.organizationId,
            current.accountId,
            current.role,
            'active',
            prior.created_at + 1000,
          );
        assert.equal(f.api.access(f.current('owner')).enabled, false);
      }
      if (change === 'organization switch') {
        f.database.db
          .prepare('INSERT INTO memberships VALUES(?,?,?,?,?)')
          .run(f.other.organizationId, current.accountId, current.role, 'active', Date.now());
        f.database.db
          .prepare('UPDATE memberships SET status=? WHERE organization_id=? AND account_id=?')
          .run('suspended', current.organizationId, current.accountId);
        f.database.db
          .prepare('UPDATE platform_sessions SET organization_id=NULL WHERE id=?')
          .run(current.sessionId);
        assert.equal(f.store.availableMemberships(current.accountId).length, 1);
        f.store.selectOrganization(f.actors.owner.token, f.other.organizationId);
        assert.equal(f.api.access(f.current('owner')).enabled, false);
      }
      pending.release();
      await assert.rejects(result, { status: change === 'session expiry' ? 401 : 403 });
      assert.equal(f.calls.llm, 1);
      assert.equal(Object.keys(f.readState().reservations).length, 0);
      assert.equal(f.admin.view(f.actor).usage.spentRub, 0);
    },
  );
