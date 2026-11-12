const test = require('node:test');
const assert = require('node:assert/strict');
const { initialState } = require('../src/server/modules/assistant/access/defaults.cjs');
const { dialogueFixture } = require('./helpers/assistant-dialogue-fixture.cjs');
const {
  continuationExample,
  safeContinuationContext,
  parseContinuation,
} = require('../src/server/modules/assistant/dialogue/continuation/continuation-contract.cjs');
const {
  continuationExamples,
} = require('../src/server/modules/assistant/dialogue/continuation/continuation-examples.cjs');
const {
  continuationPayload,
} = require('../src/server/modules/assistant/dialogue/continuation/continuation-prompt.cjs');
const { modelPayload } = require('../src/server/modules/assistant/interpretation/intents.cjs');
const {
  selectExamples,
  eligible,
} = require('../src/server/modules/assistant/behavior/example-selection.cjs');
const { loadCatalog } = require('../src/server/modules/assistant/behavior/behavior-library.cjs');
const {
  currentIntentForCase,
} = require('../src/server/modules/assistant/behavior/example-projection.cjs');
const {
  assessmentForCase,
} = require('../src/server/modules/assistant/behavior/behavior-library-coverage.cjs');
const { taskOf } = require('../src/server/modules/assistant/behavior/example-routing.cjs');
const {
  continuationOperation,
} = require('../src/server/modules/assistant/dialogue/continuation/continuation-operation.cjs');
const {
  validateCommandFields,
  normalizeIntent,
} = require('../src/server/modules/assistant/interpretation/intent-schema.cjs');
const clock = { date: '2099-01-05', hour: 8, minute: 0 };
function context(step = 'staff', options = []) {
  return { step, role: 'owner', clock, selected: {}, missingFields: ['staff'], options };
}
for (const text of ['В ноябре утром', 'В ноябре, утром', 'В ноябре в шестнадцать тридцать']) {
  test('pending month joins a whole temporal clause: ' + text, () => {
    const f = dialogueFixture();
    f.start({ query: 'Анна Семёнова', serviceQuery: 'Чистка', time: '16:00' }, { date: null });
    f.answer({ text: 'на двадцать девятое' });
    const body = {
      dialogueId: f.result.dialogue.id,
      dialogueVersion: f.result.dialogue.version,
      text,
    };
    const snapshot = f.flow.prepareModelTurn(f.c, body, f.state, f.member, f.clock);
    assert.ok(snapshot);
    const r = f.flow.applyModelTurn(
      f.c,
      body,
      f.state,
      f.member,
      f.clock,
      /шестнадцать/u.test(text)
        ? continuationExample({ operation: 'patch', fields: { time: '16:30' } })
        : continuationExample({ operation: 'slots' }),
      snapshot,
    );
    const pending = f.flow.get(f.c, f.member, f.state, body.dialogueId).data;
    assert.equal(pending.date, null);
    assert.equal(pending.dateProposal.date, '2099-11-29');
    if (/шестнадцать/u.test(text)) assert.equal(pending.time, '16:30');
    else assert.equal(pending.timeWindow.kind, 'morning');
    assert.equal(r.action, null);
    f.flow.continueDialogue(
      f.c,
      {
        dialogueId: r.dialogue.id,
        dialogueVersion: r.dialogue.version,
        policyVersion: f.state.revision,
        text: 'да',
      },
      f.state,
      f.member,
      f.clock,
    );
    const confirmed = f.flow.get(f.c, f.member, f.state, body.dialogueId).data;
    assert.equal(confirmed.date, '2099-11-29');
    assert.equal(confirmed.dateProposal, undefined);
    if (/шестнадцать/u.test(text)) assert.equal(confirmed.time, '16:30');
    else assert.equal(confirmed.timeWindow.kind, 'morning');
    assert.equal(f.patients[0].appointments.length, 0);
  });
}
test('month joining does not hide a condition, alternative, second action or trailing entity', () => {
  const {
    pendingMonthAnswer,
  } = require('../src/server/modules/assistant/dialogue/pending-month-answer.cjs');
  const e = { data: { dateProposal: { day: 29, date: '2099-01-29' } } };
  for (const text of [
    'В ноябре если утром',
    'В ноябре утром или вечером',
    'В ноябре утром удали запись',
    'В ноябре в 16:30 Мария',
    'В ноябре не утром',
  ])
    assert.equal(pendingMonthAnswer(e, text, clock), null, text);
});
test('all current positive eligible author cases retrieve an example of their own intent', () => {
  const s = initialState();
  s.policy.exampleSelection = 'automatic';
  const cases = loadCatalog().cases;
  assert.equal(cases.length, 313);
  for (const row of cases) {
    const expected = currentIntentForCase(row);
    const selected = selectExamples(row.text, s.policy, {
      clock: { ...clock, date: row.referenceDate },
    });
    for (const example of selected.examples)
      validateCommandFields(normalizeIntent(example.expected));
    if (eligible(row) && assessmentForCase(row).family !== 'archive' && expected.intent !== 'help')
      assert.ok(
        selected.examples.some((example) => example.expected.intent === expected.intent),
        row.id,
      );
  }
});
test('all-record calendar read is distinct from bulk writes, exports and foreign organizations', () => {
  assert.equal(taskOf('Покажи все записи на следующую неделю').boundaryOnly, false);
  for (const text of [
    'Отмени все записи на следующую неделю',
    'Выгрузи все записи',
    'Покажи все записи всех организаций',
  ])
    assert.equal(taskOf(text).boundaryOnly, true, text);
  const rows = loadCatalog().cases;
  for (const id of ['identity-archived', 'correction-new-vs-old']) {
    assert.equal(eligible(rows.find((row) => row.id === id)), false);
    assert.equal(assessmentForCase(rows.find((row) => row.id === id)).family, 'archive');
  }
});
for (const count of [0, 1, 2])
  test('choice examples require an available numbered option: ' + count, () => {
    const c = context(
      'client',
      Array.from({ length: count }, (_, index) => ({ number: index + 1, kind: 'client' })),
    );
    const selected = continuationExamples('Из предложенных мне больше подходит второй', c);
    assert.equal(
      selected.examples.some((row) => row.expected.operation === 'choice'),
      count === 2,
    );
    selected.examples.forEach((row) => parseContinuation(row.expected));
  });
