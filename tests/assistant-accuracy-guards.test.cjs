const test = require('node:test');
const assert = require('node:assert/strict');
const { accuracyFixture, corpus } = require('./helpers/assistant-accuracy-eval.cjs');
const { assistantBoundariesFixture } = require('./helpers/assistant-boundaries-fixture.cjs');
const base = '../src/server/modules/assistant/';
const { clientSuggestionOperation, isFastContinuation } = require(
  base + 'dialogue/dialogue-input.cjs',
);
const { repairOperation } = require(base + 'dialogue/dialogue-repair-parse.cjs');
const { applyRepair } = require(base + 'dialogue/dialogue-repair-apply.cjs');
const { applySearchRepair } = require(base + 'dialogue/dialogue-search-repair.cjs');
const { parseBookingTimeWindow } = require(base + 'language/time/booking-time-window.cjs');
const { defaults } = require('../src/server/modules/workspace/policy.cjs');
const complete = {
  query: 'Алёну Журавлёву',
  serviceQuery: 'Чистка',
  date: corpus.clock.date,
  time: '10:00',
};
const current = (f) => f.flow.get(f.c, f.member, f.state, f.result.dialogue.id);

test('identity acknowledgements remain specific to a current approximate client question', async () => {
  for (const text of ['да, это она', 'ага, это он', 'да да это она!', 'верно, это она.']) {
    const f = accuracyFixture();
    f.start({ ...complete, query: 'Алёну Журавлёфу' });
    const entry = current(f);
    assert.equal(entry.options.size, 1);
    assert.equal(clientSuggestionOperation(entry, text).kind, 'choice');
    assert.equal(await isFastContinuation(text, entry, f.clock, f.c), true);
    f.answer({ text });
    assert.equal(f.result.dialogue.step, 'review');
    assert.equal(current(f).data.patient.id, 'holdout-alena');
    assert.equal(f.result.action, null);
    assert.equal(clientSuggestionOperation(current(f), text), null, 'does not confirm review');
  }
  const f = accuracyFixture();
  f.start({ ...complete, query: 'Анну Бережнофу' });
  assert.equal(current(f).options.size, 2);
  assert.equal(clientSuggestionOperation(current(f), 'да, это она').kind, 'localHelp');
  for (const text of [
    'да, это она, но не записывай',
    'нет, это она',
    'да, это она или Елена',
    'да, это она если позвонит',
    'да, это она и сохрани',
    'наверное, это она',
  ])
    assert.equal(clientSuggestionOperation(current(f), text), null, text);
});

test('paired after/before bounds preserve strict lower edge and reject partial or conflicting evidence', () => {
  const expected = {
    kind: 'range',
    from: '13:00',
    to: '16:00',
    fromInclusive: false,
    toInclusive: false,
  };
  for (const text of [
    'после 13:00 и до 16:00',
    'после 13:00 до 16:00',
    'после тринадцати до шестнадцати',
  ])
    assert.deepEqual(parseBookingTimeWindow(text).window, expected, text);
  for (const text of [
    'после 16:00 до 13:00',
    'после 13:00 до 13:00',
    'после 25:00 до 16:00',
    'не после 13:00 до 16:00',
    'после 13:00 до 16:00 или 17:00',
  ])
    assert.notEqual(parseBookingTimeWindow(text).status, 'valid', text);
  for (const text of [
    'завтра после 13:00 и до 16:00, если будет свободно',
    'завтра после 13:00 и до 16:00 и сохрани',
    'завтра после 16:00 до 13:00',
    'завтра или послезавтра после 13:00 до 16:00',
    'завтра после 13:00 до 16:00, время не меняй',
  ]) {
    const f = accuracyFixture();
    f.start(complete);
    const before = structuredClone(current(f).data);
    const result = f.answer({ text }).result;
    assert.equal(result.action, null, text);
    assert.deepEqual(current(f).data, before, text);
  }
});

