const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const {
  resolveClient,
} = require('../src/server/modules/assistant/language/names/name-directory.cjs');
const {
  clientChoiceMetadata,
  clientChoiceOperation,
} = require('../src/server/modules/assistant/dialogue/client-choice-names.cjs');
function fixture(t, { duplicate = false, role = 'owner', tails = ['7006', '4507'] } = {}) {
  const f = dialogueFixture({ role });
  if (role === 'cosmetologist') f.members[0].role = role;
  const original = f.patients[0];
  f.patients.splice(
    0,
    f.patients.length,
    {
      ...original,
      id: randomUUID(),
      firstName: 'Гульнара',
      lastName: 'Мухамедьянова',
      name: 'Гульнара Мухамедьянова',
      phone: '+7999932' + tails[0],
      appointments: [],
    },
    {
      ...original,
      id: randomUUID(),
      firstName: 'Гульнара',
      lastName: 'Хабибулина',
      name: 'Гульнара Хабибулина',
      phone: duplicate ? '+7888932' + tails[0] : '+7999981' + tails[1],
      appointments: [],
    },
    {
      ...original,
      id: randomUUID(),
      firstName: 'Олег',
      lastName: 'Иванов',
      name: 'Олег Иванов',
      phone: '+78889327006',
      appointments: [],
    },
  );
  const store = f.c.tenantStore('org'),
    originalRows = store.indexes.summaryRows;
  const reads = [];
  store.indexes.summaryRows = (current, ids) => {
    reads.push(ids ? [...ids] : null);
    return originalRows(current, ids);
  };
  let writes = 0;
  for (const key of ['save', 'write'])
    store[key] = () => {
      writes++;
      throw Error('No save is allowed');
    };
  const entry = {
    step: 'client',
    options: new Map(
      f.patients.slice(0, 2).map((patient, i) => [
        'opaque-' + i,
        {
          kind: 'client',
          value: patient.id,
          ...clientChoiceMetadata(patient),
        },
      ]),
    ),
  };
  t.after(() => {
    assert.equal(writes, 0);
    assert.ok(f.patients.every((row) => row.appointments.length === 0));
  });
  return { ...f, entry, reads };
}
function matchingChoice(f, raw, id = 'opaque-0') {
  assert.deepEqual(clientChoiceOperation(f.c, f.entry, raw), {
    kind: 'choice',
    choice: id,
  });
  assert.equal(f.reads.length, 1, 'Suffix selection must use one bounded ACL batch');
  assert.deepEqual(
    f.reads[0],
    f.patients.slice(0, 2).map((patient) => patient.id),
  );
}
test('seven literal final phone digits with commas spaces or hyphens identify only one fresh current candidate', async (t) => {
  for (const raw of ['9327006', '932,70,06', '932 70 06', '932-70-06', '9 3 2 7 0 0 6'])
    await t.test(raw, (t) => matchingChoice(fixture(t), raw));
});
test('an identical suffix outside the active candidate set neither enters the match nor blocks its unique current selection', (t) => {
  const f = fixture(t);
  matchingChoice(f, '932,70,06');
  assert.equal(f.entry.options.size, 2);
  assert.ok(![...f.entry.options.values()].some((choice) => choice.value === f.patients[2].id));
});
test('a suffix shared by two current people asks the distinguishing surnames without choosing either', (t) => {
  const f = fixture(t, { duplicate: true });
  const operation = clientChoiceOperation(f.c, f.entry, '932,70,06');
  assert.equal(operation?.kind, 'clientPhoneClarify');
  assert.equal(operation.choice, undefined);
  assert.equal(operation.message, 'Окончания совпали — Мухамедьянова или Хабибулина?');
  assert.equal(f.reads.length, 1);
});
test('a fresh collision whose old four-digit stamps are unchanged is still not a unique suffix', (t) => {
  const f = fixture(t);
  f.patients[1].phone = '+79919817006';
  f.entry.options.get('opaque-1').clientPhoneTail = '7006';
  f.entry.options.get('opaque-1').clientNameStamp = clientChoiceMetadata(
    f.patients[1],
  ).clientNameStamp;
  f.patients[1].phone = '+78889327006';
  const operation = clientChoiceOperation(f.c, f.entry, '9327006');
  assert.equal(operation?.kind, 'clientPhoneClarify');
  assert.equal(operation.choice, undefined);
});
test('removed renamed or newly hidden candidates cannot be selected by their old suffix', async (t) => {
  for (const mode of ['removed', 'renamed', 'hidden'])
    await t.test(mode, (t) => {
      const f = fixture(t, {
        role: mode === 'hidden' ? 'cosmetologist' : 'owner',
      });
      if (mode === 'removed') f.patients.splice(0, 1);
      else if (mode === 'renamed') f.patients[0].lastName = 'Петрова';
      else f.patients[0].createdBy = 'other-staff';
      const operation = clientChoiceOperation(f.c, f.entry, '932,70,06');
      assert.equal(operation?.kind, 'clientPhoneClarify');
      assert.equal(operation.choice, undefined);
      assert.match(operation.message, /изменил|уточни/iu);
    });
});
test('seven digits without current candidates ask for an identity locally and never search the directory', (t) => {
  const f = fixture(t);
  f.entry.options.clear();
  const operation = clientChoiceOperation(f.c, f.entry, '932,70,06');
  assert.equal(operation?.kind, 'clientPhoneClarify');
  assert.equal(operation.message, 'Сначала назовите имя клиента.');
  assert.equal(f.reads.length, 0);
  assert.equal(resolveClient(f.c, '9327006').matches.length, 0);
  assert.equal(resolveClient(f.c, '932,70,06').matches.length, 0);
});
test('the suffix path rejects names with numbers times dates conditions and option commands without a read', (t) => {
  for (const raw of [
    'Анна 9327006',
    '9327006 или 9814507',
    'не 9327006',
    'номер 7',
    'вариант 9327006',
    '1-10-2026',
    '1,10,2026',
    '01.10.2026',
    '12:30',
    '+9327006',
    '932/70/06',
    '932e7006',
    'ноль два тридцать пять или пятьдесят три пятнадцать',
    'не пятьдесят три пятнадцать',
    'двадцать три:пятнадцать',
    'пятьдесят три пятнадцать шесть',
  ]) {
    const f = fixture(t);
    assert.equal(clientChoiceOperation(f.c, f.entry, raw), null, raw);
    assert.equal(f.reads.length, 0, raw);
  }
});
test('other dialogue fields never reinterpret numeric text as a client suffix', (t) => {
  for (const step of ['time', 'date', 'duration', 'service', 'staff', 'review', 'availability']) {
    const f = fixture(t);
    f.entry.step = step;
    assert.equal(clientChoiceOperation(f.c, f.entry, '932,70,06'), null, step);
    assert.equal(clientChoiceOperation(f.c, f.entry, 'пятьдесят три пятнадцать'), null, step);
    assert.equal(f.reads.length, 0, step);
  }
});
test('complete numeric phones with ASR commas keep exact matching and the established country-code rules', (t) => {
  const f = fixture(t);
  for (const raw of ['+7 (999) 932,70,06', '7 999 932 70 06', '89999327006'])
    assert.deepEqual(
      resolveClient(f.c, raw).matches.map((patient) => patient.id),
      [f.patients[0].id],
      raw,
    );
  for (const raw of ['+8 999 932,70,06', '932,70,06', 'Анна +7 (999) 932,70,06'])
    assert.equal(resolveClient(f.c, raw).matches.length, 0, raw);
  const local = clientChoiceOperation(f.c, f.entry, '+7 (999) 932,70,06');
  assert.deepEqual(local, { kind: 'text', text: '+79999327006' });
  const explicitEight = clientChoiceOperation(f.c, f.entry, '+8 999 932,70,06');
  assert.deepEqual(explicitEight, { kind: 'text', text: '+89999327006' });
  assert.equal(resolveClient(f.c, explicitEight.text).matches.length, 0);
});
test('four displayed phone digits select a fresh visible client even when full names differ', (t) => {
  const f = fixture(t);
  matchingChoice(f, '7006');
  f.patients[1].lastName = f.patients[0].lastName;
  f.patients[1].name = f.patients[0].name;
  f.entry.options.get('opaque-1').clientName = clientChoiceMetadata(f.patients[1]).clientName;
  f.entry.options.get('opaque-1').clientNameStamp = clientChoiceMetadata(
    f.patients[1],
  ).clientNameStamp;
  const selected = clientChoiceOperation(f.c, f.entry, '7006');
  assert.equal(selected?.kind, 'choice');
  assert.equal(selected.choice, 'opaque-0');
});

