const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fail } = require('../../src/shared/errors.cjs');
const { createStorage } = require('../../src/server/infrastructure/cabinet-storage.cjs');
const {
  createAppointmentManagementFlow,
} = require('../../src/server/modules/assistant/actions/appointments/appointment-management-flow.cjs');
const {
  createAppointmentExecution,
} = require('../../src/server/modules/assistant/actions/appointments/appointment-execution.cjs');
const { saveMutation } = require('../../src/server/modules/cabinet/mutations.cjs');
const { createServiceCatalog } = require('../../src/server/modules/services/catalog.cjs');
const { defaults } = require('../../src/server/modules/workspace/policy.cjs');
const { dialogueFixture, day } = require('./assistant-dialogue-fixture.cjs');
const NOW = Date.parse(day + 'T05:00:00Z');
function cancellationFixture(
  t,
  { enabled = true, role = 'owner', query = 'Анна Семёнова', failWritten = false } = {},
) {
  const f = dialogueFixture({ role }),
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-assistant-cancel-'));
  const storage = createStorage(directory);
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const source = {
    id: randomUUID(),
    date: day,
    time: '10:00',
    duration: 30,
    staffId: 'owner',
    roomId: 'main',
    status: 'scheduled',
    service: 'Чистка',
    serviceItems: [{ id: 'clean', name: 'Чистка', duration: 30, category: 'other', price: 100 }],
    notes: 'Synthetic preservednote',
  };
  storage.write({
    revision: 0,
    patients: f.patients.map((p) => ({ ...p, appointments: [source], visits: [] })),
    services: [{ ...f.services[0], duration: '30', category: 'other', price: 100 }],
  });
  const workspace = defaults('owner');
  workspace.enabled = false;
  workspace.rooms[0].preventOverlap = false;
  let revoked = false,
    insideLock = false,
    calls = 0;
  const hooks = {};
  f.state.providers = { llm: { provider: 'codex', model: 'synthetic-no-provider' } };
  f.c.req = { headers: {}, aborted: false };
  f.c.res = { destroyed: false };
  f.c.tenantStore = () => storage;
  f.c.assertCurrent = () => {
    if (revoked) throw fail(403, 'Synthetic revokedaccess');
  };
  const standalone = storage.readServices;
  storage.readServices = () => {
    assert.equal(insideLock, false, 'no standalonecatalog read insideexisting writer');
    return standalone();
  };
  Object.assign(f.c.platform, {
    session: () => (revoked ? null : f.c.current),
    subscription: () => ({
      status: 'active',
      limits: { patients: 1000, photos: 1000, services: 1000 },
    }),
    workspaceIdentities: () => f.members,
    workspaceSettings: () => workspace,
    notificationChannels: { enabled: () => false },
    appointmentConfirmations: { invalidateChanges() {} },
    telegram: { cancelPending() {} },
    assertServiceGroups() {},
    assertWorkspaceSelection() {},
    async withAsyncWriteLock(callback) {
      if (hooks.beforeCommit) await hooks.beforeCommit();
      insideLock = true;
      try {
        return callback();
      } finally {
        insideLock = false;
      }
    },
    personalEvents: { occupancy: () => [], assertAppointments() {} },
    workSchedules: {
      view: () => ({ days: {}, closures: {} }),
      check() {
        throw Error('Cancellation must not require openingaworkday');
      },
      assertChanges() {},
    },
  });
  f.c.platform.assertServiceCatalog = createServiceCatalog(f.c.platform).assertServiceCatalog;
  const scope = (c, version) => {
    c.assertCurrent();
    if (version !== f.state.revision) throw fail(409, 'Synthetic stalepolicy');
    return { state: f.state, member: f.member };
  };
  const management = createAppointmentManagementFlow({
    memory: f.flow,
    appointmentSavingEnabled: enabled,
  });
  let result = management.start(
    f.c,
    { intent: 'cancelAppointment', query },
    f.state,
    f.member,
    f.clock,
    f.flow.beginCommand(f.c, f.member, f.state),
  );
  const answer = (operation) => {
    const body = {
      dialogueId: result.dialogue.id,
      dialogueVersion: result.dialogue.version,
      ...operation,
    };
    result = management.continueDialogue(f.c, body, f.state, f.member, f.clock);
    return { result, body };
  };
  const options = {
    dialogues: f.flow,
    scope,
    currentScope: (c) => scope(c, f.state.revision),
    enabled,
    now: () => NOW,
    async commit(c, body, options) {
      calls++;
      const written = options.trustedCommit.written;
      options.trustedCommit.written = (store) => {
        assert.equal(insideLock, true);
        written(store);
        if (failWritten) throw fail(503, 'Synthetic markerrollback');
      };
      const saved = await saveMutation(c, body, options);
      if (hooks.afterCommit) await hooks.afterCommit();
      return saved;
    },
  };
  const api = createAppointmentExecution(options);
  return {
    ...f,
    storage,
    source,
    hooks,
    management,
    api,
    options,
    answer,
    get result() {
      return result;
    },
    body: () => ({ executionId: result.action.executionId, policyVersion: f.state.revision }),
    row: () => storage.readSelected([f.patients[0].id]).patients[0].appointments[0],
    calls: () => calls,
    revoke() {
      revoked = true;
    },
  };
}
module.exports = { cancellationFixture, NOW };