test('unsupported option kinds and unfinished review never teach choice or ready', () => {
  const c = context('review', [{ number: 2, kind: 'managementCancelConfirm' }]);
  const selected = continuationExamples('Да, подтверждаю, второй', c);
  assert.equal(
    selected.examples.some((row) => ['choice', 'ready'].includes(row.expected.operation)),
    false,
  );
});
for (const step of ['client', 'service', 'date', 'time', 'staff'])
  test('explicit staff correction is represented at step ' + step, () => {
    for (const role of ['owner', 'salon_admin']) {
      const selected = continuationExamples('Сотрудника поменяй на Марию Иванову', {
        ...context(step),
        role,
      });
      assert.ok(selected.examples.some((row) => row.expected.fields.staff === 'Марию Иванову'));
      assert.ok(selected.examples.length <= 6);
      assert.ok(Buffer.byteLength(JSON.stringify(selected.examples)) <= 4096);
    }
    assert.equal(
      continuationExamples('Сотрудника поменяй на Марию Иванову', {
        ...context(step),
        role: 'cosmetologist',
      }).examples.some((row) => row.expected.fields.staff),
      false,
    );
  });
test('approved field examples are adapted with provenance and the continuation contract in both modes', () => {
  for (const mode of ['manual', 'automatic']) {
    const s = initialState();
    s.policy.exampleSelection = mode;
    s.policy.examples = [
      {
        id: '10000000-0000-4000-8000-000000000080',
        enabled: true,
        text: 'Клиент Анна Семёнова',
        referenceDate: '2026-10-20',
        referenceTime: '10:00',
        expected: { intent: 'prepareAppointment', query: 'Анна Семёнова' },
      },
    ];
    const c = { ...context('client'), missingFields: ['client'] };
    const built = continuationPayload('Клиент Анна Семёнова', s, c, 'Europe/Moscow');
    assert.equal(built.exampleSelection.branch, 'create-followup');
    assert.equal(built.exampleSelection.configuredMode, mode);
    assert.ok(
      built.exampleSelection.selected.some(
        (row) => row.id === s.policy.examples[0].id && row.source === 'custom-adapted',
      ),
    );
    const selected = continuationExamples('Клиент Анна Семёнова', c, { policy: s.policy });
    const example = selected.examples.find((row) => row.text === s.policy.examples[0].text);
    assert.equal(example.expected.operation, 'patch');
    assert.equal(example.expected.fields.client, 'Анна Семёнова');
    assert.equal(example.expected.intent, undefined);
    assert.equal(example.referenceDate, '2026-10-20');
    assert.ok(built.payload.messages[0].content.includes('Анна Семёнова'));
  }
});
test('invalid, disabled and unrelated initial examples never become followup patches', () => {
  const s = initialState();
  s.policy.examples = ['disabled', 'unspoken', 'other-intent'].map((kind, index) => ({
    id: '10000000-0000-4000-8000-00000000008' + index,
    enabled: kind !== 'disabled',
    text: 'Клиент Анна Семёнова',
    referenceDate: '2026-10-20',
    expected:
      kind === 'other-intent'
        ? { intent: 'clientCard', query: 'Анна Семёнова' }
        : {
            intent: 'prepareAppointment',
            query: kind === 'unspoken' ? 'Ольга Петрова' : 'Анна Семёнова',
          },
  }));
  assert.equal(
    continuationExamples('Клиент Анна Семёнова', context('client'), { policy: s.policy }).metadata
      .customCandidates,
    0,
  );
});
for (const [text, field, value] of [
  ['Сотрудника поменяй на Марию Иванову', 'staff', 'Марию Иванову'],
  ['Клиента поменяй на Ольгу Семёнову', 'client', 'Ольгу Семёнову'],
  ['Услугу поменяй на пилинг PRX', 'service', 'пилинг PRX'],
])
  test(
    'cross-field example is accepted by source guards without replaying selected values: ' + field,
    () => {
      const c = context('time');
      const example = continuationExamples(text, c).examples.find((row) => row.text === text);
      assert.ok(example);
      const entry = {
        step: 'time',
        options: new Map(),
        data: { date: '2099-01-05', time: null, duration: 60 },
      };
      const before = structuredClone(entry.data);
      const op = continuationOperation(example.expected, { text }, entry, clock);
      assert.equal(op.kind, 'modelPatch');
      assert.deepEqual(op.edits, [{ field, text: value }]);
      assert.deepEqual(entry.data, before);
    },
  );
