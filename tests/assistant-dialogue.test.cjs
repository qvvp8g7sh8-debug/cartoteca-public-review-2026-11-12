const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const {
  createDialogueStore,
  TTL_MS,
  MAX_DIALOGUES,
} = require('../src/server/modules/assistant/dialogue/dialogue-store.cjs');
const { parseDuration } = require('../src/server/modules/assistant/dialogue/dialogue-input.cjs');
const complete = { query: 'Анну Семенову', serviceQuery: 'Чистка', date: day, time: '10:00' };

test('dialogue asks only missing fields and emits an ordinary form only after explicit review', () => {
  const f = dialogueFixture();
  const first = f.start(complete);
  assert.equal(first.dialogue.step, 'review');
  assert.equal(first.action, null);
  assert.equal(first.dialogue.fields.find((row) => row.key === 'duration').value, '30 мин');
  const done = f.answer({ choice: first.dialogue.options[0].id }).result;
  assert.equal(done.dialogue, null);
  assert.deepEqual(done.action, {
    type: 'prepareAppointment',
    patientId: f.patients[0].id,
    staffId: 'owner',
    date: day,
    time: '10:00',
    duration: 30,
    roomId: 'main',
    serviceIds: ['clean'],
  });
  assert.match(done.text, /^Подготовил запись: /u);
  assert.equal(f.patients[0].appointments.length, 0);
});

test('ambiguity uses opaque bounded choices and never trusts a browser patient ID', () => {
  const f = dialogueFixture({ ambiguous: true });
  f.patients[1].phone = f.patients[0].phone;
  const first = f.start({ ...complete, query: f.patients[0].phone });
  assert.equal(first.dialogue.step, 'client');
  assert.equal(first.dialogue.options.length, 2);
  assert.ok(
    first.dialogue.options.every(
      (choice) => !f.patients.some((patient) => choice.id === patient.id),
    ),
  );
  assert.doesNotMatch(JSON.stringify(first), /79991112233|79991114455/);
  assert.throws(() => f.answer({ choice: f.patients[0].id }), { status: 409 });
  const next = f.answer({ choice: first.dialogue.options[0].id }).result;
  assert.equal(next.dialogue.step, 'review');
});

test('typed answers fill missing date/time and explicit duration for a selected catalog service', () => {
  const f = dialogueFixture();
  const first = f.start({ query: 'Анна Семёнова' }, { requireDuration: true });
  assert.equal(first.dialogue.step, 'service');
  f.answer({ text: 'Чистка' });
  assert.equal(f.result.dialogue.step, 'date');
  f.answer({ text: day });
  assert.equal(f.result.dialogue.step, 'duration');
  f.answer({ text: 'полчаса' });
  assert.equal(f.result.dialogue.step, 'time');
  assert.equal(f.result.dialogue.phase, 'period');
  assert.match(f.result.text, /весь рабочий день свободен/iu);
  f.answer({ text: '11:30' });
  assert.equal(f.result.dialogue.step, 'review');
  assert.equal(f.result.action, null);
  assert.equal(f.patients[0].appointments.length, 0);
  const done = f.answer({ choice: f.result.dialogue.options[0].id }).result;
  assert.equal(done.action.patientId, f.patients[0].id);
  assert.equal(done.action.date, day);
  assert.equal(done.action.time, '11:30');
  assert.equal(done.action.duration, 30);
  assert.deepEqual(done.action.serviceIds, ['clean']);
  assert.equal(f.patients[0].appointments.length, 0);
});

test('editing the sole default specialist keeps the freshly available service and all other booking fields', () => {
  const f = dialogueFixture();
  f.start(complete);
  const before = f.flow.get(f.c, f.member, f.state, f.result.dialogue.id).data;
  const patient = structuredClone(before.patient);
  f.services[0].duration = 45;
  f.answer({ edit: 'staff' });
  assert.equal(f.result.dialogue.step, 'review');
  const after = f.flow.get(f.c, f.member, f.state, f.result.dialogue.id).data;
  assert.equal(after.staff.id, 'owner');
  assert.equal(after.staff.label, 'Тестовый Специалист');
  assert.equal(after.service.id, 'clean');
  assert.equal(after.service.label, 'Чистка');
  assert.equal(after.duration, 45);
  assert.deepEqual(after.patient, patient);
  assert.equal(after.date, day);
  assert.equal(after.time, '10:00');
  assert.equal(f.result.action, null);
  assert.equal(f.patients[0].appointments.length, 0);
  const ready = f.answer({ text: 'открой форму' }).result;
  assert.equal(ready.action.patientId, patient.id);
  assert.equal(ready.action.staffId, 'owner');
  assert.deepEqual(ready.action.serviceIds, ['clean']);
  assert.equal(ready.action.duration, 45);
  assert.equal(ready.action.date, day);
  assert.equal(ready.action.time, '10:00');
});

