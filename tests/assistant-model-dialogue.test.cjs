const test = require('node:test');
const assert = require('node:assert/strict');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const empty = { client: null, staff: null, service: null, date: null, time: null, duration: null };
const proposal = (operation, values = {}, extra = {}) => ({
  operation,
  fields: { ...empty, ...values },
  choice: null,
  field: null,
  ...extra,
});
function harness(intent = {}, role = 'owner') {
  const f = dialogueFixture({ role });
  if (role === 'cosmetologist') f.members[0].role = role;
  let result = f.start({ query: 'Анна', ...intent });
  const body = (operation) => ({
    policyVersion: f.state.revision,
    dialogueId: result.dialogue.id,
    dialogueVersion: result.dialogue.version,
    ...operation,
  });
  return {
    f,
    get result() {
      return result;
    },
    entry() {
      return f.flow.get(f.c, f.member, f.state, result.dialogue.id);
    },
    prepare(text) {
      const request = body({ text });
      return {
        body: request,
        snapshot: f.flow.prepareModelTurn(f.c, request, f.state, f.member, f.clock),
      };
    },
    apply(prepared, value) {
      result = f.flow.applyModelTurn(
        f.c,
        prepared.body,
        f.state,
        f.member,
        f.clock,
        value,
        prepared.snapshot,
      );
      return result;
    },
    model(text, value) {
      const prepared = this.prepare(text);
      assert.ok(prepared.snapshot, text);
      return this.apply(prepared, value);
    },
    local(operation) {
      result = f.flow.continueDialogue(f.c, body(operation), f.state, f.member, f.clock);
      return result;
    },
  };
}
const readyIntent = { serviceQuery: 'Чистка', date: day, time: '10:00', duration: 45 };
const noSave = (h) => assert.ok(h.f.patients.every((row) => row.appointments.length === 0));
test('free multi-field followups become a reviewed manual form with fresh local identities and unchanged appointment storage', () => {
  const h = harness();
  assert.equal(h.result.dialogue.step, 'service');
  h.model(
    'Тогда мне нужна Чистка, давайте сегодня в десять утра',
    proposal('patch', { service: 'Чистка', date: day, time: '10:00' }),
  );
  assert.equal(h.result.dialogue.step, 'review');
  h.model('Пусть приём длится сорок пять минут', proposal('patch', { duration: 45 }));
  assert.equal(h.entry().data.duration, 45);
  assert.equal(h.prepare('Перенеси на полчаса позже').snapshot, null);
  h.local({ text: 'Перенеси на полчаса позже' });
  assert.equal(h.entry().data.time, '10:30');
  assert.equal(h.entry().data.duration, 45);
  const result = h.model('Тогда можно открыть готовую форму', proposal('ready'));
  assert.equal(result.action.type, 'prepareAppointment');
  assert.equal(result.action.patientId, h.f.patients[0].id);
  assert.equal(result.action.time, '10:30');
  assert.equal(result.action.duration, 45);
  noSave(h);
});
test('hallucinated temporal fields in a service-only answer reject the entire patch while an explicit service plus date answer is accepted', () => {
  for (const extra of [{ date: day }, { time: '14:30' }, { duration: 60 }]) {
    const h = harness(),
      before = structuredClone(h.entry().data);
    h.model('Мне нужна услуга Чистка', proposal('patch', { service: 'Чистка', ...extra }));
    assert.deepEqual(h.entry().data, before);
    assert.equal(h.result.action, null);
    noSave(h);
  }
  const h = harness();
  h.model('Нужна Чистка, а день сегодня', proposal('patch', { service: 'Чистка', date: day }));
  assert.equal(h.entry().data.service.id, 'clean');
  assert.equal(h.entry().data.date, day);
  noSave(h);
});
test('names are grounded in the original utterance and a split negative surname cannot be silently repaired or reduced to its negated tail', () => {
  const h = harness(readyIntent),
    before = structuredClone(h.entry().data);
  assert.equal(h.prepare('Исправь клиента на Ольгу').snapshot, null);
  h.model('Я хочу, чтобы следующим клиентом была Ольга', proposal('patch', { client: 'Анна' }));
  assert.deepEqual(h.entry().data, before);
  h.model('Нет, не Анна', proposal('patch', { client: 'Анна' }));
  assert.equal(h.entry().data.patient.id, before.patient.id);
  h.model('не Олина', proposal('patch', { client: 'Олина' }));
  assert.equal(h.entry().data.patient.id, before.patient.id);
  assert.equal(h.entry().data.clientQuery, before.clientQuery);
  assert.equal(h.result.action, null);
  noSave(h);
});
test('explicit ambiguity never becomes an arbitrary exact time or a truncated duration and preserves the unrelated chosen fields', () => {
  const h = harness(readyIntent),
    patient = h.entry().data.patient.id;
  h.model('Давай в два или три часа', proposal('patch', { time: '14:00' }));
  assert.equal(h.result.dialogue.step, 'time');
  assert.equal(h.entry().data.time, null);
  assert.equal(h.entry().data.patient.id, patient);
  assert.equal(h.entry().data.duration, 45);
  h.model('Приём на один час шестьдесят минут', proposal('patch', { duration: 60 }));
  assert.equal(h.result.dialogue.step, 'duration');
  assert.equal(h.entry().data.duration, null);
  assert.equal(h.entry().data.durationSource, 'required');
  assert.equal(h.entry().data.patient.id, patient);
  noSave(h);
});
test('a service alternative or an unsupported secondary action cannot be reduced to its supported first clause', () => {
  for (const text of ['Нужна Чистка или массаж', 'Выбери Чистка и отправь клиенту сообщение']) {
    const h = harness(),
      before = structuredClone(h.entry().data);
    h.model(text, proposal('patch', { service: 'Чистка' }));
    const { _clarificationRecovery, ...businessData } = h.entry().data;
    assert.deepEqual(businessData, before);
    if (text.includes(' или ')) assert.equal(_clarificationRecovery?.count, 1);
    else assert.equal(_clarificationRecovery, undefined);
    assert.equal(h.result.action, null);
  }
});
test('clarification can focus a filled field without deleting the existing draft or opening it through a premature short confirmation', () => {
  const h = harness(readyIntent),
    before = structuredClone(h.entry().data);
  h.model('Я не уверен, уточни специалиста', proposal('clarify', {}, { field: 'staff' }));
  assert.equal(h.result.dialogue.step, 'staff');
  assert.deepEqual(h.entry().data, before);
  h.local({ text: 'запиши' });
  assert.deepEqual(h.entry().data, before);
  assert.ok(h.result.dialogue);
  assert.equal(h.result.action, null);
  noSave(h);
});
test('a free ordinal choice is grounded in the current numbered options and a model cannot pick a client from an unrelated reply', () => {
  const h = harness({ serviceQuery: 'Чистка', date: day, duration: 45 });
  assert.equal(h.result.dialogue.step, 'time');
  assert.equal(h.result.dialogue.phase, 'period');
  assert.ok([...h.entry().options.values()].every((row) => row.kind === 'freeRange'));
  h.local({ text: 'любое время' });
  assert.equal(h.result.dialogue.phase, 'slots');
  const chosen = [...h.entry().options.values()][1].value;
  h.model('Какой из них ты считаешь удобным?', proposal('choice', {}, { choice: 2 }));
  assert.equal(h.entry().data.time, null);
  // Rebuild actual slot choices after the unrelated answer focused clarification.
  h.local({ text: 'подбери свободное время' });
  h.model(
    'Из тех что ты предложил мне больше подходит второй',
    proposal('choice', {}, { choice: 2 }),
  );
  assert.equal(h.entry().data.time, chosen.time);
  assert.equal(h.result.dialogue.step, 'review');
  noSave(h);
});
test('model application records the original frozen body for stable replay and never replays an operation against a newer version', () => {
  const h = harness(readyIntent),
    prepared = h.prepare('Лучше давайте в одиннадцать утра');
  const result = h.apply(prepared, proposal('patch', { time: '11:00' }));
  assert.equal(h.entry().lastHash, h.f.flow.fingerprint(prepared.body));
  assert.equal(
    h.f.flow.prepareModelTurn(h.f.c, prepared.body, h.f.state, h.f.member, h.f.clock),
    null,
  );
  assert.deepEqual(
    h.f.flow.continueDialogue(h.f.c, prepared.body, h.f.state, h.f.member, h.f.clock),
    result,
  );
  assert.throws(() => h.apply(prepared, proposal('patch', { time: '12:00' })), { status: 409 });
  noSave(h);
});
test('late model answers fail after cancel a conflicting answer changed role policy or a revoked patient ACL', () => {
  for (const mode of ['cancel', 'other-answer', 'role', 'policy', 'acl']) {
    const h = harness(readyIntent, mode === 'acl' ? 'cosmetologist' : 'owner');
    const prepared = h.prepare('Лучше на одиннадцать утра');
    if (mode === 'cancel') h.local({ cancel: true });
    else if (mode === 'other-answer') h.local({ text: 'в 12:00' });
    else if (mode === 'role') h.f.c.current.role = 'salon_admin';
    else if (mode === 'policy') h.f.state.revision++;
    else {
      h.f.patients[0].createdBy = 'foreign-staff';
      h.f.changed();
    }
    assert.throws(
      () => h.apply(prepared, proposal('patch', { time: '11:00' })),
      { status: 409 },
      mode,
    );
    noSave(h);
  }
});
test('fast controls and exact repeat remain local while normal text always requests a model snapshot', () => {
  const h = harness(readyIntent),
    before = structuredClone(h.entry().data);
  for (const text of ['да', 'нет', 'запиши', 'отмена', 'повтори вопрос'])
    assert.equal(h.prepare(text).snapshot, null, text);
  const repeated = h.local({ text: 'повтори вопрос' });
  assert.equal(repeated.action, null);
  assert.deepEqual(h.entry().data, before);
  assert.ok(h.prepare('Мне всё-таки нужна консультация завтра после обеда').snapshot);
  noSave(h);
});
test('a model cannot invent clock basis or change appointment length while proposing a relative time shift', () => {
  const h = harness(readyIntent),
    before = structuredClone(h.entry().data);
  assert.equal(h.prepare('Перенеси на полчаса позже').snapshot, null);
  h.model('Мне удобнее прийти на полчаса позже', proposal('patch', { time: '10:30', duration: 30 }));
  assert.deepEqual(h.entry().data, before);
  assert.equal(h.result.action, null);
  noSave(h);
});

