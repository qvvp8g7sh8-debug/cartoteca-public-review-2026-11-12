const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const { appointmentContext } = require('../src/server/modules/assistant/actions/availability-context.cjs');
const { availabilityAction } = require('../src/server/modules/assistant/actions/availability-action.cjs');
const field = (result, key) => result.dialogue.fields.find((row) => row.key === key)?.value;
function fixture(role = 'salon_admin') {
  const f = dialogueFixture({ role });
  f.c.current.accountId = role === 'owner' ? 'owner' : role === 'salon_admin' ? 'admin' : 'staff-a';
  f.members.splice(
    0,
    f.members.length,
    { accountId: 'owner', displayName: 'Ирина Владельцева', role: 'owner', status: 'active' },
    {
      accountId: 'admin',
      displayName: 'Ольга Администратор',
      role: 'salon_admin',
      status: 'active',
    },
    {
      accountId: 'staff-a',
      displayName: 'Мария Соколова',
      role: 'cosmetologist',
      status: 'active',
    },
    { accountId: 'staff-b', displayName: 'Елена Петрова', role: 'cosmetologist', status: 'active' },
    {
      accountId: 'paused',
      displayName: 'Павел Петров',
      role: 'cosmetologist',
      status: 'suspended',
    },
  );
  f.services.splice(
    0,
    f.services.length,
    { id: 'owner-clean', name: 'Чистка', duration: 30, staffId: 'owner' },
    { id: 'a-primary', name: 'Первичная консультация', duration: 30, staffId: 'staff-a' },
    { id: 'a-repeat', name: 'Повторная консультация', duration: 20, staffId: 'staff-a' },
    { id: 'b-primary', name: 'Первичная консультация', duration: 45, staffId: 'staff-b' },
    { id: 'b-massage', name: 'Массаж', duration: 60, staffId: 'staff-b' },
    { id: 'paused-secret', name: 'Услуга неактивного', duration: 30, staffId: 'paused' },
    { id: 'admin-invalid', name: 'Услуга администратора', duration: 30, staffId: 'admin' },
  );
  if (role === 'cosmetologist') f.patients[0].createdBy = 'staff-a';
  f.c.platform.workspaceSettings = () => ({
    enabled: false,
    mode: 'separate',
    staffRules: [],
    rooms: [
      {
        id: 'main',
        name: 'Общий',
        active: true,
        staffIds: ['owner', 'staff-a', 'staff-b'],
        preventOverlap: false,
      },
    ],
  });
  f.c.platform.workSchedules.view = () => ({
    days: Object.fromEntries(
      [day, '2099-01-06'].map((date) => [
        date,
        { status: 'working', intervals: [['09:00', '18:00']] },
      ]),
    ),
    closures: {},
  });
  return f;
}
const booking = (f, extra = {}) =>
  f.start({ query: 'Анну Семенову', date: day, time: '10:00', ...extra });
const choose = (f, label) =>
  f.answer({ choice: f.result.dialogue.options.find((row) => row.label.includes(label)).id })
    .result;
const noSave = (f) =>
  assert.equal(
    f.patients.every((row) => row.appointments.length === 0),
    true,
  );

test('administrator selects an active performer and is never silently assigned as performer', () => {
  const f = fixture();
  const first = booking(f, { duration: 30 });
  assert.equal(first.dialogue.step, 'staff');
  assert.deepEqual(
    first.dialogue.options.map((row) => row.label).sort(),
    ['Ирина Владельцева', 'Мария Соколова', 'Елена Петрова'].sort(),
  );
  assert.equal(field(first, 'staff'), undefined);
  assert.equal(choose(f, 'Елена').dialogue.step, 'service');
  assert.deepEqual(f.result.dialogue.options.map((row) => row.label), [
    'Первичная консультация · 45 мин',
    'Массаж · 60 мин',
  ]);
  choose(f, 'Первичная');
  const done = f.answer({ text: 'да' }).result;
  assert.equal(done.action.staffId, 'staff-b');
  assert.deepEqual(done.action.serviceIds, ['b-primary']);
  assert.equal(done.action.duration, 30);
  noSave(f);
});

