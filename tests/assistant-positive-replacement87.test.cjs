const test = require('node:test');
const assert = require('node:assert/strict');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const {
  continuationOperation,
} = require('../src/server/modules/assistant/dialogue/continuation/continuation-operation.cjs');
const {
  positiveReplacementSource,
} = require('../src/server/modules/assistant/dialogue/continuation/continuation-positive-replacement.cjs');
const {
  continuationExamples,
} = require('../src/server/modules/assistant/dialogue/continuation/continuation-examples.cjs');
const proposal = (fields = {}) => ({
  operation: 'patch',
  choice: null,
  field: null,
  fields: {
    client: null,
    staff: null,
    service: null,
    date: null,
    time: null,
    duration: null,
    ...fields,
  },
});
function fixture() {
  const f = dialogueFixture({ ambiguous: true });
  f.services[0].duration = 90;
  f.services.push({ id: 'consult', name: 'Консультация', duration: 60, staffId: 'owner' });
  f.c.platform.workSchedules.view = () => ({
    days: { [day]: { status: 'working', intervals: [['07:00', '20:00']] } },
    closures: {},
  });
  const first = f.start(
    { query: 'Анна Семёнова', serviceQuery: 'Консультация', date: day },
    { openWhenComplete: true },
  );
  assert.equal(first.dialogue.step, 'time');
  return {
    ...f,
    first,
    apply(text, fields) {
      const body = { dialogueId: first.dialogue.id, dialogueVersion: first.dialogue.version, text };
      const snapshot = f.flow.prepareModelTurn(f.c, body, f.state, f.member, f.clock);
      assert.ok(snapshot, 'Composite replacement reaches model-owned extraction');
      const before = JSON.stringify(f.patients);
      const result = f.flow.applyModelTurn(
        f.c,
        body,
        f.state,
        f.member,
        f.clock,
        proposal(fields),
        snapshot,
      );
      assert.equal(JSON.stringify(f.patients), before, 'Dialogue alone never saves clinical data');
      return result;
    },
  };
}
test('real-model reply87: bare leading Нет applies client/service/time together and keeps date', () => {
  const f = fixture();
  const result = f.apply('Нет, Ольгу на чистку в18:00', {
    client: 'Ольгу',
    service: 'чистку',
    time: '18:00',
  });
  assert.equal(result.action?.type, 'prepareAppointment');
  assert.equal(result.action.patientId, f.patients[1].id);
  assert.equal(result.action.date, day);
  assert.equal(result.action.time, '18:00');
  assert.equal(result.action.duration, 90);
  assert.deepEqual(result.action.serviceIds, ['clean']);
});
for (const text of [
  'Нет Ольгу на чистку в18:00',
  'Нет. Ольгу на чистку в18:00',
  'Нет! Ольгу на чистку в18:00',
  'Нет!Ольгу на чистку в18:00',
  'Нет: Ольгу на чистку в18:00',
  'Нет — Ольгу на чистку в18:00',
  'Нет – Ольгу на чистку в18:00',
  'Нет-Ольгу на чистку в18:00',
  'Нет… Ольгу на чистку в18:00',
  'Нет...Ольгу на чистку в18:00',
  'Нет?! Ольгу на чистку в18:00',
  'Нет; Ольгу на чистку в18:00',
  'Нет: клиента Ольгу на чистку в18:00',
])
  test('punctuation from transcription does not change a whole proven correction: ' + text, () => {
    const f = fixture();
    const result = f.apply(text, { client: 'Ольгу', service: 'чистку', time: '18:00' });
    assert.equal(result.action?.type, 'prepareAppointment');
    assert.equal(result.action.patientId, f.patients[1].id);
    assert.deepEqual(result.action.serviceIds, ['clean']);
    assert.equal(result.action.time, '18:00');
  });
for (const text of [
  'Нет!Ольгу не на чистку в18:00',
  'Нет: Ольгу или Анну на чистку в18:00',
  'Нет — Ольгу на чистку в18:00, если свободно',
  'Нет… Ольгу на чистку в18:00 и отмени запись',
  'Нет...Ольгу на чистку в18:00 и отправь сообщение',
  'Нет?! Не Ольгу на чистку в18:00',
  'Нет-нет, Ольгу на чистку в18:00',
  'Нет: Ольгу на чистку в18:00. Клиента не меняй.',
])
  test(
    'ASR punctuation does not conceal inner denial, alternatives or another action: ' + text,
    () => {
      const f = fixture();
      const result = f.apply(text, { client: 'Ольгу', service: 'чистку', time: '18:00' });
      assert.equal(result.action, null);
      const entry = f.flow.get(f.c, f.member, f.state, f.first.dialogue.id);
      if (text.startsWith('Нет-нет')) {
        assert.notEqual(
          entry.data.patient?.id,
          f.patients[1].id,
          'An unresolved denial cannot select the proposed new client',
        );
        assert.equal(
          positiveReplacementSource(text, proposal({ client: 'Ольгу', service: 'чистку' }).fields),
          null,
        );
      } else assert.equal(entry.data.patient?.id, f.patients[0].id);
      if (!text.startsWith('Нет-нет')) assert.equal(entry.data.service?.id, 'consult');
    },
  );
