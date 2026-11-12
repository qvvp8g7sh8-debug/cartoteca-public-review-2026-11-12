const test = require('node:test');
const assert = require('node:assert/strict');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const field = (result, key) => result.dialogue?.fields.find((row) => row.key === key)?.value;
const entry = (f) => f.flow.get(f.c, f.member, f.state, f.result.dialogue.id);
const noSave = (f) => assert.ok(f.patients.every((row) => row.appointments.length === 0));
const draft = { serviceQuery: 'Чистка', date: day, time: '10:00', duration: 45 };
function fixture({ count = 1, role = 'owner', query = 'Анна Семёнофа' } = {}) {
  const f = dialogueFixture({ role }),
    original = f.patients[0];
  if (role === 'cosmetologist') f.members[0].role = 'cosmetologist';
  f.patients.splice(
    0,
    f.patients.length,
    ...Array.from({ length: count }, (_, index) => ({
      ...original,
      id: 'synthetic-name-' + index,
      firstName: 'Анна',
      lastName: 'Семёнова',
      name: 'Анна Семёнова',
      phone: '+7999000' + String(index).padStart(4, '0'),
      appointments: [],
    })),
  );
  f.changed();
  f.start({ ...draft, query });
  return f;
}
function splitFixture(tail, query) {
  const f = fixture({ count: 2, query: undefined });
  const joined = 'Не' + tail.toLowerCase();
  for (const [index, lastName] of [joined, tail].entries())
    Object.assign(f.patients[index], { lastName, name: 'Анна ' + lastName });
  f.changed();
  f.start({ ...draft, query });
  return f;
}

test('a single approximate client always needs explicit confirmation and the accepted aliases emit only a reviewed manual form', () => {
  for (const text of [
    'да',
    'да-да',
    'ага',
    'угу',
    'верно',
    'правильно',
    'точно',
    'подтверждаю',
    'всё верно',
    'это она',
    'это он',
  ]) {
    const f = fixture();
    assert.equal(f.result.dialogue.step, 'client');
    assert.equal(field(f.result, 'client'), undefined);
    assert.equal(f.result.dialogue.options.length, 1);
    assert.equal(f.result.action, null);
    assert.equal(f.result.dialogue.prompt, 'Анна Семёнова, верно?');
    const option = f.result.dialogue.options[0];
    assert.notEqual(option.id, f.patients[0].id);
    assert.deepEqual(Object.keys(option).sort(), ['id', 'label']);
    assert.equal(entry(f).options.get(option.id).approximate, true);
    const selected = f.answer({ text }).result;
    assert.equal(selected.dialogue.step, 'review', text);
    assert.equal(selected.action, null, text);
    assert.equal(entry(f).data.patient.confirmedSuggestion, true);
    const ready = f.answer({ text: 'открой форму' }).result;
    assert.equal(ready.action.type, 'prepareAppointment');
    assert.equal(ready.action.patientId, f.patients[0].id);
    assert.equal(ready.action.duration, 45);
    noSave(f);
  }
});

test('yes never selects the first of multiple approximate clients while an explicit opaque choice selects its actual identity', () => {
  const f = fixture({ count: 2 });
  assert.equal(f.result.dialogue.options.length, 2);
  for (const text of [
    'да',
    'да-да',
    'ага',
    'угу',
    'верно',
    'правильно',
    'точно',
    'подтверждаю',
    'всё верно',
    'это она',
    'это он',
  ]) {
    const result = f.answer({ text }).result;
    assert.equal(result.dialogue.step, 'client', text);
    assert.equal(field(result, 'client'), undefined, text);
    assert.equal(result.action, null, text);
  }
  f.answer({ choice: f.result.dialogue.options[1].id });
  assert.equal(f.result.dialogue.step, 'review');
  const ready = f.answer({ text: 'открой форму' }).result;
  assert.equal(ready.action.patientId, f.patients[1].id);
  noSave(f);
});

