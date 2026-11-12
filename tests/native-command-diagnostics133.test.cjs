const test = require('node:test');
const assert = require('node:assert/strict');
const {
  nativeFailureDiagnostic,
} = require('../src/server/infrastructure/native-application-diagnostics.cjs');
const { nativeIsolatedFixture } = require('./helpers/native-isolated-fixture.cjs');
const { createPlatformStore } = require('../src/server/application/platform.cjs');
const path = require('node:path');
test('native startup diagnostics keep only closed role, phase and cause categories', () => {
  const privateText = 'synthetic-secret SELECT private FROM data';
  assert.deepEqual(
    nativeFailureDiagnostic('command', 'composition', {
      postgresCode: 'POSTGRES_BUSY',
      code: 'ERR_SQLITE_ERROR',
      message: privateText,
      sql: privateText,
    }),
    { role: 'command', phase: 'composition', cause: 'POSTGRES_BUSY' },
  );
  const closed = nativeFailureDiagnostic(privateText, privateText, {
    code: privateText,
    stack: privateText,
  });
  assert.deepEqual(closed, { role: 'unknown', phase: 'unknown', cause: 'UNCLASSIFIED' });
  assert.equal(JSON.stringify(closed).includes(privateText), false);
});
test('narrow command platform omits admin reconciliation while retaining current session authority; default web keeps admin', async (t) => {
  const f = await nativeIsolatedFixture(t),
    actor = f.actors[0];
  const command = createPlatformStore(path.join(f.directory, 'platform'), {
    administrationComposition: false,
    assistantComposition: false,
    notificationChannelProjection: true,
  });
  try {
    assert.equal(command.admin, undefined);
    assert.equal(command.session(actor.token).accountId, actor.accountId);
    assert.equal(command.session(actor.token).organizationId, actor.organizationId);
    assert.equal(command.session('invalid-private-session'), null);
    assert.equal(typeof f.platform.admin.overview, 'function');
    assert.throws(
      () =>
        createPlatformStore(path.join(f.directory, 'platform'), {
          administrationComposition: 'false',
        }),
      /composition/,
    );
  } finally {
    command.close();
  }
});