test('administrative review describes every supported server intent without undefined actions', () => {
  const fs = require('node:fs'),
    vm = require('node:vm');
  const source = fs.readFileSync(
    require.resolve('../src/client/modules/admin/voice-behavior-diff.js'),
    'utf8',
  );
  const sandbox = { records: { esc: String } };
  vm.runInNewContext(source + '\nthis.diff = createAdminVoiceBehaviorDiff({ records });', sandbox);
  const {
    commandFields,
  } = require('../src/server/modules/assistant/interpretation/intent-contract.cjs');
  for (const intent of Object.keys(commandFields)) {
    const html = sandbox.diff.render({
      instructions: { changed: false },
      dictionary: { changed: false },
      examples: {
        added: [
          {
            text: 'Синтетический пример',
            enabled: true,
            referenceDate: '2099-01-05',
            referenceTime: '09:00',
            expected: { intent },
          },
        ],
        removed: [],
        changed: [],
        orderChanged: false,
      },
    });
    assert.doesNotMatch(html, /<dd>undefined<\/dd>/u, intent);
    assert.match(html, /<dt>Действие<\/dt><dd>[^<]+<\/dd>/u, intent);
  }
});

test('administrative editor exposes the same command fields as the server and explains separate schemas', () => {
  const fs = require('node:fs'),
    vm = require('node:vm');
  const source = fs.readFileSync(
    require.resolve('../src/client/modules/admin/voice-behavior-view.js'),
    'utf8',
  );
  const sandbox = { records: { esc: String, date: String } };
  vm.runInNewContext(source + '\nthis.view = createAdminVoiceBehaviorView({ records });', sandbox);
  const {
    commandFields,
  } = require('../src/server/modules/assistant/interpretation/intent-contract.cjs');
  for (const [intent, fields] of Object.entries(commandFields)) {
    assert.ok(sandbox.view.intents[intent]);
    assert.deepEqual(Array.from(sandbox.view.applicable[intent]), Array.from(fields));
  }
  const rules = sandbox.view.rules({
    limits: {
      maxInstructionsChars: 4000,
      maxDictionaryChars: 4000,
      maxEnabledExamples: 12,
      maxExamples: 50,
      maxEnabledExamplesBytes: 4096,
      maxRulesBytes: 65536,
    },
    rules: { instructions: '', dictionary: '' },
  });
  assert.match(rules, /другой JSON-контракт/u);
  assert.match(rules, /исходный приём/u);
});
for (const mode of ['manual', 'automatic'])
  test('disabled capability excludes initial and followup examples: ' + mode, () => {
    for (const [intent, category] of [
      ['prepareAppointment', 'prepareAppointment'],
      ['calendar', 'calendar'],
      ['clientCard', 'clients'],
    ]) {
      const s = initialState();
      s.policy.exampleSelection = mode;
      s.policy.commands[category] = false;
      s.policy.examples = [
        {
          id: '10000000-0000-4000-8000-000000000080',
          enabled: true,
          text: 'Клиент Анна',
          referenceDate: '2026-10-20',
          expected: { intent, ...(intent === 'calendar' ? {} : { query: 'Анна' }) },
        },
      ];
      const selected = selectExamples('Клиент Анна', s.policy);
      assert.equal(
        selected.examples.some((row) => row.expected.intent === intent),
        false,
      );
      const built = modelPayload('Клиент Анна', s, 'Europe/Moscow');
      assert.ok(built.payload.messages[0].content.includes('"' + category + '":false'));
      if (category === 'prepareAppointment')
        assert.equal(
          continuationExamples('Сотрудника поменяй на Марию', context(), {
            policy: s.policy,
          }).examples.some((row) => row.expected.operation === 'patch'),
          false,
        );
    }
  });
