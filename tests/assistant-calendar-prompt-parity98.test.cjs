const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  calendarReadIntent,
} = require('../src/server/modules/assistant/actions/calendar-read-request.cjs');
const {
  detectRequestedOperation,
} = require('../src/server/modules/assistant/interpretation/requested-operation.cjs');
const {
  intentEnvelope,
} = require('../src/server/modules/assistant/interpretation/intent-contract.cjs');
const { assistantBoundariesFixture } = require('./helpers/assistant-boundaries-fixture.cjs');

const clock = { date: '2026-10-18', hour: 9, minute: 0 };
const example = 'Покажи моё расписание на неделю';
const read = (text) => calendarReadIntent(text, clock);
const grounded = [
  'Покажи расписание работы на завтра',
  'Открой мой календарь работы',
  'Покажи расписание на завтра у Ивановой',
  'Покажи расписание Ивановой на завтра',
  'Покажи календарь на завтра для всех специалистов',
  'Покажи расписание на завтра только с подтверждением',
  'Покажи календарь на 31 февраля',
  'Покажи расписание на 21:00',
  'Покажи календарь на 32',
  'Покажи расписание с 21 по 23 октября',
  'Покажи календарь на завтра или послезавтра',
  'Покажи расписание на завтра, если свободно',
  'Если свободно, покажи расписание на завтра',
  'Не открывай календарь на завтра',
  'Покажи расписание на завтра и удали запись Ивановой',
  'Открой календарь на завтра и карточку Ивановой',
  'Покажи расписание на завтра, потом создай запись',
];
const outside = [
  'Календарь',
  'Расписание',
  'Открой настройки календаря',
  'Покажи рабочее расписание на завтра',
  'Покажи моё календарь на завтра',
  'Покажи мой расписание на завтра',
  'Измени расписание на завтра',
  'Создай календарь на завтра',
];

test('the actual UI example and documented calendar aliases resolve the same whole periods as plural reads', () => {
  const client = path.join(__dirname, '../src/client/modules');
  assert.ok(fs.readFileSync(path.join(client, 'voice-assistant.js'), 'utf8').includes(example));
  assert.ok(
    fs
      .readFileSync(path.join(client, 'assistant-conversation.js'), 'utf8')
      .includes(example.toLowerCase()),
  );
  const cases = [
    [example, 'Покажи записи на неделю'],
    ['Покажи расписание на завтра', 'Покажи записи на завтра'],
    ['Покажи расписание на следующую неделю', 'Покажи записи на следующую неделю'],
    ['Открой календарь на следующий месяц', 'Открой записи на следующий месяц'],
    ['Открой расписание', 'Открой записи'],
    ['Открой мой календарь', 'Открой записи'],
    ['Откройте моё расписание на 21-е.', 'Откройте записи на 21-е.'],
    ['Пожалуйста, покажите мне мой календарь на двадцать первое октября.', 'Покажи записи на 21'],
    ['Можешь открыть моё расписание на 2027-10-21?', 'Открой записи на 2027-10-21'],
    ['Покажи мое расписание за ноябрь 2027.', 'Покажи записи за ноябрь 2027'],
    ['Покажи календарь за прошлую неделю', 'Покажи записи за прошлую неделю'],
    ['Покажи расписание в среду', 'Покажи записи в среду'],
    ['Покажи календарь за прошлый месяц', 'Покажи записи за прошлый месяц'],
  ];
  for (const [alias, canonical] of cases) {
    assert.equal(detectRequestedOperation(alias).intent, 'calendar', alias);
    assert.equal(read(alias)?.intent, 'calendar', alias);
    assert.deepEqual(read(alias), read(canonical), alias);
  }
  assert.deepEqual(calendarReadIntent('Покажи календарь на 29', { date: '2028-02-01' }), {
    intent: 'calendar',
    date: '2028-02-29',
    mode: 'day',
  });
  assert.deepEqual(calendarReadIntent(example, { date: 'not-a-date' }), { intent: 'help' });
});

test('new calendar nouns consume the whole tail and never absorb work settings, filters or another action', () => {
  for (const text of grounded) assert.deepEqual(read(text), { intent: 'help' }, text);
  for (const text of outside) assert.equal(read(text), null, text);
  for (const [text, intent] of [
    ['Открой запись Ивановой', 'editAppointment'],
    ['Открой записи Ивановой', 'editAppointment'],
    ['Открой записи клиента Ивановой', 'editAppointment'],
    ['Открой карточку Ивановой', 'clientCard'],
    ['Перенеси запись Ивановой на завтра', 'moveAppointment'],
    ['Отмени запись Ивановой', 'cancelAppointment'],
  ]) {
    assert.equal(detectRequestedOperation(text).intent, intent, text);
    assert.equal(read(text), null, text);
  }
});

