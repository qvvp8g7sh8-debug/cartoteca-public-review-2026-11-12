const test = require('node:test');
const assert = require('node:assert/strict');
const {
  initialState,
  patchSettings,
} = require('../src/server/modules/assistant/access/defaults.cjs');
const {
  capabilities,
} = require('../src/server/modules/assistant/interpretation/prompt-budget.cjs');
const {
  intentNames,
} = require('../src/server/modules/assistant/interpretation/intent-contract.cjs');
const {
  commandCategory,
} = require('../src/server/modules/assistant/interpretation/intent-schema.cjs');
const { modelPayload } = require('../src/server/modules/assistant/interpretation/intents.cjs');
const {
  continuationPayload,
} = require('../src/server/modules/assistant/dialogue/continuation/continuation-prompt.cjs');
const {
  selectExamples,
} = require('../src/server/modules/assistant/behavior/example-selection.cjs');
const context = {
  step: 'date',
  role: 'owner',
  clock: { date: '2099-01-05', hour: 8, minute: 0 },
  selected: {},
  missingFields: ['date', 'time'],
  options: [],
};
function projection(text) {
  const match = /Доступные действия \(commands, данные\): (\{[^\n]+\})\./u.exec(text);
  assert.ok(match, 'Every actual prompt includes a complete capabilities object');
  return JSON.parse(match[1]);
}
function expected(policy) {
  return Object.fromEntries(
    intentNames.map((intent) => [
      intent,
      intent === 'help' || policy.commands?.[commandCategory(intent)] === true,
    ]),
  );
}
for (let mask = 0; mask < 8; mask++)
  test(
    'All nine intents have explicit permissions in initial and continuation prompts; category mask=' +
      mask,
    () => {
      const s = initialState();
      s.policy.commands = {
        calendar: Boolean(mask & 1),
        clients: Boolean(mask & 2),
        prepareAppointment: Boolean(mask & 4),
      };
      const before = JSON.stringify(s),
        flags = expected(s.policy);
      const direct = projection(capabilities(s.policy));
      assert.equal(intentNames.length, 9);
      assert.deepEqual(Object.keys(direct.commands), [...intentNames]);
      assert.deepEqual(direct.commands, flags);
      assert.deepEqual(
        direct.intents,
        intentNames.filter((intent) => flags[intent]),
      );
      for (const provider of ['timeweb', 'codex']) {
        s.providers.llm.provider = provider;
        for (const built of [
          modelPayload('Открой карту Дед Мороз', s, 'Europe/Moscow'),
          continuationPayload('Дед Мороз', s, context, 'Europe/Moscow'),
        ]) {
          const system = built.payload.messages[0].content;
          assert.deepEqual(projection(system), direct, provider);
          assert.match(
            system,
            /commands содержит явное разрешение каждого intent; false означает help/u,
          );
        }
      }
      s.providers.llm.provider = 'demo';
      assert.equal(
        JSON.stringify(s),
        before,
        'Prompt projections never mutate stored categories or grants',
      );
    },
  );
const clientIntents = ['clients', 'clientCard'];
const appointmentIntents = [
  'prepareAppointment',
  'moveAppointment',
  'cancelAppointment',
  'editAppointment',
];
for (const mode of ['manual', 'automatic'])
  for (const [category, disabled, text] of [
    ['clients', clientIntents, 'Открой карту Анны Ивановой'],
    ['prepareAppointment', appointmentIntents, 'Запиши Анну Иванову на завтра'],
  ])
    test(
      'Disabled category disables every derived intent and its examples: ' + category + '/' + mode,
      () => {
        const s = initialState();
        s.providers.llm.provider = 'timeweb';
        s.policy.commands[category] = false;
        s.policy.exampleSelection = mode;
        s.policy.examples = disabled.map((intent, index) => ({
          id: '10000000-0000-4000-8000-' + String(index + 1).padStart(12, '0'),
          enabled: true,
          text,
          referenceDate: '2099-01-05',
          expected: { intent, query: 'Анны Ивановой' },
        }));
        const flags = projection(capabilities(s.policy));
        for (const intent of disabled) {
          assert.equal(flags.commands[intent], false);
          assert.equal(flags.intents.includes(intent), false);
        }
        const selected = selectExamples(text, s.policy);
        assert.equal(
          selected.examples.some((row) => disabled.includes(row.expected.intent)),
          false,
        );
        const payload = modelPayload(text, s, 'Europe/Moscow');
        assert.deepEqual(projection(payload.payload.messages[0].content), flags);
        for (const id of s.policy.examples.map((row) => row.id))
          assert.equal(
            payload.exampleSelection.selected.some((row) => row.id === id),
            false,
          );
        assert.equal(
          projection(
            continuationPayload('На завтра', s, context, 'Europe/Moscow').payload.messages[0]
              .content,
          ).commands[category],
          false,
        );
      },
    );
test('Projection inherits only strict existing category switches and never invents settings or ACL grants', () => {
  const s = initialState();
  const before = JSON.stringify(s);
  const all = projection(capabilities(s.policy));
  assert.equal(all.commands.clientCard, true);
  assert.equal(all.commands.availability, true);
  for (const intent of appointmentIntents) assert.equal(all.commands[intent], true);
  assert.equal(JSON.stringify(s), before);
  assert.throws(() => patchSettings(s, { policy: { commands: { clientCard: true } } }), {
    status: 400,
  });
  assert.equal(
    JSON.stringify(s),
    before,
    'The model projection does not add new persistent switches',
  );
  const forged = projection(
    capabilities({
      commands: {
        calendar: 1,
        clients: 'true',
        prepareAppointment: false,
        clientCard: true,
        moveAppointment: true,
      },
    }),
  );
  assert.deepEqual(forged.intents, ['help']);
  assert.deepEqual(
    Object.values(forged.commands),
    intentNames.map((intent) => intent === 'help'),
  );
  assert.deepEqual(projection(capabilities({})).intents, ['help']);
});
