const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  detectRequestedOperation,
} = require('../src/server/modules/assistant/interpretation/requested-operation.cjs');
const {
  assertIntentAction,
} = require('../src/server/modules/assistant/interpretation/intent-action-grounding.cjs');
const {
  localManagementIntent,
  normalizeManagementRequest,
  prepareManagementIntent,
} = require('../src/server/modules/assistant/actions/appointments/appointment-management-intent.cjs');
const {
  demoIntent,
  modelPayload,
} = require('../src/server/modules/assistant/interpretation/intents.cjs');
const {
  createAppointmentManagementFlow,
} = require('../src/server/modules/assistant/actions/appointments/appointment-management-flow.cjs');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const { nextDate } = require('../src/shared/work-schedule.cjs');
const clock = { date: day, hour: 8, minute: 0 };
const aliases = [
  'Измени',
  'Изменить',
  'Измените',
  'Поменяй',
  'Поменять',
  'Поменяйте',
  'Перенеси',
  'Перенести',
  'Перенесите',
  'Передвинь',
  'Передвинуть',
  'Передвиньте',
  'Сдвинь',
  'Сдвинуть',
  'Сдвиньте',
  'Перезапиши',
  'Перезаписать',
  'Перезапишите',
];

test('shared finite management grammar maps natural appointment changes to rescheduling in model and demo routes', () => {
  for (const verb of aliases) {
    const raw = verb + ' запись Морозовой.';
    assert.equal(detectRequestedOperation(raw).intent, 'moveAppointment', raw);
    assert.equal(demoIntent(raw, clock).intent, 'moveAppointment', raw);
    const parsed = normalizeManagementRequest({ intent: 'help' }, raw, clock);
    assert.equal(parsed.intent, 'moveAppointment', raw);
    assert.equal(parsed.query, 'Морозовой', raw);
    assert.doesNotThrow(() => assertIntentAction(raw, parsed.intent));
    const grounded = prepareManagementIntent(parsed, raw, clock);
    assert.equal(grounded.intent.query, 'Морозовой', raw);
    assert.equal(grounded.intent.date, undefined);
    assert.equal(grounded.intent.time, undefined);
    assert.equal(
      normalizeManagementRequest({ intent: 'editAppointment', query: 'Морозова' }, raw, clock)
        .intent,
      'moveAppointment',
      raw,
    );
  }
});

test('missing client is an ordinary management clarification rather than an unknown task', () => {
  for (const raw of [
    'Измени запись клиента.',
    'Поменяй запись.',
    'Можно перенести запись?',
    'Пожалуйста, передвиньте приём клиента.',
    'Перезапиши запись клиентки.',
  ]) {
    const parsed = normalizeManagementRequest({ intent: 'help' }, raw, clock);
    assert.equal(parsed.intent, 'moveAppointment', raw);
    assert.equal(parsed.query, undefined, raw);
  }
});

test('polite wrappers target coordinates and inflected full client source survive the same route', () => {
  for (const raw of [
    'Пожалуйста, поменяйте запись Анны Морозовой на завтра в14:30.',
    'Мне нужно изменить запись Анны Морозовой на завтра в14:30.',
    'Завтра в14:30 передвинь приём Анны Морозовой.',
    'Измени время записи Анны Морозовой на завтра в14:30.',
    'Поменяй дату записи Анны Морозовой на завтра в14:30.',
  ]) {
    const parsed = normalizeManagementRequest({ intent: 'help' }, raw, clock);
    assert.equal(parsed.intent, 'moveAppointment', raw);
    const grounded = prepareManagementIntent(parsed, raw, clock);
    assert.equal(grounded.intent.query, 'Анны Морозовой', raw);
    assert.equal(grounded.constraints.date, nextDate(day), raw);
    assert.equal(grounded.constraints.time, '14:30', raw);
  }
});

test('explicit field edits and opening an existing appointment are never reinterpreted as rescheduling', () => {
  for (const raw of [
    'Измени услугу в записи Морозовой.',
    'Поменяй длительность записи Морозовой.',
    'Измени запись Морозовой, услугу на пилинг.',
  ]) {
    assert.equal(detectRequestedOperation(raw).intent, 'editAppointment', raw);
    assert.equal(normalizeManagementRequest({ intent: 'help' }, raw, clock).intent, 'help');
    assert.equal(localManagementIntent(raw, clock), null);
  }
  const raw = 'Открой запись Анны Морозовой.';
  assert.equal(detectRequestedOperation(raw).intent, 'editAppointment');
  assert.equal(
    normalizeManagementRequest({ intent: 'editAppointment', query: 'Анна Морозова' }, raw, clock)
      .intent,
    'editAppointment',
  );
});

