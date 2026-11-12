const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  clientChoiceView,
  clientChoiceMetadata,
  clientChoiceOperation,
} = require('../src/server/modules/assistant/dialogue/client-choice-names.cjs');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
function fixture(
  names = [
    ['Гульнара', 'Мухамедянова'],
    ['Гульнара', 'Хабибулина'],
  ],
  role = 'owner',
) {
  const f = dialogueFixture({ role });
  const original = f.patients[0];
  f.patients.splice(
    0,
    f.patients.length,
    ...names.map(([firstName, lastName, middleName = ''], index) => ({
      ...original,
      id: 'synthetic-client-' + index,
      firstName,
      lastName,
      middleName,
      name: [firstName, middleName, lastName].filter(Boolean).join(' '),
      phone: '+7999000' + String(index + 1000),
      appointments: [],
    })),
  );
  const storage = f.c.tenantStore();
  const read = storage.indexes.summaryRows;
  const reads = [];
  storage.indexes.summaryRows = (current, ids) => {
    reads.push(ids);
    return read(current, ids);
  };
  const entry = {
    step: 'client',
    options: new Map(
      f.patients.map((patient, index) => [
        'opaque-' + index,
        { kind: 'client', value: patient.id, ...clientChoiceMetadata(patient) },
      ]),
    ),
  };
  return { ...f, entry, reads };
}
const noSave = (f) => assert.ok(f.patients.every((patient) => patient.appointments.length === 0));

test('two or three shared given names ask only the distinguishing surnames, while visual choices retain full identity', () => {
  const f = fixture();
  assert.equal(clientChoiceView(f.patients).prompt, 'Мухамедянова или Хабибулина?');
  f.patients.push({ ...f.patients[0], id: 'third', lastName: 'Неволина' });
  assert.equal(clientChoiceView(f.patients).prompt, 'Мухамедянова, Хабибулина или Неволина?');
  const flow = fixture();
  const result = flow.start({
    query: 'Гульнара',
    date: day,
    time: '10:00',
    serviceQuery: 'Чистка',
  });
  assert.equal(result.dialogue.phase, 'clientChoice');
  assert.equal(result.dialogue.prompt, 'Мухамедянова или Хабибулина?');
  assert.equal(result.dialogue.options.length, 2);
  for (const option of result.dialogue.options) {
    assert.match(option.label, /Гульнара/u);
    assert.match(option.label, /…/u);
    assert.deepEqual(Object.keys(option).sort(), ['id', 'label']);
  }
  noSave(flow);
});

test('same surnames use a distinguishing first name or patronymic before any phone suffix', () => {
  assert.equal(
    clientChoiceView(
      fixture([
        ['Анна', 'Семёнова'],
        ['Ольга', 'Семёнова'],
      ]).patients,
    ).prompt,
    'Анна или Ольга?',
  );
  const relatives = fixture([
    ['Гульнара', 'Хабибулина', 'Ивановна'],
    ['Гульнара', 'Хабибулина', 'Сергеевна'],
  ]);
  const prompt = clientChoiceView(relatives.patients).prompt;
  assert.equal(prompt, 'Гульнара Ивановна или Гульнара Сергеевна?');
  assert.doesNotMatch(prompt, /телефон|1000|1001/u);
  assert.equal(clientChoiceOperation(relatives.c, relatives.entry, 'Сергеевну').choice, 'opaque-1');
});

const surnameOnlyChoices = [
  ['Анна', 'Семёнова', 'Ивановна'],
  ['Ольга', 'Семёнова', 'Петровна'],
  ['', 'Семёнова'],
];