test('owner defaults to self and an explicit other performer is respected', () => {
  const f = fixture('owner');
  booking(f, { serviceQuery: 'Чистка' });
  assert.equal(field(f.result, 'staff'), 'Ирина Владельцева');
  assert.equal(f.answer({ text: 'да' }).result.action.staffId, 'owner');
  booking(f, { staffQuery: 'Елене Петровой', serviceQuery: 'Первичную консультацию' });
  assert.equal(f.result.dialogue.step, 'review');
  assert.equal(f.answer({ text: 'да' }).result.action.staffId, 'staff-b');
  noSave(f);
});

test('employee sees only own performer and catalog even when naming another performer', () => {
  const f = fixture('cosmetologist');
  const first = booking(f, { staffQuery: 'Елене Петровой', serviceQuery: 'Массаж' });
  assert.equal(first.dialogue.step, 'staff');
  assert.deepEqual(
    first.dialogue.options.map((row) => row.label),
    ['Мария Соколова'],
  );
  assert.doesNotMatch(JSON.stringify(first), /Елена|Массаж|Ирина|Павел|Администратор/);
  assert.throws(() => appointmentContext(f.c, 'staff-b'), { status: 403 });
  choose(f, 'Мария');
  assert.ok(
    f.result.dialogue.options.every((row) => !/Массаж|неактивного|администратора/.test(row.label)),
  );
  assert.equal(f.result.dialogue.step, 'service');
  assert.equal(field(f.result, 'service'), undefined);
  assert.equal(f.result.action, null);
  f.answer({ text: 'Первичная консультация' });
  const done = f.answer({ text: 'да' }).result;
  assert.equal(done.action.staffId, 'staff-a');
  assert.deepEqual(done.action.serviceIds, ['a-primary']);
  assert.equal(done.action.duration, 30);
  noSave(f);
});

test('ambiguous performer names keep opaque choices and never select the first match', () => {
  const f = fixture();
  f.members.push({
    accountId: 'staff-c',
    displayName: 'Мария Иванова',
    role: 'cosmetologist',
    status: 'active',
  });
  const first = booking(f, { staffQuery: 'Марии', serviceQuery: 'Первичную консультацию' });
  assert.equal(first.dialogue.step, 'staff');
  assert.equal(first.dialogue.options.length, 2);
  assert.equal(field(first, 'staff'), undefined);
  assert.ok(
    first.dialogue.options.every((row) => !f.members.some((member) => member.accountId === row.id)),
  );
  choose(f, 'Соколова');
  assert.equal(f.result.dialogue.step, 'review');
  assert.equal(field(f.result, 'staff'), 'Мария Соколова');
  assert.equal(field(f.result, 'service'), 'Первичная консультация');
  assert.deepEqual(f.answer({ text: 'открой форму' }).result.action.serviceIds, ['a-primary']);
  noSave(f);
});

test('employee client matching stays inside the directory ACL when a hidden namesake exists', () => {
  const f = fixture('cosmetologist');
  const visible = f.patients[0];
  f.patients.push({
    ...visible,
    id: randomUUID(),
    createdBy: 'staff-b',
    appointments: [],
    phone: '+79990008888',
  });
  f.changed();
  booking(f, { serviceQuery: 'Первичная консультация' });
  assert.equal(f.result.dialogue.step, 'review');
  assert.doesNotMatch(JSON.stringify(f.result), /8888/);
  assert.equal(f.answer({ text: 'да' }).result.action.patientId, visible.id);
  noSave(f);
});

test('short ambiguous service text exposes only current performer choices rather than choosing one', () => {
  const f = fixture();
  const result = booking(f, { staffQuery: 'Марии Соколовой', serviceQuery: 'консультацию' });
  assert.equal(result.dialogue.step, 'service');
  assert.equal(field(result, 'service'), undefined);
  assert.deepEqual(result.dialogue.options.map((row) => row.label), [
    'Первичная консультация · 30 мин',
    'Повторная консультация · 20 мин',
  ]);
  choose(f, 'Повторная');
  assert.equal(f.answer({ text: 'да' }).result.action.serviceIds[0], 'a-repeat');
  noSave(f);
});

