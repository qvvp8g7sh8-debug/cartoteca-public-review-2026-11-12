const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { initialState } = require('../src/server/modules/assistant/access/defaults.cjs');
const { modelPayload } = require('../src/server/modules/assistant/interpretation/intents.cjs');
const { domainRules } = require('../src/server/modules/assistant/behavior/domain-rules.cjs');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');

test('real-provider payload treats preparing one booking with free-window selection as one intent', () => {
  const text =
    'Подготовь запись Анне Семёновой на первичную консультацию на завтра на 15 минут. Подбери свободное время.';
  for (const provider of ['codex', 'timeweb']) {
    for (const mode of ['manual', 'automatic']) {
      const state = initialState();
      state.providers.llm = {
        provider,
        model: provider === 'codex' ? 'codex-default' : 'synthetic-model',
      };
      state.policy.exampleSelection = mode;
      const result = modelPayload(text, state, 'Europe/Moscow');
      const system = result.payload.messages[0].content;
      assert.match(
        system,
        /подготовка одной записи с уточнениями или подбором свободного времени — один prepareAppointment/u,
      );
      assert.match(system, /Если точное время не задано, time=null/u);
      assert.match(system, /seekSlots и другие новые поля не добавляй/u);
      assert.match(system, /несколько независимых действий/u);
      assert.equal(result.payload.messages.length, 2);
      assert.equal(result.payload.messages[1].content, text);
      assert.equal(result.payload.temperature, 0);
    }
  }
});

test('booking-window clarification keeps unsupported mutations, conditional requests and independent-action gold guards', () => {
  assert.match(
    domainRules,
    /moveAppointment\/cancelAppointment\/editAppointment.*отмена требует отдельного подтверждения/u,
  );
  assert.match(
    domainRules,
    /Удаление клиентов\/карточек, редактирование клиента, создание клиента, массовые действия и обход занятости не поддерживаются: help/u,
  );
  assert.match(domainRules, /Отмена существующего приёма — cancelAppointment/u);
  assert.match(domainRules, /конфликтующие указания без однозначного исправления: help/u);
  assert.match(domainRules, /Отрицание «не записывай» не означает создание записи/u);
  const rows = JSON.parse(
    fs.readFileSync(
      require.resolve('../src/server/modules/assistant/behavior/scenarios/safety-boundaries-1.json'),
      'utf8',
    ),
  );
  for (const id of [
    'safety-two-independent',
    'safety-save-and-delete',
    'safety-availability-fabrication',
  ]) {
    const item = rows.find((row) => row.id === id);
    assert.ok(item, id);
    assert.deepEqual(item.current.intent, { intent: 'help' }, id);
    assert.equal(item.current.status, 'unsupported', id);
  }
});

test('a single preparation without an exact time already offers real windows and retains manual Save', () => {
  const f = dialogueFixture();
  const result = f.start({
    query: 'Анну Семенову',
    serviceQuery: 'Чистка',
    date: day,
    duration: 15,
  });
  assert.equal(result.dialogue.step, 'time');
  assert.equal(result.dialogue.fields.find((row) => row.key === 'duration').value, '15 мин');
  assert.ok(result.dialogue.options.length > 0);
  assert.equal(
    result.dialogue.fields.some((row) => row.key === 'time'),
    false,
  );
  assert.equal(result.action, null);
  assert.equal(f.patients[0].appointments.length, 0);
  const periods = f.answer({ choice: result.dialogue.options[0].id }).result;
  assert.equal(periods.dialogue.step, 'time');
  assert.equal(periods.dialogue.phase, 'slots');
  assert.equal(periods.action, null);
  const review = f.answer({ choice: periods.dialogue.options[0].id }).result;
  assert.equal(review.dialogue.step, 'review');
  assert.equal(review.action, null);
  const ready = f.answer({ text: 'да' }).result;
  assert.equal(ready.action.type, 'prepareAppointment');
  assert.equal(ready.action.duration, 15);
  assert.equal(f.patients[0].appointments.length, 0);
});
