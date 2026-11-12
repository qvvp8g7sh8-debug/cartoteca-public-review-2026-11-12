const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/shared/time-zone.cjs'), 'utf8');
function fixture(browser = false) {
  let calls = 0;
  const actual = Intl.DateTimeFormat;
  const context = {
    Intl: {
      DateTimeFormat: function (...args) {
        calls++;
        return Reflect.construct(actual, args);
      },
    },
  };
  if (!browser) context.module = { exports: {} };
  vm.createContext(context);
  vm.runInContext(source, context);
  return {
    clock: context.module?.exports.zonedClock || context.createZonedClock().zonedClock,
    date: context.module?.exports.zonedDate,
    calls: () => calls,
    browser: context,
  };
}
function originalClock(instant, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const get = (kind) => parts.find((part) => part.type === kind).value;
  return {
    date: get('year') + '-' + get('month') + '-' + get('day'),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
  };
}
test('bounded Intl clock preserves DST, civil midnight and exact fixed options', () => {
  const f = fixture();
  for (const zone of ['Europe/Berlin', 'America/New_York', 'Europe/Moscow', 'Pacific/Chatham'])
    for (const at of [
      '2026-03-29T00:30:00Z',
      '2026-03-29T01:30:00Z',
      '2026-11-01T05:30:00Z',
      '2026-11-01T06:30:00Z',
      '2026-10-24T23:30:00Z',
    ])
      assert.deepEqual({ ...f.clock(new Date(at), zone) }, originalClock(new Date(at), zone));
  assert.deepEqual(
    { ...f.clock(new Date('2026-10-24T23:30:00Z'), 'Europe/Moscow') },
    { date: '2026-10-25', hour: 2, minute: 30 },
  );
  assert.equal(f.calls(), 4, 'one native formatter per unchanged zone/options');
});
test('scheduled workday date formatter preserves sv-SE defaults and repeats without constructor churn', () => {
  const f = fixture();
  for (let n = 0; n < 200; n++) {
    const at = Date.parse('2026-03-28T23:30:00Z') + n * 60000;
    assert.equal(
      f.date(at, 'Europe/Berlin'),
      new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(at),
    );
  }
  assert.equal(f.calls(), 1);
  f.clock(new Date(), 'Europe/Berlin');
  assert.equal(f.calls(), 2, 'clock and date options never alias');
});
test('Intl failures and non-string implicit host zones are not cached', () => {
  const f = fixture();
  for (let n = 0; n < 2; n++)
    assert.throws(() => f.date(Date.now(), 'invalid/synthetic-zone'), { name: 'RangeError' });
  assert.equal(f.calls(), 2);
  f.date(0, undefined);
  f.date(0, undefined);
  assert.equal(f.calls(), 4);
  let coerced = 0;
  const zone = {
    toString() {
      coerced++;
      return 'UTC';
    },
  };
  f.clock(new Date(0), zone);
  f.clock(new Date(0), zone);
  assert.equal(f.calls(), 6);
  assert.ok(coerced >= 2);
  assert.throws(() => f.clock(new Date(NaN), 'UTC'), { name: 'RangeError' });
  assert.equal(f.clock(new Date(0), 'UTC').hour, 0);
});
test('formatter LRU retains only64 public keys and preserves refreshed entries', () => {
  const f = fixture(),
    zones = Intl.supportedValuesOf('timeZone').slice(0, 65);
  assert.equal(zones.length, 65);
  zones.slice(0, 64).forEach((zone) => f.date(0, zone));
  assert.equal(f.calls(), 64);
  f.date(0, zones[0]);
  f.date(0, zones[64]);
  assert.equal(f.calls(), 65);
  f.date(0, zones[0]);
  assert.equal(f.calls(), 65);
  f.date(0, zones[1]);
  assert.equal(f.calls(), 66, 'oldest unused native formatter was evicted');
});
test('shared clock remains browser-compatible with unchanged createZonedClock contract', () => {
  const f = fixture(true),
    api = f.browser.createZonedClock();
  assert.deepEqual(Object.keys(api), ['zonedClock']);
  assert.equal(
    api.zonedClock(new Date('2026-10-24T23:30:00Z'), 'Europe/Moscow').date,
    '2026-10-25',
  );
  api.zonedClock(new Date(), 'Europe/Moscow');
  assert.equal(f.calls(), 1);
});