test('spoken digits and grouped four-digit tails use the same bounded current candidate selection', async (t) => {
  for (const raw of [
    '70 06',
    '70,06',
    '7-0-0-6',
    'семь ноль ноль шесть',
    'семьдесят 06',
    'семьдесят ноль шесть',
    'последние четыре цифры 7006',
    'телефон заканчивается на 7006',
    '7006?',
  ])
    await t.test(raw, (t) => matchingChoice(fixture(t), raw));
});

test('spoken number groups preserve leading zeros and select the matching offered client', async (t) => {
  for (const [raw, choice] of [
    ['ноль два тридцать пять', 'opaque-0'],
    ['последние четыре цифры телефона — нуль два, тридцать пять.', 'opaque-0'],
    ['02 тридцать пять', 'opaque-0'],
    ['пятьдесят три пятнадцать', 'opaque-1'],
    ['пятьдесят 3, пятнадцать', 'opaque-1'],
    ['пятьдесят три 15', 'opaque-1'],
  ]) {
    await t.test(raw, (t) => matchingChoice(fixture(t, { tails: ['0235', '5315'] }), raw, choice));
  }
});

test('four-digit collisions, missing candidates and fresh phone changes do not select or search other clients', (t) => {
  const collision = fixture(t, { duplicate: true });
  assert.equal(
    clientChoiceOperation(collision.c, collision.entry, '7006').kind,
    'clientPhoneClarify',
  );
  assert.equal(collision.reads.length, 1);
  const absent = fixture(t);
  assert.match(clientChoiceOperation(absent.c, absent.entry, '1234').message, /В списке нет/u);
  assert.equal(absent.reads.length, 1);
  const changed = fixture(t);
  changed.patients[0].phone = '+79999321234';
  assert.match(clientChoiceOperation(changed.c, changed.entry, '7006').message, /изменился/u);
  const empty = fixture(t);
  empty.entry.options.clear();
  assert.equal(clientChoiceOperation(empty.c, empty.entry, '7006').kind, 'clientPhoneClarify');
  assert.equal(empty.reads.length, 0);
  assert.equal(resolveClient(empty.c, '7006').matches.length, 0);
});
test('a real no-save dialogue consumes the suffix locally and opens the prepared form without asking again for known data', async (t) => {
  for (const text of ['932,70,06', 'семьдесят ноль шесть']) {
    await t.test(text, (t) => {
      const f = fixture(t);
      const initial = f.flow.start(
        f.c,
        {
          intent: 'prepareAppointment',
          query: 'Гульнара',
          serviceQuery: 'Чистка',
          date: day,
          time: '10:00',
        },
        f.state,
        f.member,
        f.clock,
        f.flow.beginCommand(f.c, f.member, f.state),
        { openWhenComplete: true },
      );
      assert.equal(initial.dialogue.step, 'client');
      const body = {
        dialogueId: initial.dialogue.id,
        dialogueVersion: initial.dialogue.version,
        text,
      };
      assert.equal(f.flow.prepareModelTurn(f.c, body, f.state, f.member, f.clock), null);
      const reply = f.flow.continueDialogue(f.c, body, f.state, f.member, f.clock);
      assert.equal(reply.dialogue, null);
      assert.deepEqual(reply.action, {
        type: 'prepareAppointment',
        patientId: f.patients[0].id,
        staffId: 'owner',
        date: day,
        time: '10:00',
        duration: 30,
        roomId: 'main',
        serviceIds: ['clean'],
      });
      assert.doesNotMatch(JSON.stringify(reply), /9327006|clientPhoneTail|clientNameStamp/u);
    });
  }
});
test('phone clarification is a single short question and preserves existing fields and current candidates', (t) => {
  const f = fixture(t, { duplicate: true });
  const initial = f.flow.start(
    f.c,
    {
      intent: 'prepareAppointment',
      query: 'Гульнара',
      serviceQuery: 'Чистка',
      date: day,
      time: '10:00',
    },
    f.state,
    f.member,
    f.clock,
    f.flow.beginCommand(f.c, f.member, f.state),
    { openWhenComplete: true },
  );
  const body = {
    dialogueId: initial.dialogue.id,
    dialogueVersion: initial.dialogue.version,
    text: '932,70,06',
  };
  assert.equal(f.flow.prepareModelTurn(f.c, body, f.state, f.member, f.clock), null);
  const reply = f.flow.continueDialogue(f.c, body, f.state, f.member, f.clock);
  assert.equal(reply.action, null);
  assert.equal(reply.dialogue.step, 'client');
  assert.equal(reply.text, reply.dialogue.prompt);
  assert.equal(reply.dialogue.prompt, 'Окончания совпали — Мухамедьянова или Хабибулина?');
  assert.equal((reply.dialogue.prompt.match(/[.?]/g) || []).length, 1);
  assert.equal(reply.dialogue.options.length, 2);
  for (const key of ['staff', 'service', 'date', 'time', 'duration'])
    assert.equal(
      reply.dialogue.fields.find((field) => field.key === key).value,
      initial.dialogue.fields.find((field) => field.key === key).value,
      key,
    );
});