test('cancellation stays cancellation and no move alias silently replaces or invents it', () => {
  for (const raw of [
    'Отмени запись Морозовой.',
    'Отменить приём Морозовой.',
    'Отмените запись Анны Морозовой.',
    'Отмена записи Морозовой',
  ]) {
    assert.equal(detectRequestedOperation(raw).intent, 'cancelAppointment', raw);
    assert.equal(demoIntent(raw, clock).intent, 'cancelAppointment', raw);
    assert.equal(
      normalizeManagementRequest({ intent: 'help' }, raw, clock).intent,
      'cancelAppointment',
      raw,
    );
    assert.equal(
      normalizeManagementRequest({ intent: 'cancelAppointment', query: 'Морозова' }, raw, clock)
        .intent,
      'cancelAppointment',
    );
  }
  const raw = 'Измени запись Морозовой.';
  const wrong = normalizeManagementRequest(
    { intent: 'cancelAppointment', query: 'Морозова' },
    raw,
    clock,
  );
  assert.equal(wrong.intent, 'moveAppointment');
  assert.doesNotThrow(() => assertIntentAction(raw, wrong.intent));
});

test('deleting one explicitly named appointment routes to the existing cancellation gate', () => {
  for (const verb of ['Удали', 'Удалить', 'Удалите'])
    for (const noun of ['запись', 'приём', 'прием']) {
      const raw = verb + ' ' + noun + ' Анны Морозовой на завтра в 18:00.';
      const requested = detectRequestedOperation(raw);
      assert.equal(requested.intent, 'cancelAppointment', raw);
      assert.equal(requested.ambiguous, false, raw);
      assert.equal(requested.negated, false, raw);
      assert.equal(demoIntent(raw, clock).intent, 'cancelAppointment', raw);
      const parsed = normalizeManagementRequest({ intent: 'help' }, raw, clock);
      assert.equal(parsed.intent, 'cancelAppointment', raw);
      assert.doesNotThrow(() => assertIntentAction(raw, parsed.intent));
      const grounded = prepareManagementIntent(parsed, raw, clock);
      assert.equal(grounded.intent.query, 'Анны Морозовой', raw);
      assert.equal(grounded.intent.date, nextDate(day), raw);
      assert.equal(grounded.intent.time, '18:00', raw);
      assert.throws(() => assertIntentAction(raw, 'moveAppointment'), { status: 502 });
    }
});

test('deletion aliases cannot hide negative conditional alternative bulk or secondary actions', () => {
  for (const raw of [
    'Не удали запись Морозовой.',
    'Не удаляй запись Морозовой.',
    'Не удаляйте приём Морозовой.',
    'Если свободно, удали запись Морозовой.',
    'Удали запись Морозовой, если она согласна.',
    'Удали запись Морозовой при условии согласия.',
    'В случае согласия удали приём Морозовой.',
    'Удали запись Морозовой или Ивановой.',
    'Удали приём Морозовой либо Ивановой.',
    'Удали запись Морозовой и Ивановой.',
    'Удали все записи Морозовой.',
    'Удали запись Морозовой и удали фото.',
    'Удали запись Морозовой и перенеси запись Ивановой.',
    'Перенеси запись Морозовой и удали запись Ивановой.',
    'Удали клиента Морозову.',
    'Удали карточку Морозовой.',
    'Удали фото.',
    'Удалить всё.',
  ]) {
    const requested = detectRequestedOperation(raw);
    assert.ok(requested.negated || requested.ambiguous, raw);
    assert.equal(localManagementIntent(raw, clock), null, raw);
    assert.equal(normalizeManagementRequest({ intent: 'help' }, raw, clock).intent, 'help', raw);
    assert.throws(() => assertIntentAction(raw, 'cancelAppointment'), { status: 400 }, raw);
    assert.throws(
      () =>
        prepareManagementIntent({ intent: 'cancelAppointment', query: 'Морозовой' }, raw, clock),
      { status: 400 },
      raw,
    );
    assert.doesNotThrow(() => assertIntentAction(raw, 'help'));
  }
});