test('no or an explicit client edit clears the approximate query and options before a new exact phone answer', () => {
  for (const count of [1, 2]) {
    const f = fixture({ count });
    const result = f.answer({ text: 'нет' }).result;
    assert.equal(result.dialogue.step, 'client');
    assert.equal(result.dialogue.options.length, 0);
    assert.equal(field(result, 'client'), undefined);
    assert.equal(field(result, 'service'), 'Чистка');
    assert.equal(field(result, 'date'), day);
    assert.equal(field(result, 'time'), '10:00');
    assert.equal(field(result, 'duration'), '45 мин');
    assert.equal(entry(f).data.clientQuery, '');
    assert.equal(entry(f).data.clientSuggestionsOnly, false);
    assert.equal(result.action, null);
    f.answer({ text: f.patients[0].phone });
    assert.equal(f.result.dialogue.step, 'review');
    assert.equal(entry(f).data.patient.confirmedSuggestion, undefined);
    noSave(f);
  }
  const confirmed = fixture();
  confirmed.answer({ text: 'да' });
  confirmed.answer({ edit: 'client' });
  assert.equal(confirmed.result.dialogue.step, 'client');
  assert.equal(confirmed.result.dialogue.options.length, 0);
  assert.equal(entry(confirmed).data.patient, null);
  confirmed.answer({ text: confirmed.patients[0].phone });
  assert.equal(confirmed.result.dialogue.step, 'review');
  assert.equal(entry(confirmed).data.patient.confirmedSuggestion, undefined);
  noSave(confirmed);
});

test('a confirmed suggestion requires fresh name confirmation after rename and is revoked when that identity leaves the employee ACL', () => {
  const f = fixture();
  f.answer({ text: 'да' });
  Object.assign(f.patients[0], { lastName: 'Соколова', name: 'Анна Соколова' });
  f.changed();
  f.answer({ text: 'в 11:00' });
  assert.equal(f.result.dialogue.step, 'client');
  assert.equal(f.result.action, null);
  assert.equal(entry(f).data.patient, null);
  assert.equal(field(f.result, 'client'), undefined);
  assert.equal(field(f.result, 'date'), day);
  assert.equal(field(f.result, 'time'), '11:00');
  assert.equal(field(f.result, 'duration'), '45 мин');
  assert.equal(field(f.result, 'service'), 'Чистка');
  f.answer({ text: 'Анна Соколова' });
  assert.equal(f.result.dialogue.step, 'review');
  assert.match(field(f.result, 'client'), /Соколова/u);
  assert.equal(entry(f).data.patient.confirmedSuggestion, undefined);
  assert.equal(f.answer({ text: 'открой форму' }).result.action.patientId, f.patients[0].id);
  noSave(f);
  const staff = fixture({ role: 'cosmetologist' });
  staff.answer({ text: 'да' });
  staff.patients[0].createdBy = 'foreign-staff';
  staff.changed();
  const denied = staff.answer({ text: 'открой форму' }).result;
  assert.equal(denied.dialogue.step, 'client');
  assert.equal(field(denied, 'client'), undefined);
  assert.equal(denied.dialogue.options.length, 0);
  assert.equal(denied.action, null);
  noSave(staff);
});

test('a removed hidden or superseded approximate option cannot assign a stale client', () => {
  for (const mode of ['removed', 'hidden', 'new-exact']) {
    const f = fixture({ role: mode === 'hidden' ? 'cosmetologist' : 'owner' });
    const id = f.result.dialogue.options[0].id;
    if (mode === 'removed') f.patients.splice(0);
    else if (mode === 'hidden') f.patients[0].createdBy = 'foreign-staff';
    else
      f.patients.push({
        ...f.patients[0],
        id: 'new-exact',
        lastName: 'Семёнофа',
        name: 'Анна Семёнофа',
        appointments: [],
      });
    f.changed();
    assert.throws(() => f.answer({ choice: id }), { status: 409 }, mode);
    assert.equal(entry(f).data.patient, null, mode);
    assert.equal(f.result.action, null, mode);
    noSave(f);
  }
});

