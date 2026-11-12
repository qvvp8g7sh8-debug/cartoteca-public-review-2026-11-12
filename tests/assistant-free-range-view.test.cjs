const test = require('node:test');
const assert = require('node:assert/strict');
const { freeRangeView } = require('../src/server/modules/assistant/actions/free-range-view.cjs');
const {
  nearestSlotMode,
  isSlotRequest,
} = require('../src/server/modules/assistant/actions/slot-request.cjs');
const { requestSlots } = require('../src/server/modules/assistant/dialogue/dialogue-slots.cjs');

test('free ranges stay distinct across rooms and retain their full continuous bounds', () => {
  const view = freeRangeView(
    {
      freeRanges: [
        ['07:00', '09:00'],
        ['08:00', '10:00'],
      ],
      empty: false,
    },
    { duration: 90, question: 'На какое время перенести?', emptyDay: false },
  );
  assert.equal(
    view.prompt,
    'Свободно с 07:00 до 09:00, с 08:00 до 10:00. На какое время перенести?',
  );
  assert.equal(view.phase, 'period');
  assert.deepEqual(
    view.choices.map((row) => [row.value.from, row.value.to]),
    [
      ['07:00', '09:00'],
      ['08:00', '10:00'],
    ],
  );
  assert.ok(view.choices.every((row) => row.kind === 'freeRange' && !('time' in row.value)));
});

test('an exhausted range page does not expose stale bounds or fabricate availability', () => {
  const view = freeRangeView({ freeRanges: [], empty: true }, { duration: 45, offset: 3 });
  assert.equal(view.choices.length, 0);
  assert.match(view.prompt, /нет свободного промежутка.*45 мин/u);
  assert.doesNotMatch(view.prompt, /Весь рабочий день/u);
});

test('only explicit nearest or earliest requests change the default range policy', () => {
  for (const raw of [
    'подбери свободное время',
    'когда есть свободное время',
    'любое время',
    'на час раньше',
    'не ближайшее время',
    'ближайшее время или завтра',
  ])
    assert.equal(nearestSlotMode(raw), null, raw);
  for (const raw of [
    'Ближайшее свободное время.',
    'покажи ближайшие свободные окна',
    'запиши Анну завтра на ближайшее время',
  ])
    assert.equal(nearestSlotMode(raw), 'nearest', raw);
  for (const raw of [
    'первое свободное время',
    'как можно раньше',
    'подбери самое раннее свободное окно',
  ]) {
    assert.equal(nearestSlotMode(raw), 'earliest', raw);
    assert.equal(isSlotRequest(raw), true, raw);
  }
});

test('generic slot searches retain full period bounds and never turn their anchor into a selected time', () => {
  const data = {
    time: '09:00',
    timeWindow: {
      kind: 'range',
      from: '07:00',
      to: '18:00',
      fromInclusive: true,
      toInclusive: false,
    },
    roomId: 'old-room',
  };
  requestSlots(data, '09:00', { ranges: true });
  assert.equal(data.time, null);
  assert.equal(data.roomId, '');
  assert.equal(data.preferredTime, '');
  assert.equal(data.rangeSummary, true);
  assert.equal(data.slotAfterTime, '09:00');
  assert.equal(data.timeWindow.from, '07:00');
  requestSlots(data, '09:00', { nearest: 'nearest' });
  assert.equal(data.preferredTime, '09:00');
  assert.equal(data.rangeSummary, false);
  assert.equal(data.time, null);
  requestSlots(data, '09:00', { nearest: 'earliest' });
  assert.equal(data.preferredTime, '00:00');
});
