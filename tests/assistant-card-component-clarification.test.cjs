const test = require('node:test');
const assert = require('node:assert/strict');
const { dialogueFixture } = require('./helpers/assistant-dialogue-fixture.cjs');
const { profile } = require('./helpers/assistant-day-profile.cjs');
const { createDialogueStore } = require('../src/server/modules/assistant/dialogue/dialogue-store.cjs');
const {
  createClientCardFlow,
  cardSourceQuery,
} = require('../src/server/modules/assistant/actions/client-card-flow.cjs');
const { initialEntities } = require('../src/server/modules/assistant/interpretation/entity-provenance.cjs');
const {
  nameForms,
  nameGender,
  firstNameKind,
} = require('../src/server/modules/assistant/language/names/name-forms.cjs');
const { resolveClient } = require('../src/server/modules/assistant/language/names/name-directory.cjs');
function fixture(role = 'owner') {
  const f = dialogueFixture({ role });
  f.state.policy.commands = { clients: true, calendar: false, prepareAppointment: false };
  f.patients.splice(
    0,
    f.patients.length,
    ...profile().clients.map((patient, index) => ({
      ...patient,
      id: 'component-synthetic-' + (index + 1),
      name: [patient.firstName, patient.middleName, patient.lastName].filter(Boolean).join(' '),
      phone: '',
      createdBy: f.c.current.accountId,
      appointments: [],
    })),
  );
  const memory = createDialogueStore(),
    flow = createClientCardFlow({ memory });
  let result, entry;
  const create = memory.create;
  memory.create = (...args) => (entry = create(...args));
  const snapshot = () => JSON.stringify(f.patients);
  const before = snapshot();
  return {
    ...f,
    flow,
    memory,
    row: (number) => f.patients.find((patient) => patient.id === 'component-synthetic-' + number),
    start(query, raw) {
      const ticket = memory.beginCommand(f.c, f.member, f.state);
      return (result = flow.start(
        f.c,
        { intent: 'clientCard', query },
        f.state,
        f.member,
        f.clock,
        ticket,
        raw,
      ));
    },
    send(operation) {
      const body = {
        dialogueId: result.dialogue.id,
        dialogueVersion: result.dialogue.version,
        ...operation,
      };
      result = flow.continueDialogue(f.c, body, f.state, f.member, f.clock);
      return { reply: result, body };
    },
    get result() {
      return result;
    },
    get entry() {
      return entry;
    },
    candidateIds: () => [...entry.options.values()].map((choice) => choice.value).sort(),
    noSave: () =>
      assert.equal(
        snapshot(),
        before,
        'Synthetic source patients and appointments remain unchanged',
      ),
  };
}
const rawName = (patient, reverse = false) => {
  const gender = nameGender(patient.firstName, patient.middleName);
  const first = nameForms(patient.firstName, 'first', gender)[1];
  const last = nameForms(patient.lastName, 'last', gender)[1];
  return (reverse ? [last, first] : [first, last]).join(' ');
};
const canonical = (patient) => patient.firstName + ' ' + patient.lastName;
function pending(f) {
  assert.equal(f.result.action, null);
  assert.equal(f.result.dialogue.step, 'client');
  assert.equal(f.entry.data.target, 'clientCard');
  assert.deepEqual(
    f.result.dialogue.fields,
    [],
    'Card identity clarification never turns into booking fields',
  );
}
test('a model canonical query locates the full declined raw card name outside the static dictionary in either order', async (t) => {
  for (const number of [7, 64, 66, 121])
    for (const reverse of [false, true])
      await t.test(number + ':' + reverse, () => {
        const f = fixture(),
          patient = f.row(number),
          raw = rawName(patient, reverse),
          query = canonical(patient);
        assert.equal(firstNameKind(patient.firstName.toLowerCase()), false);
        assert.equal(cardSourceQuery('Открой карточку ' + raw, query), raw);
        const reply = f.start(query, 'Открой карточку ' + raw);
        assert.deepEqual(reply.action, { type: 'clientCard', patientId: patient.id });
        assert.equal(f.entry.data.clientQuery, raw);
        f.noSave();
      });
});
test('literal declined full names already resolve and directory matching does not need lower thresholds', () => {
  for (const number of [7, 64, 66, 121]) {
    const f = fixture(),
      patient = f.row(number),
      query = rawName(patient);
    assert.deepEqual(
      resolveClient(f.c, query).matches.map((row) => row.id),
      [patient.id],
    );
    assert.deepEqual(f.start(query, 'Открой карточку ' + query).action, {
      type: 'clientCard',
      patientId: patient.id,
    });
    f.noSave();
  }
});
test('a canonical given-name locator cannot drop a spoken surname, while booking and card share the same raw span proof', () => {
  const f = fixture(),
    patient = f.row(121),
    raw = rawName(patient);
  const command = 'Открой карточку ' + raw;
  assert.equal(
    initialEntities({ intent: 'prepareAppointment', query: patient.firstName }, 'Запиши ' + raw)
      .query,
    raw,
  );
  assert.equal(cardSourceQuery(command, patient.firstName), raw);
  assert.deepEqual(f.start(patient.firstName, command).action, {
    type: 'clientCard',
    patientId: patient.id,
  });
  f.noSave();
});
test('a preserved first name with an unheard surname asks only the surname and retains the card target', () => {
  const f = fixture(),
    raw = 'Гульнары Пустозаписной';
  f.start(raw, 'Открой карточку ' + raw);
  pending(f);
  assert.equal(f.entry.data.clientQuery, raw);
  assert.deepEqual(f.candidateIds(), [f.row(70).id, f.row(121).id].sort());
  assert.match(f.result.dialogue.prompt, /Мухамедьянова/u);
  assert.match(f.result.dialogue.prompt, /Хабибуллина/u);
  assert.doesNotMatch(f.result.dialogue.prompt, /Имя:|Фамилия:|Клиент не найден/u);
  assert.equal(
    f.send({ text: 'да' }).reply.action,
    null,
    'A yes to two current candidates cannot guess an identity',
  );
  assert.deepEqual(f.send({ text: 'Мухамедьянова' }).reply.action, {
    type: 'clientCard',
    patientId: f.row(121).id,
  });
  f.noSave();
});
test('a preserved surname with an unheard given name asks only the given name and never auto-opens a sole candidate', () => {
  const f = fixture(),
    raw = 'Эсмеральды Мухамедьяновой';
  f.start(raw, 'Открой карточку ' + raw);
  pending(f);
  assert.equal(f.entry.data.clientQuery, raw);
  assert.deepEqual(f.candidateIds(), [f.row(121).id]);
  assert.equal(f.result.dialogue.prompt, 'Гульнара?');
  assert.deepEqual(f.send({ text: 'Гульнара' }).reply.action, {
    type: 'clientCard',
    patientId: f.row(121).id,
  });
  f.noSave();
});
test('one same-first-name component candidate still needs explicit confirmation of the unrecognized surname', () => {
  const f = fixture(),
    raw = 'Златы Пустозаписной';
  f.start(raw, 'Открой карточку ' + raw);
  pending(f);
  assert.deepEqual(f.candidateIds(), [f.row(64).id]);
  assert.equal(f.result.dialogue.prompt, 'Щербакова?');
  assert.deepEqual(f.send({ text: 'да-да' }).reply.action, {
    type: 'clientCard',
    patientId: f.row(64).id,
  });
  f.noSave();
});
test('a phonetic surname suggestion remains a full-name hypothesis and requires explicit confirmation', () => {
  const f = fixture(),
    raw = 'Гульнары Мухомидиановой';
  f.start(raw, 'Открой карточку ' + raw);
  pending(f);
  assert.ok(f.candidateIds().includes(f.row(121).id));
  assert.deepEqual(f.send({ text: 'Мухамедьянова' }).reply.action, {
    type: 'clientCard',
    patientId: f.row(121).id,
  });
  f.noSave();
});
test('conflicting exact first and surname components offer the current surname cohort without silently replacing the spoken given name', () => {
  const f = fixture(),
    raw = 'Гульнары Неволиной';
  f.start(raw, 'Открой карточку ' + raw);
  pending(f);
  assert.equal(f.entry.data.clientQuery, raw);
  const surnameIds = f.patients.filter(patient => patient.lastName === 'Неволина').map(patient => patient.id).sort();
  assert.deepEqual(f.candidateIds(), surnameIds);
  assert.ok(surnameIds.length > 1 && surnameIds.length <= 5);
  assert.ok([...f.entry.options.values()].every(choice => choice.componentClarification && choice.clientComponentStamp));
  assert.match(f.result.dialogue.prompt, /^Неволина:/u);
  assert.equal(f.send({ text: 'да' }).reply.action, null);
  assert.equal(f.send({ text: 'Гульнара' }).reply.action, null);
  assert.equal(f.entry.data.clientQuery, raw);
  assert.deepEqual(f.send({ text: 'Юлия Ивановна' }).reply.action, {
    type: 'clientCard', patientId: f.row(1).id,
  });
  assert.equal(f.entry.data.clientQuery, raw);
  f.noSave();
});
test('an absent pair or a model-invented unrelated locator cannot create component candidates', () => {
  for (const [query, raw] of [
    ['Эсмеральды Пустозаписной', 'Открой карточку Эсмеральды Пустозаписной'],
    ['Гульнара Мухамедьянова', 'Открой карточку Эсмеральды Пустозаписной'],
  ]) {
    const f = fixture();
    f.start(query, raw);
    pending(f);
    assert.equal(f.candidateIds().length, 0);
    f.noSave();
  }
});
test('an unrelated model locator cannot turn a raw alternative or negation into a partial-name selection', () => {
  for (const raw of [
    'Открой карточку Гульнары или Эльвиры Мухамедьяновой',
    'Открой карточку не Гульнары Мухамедьяновой',
  ]) {
    const f = fixture();
    f.start('Гульнара', raw);
    pending(f);
    assert.equal(f.candidateIds().length, 0);
    f.noSave();
  }
});
test('component choices recheck current candidate identity and ACL instead of accepting a stale opaque ID', () => {
  for (const change of ['rename', 'delete', 'acl']) {
    const f = fixture('cosmetologist');
    f.start('Гульнары Пустозаписной', 'Открой карточку Гульнары Пустозаписной');
    pending(f);
    const choice = [...f.entry.options].find(([, row]) => row.value === f.row(121).id);
    assert.ok(
      choice,
      'The current explicit component candidate must exist before freshness changes',
    );
    if (change === 'rename') f.row(121).lastName = 'Иная';
    if (change === 'delete') f.patients.splice(f.patients.indexOf(f.row(121)), 1);
    if (change === 'acl') f.row(121).createdBy = 'other';
    f.changed();
    assert.throws(() => f.send({ choice: choice[0] }), { status: 409 });
    assert.equal(f.result.action, null);
  }
});
test('a stale seven-digit phone answer never opens the remaining exact namesake', () => {
  const f = fixture();
  f.row(70).phone = '+79991110001';
  f.row(121).phone = '+79991110002';
  f.start('Гульнара', 'Открой карточку Гульнара');
  pending(f);
  f.patients.splice(f.patients.indexOf(f.row(121)), 1);
  f.changed();
  const reply = f.send({ text: '1110002' }).reply;
  assert.equal(reply.action, null, 'A rejected stale phone cannot select another exact name match');
  assert.match(reply.dialogue.prompt, /Список клиентов изменился/u);
  assert.equal(f.entry.data.target, 'clientCard');
  assert.equal(
    f.send({ text: 'да' }).reply.action,
    null,
    'Yes to a stale phone error does not select the other client',
  );
  assert.deepEqual(f.send({ text: '+79991110001' }).reply.action, {
    type: 'clientCard',
    patientId: f.row(70).id,
  });
});