test('a split leading ne surname remains an unassigned hypothesis in both seed and expected client answers and excludes the literal negated tail', () => {
  for (const tail of ['Полина', 'Олина']) {
    const raw = 'не ' + tail;
    for (const seeded of [true, false]) {
      const f = splitFixture(tail, seeded ? raw : undefined);
      if (!seeded) f.answer({ text: raw });
      assert.equal(f.result.dialogue.step, 'client');
      assert.equal(field(f.result, 'client'), undefined);
      assert.equal(f.result.dialogue.options.length, 1);
      assert.equal(entry(f).data.clientSuggestionsOnly, true);
      assert.equal([...entry(f).options.values()][0].value, f.patients[0].id);
      assert.equal(f.result.action, null);
      f.answer({ text: 'да' });
      assert.equal(f.result.dialogue.step, 'review');
      assert.equal(f.answer({ text: 'открой форму' }).result.action.patientId, f.patients[0].id);
      noSave(f);
    }
  }
});

test('an explicit positive client replacement starts a fresh query and preserves independent booking facts', () => {
  const f = fixture();
  const before = structuredClone(entry(f).data);
  f.answer({ text: 'не Полина, а Мария' });
  assert.equal(f.result.action, null);
  assert.equal(f.result.dialogue.step, 'client');
  assert.equal(entry(f).data.clientQuery, 'мария');
  assert.equal(entry(f).data.patient, null);
  for (const key of ['staff', 'service', 'date', 'time', 'duration', 'durationSource'])
    assert.deepEqual(entry(f).data[key], before[key], key);
  noSave(f);
});

test('negative commands do not become client hypotheses and a bare split surname cannot replace a reviewed client', () => {
  for (const text of [
    'не сохрани',
    'не открывай',
    'не удаляй',
    'не отправляй',
    'не оплати',
    'не выполни',
    'не запусти',
    'не включи',
    'не выключи',
    'не создай',
    'не добавь',
    'не оплатить',
    'не запустите',
  ]) {
    const f = fixture();
    const before = structuredClone(entry(f).data);
    f.answer({ text });
    assert.deepEqual(entry(f).data, before, text);
    assert.equal(f.result.action, null, text);
    noSave(f);
  }
  const f = fixture();
  f.answer({ text: 'да' });
  const reviewed = structuredClone(entry(f).data);
  f.answer({ text: 'не Полина' });
  assert.equal(f.result.dialogue.step, 'review');
  assert.deepEqual(entry(f).data, reviewed);
  assert.equal(f.result.action, null);
  noSave(f);
});

test('an explicit refusal to create stops only the draft instead of looking up a negative name', () => {
  const f = fixture();
  const before = JSON.stringify(f.patients);
  f.answer({ text: 'не записывай' });
  assert.equal(f.result.action, null);
  assert.equal(f.result.dialogue, null);
  assert.equal(JSON.stringify(f.patients), before);
  noSave(f);
});

test('bounded partial suggestions remain confirmation choices while strict overflow and exact matches keep their original semantics', () => {
  const partial = fixture({ count: 6 });
  assert.equal(partial.result.dialogue.step, 'client');
  assert.equal(partial.result.dialogue.options.length, 5);
  assert.equal(field(partial.result, 'client'), undefined);
  partial.answer({ choice: partial.result.dialogue.options[0].id });
  assert.equal(partial.result.dialogue.step, 'review');
  assert.equal(entry(partial).data.patient.confirmedSuggestion, true);
  noSave(partial);
  const overflow = fixture({ count: 51, query: 'Анна Семёнова' });
  assert.equal(overflow.result.dialogue.step, 'client');
  assert.equal(overflow.result.dialogue.options.length, 0);
  assert.equal(overflow.result.action, null);
  noSave(overflow);
  const exact = fixture({ query: 'Анна Семёнова' });
  assert.equal(exact.result.dialogue.step, 'review');
  assert.equal(entry(exact).data.patient.confirmedSuggestion, undefined);
  assert.equal(exact.result.action, null);
  noSave(exact);
});

test('a strict miss through the client identification wrapper uses only its cleaned name for approximate confirmation', () => {
  const f = fixture();
  Object.assign(f.patients[0], { lastName: 'Непалина', name: 'Анна Непалина' });
  f.changed();
  f.start({ ...draft, query: 'это Неполина' });
  assert.equal(f.result.dialogue.step, 'client');
  assert.equal(f.result.dialogue.options.length, 1);
  assert.equal(field(f.result, 'client'), undefined);
  assert.equal(entry(f).data.clientQuery, 'Неполина');
  const before = structuredClone(entry(f).data);
  f.answer({ text: 'это не Полина' });
  assert.deepEqual(entry(f).data, before);
  assert.equal(f.result.action, null);
  f.answer({ text: 'да' });
  assert.equal(f.result.dialogue.step, 'review');
  assert.equal(entry(f).data.patient.confirmedSuggestion, true);
  noSave(f);
});

