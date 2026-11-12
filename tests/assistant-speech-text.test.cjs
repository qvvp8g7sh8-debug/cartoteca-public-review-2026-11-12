const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(
  path.join(__dirname, '../src/client/modules/assistant-speech-text.js'),
  'utf8',
);
const api = vm.runInNewContext(source + '\ncreateAssistantSpeechText', {})();
test('known slot typography is voiced as a Russian date and from-to interval with the original specialist', () => {
  assert.equal(
    api.assistantSpokenOption('2026-10-17 · 09:00–09:30 · Вера Тестовая', 'time'),
    'в 9 часов',
  );
  assert.equal(
    api.assistantSpokenOption('2026-10-17 · 01:01–02:02 · Вера Тестовая', 'availability'),
    '17 октября 2026 года, с 1 часа 1 минуты до 2 часов 2 минут, специалист Вера Тестовая',
  );
});
test('only known slot steps and the exact slot shape are formatted; names services and phone-like labels retain their text', () => {
  const slot = '2026-10-17 · 09:00–09:30 · Вера Тестовая';
  for (const step of ['client', 'staff', 'service', 'review', null])
    assert.equal(api.assistantSpokenOption(slot, step), slot);
  for (const label of [
    'Анна × Семёнова',
    'Услуга 2×30',
    '+79990000001',
    '2026-10-17 · неизвестно · Вера',
    'opaque-slot-id',
  ])
    assert.equal(api.assistantSpokenOption(label, 'time'), label);
});
test('invalid date or time is never normalized into an invented appointment', () => {
  for (const label of [
    '2026-02-29 · 09:00–09:30 · Вера',
    '0000-10-17 · 09:00–09:30 · Вера',
    '2026-10-17 · 24:00–09:30 · Вера',
    '2026-10-17 · 09:00–09:60 · Вера',
  ])
    {
      assert.equal(api.assistantSpokenOption(label, 'availability'), label);
      assert.equal(api.assistantSpokenOption(label, 'time'), label);
    }
  assert.match(
    api.assistantSpokenOption('2028-02-29 · 00:00–00:30 · Вера', 'time'),
    /^в 0 часов$/,
  );
});
test('review speech formats only known date and time fields without reading IDs or altering any DTO', () => {
  const date = { key: 'date', label: 'Дата', value: '2026-10-17', id: 'PRIVATE-SENTINEL' },
    time = { key: 'time', label: 'Время', value: '14:30' };
  const before = JSON.stringify([date, time]);
  assert.equal(api.assistantSpokenField(date), '17 октября 2026 года');
  assert.equal(api.assistantSpokenField(time), '14 часов 30 минут');
  assert.equal(api.assistantSpokenField({ key: 'service', value: '2026-10-17' }), '2026-10-17');
  assert.equal(api.assistantSpokenField({ key: 'staff', value: '14:30' }), '14:30');
  assert.equal(JSON.stringify([date, time]), before);
  assert.equal(api.assistantSpokenField({ key: 'date', value: '2026-02-29' }), '2026-02-29');
});

test('generated service and client separators are words in speech while literal names and punctuation remain unchanged', () => {
  assert.equal(api.assistantSpokenOption('Консультация · 30 мин', 'service'), 'Консультация, 30 минут');
  assert.equal(api.assistantSpokenOption('Анна Семёнова · …1234', 'client'), 'Анна Семёнова, телефон оканчивается на 1234');
  const field = { key: 'client', value: 'Анна Семёнова · …1234' },
    before = JSON.stringify(field);
  assert.equal(api.assistantSpokenField(field), 'Анна Семёнова, телефон оканчивается на 1234');
  assert.equal(JSON.stringify(field), before);
  for (const label of ['Услуга 2×30', 'Консультация 1.5', 'И. И. Тестовая', 'Точка · в названии']) {
    assert.equal(api.assistantSpokenOption(label, 'service'), label);
    assert.equal(api.assistantSpokenOption(label, 'client'), label);
  }
});