test('negations compound actions unsupported conditions and invented model fields cannot start a local move', () => {
  for (const raw of [
    'Не передвигай запись Морозовой.',
    'Не сдвигайте приём Морозовой.',
    'Не меняй запись Морозовой.',
    'Не перезаписывай Морозову.',
    'Перенеси запись Морозовой и отмени запись Ивановой.',
    'Поменяй запись Морозовой и создай другую.',
    'Если свободно, перенеси запись Морозовой.',
    'Измени все записи Морозовой.',
    'Передвинь запись Морозовой на другого сотрудника.',
  ]) {
    assert.equal(localManagementIntent(raw, clock), null, raw);
    assert.equal(normalizeManagementRequest({ intent: 'help' }, raw, clock).intent, 'help', raw);
  }
  const raw = 'Поменяй запись Морозовой.';
  const grounded = prepareManagementIntent(
    normalizeManagementRequest(
      { intent: 'editAppointment', query: 'Морозова', date: '2099-12-31', time: '12:30' },
      raw,
      clock,
    ),
    raw,
    clock,
  );
  assert.equal(grounded.intent.date, undefined);
  assert.equal(grounded.intent.time, undefined);
  assert.equal(detectRequestedOperation('Запиши Передвигину Анну.').intent, 'prepareAppointment');
});

function fixture({ appointments = 1, role = 'owner' } = {}) {
  const f = dialogueFixture({ role });
  if (role === 'cosmetologist') f.members[0].role = role;
  Object.assign(f.patients[0], { firstName: 'Анна', lastName: 'Морозова', name: 'Анна Морозова' });
  const source = {
    id: randomUUID(),
    date: day,
    time: '10:00',
    duration: 30,
    staffId: 'owner',
    roomId: 'main',
    service: 'Историческая консультация',
    serviceItems: [
      { id: 'old-service', name: 'Историческая консультация', duration: 30, price: 700 },
    ],
    notes: 'Синтетическая заметка',
  };
  f.patients[0].appointments = Array.from({ length: appointments }, (_, index) => ({
    ...structuredClone(source),
    id: index ? randomUUID() : source.id,
    time: index ? '15:00' : '10:00',
  }));
  const store = f.c.tenantStore('org');
  store.readSelected = (ids) => ({
    patients: f.patients.filter((row) => ids.includes(row.id)),
    services: [],
    revision: 1,
  });
  store.read = () => {
    throw Error('No full scan');
  };
  store.indexes.appointments = () => f.patients.flatMap((row) => row.appointments).concat(f.busy);
  for (const name of ['save', 'write', 'saveAppointment'])
    store[name] = () => {
      throw Error('NO_SAVE');
    };
  f.c.platform.workSchedules.view = () => ({
    days: {
      [day]: { status: 'working', intervals: [['09:00', '18:00']] },
      [nextDate(day)]: { status: 'working', intervals: [['09:00', '18:00']] },
    },
    closures: {},
  });
  const before = JSON.stringify(f.patients);
  const flow = createAppointmentManagementFlow({ memory: f.flow });
  let result;
  const start = (raw, proposed = { intent: 'help' }) => {
    const parsed = normalizeManagementRequest(proposed, raw, f.clock);
    assertIntentAction(raw, parsed.intent);
    const prepared = prepareManagementIntent(parsed, raw, f.clock);
    result = flow.start(
      f.c,
      prepared.intent,
      f.state,
      f.member,
      f.clock,
      f.flow.beginCommand(f.c, f.member, f.state),
      prepared.constraints,
    );
    return result;
  };
  const answer = (operation) => {
    result = flow.continueDialogue(
      f.c,
      { dialogueId: result.dialogue.id, dialogueVersion: result.dialogue.version, ...operation },
      f.state,
      f.member,
      f.clock,
    );
    return result;
  };
  return {
    ...f,
    flow,
    source,
    start,
    answer,
    before,
    get result() {
      return result;
    },
  };
}