test('exact continuation retry replays the last response and stale different input is rejected', () => {
  const f = dialogueFixture();
  f.start({ query: 'Анна Семёнова' });
  const accepted = f.answer({ choice: f.result.dialogue.options[0].id });
  const replay = f.flow.continueDialogue(f.c, accepted.body, f.state, f.member, f.clock);
  assert.deepEqual(replay, accepted.result);
  assert.throws(
    () =>
      f.flow.continueDialogue(
        f.c,
        { ...accepted.body, choice: randomUUID() },
        f.state,
        f.member,
        f.clock,
      ),
    { status: 409 },
  );
});

test('retries recheck visible client references instead of replaying a removed client label', () => {
  const f = dialogueFixture();
  f.start({ ...complete, time: undefined });
  const accepted = f.answer({ text: '10:00' });
  f.patients.splice(0);
  f.changed();
  const replay = f.flow.continueDialogue(f.c, accepted.body, f.state, f.member, f.clock);
  assert.equal(replay.dialogue.step, 'client');
  assert.equal(
    replay.dialogue.fields.some((row) => row.key === 'client'),
    false,
  );
});

test('busy time is freshly rejected before form handoff and exact final retry remains safe', () => {
  const f = dialogueFixture();
  f.start(complete);
  const accepted = f.answer({ choice: f.result.dialogue.options[0].id });
  f.busy.push({ date: day, time: '10:00', duration: 30, staffId: 'owner', roomId: 'main' });
  const replay = f.flow.continueDialogue(f.c, accepted.body, f.state, f.member, f.clock);
  assert.equal(replay.action, null);
  assert.equal(replay.dialogue.step, 'time');
  assert.equal(f.patients[0].appointments.length, 0);
});

test('cancel is idempotent and arbitrary pending text cannot execute another action', () => {
  const f = dialogueFixture();
  f.start({ query: 'Анна Семёнова' });
  const id = f.result.dialogue.id;
  const answer = f.answer({ text: 'Открой настройки' }).result;
  assert.equal(answer.action, null);
  assert.equal(answer.dialogue.step, 'service');
  const body = { dialogueId: id, policyVersion: f.state.revision, cancel: true };
  assert.equal(f.flow.continueDialogue(f.c, body, f.state, f.member, f.clock).dialogue, null);
  assert.equal(f.flow.continueDialogue(f.c, body, f.state, f.member, f.clock).dialogue, null);
});

test('dialogue scope binds session, membership, organization and policy revision', () => {
  const f = dialogueFixture();
  f.start(complete);
  const body = { dialogueId: f.result.dialogue.id, dialogueVersion: 0, text: '10:00' };
  for (const changed of [
    { sessionId: 'other' },
    { organizationId: 'other' },
    { role: 'salon_admin' },
  ])
    assert.throws(
      () =>
        f.flow.continueDialogue(
          { ...f.c, current: { ...f.c.current, ...changed } },
          body,
          f.state,
          f.member,
          f.clock,
        ),
      { status: 409 },
    );
  assert.throws(
    () => f.flow.continueDialogue(f.c, body, { ...f.state, revision: 4 }, f.member, f.clock),
    { status: 409 },
  );
  assert.throws(
    () => f.flow.continueDialogue(f.c, body, f.state, { membershipId: 'other' }, f.clock),
    { status: 409 },
  );
});

test('volatile store expires, applies backpressure without evicting active dialogues and rejects superseded commands', () => {
  let now = 1000;
  const memory = createDialogueStore({ now: () => now });
  const f = dialogueFixture(),
    ticket = memory.beginCommand(f.c, f.member, f.state);
  const first = memory.create(f.c, f.member, f.state, ticket, {});
  now += TTL_MS;
  assert.throws(() => memory.get(f.c, f.member, f.state, first.id), { status: 409 });
  const nextTicket = memory.beginCommand(f.c, f.member, f.state);
  memory.beginCommand(f.c, f.member, f.state);
  assert.throws(() => memory.assertCommand(nextTicket), { status: 409 });
  memory.clearAccount(f.c.current.accountId);
  let oldest;
  for (let index = 0; index < MAX_DIALOGUES; index++) {
    const c = { ...f.c, current: { ...f.c.current, accountId: 'a-' + index } };
    const command = memory.beginCommand(c, f.member, f.state),
      entry = memory.create(c, f.member, f.state, command, {});
    if (!index) oldest = { c, id: entry.id };
  }
  const another = { ...f.c, current: { ...f.c.current, accountId: 'over-capacity' } };
  assert.throws(() => memory.beginCommand(another, f.member, f.state), {
    status: 503,
    code: 'ASSISTANT_DIALOGUE_CAPACITY',
  });
  assert.equal(memory.get(oldest.c, f.member, f.state, oldest.id).id, oldest.id);
  assert.equal(memory.stats().pending.active, 0);
});