test('same frozen-body retries refresh pending approximate options after ACL revocation without replaying the client input', () => {
  const f = fixture({ role: 'cosmetologist', query: '' });
  assert.equal(f.result.dialogue.options.length, 0);
  const accepted = f.answer({ text: 'Анна Семёнофа' });
  const body = structuredClone(accepted.body),
    oldVersion = accepted.result.dialogue.version;
  const oldChoice = accepted.result.dialogue.options[0].id;
  assert.deepEqual(f.flow.continueDialogue(f.c, body, f.state, f.member, f.clock), accepted.result);
  f.patients[0].createdBy = 'foreign-staff';
  f.changed();
  const refreshed = f.flow.continueDialogue(f.c, body, f.state, f.member, f.clock);
  assert.equal(refreshed.dialogue.step, 'client');
  assert.equal(refreshed.dialogue.options.length, 0);
  assert.equal(field(refreshed, 'client'), undefined);
  assert.equal(refreshed.action, null);
  assert.ok(refreshed.dialogue.version > oldVersion);
  assert.doesNotMatch(JSON.stringify(refreshed), /Семёнова/u);
  assert.deepEqual(f.flow.continueDialogue(f.c, body, f.state, f.member, f.clock), refreshed);
  assert.throws(
    () =>
      f.flow.continueDialogue(
        f.c,
        { dialogueId: body.dialogueId, dialogueVersion: oldVersion, choice: oldChoice },
        f.state,
        f.member,
        f.clock,
      ),
    { status: 409 },
  );
  assert.equal(entry(f).data.patient, null);
  noSave(f);
});

test('same frozen-body retries refresh exact ambiguous client options after ACL revocation while unchanged retries preserve opaque choices', () => {
  for (const revokeAll of [false, true]) {
    const f = fixture({ count: 2, role: 'cosmetologist', query: '' });
    const accepted = f.answer({ text: 'Анна Семёнова' });
    const body = structuredClone(accepted.body),
      original = structuredClone(accepted.result),
      privateEntry = entry(f),
      originalData = structuredClone(privateEntry.data),
      originalTurns = privateEntry.turns;
    assert.equal(original.dialogue.step, 'client');
    assert.equal(original.dialogue.options.length, 2);
    assert.equal(privateEntry.data.patient, null);
    assert.ok([...privateEntry.options.values()].every((choice) => !choice.approximate));
    assert.deepEqual(f.flow.continueDialogue(f.c, body, f.state, f.member, f.clock), original);
    assert.equal(privateEntry.turns, originalTurns);
    f.patients[0].createdBy = 'foreign-staff';
    if (revokeAll) f.patients[1].createdBy = 'foreign-staff';
    f.changed();
    const refreshed = f.flow.continueDialogue(f.c, body, f.state, f.member, f.clock);
    assert.equal(refreshed.dialogue.step, 'client');
    assert.deepEqual(
      refreshed.dialogue.options.map((option) => option.label),
      revokeAll ? [] : [original.dialogue.options[1].label],
    );
    assert.equal(privateEntry.data.patient, null);
    assert.deepEqual(privateEntry.data, originalData);
    assert.equal(privateEntry.turns, originalTurns);
    assert.equal(refreshed.action, null);
    assert.ok(refreshed.dialogue.version > original.dialogue.version);
    if (!revokeAll)
      assert.notEqual(refreshed.dialogue.options[0].id, original.dialogue.options[1].id);
    assert.deepEqual(f.flow.continueDialogue(f.c, body, f.state, f.member, f.clock), refreshed);
    assert.equal(privateEntry.turns, originalTurns);
    assert.throws(
      () =>
        f.flow.continueDialogue(
          f.c,
          {
            dialogueId: body.dialogueId,
            dialogueVersion: original.dialogue.version,
            choice: original.dialogue.options[0].id,
          },
          f.state,
          f.member,
          f.clock,
        ),
      { status: 409 },
    );
    assert.equal(privateEntry.data.patient, null);
    noSave(f);
  }
});