test('retry of an ambiguous pending answer refreshes a sole remaining candidate without opening it', () => {
  const f = fixture();
  f.start('Гульнара', 'Открой карточку Гульнара');
  pending(f);
  const accepted = f.send({ text: 'Гульнара' });
  const removed = f.row(121).id;
  f.patients.splice(f.patients.indexOf(f.row(121)), 1);
  f.changed();
  const replayed = f.flow.continueDialogue(f.c, accepted.body, f.state, f.member, f.clock);
  assert.equal(replayed.action, null, 'Pending retry cannot execute a newly unique person');
  assert.equal(replayed.dialogue.options.length, 1);
  assert.ok(![...f.entry.options.values()].some((choice) => choice.value === removed));
  assert.equal(f.entry.data.target, 'clientCard');
  const confirmed = f.flow.continueDialogue(
    f.c,
    { dialogueId: replayed.dialogue.id, dialogueVersion: replayed.dialogue.version, text: 'да' },
    f.state,
    f.member,
    f.clock,
  );
  assert.deepEqual(confirmed.action, { type: 'clientCard', patientId: f.row(70).id });
});
test('bare and recognized ASR opening verbs preserve the exact two whole client tokens in either order', () => {
  for (const verb of ['Открой', 'Открою'])
    for (const noun of ['', 'карточку '])
      for (const name of ['Алексея Петрова', 'Петрова Алексея']) {
        const f = fixture();
        f.patients.splice(
          0,
          f.patients.length,
          {
            id: 'bare-correct',
            firstName: 'Алексей',
            lastName: 'Петров',
            middleName: '',
            createdBy: 'owner',
            appointments: [],
          },
          {
            id: 'bare-patronymic',
            firstName: 'Алексей',
            lastName: 'Иванов',
            middleName: 'Петрович',
            createdBy: 'owner',
            appointments: [],
          },
        );
        const command = verb + ' ' + noun + name + '.';
        assert.equal(cardSourceQuery(command, 'Алексей Петров'), name);
        assert.deepEqual(f.start('Алексей Петров', command).action, {
          type: 'clientCard',
          patientId: 'bare-correct',
        });
      }
});
test('crossed actual first and last fields stay ambiguous in either bare-command order; patronymic prefixes do not match surnames', () => {
  for (const name of ['Алексей Петров', 'Петров Алексей']) {
    const f = fixture();
    f.patients.splice(
      0,
      f.patients.length,
      {
        id: 'bare-correct',
        firstName: 'Алексей',
        lastName: 'Петров',
        middleName: '',
        phone: '+79992220001',
        createdBy: 'owner',
        appointments: [],
      },
      {
        id: 'bare-reversed-fields',
        firstName: 'Петров',
        lastName: 'Алексей',
        middleName: '',
        phone: '+79992220002',
        createdBy: 'owner',
        appointments: [],
      },
      {
        id: 'bare-patronymic',
        firstName: 'Алексей',
        lastName: 'Иванов',
        middleName: 'Петрович',
        createdBy: 'owner',
        appointments: [],
      },
    );
    f.start(name, 'Открой ' + name);
    pending(f);
    assert.deepEqual(f.candidateIds(), ['bare-correct', 'bare-reversed-fields']);
    assert.match(f.result.dialogue.prompt, /телефон/iu);
    assert.equal(f.send({ text: 'да' }).reply.action, null);
    assert.deepEqual(f.send({ text: '+79992220001' }).reply.action, {
      type: 'clientCard',
      patientId: 'bare-correct',
    });
  }
});

