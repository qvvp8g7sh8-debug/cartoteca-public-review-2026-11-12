const test = require('node:test');
const assert = require('node:assert/strict');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const {
  createAssistantDialogue,
} = require('../src/server/modules/assistant/dialogue/dialogue-flow.cjs');
const {
  createClientCardFlow,
} = require('../src/server/modules/assistant/actions/client-card-flow.cjs');
const {
  createDialogueStore,
} = require('../src/server/modules/assistant/dialogue/dialogue-store.cjs');
const { directoryPage } = require('../src/server/modules/cabinet/directory.cjs');
const { nextDate } = require('../src/shared/work-schedule.cjs');
const {
  createAppointmentManagementFlow,
} = require('../src/server/modules/assistant/actions/appointments/appointment-management-flow.cjs');
const {
  appointmentContext,
} = require('../src/server/modules/assistant/actions/availability-context.cjs');
const {
  servicePickerView,
  selectServicePicker,
} = require('../src/server/modules/assistant/dialogue/dialogue-service-picker.cjs');
const pause = () => new Promise((resolve) => setImmediate(resolve));

test('explicit cancel in card and appointment management never starts a data read', async () => {
  for (const target of ['card', 'management']) {
    const f = dialogueFixture({ ambiguous: target === 'card' });
    f.state.policy.commands.clients = true;
    f.patients[0].appointments.push({
      id: 'existing',
      date: day,
      time: '10:00',
      duration: 30,
      staffId: 'owner',
      status: 'scheduled',
    });
    const deferred = deferredContext(f),
      memory = createDialogueStore();
    const flow =
      target === 'card'
        ? createClientCardFlow({ memory })
        : createAppointmentManagementFlow({ memory });
    const result = await flow.start(
      deferred.c,
      { intent: target === 'card' ? 'clientCard' : 'moveAppointment', query: 'Семёнова' },
      f.state,
      f.member,
      f.clock,
      memory.beginCommand(deferred.c, f.member, f.state),
    );
    assert.ok(result.dialogue);
    deferred.c.assistantReads = new Proxy(
      {},
      {
        get() {
          return () => {
            throw Error('Cancellation must not wait on a reader');
          };
        },
      },
    );
    const body = {
      dialogueId: result.dialogue.id,
      dialogueVersion: result.dialogue.version,
      cancel: true,
    };
    const cancelled = flow.continueDialogue(deferred.c, body, f.state, f.member);
    assert.equal(cancelled.then, undefined, target);
    assert.equal(cancelled.action, null);
    assert.equal(cancelled.dialogue, null);
    assert.deepEqual(
      flow.continueDialogue(deferred.c, body, f.state, f.member),
      cancelled,
      'cancel replay retains receipt',
    );
  }
});

function deferredContext(f) {
  const source = f.c,
    storage = source.tenantStore('org');
  let active = true;
  const check = () => {
    if (!active) throw Object.assign(Error('Access revoked during read'), { status: 403 });
  };
  const read =
    (operation) =>
    async (...args) => {
      await pause();
      check();
      return operation(...args);
    };
  const forbidden = () => {
    throw Error('Unexpected sync read in async dialogue');
  };
  const c = {
    ...source,
    assertCurrent: check,
    platform: new Proxy({}, { get: () => forbidden }),
    tenantStore: () => ({
      ...storage,
      get: forbidden,
      readServices: forbidden,
      indexes: { summaryRows: forbidden, appointments: forbidden },
    }),
    assistantReads: {
      appointmentContext: read(() => ({ members: f.members, services: f.services })),
      timeZone: read(() => source.platform.organizationTimeZone('org')),
      revision: read(() => storage.get('revision', 0)),
      serviceGroups: read(() =>
        typeof source.platform.serviceGroups === 'function'
          ? source.platform.serviceGroups('org')
          : { groups: [{ id: 'other', title: 'Другое' }] },
      ),
      selected: read((ids) => ({
        patients: f.patients.filter((row) => ids.includes(row.id)),
        services: f.services,
        revision: storage.get('revision', 0),
      })),
      summaries: read((ids, { predicate } = {}) =>
        f.patients.filter((row) => ids.includes(row.id) && (!predicate || predicate(row))),
      ),
      directory: read((query, limit, { predicate } = {}) => {
        const url = new URL('http://synthetic.invalid/');
        url.searchParams.set('q', query);
        url.searchParams.set('limit', String(limit));
        const scoped = predicate
          ? {
              ...storage,
              indexes: {
                ...storage.indexes,
                summaryRows(actor, ids) {
                  return storage.indexes
                    .summaryRows(actor, ids)
                    .filter((row) => predicate(storage.decode(row.value)));
                },
              },
            }
          : storage;
        return directoryPage(
          scoped,
          source.current,
          url,
          undefined,
          source.platform.organizationTimeZone('org'),
        );
      }),
      availability: read(({ staffIds, from, to, now }) => ({
        appointments: storage.indexes.appointments(nextDate(from, -1), to, { includeNames: false }),
        personalEvents: source.platform.personalEvents.occupancy('org', nextDate(from, -1), to),
        reserves: source.platform.bookingRequests.reserves('org', nextDate(from, -1), to, now),
        settings: source.platform.workspaceSettings('org'),
        schedules: new Map(
          staffIds.map((id) => [
            id,
            source.platform.workSchedules.view(source.token, id, from, to),
          ]),
        ),
        timeZone: source.platform.organizationTimeZone('org'),
      })),
    },
  };
  return {
    c,
    revoke() {
      active = false;
    },
  };
}