test('every reschedule alias reaches a date question and a no-save preview preserving existing appointment facts', () => {
  for (const role of ['owner', 'salon_admin', 'cosmetologist'])
    for (const verb of aliases) {
      const f = fixture({ role });
      const started = f.start(verb + ' запись Морозовой.');
      assert.equal(started.dialogue.step, 'date', role + '/' + verb);
      assert.equal(started.dialogue.prompt, 'На какую дату перенести?');
      assert.doesNotMatch(started.text, /Что нужно сделать/u);
      const done = f.answer({ text: 'завтра в 12:30' });
      assert.equal(done.action.type, 'appointmentPreview');
      assert.equal(done.action.operation, 'move');
      assert.equal(done.action.patientId, f.patients[0].id);
      assert.equal(done.action.appointmentId, f.source.id);
      assert.equal(done.action.date, nextDate(day));
      assert.equal(done.action.time, '12:30');
      assert.equal(JSON.stringify(f.patients), f.before);
      assert.equal(f.patients[0].appointments[0].duration, 30);
      assert.equal(f.patients[0].appointments[0].serviceItems[0].id, 'old-service');
    }
});

test('missing client asks for a person and then continues the same rescheduling request', () => {
  const f = fixture();
  const start = f.start('Измени запись клиента.');
  assert.equal(start.dialogue.step, 'client');
  assert.doesNotMatch(start.text, /Что нужно сделать/u);
  const person = f.answer({ text: 'Морозова' });
  assert.equal(person.dialogue.step, 'date');
  const date = f.answer({ text: 'завтра' });
  assert.equal(date.dialogue.step, 'time');
  assert.equal(date.action, null);
  const done = f.answer({ text: 'в 10:00' });
  assert.equal(done.action.operation, 'move');
  assert.equal(done.action.time, '10:00');
  assert.equal(JSON.stringify(f.patients), f.before);
});

test('several future records require the actual source before rescheduling and do not choose the first', () => {
  const f = fixture({ appointments: 2 });
  const start = f.start('Измени запись Морозовой.');
  assert.equal(start.dialogue.step, 'appointment');
  assert.equal(start.dialogue.prompt, 'Во сколько запись?');
  assert.equal(start.dialogue.options.length, 2);
  const selectedId = f.patients[0].appointments[1].id;
  const target = f.answer({ choice: start.dialogue.options[1].id });
  assert.equal(target.dialogue.step, 'date');
  const done = f.answer({ text: 'завтра в 12:30' });
  assert.equal(done.action.operation, 'move');
  assert.equal(done.action.appointmentId, selectedId);
  assert.equal(JSON.stringify(f.patients), f.before);
});

test('explicit create phrases require an appointment object and preserve unsupported secondary action guards', () => {
  for (const phrase of [
    'Создай новую запись',
    'Создать запись',
    'Создай запись',
    'Новый приём',
    'Новая запись',
    'Оформи запись',
    'Заведи запись',
  ]) {
    const raw = phrase + ' Анну Морозову на завтра в14:30.';
    const requested = detectRequestedOperation(raw);
    assert.equal(requested.intent, 'prepareAppointment', raw);
    assert.equal(requested.ambiguous, false, raw);
    assert.equal(
      normalizeManagementRequest({ intent: 'help' }, phrase, clock).intent,
      'prepareAppointment',
      phrase,
    );
    assert.equal(demoIntent(raw, clock).intent, 'prepareAppointment', raw);
    assert.equal(demoIntent(raw, clock).query, 'Анну Морозову', raw);
    assert.doesNotThrow(() => assertIntentAction(raw, 'prepareAppointment'));
  }
  for (const raw of [
    'Создай клиента Морозову.',
    'Создать компанию.',
    'Оформи оплату.',
    'Заведи сотрудника.',
  ]) {
    assert.notEqual(detectRequestedOperation(raw).intent, 'prepareAppointment', raw);
    assert.notEqual(demoIntent(raw, clock).intent, 'prepareAppointment', raw);
  }
  for (const raw of [
    'Создай запись Анны и сохрани другую.',
    'Создай запись Анны и удали другую.',
    'Запиши Анну и создай клиента.',
    'Создай запись Анны и создай запись Иры.',
  ]) {
    assert.equal(detectRequestedOperation(raw).ambiguous, true, raw);
    assert.throws(() => assertIntentAction(raw, 'prepareAppointment'), { status: 400 });
  }
  for (const raw of [
    'Не создавай новую запись.',
    'Не оформляй запись Анны.',
    'Не заводи приём Морозовой.',
  ]) {
    assert.equal(detectRequestedOperation(raw).negated, true, raw);
    assert.throws(() => assertIntentAction(raw, 'prepareAppointment'), { status: 400 });
  }
});

