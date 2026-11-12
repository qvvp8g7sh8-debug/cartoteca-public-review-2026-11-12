const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createCodexRuntime } = require('../src/server/modules/assistant/providers/codex/codex.cjs');
const {
  normalizeIntent,
  intentNames,
} = require('../src/server/modules/assistant/interpretation/intent-schema.cjs');
const { intentFields } = require('../src/server/modules/assistant/interpretation/intent-contract.cjs');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const local = {
  enabled: true,
  production: false,
  host: '127.0.0.1',
  origin: '',
  additionalOrigins: [],
  releaseGate: false,
  processRole: 'combined',
};
async function codexReply(intent) {
  let writtenSchema;
  const runtime = createCodexRuntime(local, {
    env: { PATH: '/synthetic' },
    findExecutable: () => '/synthetic/codex',
    async runProcess(call) {
      if (call.args[0] === '--version') return { stdout: 'codex-cli 0.154.0\n', stderr: '' };
      if (call.args[0] === 'login') return { stdout: 'Logged in using ChatGPT\n', stderr: '' };
      if (call.args[0] === 'mcp') return { stdout: '[]', stderr: '' };
      assert.equal(call.args[0], 'exec');
      assert.ok(call.args.includes('--strict-config'));
      assert.ok(call.args.includes('features.shell_tool=false'));
      const schemaIndex = call.args.indexOf('--output-schema');
      assert.ok(schemaIndex >= 0);
      writtenSchema = JSON.parse(fs.readFileSync(call.args[schemaIndex + 1], 'utf8'));
      const full = { ...Object.fromEntries(intentFields.map((field) => [field, null])), ...intent };
      for (const event of [
        { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(full) } },
        { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 10 } },
      ])
        call.onStdout(JSON.stringify(event) + '\n');
      return { stdout: '', stderr: '' };
    },
  });
  const reply = await runtime.run({
    payload: {
      messages: [
        { role: 'system', content: 'Synthetic classifier.' },
        { role: 'user', content: 'Synthetic command.' },
      ],
    },
    provider: { provider: 'codex', model: 'codex-default' },
    timeoutMs: 10000,
  });
  return { intent: JSON.parse(reply.text), schema: writtenSchema };
}
const supported = [
  { intent: 'help' },
  { intent: 'calendar', date: day, mode: 'week' },
  { intent: 'calendar', date: '2099-01-01', mode: 'month' },
  { intent: 'clients', query: 'Анну Семенову' },
  { intent: 'clientCard', query: 'Анну Семенову' },
  {
    intent: 'availability',
    date: day,
    endDate: '2099-01-07',
    time: '09:00',
    endTime: '18:00',
    duration: 30,
  },
  { intent: 'moveAppointment', query: 'Гульнару Мухамедьянову', date: day, time: '14:30' },
  {
    intent: 'cancelAppointment',
    query: 'Гульнару Мухамедьянову',
    serviceQuery: 'Чистка',
    date: day,
    time: '10:00',
  },
  { intent: 'editAppointment', query: 'Гульнару Мухамедьянову', staffQuery: 'Тестовый Специалист' },
  {
    intent: 'prepareAppointment',
    query: 'Анну Семенову',
    staffQuery: 'Тестовый Специалист',
    serviceQuery: 'Чистка',
    date: day,
    time: '10:00',
    duration: 30,
  },
];
test('written Codex schema represents every application intent and new period/view fields with strict nullable output', async () => {
  const seen = new Set();
  for (const expected of supported) {
    const result = await codexReply(expected),
      schema = result.schema;
    assert.deepEqual(result.intent, normalizeIntent(expected));
    assert.deepEqual(schema.properties.intent.enum, intentNames);
    assert.ok(schema.properties.intent.enum.includes(expected.intent));
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, Object.keys(schema.properties));
    for (const field of [
      'query',
      'date',
      'endDate',
      'time',
      'endTime',
      'mode',
      'staffQuery',
      'serviceQuery',
      'duration',
    ]) {
      assert.ok(schema.required.includes(field));
      assert.ok(schema.properties[field].type.includes('null'));
    }
    assert.deepEqual(schema.properties.mode.enum, ['day', 'week', 'month', null]);
    seen.add(result.intent.intent);
  }
  assert.deepEqual([...seen].sort(), [...intentNames].sort());
});
test('Codex nullable output still passes the common semantic restrictions and never accepts invented identities/actions', async () => {
  for (const [intent, status] of [
    [{ intent: 'calendar', mode: 'year' }, 502],
    [{ intent: 'calendar', endDate: '2099-01-07' }, 502],
    [{ intent: 'clientCard', endTime: '18:00' }, 502],
    [{ intent: 'availability', date: day, endDate: '2099-01-04' }, 502],
    [{ intent: 'availability', time: '25:00' }, 502],
    [{ intent: 'prepareAppointment', duration: 32 }, 502],
    [{ intent: 'prepareAppointment', patientId: 'invented-patient' }, 502],
    [{ intent: 'prepareAppointment', save: true }, 502],
    [{ intent: 'moveAppointment', query: 'Гульнара', duration: 30 }, 502],
    [{ intent: 'cancelAppointment', query: 'Гульнара', duration: 30 }, 502],
    [{ intent: 'editAppointment', query: 'Гульнара', appointmentId: 'invented-source' }, 502],
    [{ intent: 'moveAppointment', query: 'Гульнара', sourceStamp: 'invented-stamp' }, 502],
    [{ intent: 'deleteAppointment' }, 502],
  ])
    await assert.rejects(codexReply(intent), { status });
});
test('Codex preparation reaches the ordinary manual-save form only after review and never creates the appointment itself', async () => {
  const f = dialogueFixture();
  const parsed = await codexReply({
    intent: 'prepareAppointment',
    query: 'Анну Семенову',
    staffQuery: 'Тестовый Специалист',
    serviceQuery: 'Чистка',
    date: day,
    time: '10:00',
    duration: 30,
  });
  const first = f.start(parsed.intent);
  assert.equal(first.dialogue.step, 'review');
  assert.equal(first.action, null);
  assert.equal(f.patients[0].appointments.length, 0);
  const reviewed = f.answer({ choice: first.dialogue.options[0].id }).result;
  assert.deepEqual(reviewed.action, {
    type: 'prepareAppointment',
    patientId: f.patients[0].id,
    staffId: 'owner',
    date: day,
    time: '10:00',
    duration: 30,
    roomId: 'main',
    serviceIds: ['clean'],
  });
  assert.equal(reviewed.dialogue, null);
  assert.match(reviewed.text, /^Подготовил запись: /u);
  assert.equal(f.patients[0].appointments.length, 0);
});
test('a Codex preparation remains a clarification when required data is absent and rechecks occupancy before handoff', async () => {
  const f = dialogueFixture();
  const parsed = await codexReply({ intent: 'prepareAppointment', query: 'Анна Семёнова' });
  assert.equal(f.start(parsed.intent).dialogue.step, 'service');
  assert.equal(f.result.action, null);
  const complete = await codexReply({ ...supported.at(-1), staffQuery: null });
  f.start(complete.intent);
  const review = f.result;
  assert.equal(review.dialogue.step, 'review');
  f.busy.push({ date: day, time: '10:00', duration: 30, staffId: 'owner', roomId: 'main' });
  const rejected = f.answer({ choice: review.dialogue.options[0].id }).result;
  assert.equal(rejected.action, null);
  assert.equal(rejected.dialogue.step, 'time');
  assert.equal(f.patients[0].appointments.length, 0);
});