test('date-window patches apply atomically for booking and both availability search shapes', () => {
  const f = accuracyFixture();
  f.start(complete);
  const operation = repairOperation(current(f), 'завтра после 13:00 и до 16:00', f.clock);
  assert.equal(operation.kind, 'patch');
  assert.ok(operation.timeWindow);
  const dataBefore = structuredClone(current(f).data);
  for (const bad of [
    { ...operation, timeWindow: { ...operation.timeWindow, to: '12:00' } },
    { ...operation, edits: [...operation.edits, { field: 'time', text: '14:00' }] },
    { ...operation, edits: [{ field: 'date', text: '2098-12-31' }] },
  ]) {
    assert.ok(applyRepair(current(f), bad, f.clock).message);
    assert.deepEqual(current(f).data, dataBefore);
  }
  for (const shape of ['intent', 'values']) {
    const entry = {
      availabilitySearch: {
        [shape]:
          shape === 'intent'
            ? {
                intent: 'availability',
                date: corpus.clock.date,
                endDate: corpus.clock.date,
                duration: 30,
                time: '09:00',
                endTime: '11:00',
              }
            : {
                from: corpus.clock.date,
                to: corpus.clock.date,
                duration: 30,
                time: '09:00',
                endTime: '11:00',
              },
      },
    };
    const before = structuredClone(entry.availabilitySearch);
    const invalid = { ...operation, timeWindow: { ...operation.timeWindow, to: '12:00' } };
    applySearchRepair(entry, invalid, f.clock);
    assert.deepEqual(entry.availabilitySearch, before);
    applySearchRepair(entry, operation, f.clock);
    assert.equal(entry.availabilitySearch[shape].time, '13:01');
    assert.equal(entry.availabilitySearch[shape].endTime, '16:00');
    assert.equal(
      entry.availabilitySearch[shape][shape === 'intent' ? 'date' : 'from'],
      '2099-01-06',
    );
    assert.equal(entry.availabilitySearch[shape].duration, 30);
  }
});

test('compound named repairs retain the complete window and reject an extra exact time', () => {
  const f = accuracyFixture();
  f.start(complete);
  const op = repairOperation(
    current(f),
    'дату на завтра после 13:00 и до 16:00 и длительность на 45 минут',
    f.clock,
  );
  assert.equal(op.kind, 'patch');
  assert.equal(op.timeWindow.from, '13:00');
  assert.equal(op.edits.length, 2);
  assert.equal(applyRepair(current(f), op, f.clock).message, undefined);
  assert.equal(current(f).data.date, '2099-01-06');
  assert.equal(current(f).data.duration, 45);
  assert.equal(current(f).data.time, null);
  assert.equal(current(f).data.timeWindow.to, '16:00');
  const conflict = repairOperation(
    current(f),
    'дату на завтра после 13:00 и до 16:00 и время на 14:00',
    f.clock,
  );
  assert.equal(conflict.kind, 'localHelp');
});

test('real service continuation confirms an approximate client locally without provider work or a save', async (t) => {
  const f = await assistantBoundariesFixture(t),
    d = accuracyFixture(),
    owner = f.current('owner').accountId;
  d.patients.forEach((row) => {
    row.createdBy = owner;
  });
  d.members[0].accountId = owner;
  d.services.forEach((row) => {
    row.staffId = owner;
  });
  const c = {
    ...f.context(),
    platform: { ...d.c.platform, workspaceSettings: () => defaults(owner) },
    tenantStore: d.c.tenantStore,
  };
  f.hooks.llm = () => assert.fail('Proven local client confirmation cannot invoke a provider');
  const initial = await f.api.turn(c, {
    policyVersion: f.revision(),
    text: 'Запиши клиента Алёну Журавлёфу на 2099-01-05 в 10:00',
  });
  assert.equal(initial.dialogue.step, 'client');
  assert.equal(initial.dialogue.options.length, 1);
  const result = await f.api.turn(c, {
    policyVersion: f.revision(),
    dialogueId: initial.dialogue.id,
    dialogueVersion: initial.dialogue.version,
    text: 'да, это она',
  });
  assert.equal(result.dialogue.step, 'service');
  assert.equal(result.action, null);
  assert.equal(f.calls.llm, 0);
  assert.ok(d.patients.every((row) => row.appointments.length === 0));
  const bounded = await f.api.turn(c, {
    policyVersion: f.revision(),
    dialogueId: result.dialogue.id,
    dialogueVersion: result.dialogue.version,
    text: '2099-01-06 после 13:00 и до 16:00',
  });
  assert.equal(bounded.dialogue.step, 'service');
  const windows = await f.api.turn(c, {
    policyVersion: f.revision(),
    dialogueId: bounded.dialogue.id,
    dialogueVersion: bounded.dialogue.version,
    text: 'Чистка',
  });
  assert.equal(windows.dialogue.step, 'time');
  assert.equal(windows.action, null);
  assert.equal(windows.dialogue.fields.find((field) => field.key === 'date').value, '2099-01-06');
  assert.ok(windows.dialogue.options.length > 0);
  for (const option of windows.dialogue.options) {
    const times = /(\d{2}:\d{2})–(\d{2}:\d{2})/u.exec(option.label);
    assert.ok(times && times[1] > '13:00' && times[2] <= '16:00');
  }
  assert.equal(f.calls.llm, 0);
  assert.ok(d.patients.every((row) => row.appointments.length === 0));
});