test('a surname-only card in a shared family is selected by an explicit description or spoken position', () => {
  for (const answer of ['Без имени', 'Только фамилия Семёнова', 'position']) {
    const f = fixture(surnameOnlyChoices);
    const first = f.start({ query: 'Семёнова', date: day, time: '10:00' });
    const id = first.dialogue.id;
    const entry = () => f.flow.get(f.c, f.member, f.state, id);
    assert.equal(first.dialogue.phase, 'clientChoice');
    assert.equal(first.dialogue.options.length, 3);
    assert.equal(entry().data.patient, null);

    const shared = f.answer({ text: 'Семёнова' }).result;
    assert.equal(shared.dialogue.phase, 'clientChoice');
    assert.equal(shared.dialogue.options.length, 3);
    assert.equal(entry().data.patient, null);
    assert.equal(shared.action, null);

    const patientId = f.patients[2].id;
    const position = shared.dialogue.options.findIndex(
      (option) => entry().options.get(option.id)?.value === patientId,
    );
    assert.ok(position >= 0);
    const text = answer === 'position' ? ['Первую', 'Вторую', 'Третью'][position] : answer;
    const selected = f.answer({ text }).result;
    assert.equal(selected.dialogue.step, 'service', text);
    assert.equal(entry().data.patient?.id, patientId, text);
    assert.equal(entry().data.date, day, text);
    assert.equal(entry().data.time, '10:00', text);
    assert.equal(selected.action, null);
    noSave(f);
  }
});

test('an explicit surname-only answer leaves the choice open when multiple offered cards lack a first name', () => {
  for (const text of ['Без имени', 'Только фамилия Семёнова']) {
    const f = fixture([...surnameOnlyChoices, ['', 'Семёнова']]);
    const first = f.start({ query: 'Семёнова' });
    assert.equal(first.dialogue.phase, 'clientChoice');
    assert.equal(first.dialogue.options.length, 4);
    const result = f.answer({ text }).result;
    assert.equal(result.dialogue.phase, 'clientChoice', text);
    assert.equal(result.dialogue.options.length, 4, text);
    assert.match(result.dialogue.prompt, /выберите карточку на экране/u, text);
    assert.equal(f.flow.get(f.c, f.member, f.state, first.dialogue.id).data.patient, null, text);
    assert.equal(result.action, null, text);
    noSave(f);
  }
});

test('identical full names use only the needed phone tails and never guess from a shared name', () => {
  const f = fixture([
    ['Гульнара', 'Хабибулина'],
    ['Гульнара', 'Хабибулина'],
  ]);
  const prompt = clientChoiceView(f.patients).prompt;
  assert.match(prompt, /1000/u);
  assert.match(prompt, /1001/u);
  assert.doesNotMatch(prompt, /7999/u);
  assert.equal(clientChoiceOperation(f.c, f.entry, 'Гульнара Хабибулина').kind, 'localHelp');
  assert.equal(f.reads.length, 0);
  assert.deepEqual(clientChoiceOperation(f.c, f.entry, '1001'), {
    kind: 'choice',
    choice: 'opaque-1',
  });
  assert.deepEqual(f.reads, [['synthetic-client-0', 'synthetic-client-1']]);
  noSave(f);
});

test('more than three matches remain on screen but are never enumerated by the short question', () => {
  const names = ['Мухамедянова', 'Хабибулина', 'Неволина', 'Семёнова'];
  const f = fixture(names.map((last) => ['Гульнара', last]));
  const view = clientChoiceView(f.patients);
  assert.equal(view.showChoices, true);
  assert.equal(view.prompt, 'Какая фамилия?');
  for (const name of names) assert.ok(!view.prompt.includes(name));
  const result = f.start({ query: 'Гульнара' });
  assert.equal(result.dialogue.options.length, 4);
  assert.equal(result.dialogue.phase, 'clientChoice');
  assert.deepEqual(clientChoiceOperation(f.c, f.entry, 'Гульнару Неволину'), {
    kind: 'choice',
    choice: 'opaque-2',
  });
  noSave(f);
});