function semantic(reply) {
  const result = structuredClone(reply);
  if (result.dialogue) {
    delete result.dialogue.id;
    delete result.dialogue.expiresAt;
    for (const row of [...result.dialogue.options, ...(result.dialogue.controls || [])])
      delete row.id;
  }
  return result;
}
function begin(flow, c, f, intent) {
  return flow.start(c, intent, f.state, f.member, f.clock, flow.beginCommand(c, f.member, f.state));
}
function continuation(reply, text) {
  return { dialogueId: reply.dialogue.id, dialogueVersion: reply.dialogue.version, text };
}

test('async booking matches the complete sync clarification flow and keeps save manual', async () => {
  const f = dialogueFixture(),
    deferred = deferredContext(f);
  const sync = createAssistantDialogue(),
    asyncFlow = createAssistantDialogue();
  let expected = begin(sync, f.c, f, { intent: 'prepareAppointment', query: 'Семёнова' });
  let actual = await begin(asyncFlow, deferred.c, f, {
    intent: 'prepareAppointment',
    query: 'Семёнова',
  });
  assert.deepEqual(semantic(actual), semantic(expected));
  for (const text of ['Чистка', 'пятое января 2099', 'в 11:00', 'да']) {
    if (!expected.dialogue) break;
    expected = sync.continueDialogue(f.c, continuation(expected, text), f.state, f.member, f.clock);
    actual = await asyncFlow.continueDialogue(
      deferred.c,
      continuation(actual, text),
      f.state,
      f.member,
      f.clock,
    );
    assert.deepEqual(semantic(actual), semantic(expected), text);
  }
  assert.equal(actual.action?.type, 'prepareAppointment');
  assert.equal(actual.action.patientId, f.patients[0].id);
  assert.equal(actual.action.date, day);
  assert.equal(f.patients[0].appointments.length, 0, 'assistant only prepares the form');
});

test('async client card clarification matches sync and default clock also uses async timezone', async () => {
  const f = dialogueFixture({ ambiguous: true }),
    deferred = deferredContext(f);
  f.state.policy.commands.clients = true;
  const syncMemory = createDialogueStore(),
    asyncMemory = createDialogueStore();
  const sync = createClientCardFlow({ memory: syncMemory }),
    asyncFlow = createClientCardFlow({ memory: asyncMemory });
  let expected = sync.start(
    f.c,
    { intent: 'clientCard', query: 'Семёнова' },
    f.state,
    f.member,
    f.clock,
    syncMemory.beginCommand(f.c, f.member, f.state),
  );
  let actual = await asyncFlow.start(
    deferred.c,
    { intent: 'clientCard', query: 'Семёнова' },
    f.state,
    f.member,
    f.clock,
    asyncMemory.beginCommand(deferred.c, f.member, f.state),
  );
  assert.deepEqual(semantic(actual), semantic(expected));
  expected = sync.continueDialogue(f.c, continuation(expected, 'Анна'), f.state, f.member);
  actual = await asyncFlow.continueDialogue(
    deferred.c,
    continuation(actual, 'Анна'),
    f.state,
    f.member,
  );
  assert.deepEqual(semantic(actual), semantic(expected));
  assert.equal(actual.action?.type, 'clientCard');
  assert.equal(actual.action.patientId, f.patients[0].id);
});