test('an unmatched surname answer keeps the exact first-name anchor and current card choices', () => {
  for (const query of ['Гульнара', 'Гульнары Пустозаписной']) {
    const f = fixture();
    f.start(query, 'Открой карточку ' + query);
    pending(f);
    const before = f.candidateIds(),
      original = f.entry.data.clientQuery;
    const wrong = f.send({ text: 'Неволина' }).reply;
    assert.equal(wrong.action, null);
    assert.equal(f.entry.data.clientQuery, original);
    assert.deepEqual(f.candidateIds(), before);
    assert.deepEqual(f.send({ text: 'Мухамедьянова' }).reply.action, {
      type: 'clientCard',
      patientId: f.row(121).id,
    });
    f.noSave();
  }
});
test('an unmatched first-name answer keeps the exact surname anchor while an explicit new full name may correct the client', () => {
  const f = fixture();
  f.start('Эсмеральды Мухамедьяновой', 'Открой карточку Эсмеральды Мухамедьяновой');
  pending(f);
  const original = f.entry.data.clientQuery;
  assert.equal(f.send({ text: 'Юлиана' }).reply.action, null);
  assert.equal(f.entry.data.clientQuery, original);
  assert.deepEqual(f.candidateIds(), [f.row(121).id]);
  assert.deepEqual(f.send({ text: 'Юлиана Неволина' }).reply.action, {
    type: 'clientCard',
    patientId: f.row(7).id,
  });
  f.noSave();
});

test('repeating the known component cannot confirm the still-unrecognized component of a sole candidate', () => {
  for (const [raw, repeat, answer, target] of [
    ['Златы Пустозаписной', 'Злата', 'Щербакова', 64],
    ['Эсмеральды Мухамедьяновой', 'Мухамедьянова', 'Гульнара', 121],
  ]) {
    const f = fixture();
    f.start(raw, 'Открой карточку ' + raw);
    pending(f);
    const before = f.entry.data.clientQuery;
    assert.equal(f.send({ text: repeat }).reply.action, null);
    assert.equal(f.entry.data.clientQuery, before);
    assert.deepEqual(f.candidateIds(), [f.row(target).id]);
    assert.deepEqual(f.send({ text: answer }).reply.action, {
      type: 'clientCard',
      patientId: f.row(target).id,
    });
    f.noSave();
  }
});