test('duration parser supports bounded phrases and rejects malformed or unsafe minutes', () => {
  for (const [text, expected] of [
    ['полчаса', 30],
    ['час', 60],
    ['полтора часа', 90],
    ['2 часа', 120],
    ['45 минут', 45],
  ])
    assert.equal(parseDuration(text), expected);
  for (const text of ['0', '-30', '31', '1445', '30; delete()', 'сотня'])
    assert.equal(parseDuration(text), null);
});

test('availability windows use opaque choices and seed only a verified server slot', () => {
  const f = dialogueFixture(),
    ticket = f.flow.beginCommand(f.c, f.member, f.state);
  const slot = {
    date: day,
    time: '10:00',
    endTime: '10:30',
    duration: 30,
    staffId: 'owner',
    staffName: 'Тестовый Специалист',
    roomId: 'main',
    serviceIds: ['clean'],
  };
  const initial = f.flow.startAvailability(
    f.c,
    { text: 'Найдены окна', action: null, slots: [slot] },
    f.state,
    f.member,
    f.clock,
    ticket,
  );
  assert.equal(initial.slots, undefined);
  assert.equal(initial.dialogue.step, 'availability');
  assert.notEqual(initial.dialogue.options[0].id, 'owner');
  const selected = f.flow.continueDialogue(
    f.c,
    {
      dialogueId: initial.dialogue.id,
      dialogueVersion: initial.dialogue.version,
      choice: initial.dialogue.options[0].id,
    },
    f.state,
    f.member,
    f.clock,
  );
  assert.equal(selected.dialogue.step, 'client');
  assert.equal(selected.dialogue.fields.find((row) => row.key === 'time').value, '10:00');
  assert.equal(selected.action, null);
});

test('window browsing remains available without preparation permission and exposes no raw IDs', () => {
  const f = dialogueFixture();
  f.state.policy.commands.prepareAppointment = false;
  const ticket = f.flow.beginCommand(f.c, f.member, f.state);
  const value = f.flow.startAvailability(
    f.c,
    {
      text: 'Найдены окна',
      action: null,
      slots: [
        {
          date: day,
          time: '10:00',
          endTime: '10:30',
          duration: 30,
          staffId: 'private-staff-id',
          roomId: 'private-room-id',
          staffName: 'Специалист',
        },
      ],
    },
    f.state,
    f.member,
    f.clock,
    ticket,
  );
  assert.equal(value.dialogue, undefined);
  assert.equal(value.slots, undefined);
  assert.equal(value.readOnlySlots.length, 1);
  assert.doesNotMatch(JSON.stringify(value), /private-staff-id|private-room-id/);
});

test('a bounded declined surname keeps every strict match until the client is narrowed by a full name', () => {
  const f = dialogueFixture({ ambiguous: true });
  const first = f.start({ ...complete, query: 'Семенову' });
  const pending = f.flow.get(f.c, f.member, f.state, first.dialogue.id);
  assert.equal(first.action, null);
  assert.equal(first.dialogue.step, 'client');
  assert.equal(first.dialogue.options.length, 2);
  assert.equal(pending.data.patient, null);
  assert.equal(
    first.dialogue.fields.find((row) => row.key === 'client'),
    undefined,
  );
  assert.deepEqual(
    new Set([...pending.options.values()].map((choice) => choice.value)),
    new Set(f.patients.map((patient) => patient.id)),
  );
  assert.ok(
    [...pending.options.values()].every(
      (choice) => choice.kind === 'client' && !choice.approximate,
    ),
  );
  const next = f.answer({ text: 'Анну Семенову' }).result;
  assert.equal(next.dialogue.step, 'review');
  assert.match(next.dialogue.fields.find((row) => row.key === 'client').value, /Анна Семёнова/);
  assert.equal(next.action, null);
  assert.ok(f.patients.every((patient) => patient.appointments.length === 0));
});