test('actual assistant model boundary routes help to rescheduling and explicit creates to the existing autosave token', async (t) => {
  const { assistantBoundariesFixture } = require('./helpers/assistant-boundaries-fixture.cjs');
  const { createAssistant } = require('../src/server/modules/assistant/service.cjs');
  const { defaults } = require('../src/server/modules/workspace/policy.cjs');
  const boundary = await assistantBoundariesFixture(t, { grantRoles: ['owner'] });
  const clinical = fixture(),
    actor = boundary.current('owner');
  const storage = clinical.c.tenantStore('org');
  clinical.members[0].accountId = actor.accountId;
  clinical.services[0].staffId = actor.accountId;
  clinical.patients[0].createdBy = actor.accountId;
  clinical.patients[0].appointments[0].staffId = actor.accountId;
  const before = JSON.stringify(clinical.patients);
  const context = boundary.context('owner');
  context.tenantStore = (organizationId) => {
    assert.equal(organizationId, actor.organizationId);
    return storage;
  };
  context.platform = {
    ...boundary.store,
    workspaceMembers: () => clinical.members,
    workspaceSettings: () => defaults(actor.accountId),
    workSchedules: clinical.c.platform.workSchedules,
    bookingRequests: { reserves: () => [] },
    personalEvents: { occupancy: () => [] },
  };
  const api = createAssistant(
    { ...boundary.database, organizationTimeZone: boundary.store.organizationTimeZone },
    {
      directory: boundary.platformDirectory,
      ...boundary.ports,
      appointmentSavingEnabled: true,
    },
  );
  let model = { intent: 'help' };
  boundary.hooks.llm = () => ({ text: JSON.stringify(model) });
  const moved = await api.turn(context, {
    policyVersion: boundary.revision(),
    text: 'Измени запись Морозовой.',
  });
  assert.equal(moved.intent, 'moveAppointment');
  assert.equal(moved.dialogue.step, 'date');
  assert.doesNotMatch(moved.text, /Что нужно сделать/u);
  const moveReady = await api.turn(context, {
    policyVersion: boundary.revision(),
    dialogueId: moved.dialogue.id,
    dialogueVersion: moved.dialogue.version,
    text: '2099-01-06 в12:30',
  });
  assert.equal(moveReady.action.type, 'moveAppointment');
  assert.match(moveReady.action.executionId, /^[a-f0-9-]{36}$/u);
  assert.equal(
    clinical.patients[0].appointments[0].time,
    '10:00',
    'the enabled turn still never executes a clinical write',
  );
  assert.equal(
    boundary.calls.llm,
    1,
    'local management clarification does not ask the model again',
  );
  const missing = await api.turn(context, {
    policyVersion: boundary.revision(),
    text: 'Создай новую запись.',
  });
  assert.equal(missing.intent, 'prepareAppointment');
  assert.equal(missing.dialogue.step, 'client');
  assert.doesNotMatch(missing.text, /Что нужно сделать/u);
  model = {
    intent: 'prepareAppointment',
    query: 'Анна Морозова',
    serviceQuery: 'Чистка',
    date: day,
    time: '12:30',
  };
  for (const phrase of [
    'Создай новую запись',
    'Создать запись',
    'Создай запись',
    'Новый приём',
    'Оформи запись',
    'Заведи запись',
  ]) {
    const created = await api.turn(context, {
      policyVersion: boundary.revision(),
      text: phrase + ' Анну Морозову на Чистку на ' + day + ' в12:30.',
    });
    assert.equal(created.intent, 'prepareAppointment', phrase);
    assert.equal(created.action.type, 'createAppointment', phrase);
    assert.equal(typeof created.action.executionId, 'string', phrase);
    assert.equal(created.dialogue, null, phrase);
  }
  assert.equal(
    JSON.stringify(clinical.patients),
    before,
    'tokens and previews do not write appointments',
  );
});