test('larger visible same-family choices ask the smallest distinguishing name component before any phone', () => {
  const sameFamily = fixture(
    ['Анна', 'Ольга', 'Ирина', 'Мария'].map((first) => [first, 'Семёнова']),
  );
  for (const patient of sameFamily.patients) patient.phone = '';
  assert.equal(clientChoiceView(sameFamily.patients).prompt, 'Какое имя?');
  const patronymics = fixture(
    ['Петровна', 'Ивановна', 'Олеговна', 'Сергеевна'].map((middle) => ['Анна', 'Семёнова', middle]),
  );
  assert.equal(clientChoiceView(patronymics.patients).prompt, 'Какое отчество?');
  const repeatedFirst = fixture([
    ['Анна', 'Семёнова', 'Петровна'],
    ['Анна', 'Семёнова', 'Ивановна'],
    ['Ирина', 'Семёнова', 'Олеговна'],
    ['Ирина', 'Семёнова', 'Сергеевна'],
  ]);
  assert.equal(clientChoiceView(repeatedFirst.patients).prompt, 'Назовите имя и отчество.');
});

test('phone fallback mentions only four shown digits and cannot borrow a hidden approximate candidate phone', () => {
  const names = Array.from({ length: 6 }, () => ['Анна', 'Семёнова']);
  const f = fixture(names);
  const question = clientChoiceView(f.patients, { approximate: true });
  assert.equal(question.prompt, 'Назовите последние четыре цифры телефона или полное имя.');
  for (const patient of f.patients.slice(0, 5)) patient.phone = '';
  assert.equal(
    clientChoiceView(f.patients, { approximate: true }).prompt,
    'Уточните полное имя или выберите клиента на экране.',
  );
});

test('a colliding visible phone tail requests the complete number only when identical names need distinct full phones', () => {
  const f = fixture([
    ['Анна', 'Семёнова'],
    ['Анна', 'Семёнова'],
  ]);
  f.patients[1].phone = '+78880001000';
  f.entry.options.get('opaque-1').clientPhoneTail = '1000';
  f.entry.options.get('opaque-1').clientNameStamp = clientChoiceMetadata(
    f.patients[1],
  ).clientNameStamp;
  assert.equal(
    clientChoiceOperation(f.c, f.entry, '1000').message,
    'Окончания совпали — назовите полный номер телефона.',
  );
  f.patients[1].phone = f.patients[0].phone;
  assert.equal(
    clientChoiceOperation(f.c, f.entry, '1000').message,
    'Окончания совпали — выберите клиента на экране.',
  );
  assert.equal(clientChoiceOperation(f.c, f.entry, 'Анна Семёнова').kind, 'localHelp');
  noSave(f);
});

test('surname inflection selects only the currently offered identity with a single fresh ACL read', () => {
  for (const raw of ['Мухамедянова', 'Мухамедянову.', 'Гульнару Мухамедянову', 'Хабибулиной']) {
    const f = fixture();
    const expected = raw.startsWith('Хабиб') ? 'opaque-1' : 'opaque-0';
    assert.deepEqual(clientChoiceOperation(f.c, f.entry, raw), {
      kind: 'choice',
      choice: expected,
    });
    assert.equal(f.reads.length, 1);
    assert.deepEqual(f.reads[0], [
      expected === 'opaque-0' ? 'synthetic-client-0' : 'synthetic-client-1',
    ]);
    noSave(f);
  }
});

test('a different person sharing the surname never replaces the first name established by the current candidate list', () => {
  const f = fixture();
  f.patients.push({
    ...f.patients[0],
    id: 'outside-pair',
    firstName: 'Анна',
    name: 'Анна Мухамедянова',
  });
  assert.equal(clientChoiceOperation(f.c, f.entry, 'Анна Мухамедянова'), null);
  assert.equal(f.reads.length, 0);
  assert.deepEqual(clientChoiceOperation(f.c, f.entry, 'Мухамедянову'), {
    kind: 'choice',
    choice: 'opaque-0',
  });
  assert.deepEqual(f.reads, [['synthetic-client-0']]);
  assert.notEqual(f.entry.options.get('opaque-0').value, 'outside-pair');
  noSave(f);
});

