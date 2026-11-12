const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_SHOWN_SLOTS,
  representativeSlots,
} = require('../src/server/modules/assistant/actions/representative-slots.cjs');
const DATE = '2030-01-02';
const clock = (value) =>
  String(Math.floor(value / 60)).padStart(2, '0') + ':' + String(value % 60).padStart(2, '0');
const minute = (value) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
function candidates(from = 540, to = 1080, duration = 30) {
  const slots = [];
  for (let start = from; start + duration <= to; start += 15)
    slots.push({
      date: DATE,
      time: clock(start),
      staffId: 'owner',
      roomId: 'room',
      duration,
      endTime: clock(start + duration),
    });
  return slots;
}
const select = (slots, extra = {}) =>
  representativeSlots(slots, { duration: slots[0]?.duration || 30, ...extra });
const shown = (slots) => slots.map(({ date, time, staffId }) => ({ date, time, staffId }));
function separated(slots, duration) {
  assert.ok(slots.length <= 3);
  for (let index = 1; index < slots.length; index++)
    assert.ok(minute(slots[index].time) - minute(slots[index - 1].time) >= Math.max(60, duration));
}

test('representative selection offers real early, middle and late starts instead of the first grid ticks', () => {
  const slots = candidates();
  const frozen = slots.map((slot) => Object.freeze({ ...slot }));
  Object.freeze(frozen);
  const result = select(frozen);
  assert.deepEqual(
    result.slots.map((slot) => slot.time),
    ['09:00', '13:15', '17:30'],
  );
  assert.equal(result.truncated, true);
  separated(result.slots, 30);
  for (const slot of result.slots) assert.ok(frozen.includes(slot));
  assert.deepEqual(slots.map((slot) => slot.time).slice(0, 3), ['09:00', '09:15', '09:30']);
});

test('long services preserve duration-sized distance and actual gaps rather than inventing a midpoint', () => {
  const slots = candidates(540, 1080, 120).filter(
    (slot) => slot.time < '11:00' || slot.time >= '14:00',
  );
  const result = select(slots);
  assert.deepEqual(
    result.slots.map((slot) => slot.time),
    ['09:00', '14:00', '16:00'],
  );
  separated(result.slots, 120);
  for (const slot of result.slots) assert.ok(slots.includes(slot));
});

test('narrow or empty availability yields only the substantially different real choices', () => {
  assert.deepEqual(select([]), { slots: [], truncated: false });
  const close = candidates(540, 600);
  assert.deepEqual(
    select(close).slots.map((slot) => slot.time),
    ['09:00'],
  );
  assert.equal(select(close).truncated, false);
  const two = candidates(540, 630);
  assert.deepEqual(
    select(two).slots.map((slot) => slot.time),
    ['09:00', '10:00'],
  );
  assert.equal(select(two).truncated, false);
});

test('more choices exclude the entire neighborhood of all previously shown starts', () => {
  const slots = candidates();
  let history = [];
  let turns = 0;
  for (;;) {
    const result = select(slots, { shownSlots: history });
    separated(result.slots, 30);
    for (const slot of result.slots)
      for (const previous of history)
        assert.ok(Math.abs(minute(slot.time) - minute(previous.time)) >= 60);
    history.push(...shown(result.slots));
    turns++;
    assert.ok(history.length <= MAX_SHOWN_SLOTS);
    assert.ok(turns <= 5);
    if (!result.truncated) {
      const exhausted = select(slots, { shownSlots: history });
      assert.deepEqual(exhausted, { slots: [], truncated: false });
      break;
    }
  }
  assert.ok(history.length > 3);
  assert.equal(new Set(history.map((slot) => slot.time)).size, history.length);
});

test('history is bounded and never wraps to old offers after twelve displayed starts', () => {
  const slots = candidates(0, 1440);
  const history = Array.from({ length: 12 }, (_, index) => ({
    date: DATE,
    time: clock(index * 60),
    staffId: 'owner',
  }));
  assert.deepEqual(select(slots, { shownSlots: history }), { slots: [], truncated: false });
  assert.throws(() => select(slots, { shownSlots: [...history, history[0]] }), { status: 400 });
  assert.throws(
    () => select(slots, { shownSlots: [{ date: DATE, time: '99:00', staffId: 'owner' }] }),
    { status: 400 },
  );
});

test('limits cannot exceed three and history from another date or specialist does not exclude this search', () => {
  const slots = candidates();
  assert.equal(select(slots, { limit: 99 }).slots.length, 3);
  assert.deepEqual(
    select(slots, { limit: 1 }).slots.map((slot) => slot.time),
    ['09:00'],
  );
  assert.deepEqual(
    select(slots, { limit: 2 }).slots.map((slot) => slot.time),
    ['09:00', '17:30'],
  );
  const history = [
    { date: '2030-01-03', time: '09:00', staffId: 'owner' },
    { date: DATE, time: '09:00', staffId: 'other' },
  ];
  assert.deepEqual(select(slots, { shownSlots: history }), select(slots));
});

test('selection is deterministic for unsorted candidates and rejects a mixed date or duration pool', () => {
  const slots = candidates();
  assert.deepEqual(select([...slots].reverse()), select(slots));
  assert.throws(() => select([...slots, { ...slots[0], date: '2030-01-03' }]), { status: 400 });
  assert.throws(() => select([...slots, { ...slots[0], duration: 45 }]), { status: 400 });
});

test('preferred time picks the nearest real start, with an earlier tie and no hidden lower bound', () => {
  const slots = candidates();
  assert.deepEqual(
    select(slots, { limit: 1, preferredTime: '12:07' }).slots.map((slot) => slot.time),
    ['12:00'],
  );
  assert.deepEqual(
    select(slots, { limit: 1, preferredTime: '12:08' }).slots.map((slot) => slot.time),
    ['12:15'],
  );
  const tie = slots.filter((slot) => ['10:00', '11:00'].includes(slot.time));
  assert.deepEqual(
    select(tie, { limit: 1, preferredTime: '10:30' }).slots.map((slot) => slot.time),
    ['10:00'],
  );
  assert.deepEqual(
    select(slots, { limit: 1, preferredTime: '23:00' }).slots.map((slot) => slot.time),
    ['17:30'],
  );
  assert.throws(() => select(slots, { preferredTime: '25:00' }), { status: 400 });
});