test('actual service calendar prompt parity preserves each actor scope and zero provider usage across providers', async (t) => {
  const f = await assistantBoundariesFixture(t, { dailyRequests: 1 });
  f.hooks.llm = () => {
    throw Error('Covered product calendar prompts must not call a model');
  };
  let local = 0;
  for (const provider of ['codex', 'timeweb', 'demo']) {
    f.settings({
      providers: { llm: { provider } },
      policy: { limits: { monthlyBudgetRub: 0 } },
    });
    const before = f.readState();
    for (const role of ['owner', 'salon_admin', 'cosmetologist']) {
      for (const [alias, canonical] of [
        [example, 'Покажи записи на неделю'],
        ['Покажи расписание на завтра', 'Покажи записи на завтра'],
        ['Открой календарь на следующий месяц', 'Открой записи на следующий месяц'],
        ['Открой расписание', 'Открой записи'],
      ]) {
        const expected = await f.request('llm', role, { text: canonical });
        const result = await f.request('llm', role, { text: alias });
        local += 2;
        assert.deepEqual(result, expected, role + ': ' + alias);
        assert.equal(
          result.action.staffId,
          role === 'salon_admin' ? undefined : f.current(role).accountId,
        );
        assert.equal(result.dialogue, undefined);
        assert.equal(result.action.executionId, undefined);
        assert.equal(result.usage, undefined);
      }
    }
    assert.deepEqual(f.readState(), before, 'read aliases must not mutate provider usage or state');
  }
  assert.deepEqual(f.calls, { llm: 0, stt: 0, tts: 0 });
  assert.equal(f.api.runtimeStats().turns.localCalendar, local);
  assert.equal(f.api.runtimeStats().turns.model, 0);
});

test('unsupported aliases retain strict provider wire validation and cannot return an invented calendar action', async (t) => {
  const f = await assistantBoundariesFixture(t);
  f.hooks.llm = () => ({ text: 'synthetic malformed model output' });
  for (const text of [...grounded, ...outside]) {
    const calls = f.calls.llm;
    await assert.rejects(f.request('llm', 'owner', { text }), { status: 502 }, text);
    assert.equal(f.calls.llm, calls + 1, text);
  }
  f.hooks.llm = () => ({
    text: JSON.stringify(intentEnvelope({ intent: 'calendar', date: '2099-01-01', mode: 'month' })),
  });
  for (const text of grounded) {
    const calls = f.calls.llm;
    const result = await f.request('llm', 'owner', { text });
    assert.equal(f.calls.llm, calls + 1, text);
    assert.equal(result.intent, 'help', text);
    assert.equal(result.action, null, text);
    assert.equal(result.dialogue, undefined, text);
  }
});

test('new aliases keep fresh grants, policy/category, native membership and actor isolation', async (t) => {
  const f = await assistantBoundariesFixture(t);
  f.settings({ policy: { commands: { calendar: false } } });
  await assert.rejects(f.request('llm', 'owner', { text: example }), { status: 403 });
  f.settings({ policy: { commands: { calendar: true } } });
  await assert.rejects(
    f.request('llm', 'owner', { text: example, policyVersion: f.revision() - 1 }),
    { status: 409 },
  );
  f.grant('owner', false);
  await assert.rejects(f.request('llm', 'owner', { text: example }), { status: 403 });
  f.grant('owner');
  const c = f.context('cosmetologist');
  for (const forged of [{ role: 'owner' }, { organizationId: f.other.organizationId }])
    await assert.rejects(
      f.api.turn(
        { ...c, current: { ...c.current, ...forged } },
        { text: example, policyVersion: f.revision() },
      ),
      { status: 403 },
    );
  const staff = f.actors.cosmetologist;
  const old = f.database.db
    .prepare('SELECT created_at FROM memberships WHERE organization_id=? AND account_id=?')
    .get(staff.organizationId, staff.accountId);
  f.database.db
    .prepare('DELETE FROM memberships WHERE organization_id=? AND account_id=?')
    .run(staff.organizationId, staff.accountId);
  f.database.db
    .prepare('INSERT INTO memberships VALUES(?,?,?,?,?)')
    .run(staff.organizationId, staff.accountId, 'cosmetologist', 'active', old.created_at + 1000);
  await assert.rejects(f.request('llm', 'cosmetologist', { text: example }), { status: 403 });
  assert.deepEqual(f.calls, { llm: 0, stt: 0, tts: 0 });
  assert.deepEqual(f.readState().reservations, {});
});

test('a product prompt fences an older model response and still rejects a disconnected transport', async (t) => {
  const f = await assistantBoundariesFixture(t);
  let finish, entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  f.hooks.llm = () =>
    new Promise((resolve) => {
      finish = resolve;
      entered();
    });
  const older = assert.rejects(f.request('llm', 'owner', { text: 'Календарь' }), { status: 409 });
  await started;
  const result = await f.request('llm', 'owner', { text: example });
  assert.equal(result.action.mode, 'week');
  finish({ text: JSON.stringify(intentEnvelope({ intent: 'calendar', date: '2099-01-01' })) });
  await older;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    f.api.turn(
      { ...f.context(), transportAbortSignal: controller.signal },
      { text: example, policyVersion: f.revision() },
    ),
    { code: 'ASSISTANT_REQUEST_ABORTED' },
  );
  assert.equal(f.calls.llm, 1);
});