test('negative, alternatives, unknown, partial and compound replies never become a fast client choice or trigger a read', () => {
  for (const raw of [
    'не Мухамедянова',
    'Мухамедянова или Хабибулина',
    'Мухамедянова и Хабибулина',
    'Мухамед',
    'Анна',
    'Мухамедянову завтра в12:00',
    'запиши Мухамедянову',
    'Мухамедянову, отмени другую запись',
    'да',
  ]) {
    const f = fixture();
    const answer = clientChoiceOperation(f.c, f.entry, raw);
    if (raw === 'да') assert.equal(answer?.kind, 'localHelp', raw);
    else assert.equal(answer, null, raw);
    assert.equal(f.reads.length, 0, raw);
    noSave(f);
  }
});

test('a four-digit phone tail explicitly selects only the fresh current candidates', () => {
  const f = fixture();
  assert.deepEqual(clientChoiceOperation(f.c, f.entry, '1000'), {
    kind: 'choice',
    choice: 'opaque-0',
  });
  assert.deepEqual(f.reads, [['synthetic-client-0', 'synthetic-client-1']]);
  noSave(f);
});

test('removed, renamed or hidden current candidates are rejected without selecting a replacement identity', () => {
  for (const mode of ['removed', 'renamed', 'hidden']) {
    const f = fixture(undefined, mode === 'hidden' ? 'cosmetologist' : 'owner');
    if (mode === 'removed') f.patients.splice(0, 1);
    if (mode === 'renamed') f.patients[0].lastName = 'Иванова';
    if (mode === 'hidden') f.patients[0].createdBy = 'other-staff';
    const result = clientChoiceOperation(f.c, f.entry, 'Мухамедянову');
    assert.equal(result.kind, 'localHelp', mode);
    assert.equal(result.choice, undefined, mode);
    assert.equal(f.reads.length, 1);
    noSave(f);
  }
});

test('one approximate identity still requires a named or yes confirmation, and named choice opens only an unsaved form', () => {
  const f = dialogueFixture();
  const result = f.start({
    query: 'Анна Семёнофа',
    date: day,
    time: '10:00',
    serviceQuery: 'Чистка',
    duration: 30,
  });
  assert.equal(result.dialogue.phase, 'clientChoice');
  assert.match(result.dialogue.prompt, /Анна Семёнова/u);
  assert.equal(result.action, null);
  const entry = f.flow.get(f.c, f.member, f.state, result.dialogue.id);
  const operation = clientChoiceOperation(f.c, entry, 'Анну Семёнову');
  assert.equal(operation.kind, 'choice');
  const selected = f.answer({ text: 'Анну Семёнову' }).result;
  assert.equal(
    f.flow.get(f.c, f.member, f.state, selected.dialogue.id).data.patient.confirmedSuggestion,
    true,
  );
  assert.equal(f.answer({ text: 'открой форму' }).result.action.type, 'prepareAppointment');
  noSave(f);
});

test('short client speech contains only the natural server question, with no option numbers, repetitions or phone leak', async () => {
  const speech = fs.readFileSync(
    path.resolve(__dirname, '../src/client/modules/assistant-speech.js'),
    'utf8',
  );
  const factory = vm.runInNewContext(speech + '\ncreateAssistantSpeech', {});
  const text = fs.readFileSync(
    path.resolve(__dirname, '../src/client/modules/assistant-speech-text.js'),
    'utf8',
  );
  const actions = vm.runInNewContext(text + '\ncreateAssistantSpeechText', {})();
  const spoken = [];
  actions.playAssistantAudio = async () => true;
  const state = {
    assistantGeneration: 1,
    assistantScope: { limits: { maxReplyChars: 2000 }, capabilities: { tts: { ready: true } } },
  };
  const ui = {
    session: 1,
    valid: () => true,
    activity() {},
    request: async (route, body) => {
      spoken.push(body.text);
      return { audioBase64: 'synthetic' };
    },
  };
  const controller = factory(state, actions).assistantSpeechController(ui);
  const question = 'Мухамедянова или Хабибулина?';
  const reply = {
    text: 'Лишний вводный текст ' + question,
    dialogue: {
      step: 'client',
      phase: 'clientChoice',
      prompt: question,
      options: [
        { id: 'PRIVATE_1', label: 'Гульнара Мухамедянова · …1000' },
        { id: 'PRIVATE_2', label: 'Гульнара Хабибулина · …1001' },
      ],
    },
  };
  const before = JSON.stringify(reply);
  assert.equal(await controller.speakReply(reply, true), true);
  assert.equal(spoken.join(' '), question);
  assert.equal(JSON.stringify(reply), before);
  assert.doesNotMatch(spoken.join(' '), /Вариант|номер|Лишний|PRIVATE_|1000|1001|Гульнара/u);
});

