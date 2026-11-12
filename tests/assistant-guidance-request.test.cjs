const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  assistantGuidanceRequest,
} = require('../src/server/modules/assistant/actions/assistant-guidance-request.cjs');
const { helpText } = require('../src/server/modules/assistant/actions/help-response.cjs');
const { createAssistant } = require('../src/server/modules/assistant/service.cjs');
const { assistantBoundariesFixture } = require('./helpers/assistant-boundaries-fixture.cjs');
const { createPaidBookingFixture } = require('./helpers/assistant-paid-booking-fixture.cjs');

test('guidance consumes an entire speech act and keeps names, conditions and additional tasks on interpretation', () => {
  for (const text of ['Что ты умеешь?', 'Какие команды доступны?', 'Пожалуйста, справка.'])
    assert.equal(assistantGuidanceRequest(text), 'capabilities');
  for (const text of [
    'Открой банковскую карту',
    'Покажи карту мира, пожалуйста',
    'Открыть карту сайта',
  ])
    assert.equal(assistantGuidanceRequest(text), 'unsupportedCard');
  for (const text of [
    'Открой карту клиента Миры',
    'Открой карту клиента Банковского',
    'Запиши клиента Справку',
    'Запиши на услугу Помощь',
    'Что ты умеешь и запиши клиента',
    'Справка по клиенту',
    'Если можешь, открой банковскую карту',
    'Не открывай карту мира',
    'Открою карту мира',
    'Открой карту мира и карточку клиента',
    'Открой карту мира Никиты',
    'Справка\nОткрой карту мира',
    'Непонятная команда',
  ])
    assert.equal(assistantGuidanceRequest(text), null, text);
});

test('capabilities and refusals use fresh enabled categories and preserve disabled or unavailable explanations', () => {
  const current = { organizationId: 'synthetic', role: 'owner' };
  const calendar = { calendar: true, clients: false, prepareAppointment: false };
  const text = helpText(current, calendar, 'unsupportedCard');
  assert.match(text, /тип карты.*не открывает/u);
  assert.match(text, /расписание и свободные окна/u);
  assert.doesNotMatch(text, /найти клиента|его карточку|подготовить запись/u);
  assert.equal(helpText(current, calendar), 'Что нужно сделать?');
  assert.equal(
    helpText(current, {}, 'capabilities'),
    'Действия помощника выключены администратором.',
  );
  assert.equal(
    helpText({ ...current, globalAdmin: true }, calendar, 'capabilities'),
    'Помощник доступен сотрудникам выбранной организации с разрешением администратора.',
  );
  assert.match(
    helpText(current, { prepareAppointment: true }, 'capabilities'),
    /проверки и ручного сохранения/u,
  );
});

test('actual paid guidance skips model, returns a meaningful exact permitted response and retains terminal replay protection', async (t) => {
  const f = await createPaidBookingFixture();
  t.after(() => f.close());
  f.fixture.hooks.llm = async () => ({ text: JSON.stringify({ intent: 'help' }) });
  const request = {
    text: 'Что ты умеешь?',
    policyVersion: f.scope.policyVersion,
    taskRequestId: randomUUID(),
    speech: { format: 'pcm', stream: true, mode: 'answerable' },
  };
  const response = await f.api.turn(f.context, request);
  assert.equal(f.fixture.calls.llm, 0);
  assert.equal(response.intent, 'help');
  assert.equal(response.action, null);
  assert.equal(response.dialogue, undefined);
  assert.match(response.text, /Могу.*Что нужно сделать/u);
  assert.equal(response.speechPermit.answerableText, response.text);
  assert.equal(f.api.runtimeStats().turns.localHelp, 1);
  await assert.rejects(f.api.turn(f.context, request), {
    status: 409,
    code: 'TASK_ALREADY_COUNTED',
  });
  assert.equal(f.fixture.calls.llm, 0);
  assert.equal(f.packages.status(f.context.current.organizationId).usedTasks, 1);
  assert.equal(f.pcmCalls(), 0);
  const refusal = await f.api.turn(f.context, {
    ...request,
    text: 'Открой банковскую карту',
    taskRequestId: randomUUID(),
  });
  assert.match(refusal.text, /тип карты помощник не открывает/u);
  assert.equal(refusal.speechPermit.answerableText, refusal.text);
  assert.equal(f.fixture.calls.llm, 0);
  assert.equal(refusal.action, null);
  f.fixture.settings({
    policy: { commands: { calendar: true, clients: false, prepareAppointment: false } },
  });
  const fresh = f.api.access(f.context.current);
  const restricted = await f.api.turn(f.context, {
    ...request,
    policyVersion: fresh.policyVersion,
    taskRequestId: randomUUID(),
  });
  assert.match(restricted.text, /расписание и свободные окна/u);
  assert.doesNotMatch(restricted.text, /найти клиента|его карточку|подготовить запись/u);
  assert.equal(f.fixture.calls.llm, 0);
});

test('unknown or uncovered guidance remains one model interpretation and never becomes a keyword refusal', async (t) => {
  const f = await createPaidBookingFixture();
  t.after(() => f.close());
  f.fixture.hooks.llm = async () => ({ text: JSON.stringify({ intent: 'help' }) });
  for (const text of [
    'Объясни что умеешь по этой записи',
    'Открой карту мира и карточку клиента',
  ]) {
    const before = f.fixture.calls.llm;
    const response = await f.api.turn(f.context, {
      text,
      policyVersion: f.scope.policyVersion,
      taskRequestId: randomUUID(),
    });
    assert.equal(f.fixture.calls.llm - before, 1);
    assert.equal(response.text, 'Что нужно сделать?');
    assert.equal(response.action, null);
  }
});

test('exact guidance needs no organization clock while a model turn still reads it', async (t) => {
  const f = await assistantBoundariesFixture();
  t.after(() => f.close());
  f.hooks.llm = () => ({ text: '{"intent":"help"}' });
  for (const useReadDispatcher of [false, true]) {
    let timeZoneReads = 0;
    const readTimeZone = () => {
      timeZoneReads++;
      return 'Europe/Moscow';
    };
    const api = createAssistant(
      {
        ...f.database,
        organizationTimeZone: readTimeZone,
        ...(useReadDispatcher
          ? { assistantReads: { bind: () => ({ timeZone: readTimeZone }) } }
          : {}),
      },
      { directory: f.platformDirectory, ...f.ports },
    );
    const turn = (text) => api.turn(f.context(), { text, policyVersion: f.revision() });
    const calls = f.calls.llm;
    assert.match((await turn('Что ты умеешь?')).text, /Могу/u);
    assert.equal(timeZoneReads, 0);
    assert.equal(f.calls.llm, calls);
    assert.equal((await turn('Объясни что умеешь по этой записи')).text, 'Что нужно сделать?');
    assert.equal(timeZoneReads, 1);
    assert.equal(f.calls.llm, calls + 1);
  }
});

test('fresh revocation rejects local guidance before interpretation and paid acceptance', async (t) => {
  const f = await createPaidBookingFixture();
  t.after(() => f.close());
  f.fixture.database.db
    .prepare("UPDATE memberships SET status='suspended' WHERE organization_id=? AND account_id=?")
    .run(f.context.current.organizationId, f.context.current.accountId);
  await assert.rejects(
    f.api.turn(f.context, {
      text: 'Что ты умеешь?',
      policyVersion: f.scope.policyVersion,
      taskRequestId: randomUUID(),
    }),
    { status: 401 },
  );
  assert.equal(f.fixture.calls.llm, 0);
  assert.equal(f.packages.status(f.context.current.organizationId).usedTasks, 0);
});