test('trusted openWhenComplete returns a complete unique initial draft directly as a manual form while ordinary internal callers retain review', () => {
  for (const enabled of [true, false]) {
    const f = dialogueFixture(),
      ticket = f.flow.beginCommand(f.c, f.member, f.state);
    const result = f.flow.start(
      f.c,
      { intent: 'prepareAppointment', query: 'Анна', ...readyIntent },
      f.state,
      f.member,
      f.clock,
      ticket,
      enabled ? { openWhenComplete: true } : {},
    );
    if (enabled) {
      assert.equal(result.dialogue, null);
      assert.equal(result.action.type, 'prepareAppointment');
      assert.equal(result.action.patientId, f.patients[0].id);
    } else {
      assert.equal(result.dialogue.step, 'review');
      assert.equal(result.action, null);
    }
    assert.ok(f.patients.every((row) => row.appointments.length === 0));
  }
});
test('trusted multi-turn completion and an explicitly confirmed ambiguous client open only a manual form after the last accepted field', () => {
  for (const approximate of [false, true]) {
    const f = dialogueFixture(),
      ticket = f.flow.beginCommand(f.c, f.member, f.state);
    let result = f.flow.start(
      f.c,
      {
        intent: 'prepareAppointment',
        query: approximate ? 'Анна Семёнофа' : 'Анна',
        ...(approximate ? readyIntent : { date: day, time: '10:00', duration: 45 }),
      },
      f.state,
      f.member,
      f.clock,
      ticket,
      { openWhenComplete: true },
    );
    assert.equal(result.action, null);
    assert.equal(result.dialogue.step, approximate ? 'client' : 'service');
    const body = {
      dialogueId: result.dialogue.id,
      dialogueVersion: result.dialogue.version,
      text: approximate ? 'да' : 'Теперь нужна услуга Чистка',
    };
    if (approximate) result = f.flow.continueDialogue(f.c, body, f.state, f.member, f.clock);
    else {
      const snapshot = f.flow.prepareModelTurn(f.c, body, f.state, f.member, f.clock);
      result = f.flow.applyModelTurn(
        f.c,
        body,
        f.state,
        f.member,
        f.clock,
        proposal('patch', { service: 'Чистка' }),
        snapshot,
      );
    }
    assert.equal(result.dialogue, null);
    assert.equal(result.action.type, 'prepareAppointment');
    assert.ok(f.patients.every((row) => row.appointments.length === 0));
  }
});
test('trusted auto-open still requires an exact choice for two clients and does not turn a repeated question into permission', () => {
  const f = dialogueFixture({ ambiguous: true }),
    ticket = f.flow.beginCommand(f.c, f.member, f.state);
  const started = f.flow.start(
    f.c,
    { intent: 'prepareAppointment', query: 'Семёнова', ...readyIntent },
    f.state,
    f.member,
    f.clock,
    ticket,
    { openWhenComplete: true },
  );
  assert.equal(started.dialogue.step, 'client');
  assert.equal(started.dialogue.options.length, 2);
  const repeated = f.flow.continueDialogue(
    f.c,
    {
      dialogueId: started.dialogue.id,
      dialogueVersion: started.dialogue.version,
      text: 'повтори вопрос',
    },
    f.state,
    f.member,
    f.clock,
  );
  assert.equal(repeated.action, null);
  const selected = f.flow.continueDialogue(
    f.c,
    {
      dialogueId: repeated.dialogue.id,
      dialogueVersion: repeated.dialogue.version,
      choice: repeated.dialogue.options[1].id,
    },
    f.state,
    f.member,
    f.clock,
  );
  assert.equal(selected.dialogue, null);
  assert.equal(selected.action.patientId, f.patients[1].id);
  assert.ok(f.patients.every((row) => row.appointments.length === 0));
});

