const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  managementCommandTransition,
} = require('../src/server/modules/assistant/dialogue/dialogue-command-transition.cjs');
const { assistantBoundariesFixture } = require('./helpers/assistant-boundaries-fixture.cjs');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const { createAssistant } = require('../src/server/modules/assistant/service.cjs');
const { defaults } = require('../src/server/modules/workspace/policy.cjs');

const clock = { date: day, hour: 8, minute: 0 };
const entry = (data = {}) => ({ complete: false, data });
test('only a different explicit appointment command changes an unfinished dialogue', () => {
  const draft = entry();
  for (const text of ['Измени запись.', 'Перенеси запись Анны Семёновой.', 'Отмени запись.'])
    assert.equal(managementCommandTransition(draft, text, clock), true, text);
  for (const text of [
    'Отмени',
    'Отмена',
    'Измени услугу',
    'Поменяй дату',
    'На час позже',
    'Не отменяй запись',
    'Перенеси запись или отмени запись',
    'Перенеси запись, если день свободен',
  ])
    assert.equal(managementCommandTransition(draft, text, clock), false, text);
  const moving = entry({ target: 'appointmentManagement', management: { operation: 'move' } });
  assert.equal(managementCommandTransition(moving, 'Перенеси запись на час позже', clock), false);
  assert.equal(
    managementCommandTransition(moving, 'Перенеси запись клиента на час позже', clock),
    false,
  );
  assert.equal(managementCommandTransition(moving, 'Измени запись', clock), false);
  assert.equal(
    managementCommandTransition(moving, 'Перенеси запись Анны Семёновой на час позже', clock),
    true,
  );
  assert.equal(managementCommandTransition(moving, 'Отмени запись', clock), true);
  assert.equal(
    managementCommandTransition({ ...draft, complete: true }, 'Измени запись', clock),
    false,
  );
  assert.equal(
    managementCommandTransition({ ...draft, executionSaved: {} }, 'Измени запись', clock),
    false,
  );
});

async function fixture(t) {
  const boundary = await assistantBoundariesFixture(t, { grantRoles: ['owner'] });
  const world = dialogueFixture(),
    actor = boundary.current('owner');
  world.members[0].accountId = actor.accountId;
  world.services[0].staffId = actor.accountId;
  world.patients[0].createdBy = actor.accountId;
  world.patients[0].appointments = [
    {
      id: randomUUID(),
      date: day,
      time: '10:00',
      duration: 30,
      staffId: actor.accountId,
      roomId: 'main',
      service: 'Чистка',
      serviceItems: [{ id: 'clean', name: 'Чистка', duration: 30, price: 700 }],
      notes: '',
    },
  ];
  const storage = world.c.tenantStore('org');
  storage.readSelected = (ids) => ({
    patients: world.patients.filter((p) => ids.includes(p.id)),
    services: world.services,
    revision: 1,
  });
  storage.indexes.appointments = () => world.patients.flatMap((p) => p.appointments);
  storage.read = () => {
    throw Error('Unexpected full cabinet scan');
  };
  for (const name of ['save', 'write', 'saveAppointment'])
    storage[name] = () => {
      throw Error('Unexpected clinical write');
    };
  const c = boundary.context('owner');
  c.tenantStore = () => storage;
  c.platform = {
    ...boundary.store,
    workspaceMembers: () => world.members,
    workspaceSettings: () => defaults(actor.accountId),
    workSchedules: world.c.platform.workSchedules,
    bookingRequests: { reserves: () => [] },
    personalEvents: { occupancy: () => [] },
  };
  const api = createAssistant(
    { ...boundary.database, organizationTimeZone: boundary.store.organizationTimeZone },
    { directory: boundary.platformDirectory, ...boundary.ports },
  );
  boundary.hooks.llm = () => ({ text: JSON.stringify({ intent: 'help' }) });
  return {
    boundary,
    api,
    c,
    world,
    before: JSON.stringify(world.patients),
    turn: (body) => api.turn(c, { policyVersion: boundary.revision(), ...body }),
  };
}

test('an explicit change command in the client question starts management without a clinical write', async (t) => {
  const f = await fixture(t);
  const draft = await f.turn({ text: 'Создай новую запись.' });
  assert.equal(f.boundary.calls.llm, 0, 'the fully covered initial create request stays local');
  assert.equal(draft.dialogue.step, 'client');
  const body = {
    dialogueId: draft.dialogue.id,
    dialogueVersion: draft.dialogue.version,
    text: 'Измени запись.',
  };
  const reply = await f.turn(body);
  assert.equal(reply.intent, 'moveAppointment');
  assert.equal(reply.dialogue.step, 'client');
  assert.notEqual(reply.dialogue.id, draft.dialogue.id);
  assert.equal(reply.action, null);
  assert.equal(f.boundary.calls.llm, 1);
  await assert.rejects(f.turn(body), { status: 409 });
  assert.equal(f.boundary.calls.llm, 1);
  assert.equal(JSON.stringify(f.world.patients), f.before);
});