test('changing performer resolves the same exact service in the new catalog and uses its own duration', () => {
  const f = fixture();
  booking(f, { staffQuery: 'Марии Соколовой', serviceQuery: 'Первичную консультацию' });
  const first = f.result;
  assert.equal(field(first, 'duration'), '30 мин');
  f.answer({ text: 'специалиста на Елену Петрову' });
  assert.equal(f.result.dialogue.step, 'review');
  assert.equal(field(f.result, 'service'), 'Первичная консультация');
  assert.equal(field(f.result, 'duration'), '45 мин');
  assert.equal(field(f.result, 'client'), field(first, 'client'));
  assert.equal(field(f.result, 'date'), day);
  assert.equal(field(f.result, 'time'), '10:00');
  assert.equal(f.result.action, null);
  const done = f.answer({ text: 'да' }).result;
  assert.deepEqual(done.action.serviceIds, ['b-primary']);
  assert.equal(done.action.staffId, 'staff-b');
  assert.equal(done.action.duration, 45);
  noSave(f);
});

test('manual duration survives performer and catalog corrections', () => {
  const f = fixture();
  booking(f, {
    staffQuery: 'Марии Соколовой',
    serviceQuery: 'Первичную консультацию',
    duration: 15,
  });
  f.answer({ text: 'специалиста на Елену Петрову, услугу на первичную консультацию' });
  assert.equal(f.result.dialogue.step, 'review');
  assert.equal(field(f.result, 'duration'), '15 мин');
  const done = f.answer({ text: 'да' }).result;
  assert.equal(done.action.staffId, 'staff-b');
  assert.deepEqual(done.action.serviceIds, ['b-primary']);
  assert.equal(done.action.duration, 15);
  noSave(f);
});

test('suspended chosen performer before review handoff cannot open a stale form', () => {
  const f = fixture();
  booking(f, { staffQuery: 'Марии Соколовой', serviceQuery: 'Первичную консультацию' });
  f.members.find((row) => row.accountId === 'staff-a').status = 'suspended';
  const changed = f.answer({ text: 'да' }).result;
  assert.equal(changed.action, null);
  assert.equal(changed.dialogue.step, 'staff');
  assert.ok(changed.dialogue.options.every((row) => row.label !== 'Мария Соколова'));
  noSave(f);
});

test('removed catalog service before review handoff requires a fresh selection', () => {
  const f = fixture();
  booking(f, { staffQuery: 'Марии Соколовой', serviceQuery: 'Первичную консультацию' });
  f.services.splice(
    f.services.findIndex((row) => row.id === 'a-primary'),
    1,
  );
  const changed = f.answer({ text: 'да' }).result;
  assert.equal(changed.action, null);
  assert.equal(changed.dialogue.step, 'service');
  assert.equal(field(changed, 'service'), undefined);
  noSave(f);
});

test('availability respects role scope and catalog ambiguity without guessing a performer', () => {
  const f = fixture();
  const broad = availabilityAction(
    f.c,
    { intent: 'availability', date: day, serviceQuery: 'Первичную консультацию' },
    f.clock,
  );
  assert.equal(broad.action, null);
  assert.equal(broad.slots, undefined);
  assert.match(broad.text, /Повторите запрос.*целиком/);
  const exact = availabilityAction(
    f.c,
    {
      intent: 'availability',
      date: day,
      staffQuery: 'Елене Петровой',
      serviceQuery: 'Первичную консультацию',
    },
    f.clock,
  );
  assert.ok(exact.slots.length > 0);
  assert.ok(exact.slots.every((row) => row.staffId === 'staff-b' && row.duration === 45));
  const employee = fixture('cosmetologist');
  const denied = availabilityAction(
    employee.c,
    { intent: 'availability', date: day, staffQuery: 'Елене Петровой' },
    employee.clock,
  );
  assert.equal(denied.slots, undefined);
  assert.equal(denied.action, null);
  noSave(f);
  noSave(employee);
});

test('a window becoming busy preserves selected performer and refreshes alternatives without Save', () => {
  const f = fixture();
  const offered = booking(f, {
    staffQuery: 'Марии Соколовой',
    serviceQuery: 'Первичную консультацию',
    time: undefined,
  });
  assert.equal(offered.dialogue.step, 'time');
  const chosen = offered.dialogue.options[0];
  const time = chosen.label.match(/(\d{2}:\d{2})/)[1];
  f.busy.push({ date: day, time, duration: 30, staffId: 'staff-a', roomId: 'main' });
  const changed = f.answer({ choice: chosen.id }).result;
  assert.equal(changed.action, null);
  assert.equal(changed.dialogue.step, 'time');
  assert.equal(field(changed, 'staff'), 'Мария Соколова');
  assert.ok(changed.dialogue.options.every((row) => !row.label.includes(time + '–')));
  noSave(f);
});