function permutations(values) {
  return values.length < 2
    ? [values]
    : values.flatMap((value, index) =>
        permutations(values.filter((_, at) => at !== index)).map((tail) => [value, ...tail]),
      );
}
for (const chunks of permutations(['Ольгу Семёнову', 'на чистку', 'на сегодня', 'в16:00']))
  test('positive replacement is whole and independent of field order: ' + chunks.join('; '), () => {
    const f = fixture();
    const result = f.apply('Нет, ' + chunks.join('; '), {
      client: 'Ольгу Семёнову',
      service: 'чистку',
      date: day,
      time: '16:00',
    });
    assert.equal(result.action?.type, 'prepareAppointment');
    assert.equal(result.action.patientId, f.patients[1].id);
    assert.equal(result.action.date, day);
    assert.equal(result.action.time, '16:00');
    assert.equal(result.action.duration, 90);
    assert.deepEqual(result.action.serviceIds, ['clean']);
  });
for (const text of ['Нет, Ольгу на чистку после обеда', 'Нет, после обеда Ольгу на чистку'])
  test('leading correction acknowledgement also preserves a proven time window: ' + text, () => {
    const f = fixture();
    const entry = f.flow.get(f.c, f.member, f.state, f.first.dialogue.id);
    const operation = continuationOperation(
      proposal({ client: 'Ольгу', service: 'чистку' }),
      { text },
      entry,
      f.clock,
    );
    assert.equal(operation.kind, 'modelPatch');
    assert.ok(operation.constraints.timeWindow);
    assert.deepEqual(
      operation.edits.filter((row) => ['client', 'service'].includes(row.field)),
      [
        { field: 'client', text: 'Ольгу' },
        { field: 'service', text: 'чистку' },
      ],
    );
  });
for (const text of [
  'Нет, Ольгу не на чистку в16:00',
  'Нет, Ольгу или Анну на чистку в16:00',
  'Нет, Ольгу на чистку в16:00, если свободно',
  'Нет, Ольгу на чистку в16:00 и отмени запись',
  'Нет, Ольгу на чистку в16:00 и отправь сообщение',
  'Нет, Ольгу на чистку в16:00 и включи оплату',
  'Нет, Ольгу на чистку в16:00 и ещё что-нибудь',
  'Нет, не Ольгу на чистку в16:00',
  'Нет, примерно в16:00 Ольгу на чистку',
  'Нет, Ольгу на чистку в16:00. Клиентку не меняй.',
])
  test('acknowledgement never weakens full-clause safety: ' + text, () => {
    const f = fixture();
    const result = f.apply(text, { client: 'Ольгу', service: 'чистку', time: '16:00' });
    assert.equal(result.action, null);
    const entry = f.flow.get(f.c, f.member, f.state, f.first.dialogue.id);
    assert.equal(entry.data.patient?.id, f.patients[0].id);
    assert.equal(entry.data.service?.id, 'consult');
  });
test('an incomplete model patch cannot use acknowledgement to hide an omitted bare client', () => {
  const f = fixture();
  const result = f.apply('Нет, Ольгу на чистку в16:00', { service: 'чистку', time: '16:00' });
  assert.equal(result.action, null);
  const entry = f.flow.get(f.c, f.member, f.state, f.first.dialogue.id);
  assert.equal(entry.data.patient?.id, f.patients[0].id);
  assert.equal(entry.data.service?.id, 'consult');
});
test('source scope masks only a proved positive acknowledgement and retains literal name endings', () => {
  const raw = 'Нет, Ольгу на чистку в16:00';
  const result = positiveReplacementSource(
    raw,
    proposal({ client: 'Ольгу', service: 'чистку' }).fields,
  );
  assert.equal(result, '     Ольгу на чистку в16:00');
  assert.equal(
    positiveReplacementSource(
      'Нет, Ольгу на чистку и сюрприз',
      proposal({ client: 'Ольгу', service: 'чистку' }).fields,
    ),
    null,
  );
  assert.equal(
    positiveReplacementSource(
      'Нет, Ольгу на чистку',
      proposal({ client: 'Марию', service: 'чистку' }).fields,
    ),
    null,
  );
});
for (const step of ['client', 'staff', 'service', 'date', 'time', 'duration', 'review'])
  test('bare correction example is selected and passes the actual guard on step=' + step, () => {
    const text = 'Нет, Ольгу на чистку в18:00';
    const context = {
      step,
      role: 'owner',
      selected: {},
      missingFields: step === 'review' ? [] : [step],
      options: [],
    };
    const selected = continuationExamples(text, context);
    const example = selected.examples.find((row) => row.text === text);
    assert.ok(example);
    assert.ok(selected.examples.length <= 6);
    assert.ok(selected.metadata.bytes <= 4096);
    const entry = { step, options: new Map(), data: {} };
    const parsed = continuationOperation(example.expected, { text }, entry, {
      date: day,
      hour: 8,
      minute: 0,
    });
    assert.equal(parsed.kind, 'modelPatch');
    assert.deepEqual(parsed.edits, [
      { field: 'client', text: 'Ольгу' },
      { field: 'service', text: 'чистку' },
      { field: 'time', text: '18:00' },
    ]);
    assert.deepEqual(entry.data, {});
  });