test('a full natural followup sets all explicit fields at once and opens the manual form for a sole eligible performer', () => {
  const f = dialogueFixture();
  f.clock.date = '2099-01-04';
  Object.assign(f.patients[0], { firstName: 'Юлия', lastName: 'Неволина', name: 'Юлия Неволина' });
  f.services[0].name = 'Консультация';
  f.changed();
  const ticket = f.flow.beginCommand(f.c, f.member, f.state);
  const initial = f.flow.start(
    f.c,
    { intent: 'prepareAppointment' },
    f.state,
    f.member,
    f.clock,
    ticket,
    { openWhenComplete: true },
  );
  const body = {
    dialogueId: initial.dialogue.id,
    dialogueVersion: initial.dialogue.version,
    text: 'запиши на завтра на12:00 неволину Юлию на консультацию',
  };
  const snapshot = f.flow.prepareModelTurn(f.c, body, f.state, f.member, f.clock);
  const result = f.flow.applyModelTurn(
    f.c,
    body,
    f.state,
    f.member,
    f.clock,
    proposal('patch', {
      client: 'неволину Юлию',
      service: 'консультацию',
      date: day,
      time: '12:00',
    }),
    snapshot,
  );
  assert.equal(result.dialogue, null);
  assert.equal(result.action.type, 'prepareAppointment');
  assert.equal(result.action.patientId, f.patients[0].id);
  assert.equal(result.action.staffId, f.c.current.accountId);
  assert.equal(result.action.date, day);
  assert.equal(result.action.time, '12:00');
  assert.ok(f.patients.every((row) => row.appointments.length === 0));
});

test('generic time and duration wording never proves a model-supplied value even on that step', () => {
  for (const [intent, raw, fields] of [
    [{ serviceQuery: 'Чистка', date: day }, 'время уточню', { time: '12:30' }],
    [readyIntent, 'длительность уточню', { duration: 60 }],
    [readyIntent, 'пока нев12:30', { time: '12:30' }],
  ]) {
    const h = harness(intent),
      before = structuredClone(h.entry().data);
    h.model(raw, proposal('patch', fields));
    assert.deepEqual(h.entry().data, before, raw);
    assert.equal(h.result.action, null);
    noSave(h);
  }
});

test('split negative name outside a client clarification never replaces the selected client', () => {
  const h = harness(readyIntent),
    before = structuredClone(h.entry().data);
  assert.equal(h.result.dialogue.step, 'review');
  h.model('не Олина', proposal('patch', { client: 'Олина' }));
  assert.deepEqual(h.entry().data, before);
  assert.equal(h.result.action, null);
  assert.equal(h.result.dialogue.step, 'client');
  noSave(h);
});