test('permission revocation during an async clarification cannot emit a client card', async () => {
  const f = dialogueFixture({ ambiguous: true }),
    deferred = deferredContext(f);
  f.state.policy.commands.clients = true;
  const memory = createDialogueStore(),
    flow = createClientCardFlow({ memory });
  const reply = await flow.start(
    deferred.c,
    { intent: 'clientCard', query: 'Семёнова' },
    f.state,
    f.member,
    f.clock,
    memory.beginCommand(deferred.c, f.member, f.state),
  );
  const pending = flow.continueDialogue(
    deferred.c,
    continuation(reply, 'Анна'),
    f.state,
    f.member,
    f.clock,
  );
  deferred.revoke();
  await assert.rejects(pending, (error) => error.status === 403);
});

test('async closed-day consent preserves owner and employee permissions and response sequence', async () => {
  for (const role of ['owner', 'cosmetologist']) {
    const f = dialogueFixture({ role });
    if (role === 'cosmetologist') f.members[0].role = role;
    f.c.platform.workSchedules.view = () => ({ days: {}, closures: {} });
    const deferred = deferredContext(f),
      sync = createAssistantDialogue(),
      asyncFlow = createAssistantDialogue();
    const intent = {
      intent: 'prepareAppointment',
      query: 'Семёнова',
      serviceQuery: 'Чистка',
      date: day,
    };
    let expected = begin(sync, f.c, f, intent);
    let actual = await begin(asyncFlow, deferred.c, f, intent);
    assert.equal(actual.dialogue.phase, 'closedDay');
    assert.deepEqual(semantic(actual), semantic(expected), role);
    for (const text of ['да', '11:00', 'да']) {
      if (!expected.dialogue) break;
      expected = sync.continueDialogue(
        f.c,
        continuation(expected, text),
        f.state,
        f.member,
        f.clock,
      );
      actual = await asyncFlow.continueDialogue(
        deferred.c,
        continuation(actual, text),
        f.state,
        f.member,
        f.clock,
      );
      assert.deepEqual(semantic(actual), semantic(expected), role + '/' + text);
    }
    if (role === 'owner') assert.equal(actual.action?.type, 'prepareAppointment');
    else assert.equal(actual.action, null);
    assert.equal(f.patients[0].appointments.length, 0);
  }
});

test('async busy-slot correction waits for timezone and offers the same available alternatives', async () => {
  const f = dialogueFixture();
  f.busy.push({
    id: 'busy',
    date: day,
    time: '11:00',
    duration: 30,
    staffId: 'owner',
    status: 'scheduled',
  });
  const deferred = deferredContext(f),
    sync = createAssistantDialogue(),
    asyncFlow = createAssistantDialogue();
  const intent = {
    intent: 'prepareAppointment',
    query: 'Семёнова',
    serviceQuery: 'Чистка',
    date: day,
    time: '11:00',
  };
  const expected = begin(sync, f.c, f, intent);
  const actual = await begin(asyncFlow, deferred.c, f, intent);
  assert.deepEqual(semantic(actual), semantic(expected));
  assert.equal(actual.action, null);
  assert.equal(actual.dialogue.step, 'time');
  assert.doesNotMatch(JSON.stringify(actual), /Promise/);
});

test('async service category selection waits for catalog metadata and retains its signed choices', async () => {
  const f = dialogueFixture();
  f.services[0].category = 'first';
  f.services.push({
    id: 'second-service',
    name: 'Другая услуга',
    duration: 30,
    staffId: 'owner',
    category: 'second',
  });
  f.c.platform.serviceGroups = () => ({
    groups: [
      { id: 'first', title: 'Первая' },
      { id: 'second', title: 'Вторая' },
      { id: 'other', title: 'Другое' },
    ],
  });
  const deferred = deferredContext(f);
  const context = appointmentContext(f.c),
    asyncContext = await appointmentContext(deferred.c);
  const data = { staff: { id: 'owner' } },
    asyncData = structuredClone(data);
  const expected = servicePickerView(f.c, data, context);
  const actual = await servicePickerView(deferred.c, asyncData, asyncContext);
  assert.deepEqual(actual, expected);
  assert.equal(actual.choices[0].kind, 'serviceCategory');
  assert.equal(selectServicePicker(f.c, data, expected.choices[0], context), true);
  assert.equal(
    await selectServicePicker(deferred.c, asyncData, actual.choices[0], asyncContext),
    true,
  );
  assert.deepEqual(asyncData, data);
  assert.deepEqual(
    await servicePickerView(deferred.c, asyncData, asyncContext),
    servicePickerView(f.c, data, context),
  );
});