test('a current surname reply bypasses the model and reaches the exact unsaved client form', () => {
  const f = fixture();
  const result = f.start({
    query: 'Гульнара',
    date: day,
    time: '10:00',
    serviceQuery: 'Чистка',
    duration: 30,
  });
  const body = {
    dialogueId: result.dialogue.id,
    dialogueVersion: result.dialogue.version,
    text: 'Мухамедянову',
  };
  assert.equal(f.flow.prepareModelTurn(f.c, body, f.state, f.member, f.clock), null);
  const selected = f.answer({ text: 'Мухамедянову' }).result;
  assert.equal(selected.dialogue.step, 'review');
  const entry = f.flow.get(f.c, f.member, f.state, selected.dialogue.id);
  assert.equal(entry.data.patient.id, 'synthetic-client-0');
  const ready = f.answer({ text: 'открой форму' }).result;
  assert.equal(ready.action.patientId, 'synthetic-client-0');
  assert.equal(ready.action.type, 'prepareAppointment');
  noSave(f);
});
test('reversed first/surname roles never turn full identities into choosing one component', () => {
  const f = fixture([
    ['Алексей', 'Иванов'],
    ['Иванов', 'Алексей'],
  ]);
  const before = JSON.stringify(f.patients);
  const view = clientChoiceView(f.patients);
  assert.equal(view.prompt, 'Назовите последние четыре цифры телефона или полное имя.');
  assert.equal(view.showChoices, true, 'whole candidate identities stay on screen');
  const { resolveClient } = require('../src/server/modules/assistant/language/names/name-directory.cjs');
  assert.deepEqual(
    resolveClient(f.c, 'Алексей Иванов').matches.map((patient) => patient.id),
    f.patients.map((patient) => patient.id),
  );
  assert.equal(JSON.stringify(f.patients), before);
});
test('crossed name components use patronymics only when every candidate has a distinct real patronymic', () => {
  const f = fixture([
    ['Алексей', 'Иванов', 'Петрович'],
    ['Иванов', 'Алексей', 'Сергеевич'],
  ]);
  assert.equal(clientChoiceView(f.patients).prompt, 'Петрович или Сергеевич?');
  assert.equal(clientChoiceOperation(f.c, f.entry, 'Сергеевича').choice, 'opaque-1');
  f.patients[1].middleName = '';
  assert.equal(
    clientChoiceView(f.patients).prompt,
    'Назовите последние четыре цифры телефона или полное имя.',
  );
});
test('legacy reversed two-word cards without shown phone tails keep whole choices without requiring an unavailable phone', () => {
  const patients = [{ name: 'Алексей Иванов' }, { name: 'Иванов Алексей' }];
  assert.equal(
    clientChoiceView(patients).prompt,
    'Уточните полное имя или выберите клиента на экране.',
  );
  assert.equal(clientChoiceView(patients).showChoices, true);
});

test('single-client confirmation asks the exact card name and one short verification', () => {
  const f = fixture([['Анаид', 'Макартычян']]);
  const view = clientChoiceView(f.patients, { approximate: true, hasQuery: true });
  assert.equal(view.prompt, 'Анаид Макартычян, верно?');
  assert.equal(view.showChoices, true);
  assert.equal(view.phase, 'clientChoice');
  assert.equal(clientChoiceView([{ name: 'Анна Семёнова' }]).prompt, 'Анна Семёнова, верно?');
  noSave(f);
});