test('stale or mixed continuations cannot retire a dialogue or dispatch a new model command', async (t) => {
  const f = await fixture(t);
  const draft = await f.turn({ text: 'Создай новую запись.' });
  assert.equal(f.boundary.calls.llm, 0, 'the fully covered initial create request stays local');
  const body = {
    dialogueId: draft.dialogue.id,
    dialogueVersion: draft.dialogue.version,
    text: 'Измени запись.',
  };
  await assert.rejects(f.turn({ ...body, dialogueVersion: 4 }), { status: 409 });
  await assert.rejects(f.turn({ ...body, choice: 'foreign-choice' }), { status: 400 });
  assert.equal(f.boundary.calls.llm, 0);
  const reply = await f.turn(body);
  assert.equal(reply.intent, 'moveAppointment');
  assert.equal(
    f.boundary.calls.llm,
    1,
    'only the accepted explicit management transition calls the model',
  );
  assert.equal(JSON.stringify(f.world.patients), f.before);
});

test('changing an unconfirmed cancellation to a move never cancels the source appointment', async (t) => {
  const f = await fixture(t);
  const cancellation = await f.turn({ text: 'Отмени запись Анны Семёновой.' });
  assert.equal(cancellation.dialogue.phase, 'cancelConfirmation');
  const reply = await f.turn({
    dialogueId: cancellation.dialogue.id,
    dialogueVersion: cancellation.dialogue.version,
    text: 'Перенеси запись Анны Семёновой.',
  });
  assert.equal(reply.intent, 'moveAppointment');
  assert.equal(reply.dialogue.step, 'date');
  assert.equal(reply.action, null);
  assert.equal(JSON.stringify(f.world.patients), f.before);
});

test('a full repeated move with the same resolved client continues without a second model call', async (t) => {
  const f = await fixture(t);
  const first = await f.turn({ text: 'Перенеси запись Анны Семёновой.' });
  assert.equal(first.dialogue.step, 'date');
  const body = {
    dialogueId: first.dialogue.id,
    dialogueVersion: first.dialogue.version,
    text: 'Перенеси запись Анны Семёновой на час позже.',
  };
  const reply = await f.turn(body);
  assert.equal(reply.intent, undefined);
  assert.equal(
    reply.dialogue,
    null,
    'the selected existing source anchors the relative clock without another date question',
  );
  assert.equal(reply.action?.type, 'appointmentPreview');
  assert.equal(reply.action.operation, 'move');
  assert.equal(reply.action.appointmentId, f.world.patients[0].appointments[0].id);
  assert.equal(reply.action.date, day);
  assert.equal(reply.action.time, '11:00');
  assert.equal(f.boundary.calls.llm, 1, 'the owned continuation does not request another model');
  assert.equal(JSON.stringify(f.world.patients), f.before);
  const replay = await f.turn(body);
  assert.deepEqual(replay.action, reply.action);
  assert.equal(replay.action.time, '11:00', 'a repeated receipt cannot apply the shift twice');
  assert.equal(f.boundary.calls.llm, 1);
});

test('an explicit plural calendar command leaves a booking question without editing or saving a record', async (t) => {
  const f = await fixture(t);
  const draft = await f.turn({ text: 'Создай новую запись.' });
  assert.equal(f.boundary.calls.llm, 0, 'the fully covered initial create request stays local');
  assert.equal(draft.dialogue.step, 'client');
  const body = {
    dialogueId: draft.dialogue.id,
    dialogueVersion: draft.dialogue.version,
    text: 'Открой записи на 21',
  };
  await assert.rejects(f.turn({ ...body, dialogueVersion: draft.dialogue.version + 1 }), {
    status: 409,
  });
  assert.equal(f.boundary.calls.llm, 0);
  const reply = await f.turn(body);
  assert.equal(reply.intent, 'calendar');
  assert.equal(reply.action.type, 'calendar');
  assert.equal(reply.action.date.slice(8), '21');
  assert.equal(reply.action.mode, 'day');
  assert.equal(reply.dialogue, undefined);
  assert.equal(JSON.stringify(f.world.patients), f.before);
  await assert.rejects(f.turn(body), { status: 409 });
  assert.equal(f.boundary.calls.llm, 0, 'the fully covered calendar command does not call a model');
});

test('a same-client named clock answer retains the already stated destination date through service routing', async (t) => {
  const f = await fixture(t);
  const first = await f.turn({ text: 'Перенеси запись Анны Семёновой на завтра.' });
  assert.equal(first.dialogue.step, 'time');
  const targetDate = first.dialogue.fields.find((row) => row.key === 'date').value;
  const reply = await f.turn({
    dialogueId: first.dialogue.id,
    dialogueVersion: first.dialogue.version,
    text: 'Перенеси запись Анны Семёновой на 16:00',
  });
  assert.equal(reply.dialogue.id, first.dialogue.id);
  assert.equal(reply.dialogue.fields.find((row) => row.key === 'date').value, targetDate);
  assert.equal(reply.dialogue.fields.find((row) => row.key === 'time').value, '16:00');
  assert.equal(reply.dialogue.phase, 'closedDay');
  assert.equal(reply.action, null);
  assert.equal(f.boundary.calls.llm, 1);
  assert.equal(JSON.stringify(f.world.patients), f.before);
});
