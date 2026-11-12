const test = require('node:test');
const assert = require('node:assert/strict');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const field = (result, key) => result.dialogue?.fields.find((row) => row.key === key)?.value;
const noSave = (f) => assert.ok(f.patients.every((row) => row.appointments.length === 0));
function fixture(role = 'owner') {
  const f = dialogueFixture({ role });
  const performer = role === 'cosmetologist' ? 'worker' : 'owner';
  f.c.current.accountId = role === 'salon_admin' ? 'admin' : performer;
  f.members.splice(
    0,
    f.members.length,
    { accountId: 'owner', displayName: 'Ирина Орлова', role: 'owner', status: 'active' },
    {
      accountId: 'admin',
      displayName: 'Ольга Администратор',
      role: 'salon_admin',
      status: 'active',
    },
    ...(role === 'cosmetologist'
      ? [{ accountId: 'worker', displayName: 'Мария Соколова', role, status: 'active' }]
      : []),
  );
  f.services.splice(0, f.services.length, {
    id: 'clean',
    name: 'Чистка',
    duration: 30,
    staffId: performer,
  });
  if (role === 'cosmetologist') f.patients[0].createdBy = performer;
  f.c.platform.workspaceSettings = () => ({
    enabled: false,
    mode: 'separate',
    staffRules: [],
    rooms: [
      {
        id: 'main',
        name: 'Общий',
        active: true,
        staffIds: ['owner', 'worker', 'other', 'staff-a'],
        preventOverlap: false,
      },
    ],
  });
  return { f, performer };
}
const start = (f, extra = {}) =>
  f.start({
    query: 'Анна Семёнова',
    serviceQuery: 'Чистка',
    date: day,
    time: '10:00',
    duration: 45,
    ...extra,
  });

test('an explicit empty staff edit selects the sole eligible owner administrator performer or employee and leaves Save manual', () => {
  for (const role of ['owner', 'salon_admin', 'cosmetologist']) {
    for (const operation of [{ edit: 'staff' }, { text: 'поменяй специалиста' }]) {
      const { f, performer } = fixture(role);
      const original = start(f);
      assert.equal(original.dialogue.step, 'review');
      const next = f.answer(operation).result;
      assert.equal(next.dialogue.step, 'review', role);
      assert.equal(field(next, 'staff'), performer === 'owner' ? 'Ирина Орлова' : 'Мария Соколова');
      assert.equal(field(next, 'client'), field(original, 'client'));
      assert.equal(field(next, 'date'), day);
      assert.equal(field(next, 'time'), '10:00');
      assert.equal(field(next, 'duration'), '45 мин');
      assert.equal(field(next, 'service'), 'Чистка');
      assert.equal(next.action, null);
      const ready = f.answer({ text: 'открой форму' }).result;
      assert.equal(ready.action.type, 'prepareAppointment');
      assert.equal(ready.action.staffId, performer);
      assert.equal(ready.action.duration, 45);
      noSave(f);
    }
  }
});

test('a fresh second eligible performer still requires a choice instead of silently defaulting to self', () => {
  const { f } = fixture();
  start(f);
  f.members.push({
    accountId: 'other',
    displayName: 'Елена Петрова',
    role: 'cosmetologist',
    status: 'active',
  });
  f.services.push({ id: 'other-clean', name: 'Чистка', duration: 30, staffId: 'other' });
  f.changed();
  const result = f.answer({ edit: 'staff' }).result;
  assert.equal(result.dialogue.step, 'staff');
  assert.equal(field(result, 'staff'), undefined);
  assert.deepEqual(result.dialogue.options.map((row) => row.label).sort(), [
    'Елена Петрова',
    'Ирина Орлова',
  ]);
  assert.equal(result.action, null);
  noSave(f);
});

test('an explicit unmatched staff query is never replaced by the sole allowed performer including employee ACL', () => {
  for (const role of ['owner', 'salon_admin', 'cosmetologist']) {
    const { f, performer } = fixture(role);
    const expected = performer === 'owner' ? 'Ирина Орлова' : 'Мария Соколова';
    const first = start(f, { staffQuery: 'Елене Петровой' });
    assert.equal(first.dialogue.step, 'staff');
    assert.equal(field(first, 'staff'), undefined);
    assert.deepEqual(
      first.dialogue.options.map((row) => row.label),
      [expected],
    );
    const next = f.answer({ text: 'специалиста на Елену Петрову' }).result;
    assert.equal(next.dialogue.step, 'staff');
    assert.equal(field(next, 'staff'), undefined);
    assert.deepEqual(
      next.dialogue.options.map((row) => row.label),
      [expected],
    );
    assert.equal(next.action, null);
    noSave(f);
  }
});

test('revoking the selected performer cannot silently substitute the one remaining performer during form handoff', () => {
  const { f } = fixture('salon_admin');
  f.members.push({
    accountId: 'staff-a',
    displayName: 'Татьяна Выбранная',
    role: 'cosmetologist',
    status: 'active',
  });
  f.services.push({ id: 'a-massage', name: 'Массаж', duration: 30, staffId: 'staff-a' });
  assert.equal(
    start(f, { staffQuery: 'Татьяна Выбранная', serviceQuery: 'Массаж' }).dialogue.step,
    'review',
  );
  f.members.find((row) => row.accountId === 'staff-a').status = 'suspended';
  f.changed();
  const result = f.answer({ text: 'открой форму' }).result;
  assert.equal(result.action, null);
  assert.equal(result.dialogue.step, 'staff');
  assert.equal(field(result, 'staff'), undefined);
  assert.deepEqual(
    result.dialogue.options.map((row) => row.label),
    ['Ирина Орлова'],
  );
  assert.equal(f.answer({ text: 'запиши' }).result.action, null);
  assert.equal(field(f.result, 'staff'), undefined);
  noSave(f);
});

test('an employee with no eligible performer cannot fall back to another account on an explicit staff edit', () => {
  const { f } = fixture('cosmetologist');
  f.members.find((row) => row.accountId === 'worker').status = 'suspended';
  const original = start(f);
  assert.equal(original.dialogue.step, 'staff');
  assert.equal(original.dialogue.options.length, 0);
  const result = f.answer({ edit: 'staff' }).result;
  assert.equal(result.dialogue.step, 'staff');
  assert.equal(result.dialogue.options.length, 0);
  assert.equal(field(result, 'staff'), undefined);
  assert.equal(result.action, null);
  noSave(f);
});
