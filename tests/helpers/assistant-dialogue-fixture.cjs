const { randomUUID } = require('node:crypto');
const { createAssistantDialogue } = require('../../src/server/modules/assistant/dialogue/dialogue-flow.cjs');
const { defaults } = require('../../src/server/modules/workspace/policy.cjs');
const day = '2099-01-05';
function dialogueFixture({ ambiguous = false, role = 'owner' } = {}) {
  let revision = 1;
  const actor = {
    accountId: 'owner',
    organizationId: 'org',
    sessionId: randomUUID(),
    role,
    expiresAt: Date.now() + 3600000,
  };
  const member = { membershipId: randomUUID() },
    state = { revision: 3, policy: { commands: { prepareAppointment: true } } };
  const patients = [
    {
      id: randomUUID(),
      firstName: 'Анна',
      lastName: 'Семёнова',
      name: 'Анна Семёнова',
      phone: '+79991112233',
      createdBy: 'owner',
      appointments: [],
    },
  ];
  if (ambiguous)
    patients.push({
      ...patients[0],
      id: randomUUID(),
      firstName: 'Ольга',
      name: 'Ольга Семёнова',
      phone: '+79991114455',
    });
  const members = [
    { accountId: 'owner', displayName: 'Тестовый Специалист', role: 'owner', status: 'active' },
  ];
  const services = [{ id: 'clean', name: 'Чистка', duration: 30, staffId: 'owner' }],
    busy = [];
  const encode = (value) => Buffer.from(JSON.stringify(value));
  const storage = {
    filename: 'synthetic-dialogue-' + randomUUID(),
    encode,
    decode: (value) => JSON.parse(value.toString()),
    get: () => revision,
    readServices: () => services,
    transaction(callback) {
      return callback();
    },
    indexes: {
      summaryRows(current) {
        return patients
          .filter((row) => current.role !== 'cosmetologist' || row.createdBy === current.accountId)
          .map((row) => ({ patient_id: row.id, value: encode(row) }));
      },
      appointments: () => busy,
    },
  };
  const c = {
    current: actor,
    token: 'synthetic-token',
    assertCurrent() {},
    tenantStore: () => storage,
    platform: {
      workspaceMembers: () => members,
      organizationTimeZone: () => 'Europe/Moscow',
      workspaceSettings: () => defaults('owner'),
      bookingRequests: { reserves: () => [] },
      personalEvents: { occupancy: () => [] },
      workSchedules: {
        view: () => ({
          days: { [day]: { status: 'working', intervals: [['09:00', '18:00']] } },
          closures: {},
        }),
      },
    },
  };
  const flow = createAssistantDialogue(),
    clock = { date: day, hour: 8, minute: 0 };
  let result;
  return {
    flow,
    c,
    state,
    member,
    clock,
    patients,
    members,
    services,
    busy,
    changed() {
      revision++;
    },
    start(intent = {}, constraints = {}) {
      const ticket = flow.beginCommand(c, member, state);
      result = flow.start(
        c,
        { intent: 'prepareAppointment', ...intent },
        state,
        member,
        clock,
        ticket,
        constraints,
      );
      return result;
    },
    answer(operation) {
      const body = {
        policyVersion: state.revision,
        dialogueId: result.dialogue.id,
        dialogueVersion: result.dialogue.version,
        ...operation,
      };
      result = flow.continueDialogue(c, body, state, member, clock);
      return { result, body };
    },
    get result() {
      return result;
    },
  };
}
module.exports = { dialogueFixture, day };
