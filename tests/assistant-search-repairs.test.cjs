const test = require('node:test');
const assert = require('node:assert/strict');
const { applySearchRepair } = require('../src/server/modules/assistant/dialogue/dialogue-search-repair.cjs');
const clock = { date: '2099-01-05', hour: 8, minute: 0 };
const fixture = (extra = {}) => ({
  availabilitySearch: {
    intent: { intent: 'availability', date: clock.date, time: '13:00', duration: 30, ...extra },
  },
});
const patch = (...edits) => ({ kind: 'patch', edits });
test('search corrections update a selected day and duration without mutating prior snapshot', () => {
  const entry = fixture(),
    original = entry.availabilitySearch;
  applySearchRepair(
    entry,
    patch({ field: 'date', text: 'завтра' }, { field: 'duration', text: 'сорок пять минут' }),
    clock,
  );
  assert.equal(original.intent.date, clock.date);
  assert.equal(entry.availabilitySearch.intent.date, '2099-01-06');
  assert.equal(entry.availabilitySearch.intent.endDate, '2099-01-06');
  assert.equal(entry.availabilitySearch.intent.duration, 45);
});
test('a compound search repair is atomic when its second field is invalid', () => {
  const entry = fixture(),
    before = structuredClone(entry);
  const reply = applySearchRepair(
    entry,
    patch({ field: 'date', text: 'завтра' }, { field: 'time', text: 'около трех' }),
    clock,
  );
  assert.match(reply.message, /Уточните/);
  assert.deepEqual(entry, before);
});
test('relative search repairs use only an explicit single date and a known time boundary', () => {
  const entry = fixture();
  applySearchRepair(entry, { kind: 'shiftDate', days: 1 }, clock);
  applySearchRepair(entry, { kind: 'shiftTime', minutes: 30 }, clock);
  assert.equal(entry.availabilitySearch.intent.date, '2099-01-06');
  assert.equal(entry.availabilitySearch.intent.time, '13:30');
});
test('range and midnight ambiguities retain old search instead of choosing a candidate basis', () => {
  for (const [entry, operation] of [
    [fixture({ endDate: '2099-01-10' }), { kind: 'shiftDate', days: 1 }],
    [fixture({ time: undefined }), { kind: 'shiftTime', minutes: 30 }],
    [fixture({ time: '23:45' }), { kind: 'shiftTime', minutes: 30 }],
  ]) {
    const before = structuredClone(entry);
    applySearchRepair(entry, operation, clock);
    assert.deepEqual(entry, before);
  }
});
test('legacy slot envelope can change date and duration while keeping internal authorized staff IDs', () => {
  const entry = {
    availabilitySearch: {
      values: {
        from: clock.date,
        to: clock.date,
        time: '13:00',
        endTime: '16:00',
        duration: 30,
        staffIds: ['synthetic-staff'],
        serviceIds: [],
      },
    },
  };
  applySearchRepair(
    entry,
    patch({ field: 'date', text: '2099-01-06' }, { field: 'duration', text: 'полчаса' }),
    clock,
  );
  assert.equal(entry.availabilitySearch.values.to, '2099-01-06');
  assert.deepEqual(entry.availabilitySearch.values.staffIds, ['synthetic-staff']);
});
test('staff correction clears the old service unless the same repair explicitly replaces it', () => {
  const entry = fixture({ staffQuery: 'Анна', serviceQuery: 'Старая услуга' });
  applySearchRepair(
    entry,
    patch({ field: 'service', text: 'Новая услуга' }, { field: 'staff', text: 'Мария' }),
    clock,
  );
  assert.equal(entry.availabilitySearch.intent.staffQuery, 'Мария');
  assert.equal(entry.availabilitySearch.intent.serviceQuery, 'Новая услуга');
  applySearchRepair(entry, patch({ field: 'staff', text: 'Ольга' }), clock);
  assert.equal(entry.availabilitySearch.intent.serviceQuery, undefined);
});
test('search repairs cannot change a client, accept past dates or silently extend the original time range', () => {
  for (const edit of [
    { field: 'client', text: 'Анна' },
    { field: 'date', text: '2098-01-01' },
    { field: 'time', text: '17:00' },
  ]) {
    const entry = fixture({ endTime: '16:00' }),
      before = structuredClone(entry);
    applySearchRepair(entry, patch(edit), clock);
    assert.deepEqual(entry, before);
  }
});