test('a uniquely matched current approximate candidate can be explicitly identified by its seven phone digits', (t) => {
  const f = fixture(t);
  const initial = f.flow.start(
    f.c,
    {
      intent: 'prepareAppointment',
      query: 'Гульнара Мухамедьянофа',
      serviceQuery: 'Чистка',
      date: day,
      time: '10:00',
    },
    f.state,
    f.member,
    f.clock,
    f.flow.beginCommand(f.c, f.member, f.state),
    { openWhenComplete: true },
  );
  assert.equal(initial.dialogue.step, 'client');
  assert.equal(initial.action, null);
  assert.equal(initial.dialogue.options.length, 1);
  const entry = f.flow.get(f.c, f.member, f.state, initial.dialogue.id);
  assert.equal([...entry.options.values()][0].approximate, true);
  const reply = f.flow.continueDialogue(
    f.c,
    {
      dialogueId: initial.dialogue.id,
      dialogueVersion: initial.dialogue.version,
      text: '932,70,06',
    },
    f.state,
    f.member,
    f.clock,
  );
  assert.equal(reply.dialogue, null);
  assert.equal(reply.action?.patientId, f.patients[0].id);
  assert.doesNotMatch(reply.text, /Мухамедьянофа|9327006/u);
});

test('a stale phone reply cannot silently replace the intended client with the one remaining namesake', (t) => {
  const f = fixture(t);
  const initial = f.flow.start(
    f.c,
    {
      intent: 'prepareAppointment',
      query: 'Гульнара',
      serviceQuery: 'Чистка',
      date: day,
      time: '10:00',
    },
    f.state,
    f.member,
    f.clock,
    f.flow.beginCommand(f.c, f.member, f.state),
    { openWhenComplete: true },
  );
  const target = f.patients.shift();
  f.changed();
  const reply = f.flow.continueDialogue(
    f.c,
    {
      dialogueId: initial.dialogue.id,
      dialogueVersion: initial.dialogue.version,
      text: '932,70,06',
    },
    f.state,
    f.member,
    f.clock,
  );
  assert.equal(reply.action, null);
  assert.equal(reply.dialogue.step, 'client');
  assert.match(reply.dialogue.prompt, /изменил|уточни/iu);
  const entry = f.flow.get(f.c, f.member, f.state, reply.dialogue.id);
  assert.equal(entry.data.patient, null);
  assert.equal(entry.data.clientQuery, 'Гульнара');
  assert.ok([...entry.options.values()].every((choice) => choice.value !== target.id));
});
test('a suffix without displayed candidates cannot approve a client retained during explicit refocus', (t) => {
  const f = fixture(t);
  const initial = f.flow.start(
    f.c,
    {
      intent: 'prepareAppointment',
      query: 'Гульнара',
      serviceQuery: 'Чистка',
      date: day,
      time: '10:00',
    },
    f.state,
    f.member,
    f.clock,
    f.flow.beginCommand(f.c, f.member, f.state),
    { openWhenComplete: true },
  );
  const entry = f.flow.get(f.c, f.member, f.state, initial.dialogue.id);
  entry.data.patient = {
    id: f.patients[0].id,
    label: 'Гульнара Мухамедьянова · …7006',
  };
  entry.options.clear();
  const reply = f.flow.continueDialogue(
    f.c,
    {
      dialogueId: initial.dialogue.id,
      dialogueVersion: initial.dialogue.version,
      text: '932,70,06',
    },
    f.state,
    f.member,
    f.clock,
  );
  assert.equal(reply.action, null);
  assert.equal(reply.dialogue.step, 'client');
  assert.equal(reply.dialogue.prompt, 'Сначала назовите имя клиента.');
  assert.equal(entry.data.patient.id, f.patients[0].id);
});
