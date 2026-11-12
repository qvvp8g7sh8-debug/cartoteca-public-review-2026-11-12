const test = require('node:test');
const assert = require('node:assert/strict');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const { defaults } = require('../src/server/modules/workspace/policy.cjs');
const { createScheduleBooking } = require('../src/server/modules/schedules/booking.cjs');
const { fail } = require('../src/shared/errors.cjs');
const { nextDate } = require('../src/shared/work-schedule.cjs');

const next = nextDate(day);
const working = (intervals = [['09:00', '18:00']]) => ({ status: 'working', intervals });
const windowFrom = (from, to) => ({
  kind: 'range',
  from,
  to,
  fromInclusive: true,
  toInclusive: false,
});
const clone = (value) => structuredClone(value);
const field = (result, key) => result.dialogue?.fields.find((row) => row.key === key)?.value;
const slotTime = (row) => row.value.time;
const minutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
const appointment = (id, time, duration, date = day) => ({
  id,
  date,
  time,
  duration,
  staffId: 'owner',
  roomId: 'main',
  status: 'scheduled',
});

function fixture(
  t,
  { role = 'owner', days: suppliedDays, closures: suppliedClosures, intervals, duration = 30 } = {},
) {
  const base = dialogueFixture({ role });
  if (role === 'cosmetologist') base.members[0].role = role;
  base.services[0].duration = duration;
  const days = clone(suppliedDays ?? { [day]: working(intervals), [next]: working() });
  const closures = clone(suppliedClosures ?? {});
  const personal = [],
    reserves = [],
    workspace = defaults('owner');
  workspace.enabled = true;
  const reads = {
    schedules: [],
    appointments: [],
    personal: [],
    reserves: [],
    scheduleChecks: [],
    writes: 0,
  };
  const storage = base.c.tenantStore(base.c.current.organizationId);
  const inPeriod = (row, from, to) => row.date >= from && row.date <= to;
  storage.indexes.appointments = (from, to, options) => {
    reads.appointments.push({ from, to, options });
    return base.busy.filter((row) => inPeriod(row, from, to));
  };
  const forbiddenWrite = () => {
    reads.writes++;
    throw Error('This dialogue must never save');
  };
  storage.save = forbiddenWrite;
  storage.write = forbiddenWrite;
  base.c.platform.workspaceSettings = () => workspace;
  base.c.platform.personalEvents.occupancy = (org, from, to) => {
    assert.equal(org, 'org');
    reads.personal.push({ from, to });
    return personal.filter((row) => inPeriod(row, from, to));
  };
  base.c.platform.bookingRequests.reserves = (org, from, to, now) => {
    assert.equal(org, 'org');
    reads.reserves.push({ from, to });
    return reserves.filter((row) => inPeriod(row, from, to) && row.expiresAt > now);
  };
  const scheduleBooking = createScheduleBooking(
    { key: Buffer.alloc(32, 7), fail, organizationTimeZone: () => 'Europe/Moscow' },
    {
      day: (org, staffId, date) => (staffId === 'organization' ? closures[date] : days[date]),
      profile: () => ({ revision: 1 }),
      authorize(current, staffId) {
        if (current.role === 'cosmetologist' && staffId !== current.accountId)
          throw fail(403, 'Недоступный сотрудник');
      },
    },
  );
  base.c.platform.workSchedules = {
    view(token, staffId, from, to) {
      assert.equal(token, base.c.token);
      assert.equal(staffId, 'owner');
      reads.schedules.push({ staffId, from, to });
      return {
        revision: 1,
        staffId,
        days: Object.fromEntries(
          Object.entries(days).filter(([date]) => date >= from && date <= to),
        ),
        closures: Object.fromEntries(
          Object.entries(closures).filter(([date]) => date >= from && date <= to),
        ),
      };
    },
    check(token, value) {
      assert.equal(token, base.c.token);
      reads.scheduleChecks.push(clone(value));
      return scheduleBooking.check(base.c.current, value);
    },
    save: forbiddenWrite,
  };
  const beforePatients = clone(base.patients),
    beforeServices = clone(base.services);
  const beforeDays = clone(days),
    beforeClosures = clone(closures);
  let result, activeId;
  const body = (operation) => ({
    policyVersion: base.state.revision,
    dialogueId: result.dialogue.id,
    dialogueVersion: result.dialogue.version,
    ...operation,
  });
  const capture = (reply) => {
    result = reply;
    if (reply.dialogue) activeId = reply.dialogue.id;
    return result;
  };
  const f = {
    ...base,
    days,
    closures,
    personal,
    reserves,
    workspace,
    reads,
    start(intent = {}, constraints = {}) {
      return capture(
        base.flow.start(
          base.c,
          {
            intent: 'prepareAppointment',
            query: 'Анна Семёнова',
            serviceQuery: 'Чистка',
            ...intent,
          },
          base.state,
          base.member,
          base.clock,
          base.flow.beginCommand(base.c, base.member, base.state),
          constraints,
        ),
      );
    },
    answer(operation) {
      return capture(
        base.flow.continueDialogue(base.c, body(operation), base.state, base.member, base.clock),
      );
    },
    prepare(text, extra = {}) {
      const request = body({ text, ...extra });
      return {
        request,
        snapshot: base.flow.prepareModelTurn(base.c, request, base.state, base.member, base.clock),
      };
    },
    apply(prepared, proposal) {
      assert.ok(prepared.snapshot, 'A synthetic model proposal needs a captured current turn');
      return capture(
        base.flow.applyModelTurn(
          base.c,
          prepared.request,
          base.state,
          base.member,
          base.clock,
          proposal,
          prepared.snapshot,
        ),
      );
    },
    entry() {
      return base.flow.get(base.c, base.member, base.state, activeId);
    },
    clearReads() {
      for (const key of ['schedules', 'appointments', 'personal', 'reserves', 'scheduleChecks'])
        reads[key].length = 0;
    },
    noSave() {
      assert.ok(
        !result?.action || result.action.type === 'prepareAppointment',
        'Current test mode may only prepare a form',
      );
      assert.equal(reads.writes, 0);
      assert.deepEqual(base.patients, beforePatients);
      assert.deepEqual(base.services, beforeServices);
      assert.deepEqual(
        days,
        beforeDays,
        'Preparing an exception never opens or edits a working day',
      );
      assert.deepEqual(closures, beforeClosures);
    },
  };
  Object.defineProperty(f, 'result', { get: () => result });
  t.after(() => f.noSave());
  return f;
}
function rows(f, kind) {
  return [...f.entry().options]
    .filter(([, row]) => !kind || row.kind === kind)
    .map(([id, row]) => ({ id, ...row }));
}
function control(f, kind) {
  const match = [...(f.entry().controls || [])].find(([, row]) => row.kind === kind);
  assert.ok(match, 'Missing current control ' + kind);
  return match[0];
}
function ranges(f) {
  return rows(f, 'freeRange').map((row) => {
    const times = row.label.match(/\d{2}:\d{2}/gu) || [];
    assert.equal(times.length, 2, row.label);
    return times;
  });
}
function chooseWholeRange(f) {
  const range = rows(f, 'freeRange')[0];
  assert.ok(range, 'Expected an actual free range');
  f.answer({ choice: range.id });
  assert.equal(f.result.dialogue.phase, 'slots');
  return range;
}
function openForm(f) {
  if (!f.result.action) {
    assert.equal(f.result.dialogue.step, 'review');
    f.answer({ text: 'открой форму' });
  }
  assert.equal(f.result.dialogue, null);
  assert.equal(f.result.action?.type, 'prepareAppointment');
  return f.result.action;
}
function assertAction(f, action, date, time, duration = 30) {
  assert.equal(action.patientId, f.patients[0].id);
  assert.equal(action.staffId, 'owner');
  assert.deepEqual(action.serviceIds, ['clean']);
  assert.equal(action.date, date);
  assert.equal(action.time, time);
  assert.equal(action.duration, duration);
}
function assertChosenDayReads(f) {
  assert.ok(f.reads.schedules.length > 0);
  for (const read of f.reads.schedules) {
    assert.equal(read.from, day);
    assert.equal(read.to, day);
  }
  for (const source of ['appointments', 'personal', 'reserves']) {
    assert.ok(f.reads[source].length > 0, source);
    for (const read of f.reads[source]) {
      assert.ok(read.from >= nextDate(day, -1), source + ' fetched an unbounded past range');
      assert.equal(read.to, day, source + ' silently fetched other dates');
    }
  }
}

test('an available exact time skips date overview, period and slots for each supported role', async (t) => {
  for (const role of ['owner', 'salon_admin', 'cosmetologist'])
    await t.test(role, (t) => {
      const f = fixture(t, { role });
      const result = f.start({ date: day, time: '12:30' });
      assert.equal(result.dialogue.step, 'review');
      assert.equal(result.dialogue.phase, undefined);
      assert.equal(field(result, 'time'), '12:30');
      assertAction(f, openForm(f), day, '12:30');
      assertChosenDayReads(f);
    });
});

test('missing date asks for a date first and selecting one retains client service and duration', (t) => {
  const f = fixture(t);
  const result = f.start();
  assert.equal(result.dialogue.phase, 'date');
  assert.equal(field(result, 'time'), undefined);
  assert.ok(rows(f).every((row) => row.kind === 'date'));
  for (const read of f.reads.schedules)
    assert.ok((Date.parse(read.to) - Date.parse(read.from)) / 86400000 <= 6);
  const chosen = rows(f, 'date').find((row) => row.value === day);
  assert.ok(chosen);
  f.answer({ choice: chosen.id });
  assert.equal(f.result.dialogue.phase, 'period');
  assert.match(f.result.text, /весь рабочий день свободен/iu);
  assert.equal(field(f.result, 'date'), day);
  assert.equal(field(f.result, 'client'), 'Анна Семёнова · …2233');
  assert.equal(field(f.result, 'service'), 'Чистка');
  assert.equal(field(f.result, 'duration'), '30 мин');
});

test('an opened empty day describes the entire real working interval instead of enumerating starts', (t) => {
  const f = fixture(t);
  f.start({ date: day });
  assert.equal(f.result.dialogue.phase, 'period');
  assert.match(f.result.text, /весь рабочий день свободен/iu);
  assert.deepEqual(ranges(f), [['09:00', '18:00']]);
  assert.equal(rows(f, 'slot').length, 0);
  assert.equal(field(f.result, 'time'), undefined);
  assertChosenDayReads(f);
});

test('an empty split shift retains its break rather than inventing one continuous working day', (t) => {
  const f = fixture(t, {
    intervals: [
      ['09:00', '12:00'],
      ['13:00', '18:00'],
    ],
  });
  f.start({ date: day });
  assert.match(f.result.text, /весь рабочий день свободен/iu);
  assert.deepEqual(ranges(f), [
    ['09:00', '12:00'],
    ['13:00', '18:00'],
  ]);
});

test('partial occupancy exposes maximal ranges only when the complete appointment fits', (t) => {
  const f = fixture(t, { duration: 45 });
  f.busy.push(appointment('busy-1', '10:00', 60), appointment('busy-2', '13:00', 60));
  f.personal.push(appointment('personal', '16:00', 30));
  f.reserves.push({
    ...appointment('reserve', '17:00', 30),
    status: 'pending',
    expiresAt: Date.now() + 3600000,
  });
  f.start({ date: day });
  assert.doesNotMatch(f.result.text, /весь рабочий день свободен/iu);
  assert.deepEqual(ranges(f), [
    ['09:00', '10:00'],
    ['11:00', '13:00'],
    ['14:00', '16:00'],
  ]);
  for (const [from, to] of ranges(f)) assert.ok(minutes(to) - minutes(from) >= 45);
  assert.equal(rows(f, 'slot').length, 0);
  assertChosenDayReads(f);
});

test('personal time and a live online reserve prevent the empty-day claim even without appointments', (t) => {
  const f = fixture(t, { intervals: [['09:00', '12:00']] });
  f.personal.push(appointment('personal', '09:00', 60));
  f.reserves.push({
    ...appointment('reserve', '11:00', 60),
    status: 'pending',
    expiresAt: Date.now() + 3600000,
  });
  f.start({ date: day });
  assert.doesNotMatch(f.result.text, /весь рабочий день свободен/iu);
  assert.deepEqual(ranges(f), [['10:00', '11:00']]);
});

test('owner and administrator explicitly continue a closed or unset day to a manual form without changing schedules', async (t) => {
  for (const role of ['owner', 'salon_admin'])
    for (const status of ['unset', 'closed', 'organization']) {
      await t.test(role + '/' + status, (t) => {
        const f = fixture(t, {
          role,
          days:
            status === 'unset'
              ? {}
              : status === 'closed'
                ? { [day]: { status: 'closed', intervals: [] } }
                : { [day]: working() },
          closures: status === 'organization' ? { [day]: { status: 'closed' } } : {},
        });
        f.start({ date: day });
        assert.equal(f.result.dialogue.phase, 'closedDay');
        assert.match(f.result.text, /день не открыт/iu);
        const yes = rows(f, 'closedDayContinue');
        assert.equal(yes.length, 1);
        assert.equal(f.result.action, null);
        f.answer({ choice: yes[0].id });
        assert.notEqual(f.result.dialogue?.phase, 'closedDay');
        assert.equal(f.result.action, null);
        f.answer({ text: 'в 12:30' });
        assertAction(f, openForm(f), day, '12:30');
      });
    }
});

test('an employee cannot grant a closed-day override by saying yes', async (t) => {
  for (const status of ['unset', 'closed', 'organization'])
    await t.test(status, (t) => {
      const f = fixture(t, {
        role: 'cosmetologist',
        days:
          status === 'unset'
            ? {}
            : status === 'closed'
              ? { [day]: { status: 'closed', intervals: [] } }
              : { [day]: working() },
        closures: status === 'organization' ? { [day]: { status: 'closed' } } : {},
      });
      f.start({ date: day });
      assert.equal(f.result.dialogue.phase, 'closedDay');
      assert.equal(rows(f, 'closedDayContinue').length, 0);
      const before = clone(f.entry().data);
      f.answer({ text: 'да' });
      assert.match(f.result.text, /День не открыт. Выберите другую дату./u);
      assert.equal(f.result.dialogue.phase, 'closedDay');
      assert.equal(rows(f, 'closedDayContinue').length, 0);
      assert.deepEqual(f.entry().data, before);
      assert.equal(f.result.action, null);
      assert.throws(() => f.answer({ choice: 'forged-closed-day-continue' }), { status: 409 });
      assert.deepEqual(f.entry().data, before);
    });
});

test('an occupied exact time offers complete free ranges inside the requested window', (t) => {
  const f = fixture(t);
  f.busy.push(appointment('busy', '10:00', 60));
  f.start({ date: day, time: '10:30' }, { timeWindow: windowFrom('09:00', '12:00') });
  assert.equal(f.result.dialogue.phase, 'period');
  assert.deepEqual(ranges(f), [
    ['09:00', '10:00'],
    ['11:00', '12:00'],
  ]);
  assert.equal(rows(f, 'slot').length, 0);
  assert.match(f.result.text, /^В 10:30 занято\. Свободно с 09:00 до 10:00, с 11:00 до 12:00\./u);
  f.answer({ text: 'ближайшее свободное время' });
  const options = rows(f, 'slot');
  assert.equal(options.length, 1);
  assert.equal(options[0].value.date, day);
  assert.equal(options[0].value.time, '11:00');
  assert.ok(minutes(options[0].value.time) + options[0].value.duration <= minutes('12:00'));
  f.answer({ choice: options[0].id });
  assertAction(f, openForm(f), day, '11:00');
  assertChosenDayReads(f);
});

test('a fully occupied selected day never replaces it with a free slot in the following six days', (t) => {
  const f = fixture(t);
  f.busy.push(appointment('full-day', '09:00', 540));
  f.start({ date: day });
  assert.equal(field(f.result, 'date'), day);
  assert.equal(rows(f, 'freeRange').length, 0);
  assert.equal(rows(f, 'slot').length, 0);
  assert.equal(f.result.action, null);
  assert.match(f.result.text, /нет свободн|подходящих окон нет|нет .*промежут/iu);
  assertChosenDayReads(f);
});

test('the other-date control preserves the client service staff and duration', (t) => {
  const f = fixture(t);
  f.start({ date: day });
  const original = clone(f.entry().data);
  f.answer({ choice: control(f, 'otherDate') });
  assert.equal(f.result.dialogue.phase, 'date');
  assert.equal(f.entry().data.date, null);
  for (const key of ['patient', 'staff', 'service', 'duration'])
    assert.deepEqual(f.entry().data[key], original[key], key);
  f.answer({ text: 'завтра' });
  assert.equal(field(f.result, 'date'), next);
  assert.equal(f.result.dialogue.phase, 'period');
  assert.equal(field(f.result, 'client'), 'Анна Семёнова · …2233');
  assert.equal(field(f.result, 'service'), 'Чистка');
  assert.equal(field(f.result, 'time'), undefined);
});

test('a new conflict after a free-range summary is observed before concrete starts are offered', (t) => {
  const f = fixture(t);
  f.start({ date: day });
  const range = rows(f, 'freeRange')[0];
  assert.ok(range);
  f.busy.push(appointment('new-full-day', '09:00', 540));
  f.answer({ choice: range.id });
  assert.equal(rows(f, 'slot').length, 0);
  assert.equal(field(f.result, 'date'), day);
  assert.equal(f.result.action, null);
});

test('a listed slot that becomes occupied is rejected and never reaches the prepared form', (t) => {
  const f = fixture(t);
  f.start({ date: day });
  chooseWholeRange(f);
  const offered = rows(f, 'slot');
  assert.ok(offered.length >= 2);
  const stale = offered[1];
  f.busy.push(appointment('new-conflict', stale.value.time, stale.value.duration));
  f.answer({ choice: stale.id });
  assert.equal(f.result.action, null);
  assert.notEqual(f.entry().data.time, stale.value.time);
  assert.equal(field(f.result, 'date'), day);
  assert.ok(rows(f, 'slot').every((row) => slotTime(row) !== stale.value.time));
});

test('old controls and stale dialogue versions cannot choose from a newer phase', (t) => {
  const f = fixture(t);
  f.start({ date: day });
  const oldControl = control(f, 'otherDate');
  const oldVersion = f.result.dialogue.version;
  chooseWholeRange(f);
  const before = clone(f.entry().data);
  assert.throws(() => f.answer({ choice: oldControl }), { status: 409 });
  assert.throws(() => f.prepare('номер 2', { dialogueVersion: oldVersion }), { status: 409 });
  assert.deepEqual(f.entry().data, before);
  assert.equal(f.result.action, null);
});

test('explicit numbered current options bypass the model gate and preserve their actual date and time', async (t) => {
  for (const text of [
    'номер 2',
    'окно 2',
    'вариант номер 2',
    'номер два',
    'давай второй вариант',
  ]) {
    await t.test(text, (t) => {
      const f = fixture(t);
      f.start({ date: day });
      chooseWholeRange(f);
      const current = rows(f, 'slot');
      assert.ok(current.length >= 2);
      const chosen = current[1].value;
      const prepared = f.prepare(text);
      assert.equal(prepared.snapshot, null, 'An explicit current choice must not invoke the model');
      f.answer({ text });
      assertAction(f, openForm(f), chosen.date, chosen.time, chosen.duration);
    });
  }
});

test('an exact answer to the day overview bypasses period and range selection', (t) => {
  const f = fixture(t);
  f.start({ date: day });
  assert.equal(f.result.dialogue.phase, 'period');
  f.answer({ text: 'в 14:30' });
  assert.equal(f.result.dialogue.step, 'review');
  assert.equal(f.result.dialogue.phase, undefined);
  assertAction(f, openForm(f), day, '14:30');
});

test('one date and a concrete time window are retained in either spoken order', async (t) => {
  for (const text of ['завтра с 14 до 16', 'с 14 до 16 завтра'])
    await t.test(text, (t) => {
      const f = fixture(t);
      f.start();
      const prepared = f.prepare(text);
      if (prepared.snapshot)
        f.apply(prepared, {
          operation: 'patch',
          fields: {
            client: null,
            staff: null,
            service: null,
            date: next,
            time: null,
            duration: null,
          },
          choice: null,
          field: null,
        });
      else f.answer({ text });
      assert.equal(field(f.result, 'date'), next);
      assert.equal(f.result.dialogue.phase, 'slots');
      assert.equal(f.entry().data.time, null);
      assert.equal(f.entry().data.timeWindow.from, '14:00');
      assert.equal(f.entry().data.timeWindow.to, '16:00');
      const options = rows(f, 'slot');
      assert.ok(options.length > 0);
      assert.ok(options.length <= 3);
      for (const row of options) {
        assert.equal(row.value.date, next);
        assert.ok(minutes(row.value.time) >= minutes('14:00'));
        assert.ok(minutes(row.value.time) + row.value.duration <= minutes('16:00'));
      }
      assert.equal(f.result.action, null);
    });
});

test('range selection does not silently choose its first start and recommendations remain brief', (t) => {
  const f = fixture(t);
  f.start({ date: day });
  chooseWholeRange(f);
  const options = rows(f, 'slot');
  assert.equal(f.entry().data.time, null);
  assert.equal(f.result.action, null);
  assert.equal(options.length, 3);
  for (let index = 1; index < options.length; index++)
    assert.ok(minutes(options[index].value.time) - minutes(options[index - 1].value.time) >= 60);
  assertChosenDayReads(f);
});

test('an exact time supplied before the date survives selecting a real available date', (t) => {
  const f = fixture(t);
  f.start({ time: '12:30' });
  assert.equal(f.result.dialogue.phase, 'date');
  assert.equal(field(f.result, 'time'), '12:30');
  const date = rows(f, 'date').find((row) => row.value === day);
  assert.ok(date);
  f.answer({ choice: date.id });
  assert.equal(f.result.dialogue.step, 'review');
  assert.equal(field(f.result, 'time'), '12:30');
  assertAction(f, openForm(f), day, '12:30');
});

test('an exact start inside a preference window cannot prepare a visit ending outside it', (t) => {
  const f = fixture(t);
  f.start({ date: day, time: '11:45' }, { timeWindow: windowFrom('09:00', '12:00') });
  assert.equal(f.result.action, null);
  assert.notEqual(f.result.dialogue.step, 'review');
  assert.notEqual(f.entry().data.time, '11:45');
  const alternatives = rows(f, 'slot');
  for (const row of alternatives)
    assert.ok(minutes(row.value.time) + row.value.duration <= minutes('12:00'));
  if (alternatives.length) {
    f.answer({ choice: alternatives[0].id });
    const action = openForm(f);
    assert.ok(minutes(action.time) + action.duration <= minutes('12:00'));
  }
});

test('an empty working interval shorter than the visit is not advertised as an entirely available working day', (t) => {
  const f = fixture(t, { intervals: [['09:00', '09:30']], duration: 45 });
  f.start({ date: day });
  assert.doesNotMatch(f.result.text, /весь рабочий день свободен/iu);
  assert.equal(rows(f, 'freeRange').length, 0);
  assert.equal(rows(f, 'slot').length, 0);
  assert.equal(f.result.action, null);
  assert.match(f.result.text, /не помещ|нет .*промежут|нет свободн|подходящих окон нет/iu);
});

test('yes accepts the sole nearest current slot without a model call or saving', (t) => {
  const f = fixture(t);
  f.busy.push(appointment('busy', '10:00', 60));
  f.start({ date: day, time: '10:30' }, { timeWindow: windowFrom('09:00', '12:00') });
  f.answer({ text: 'ближайшее свободное время' });
  const options = rows(f, 'slot');
  assert.equal(options.length, 1);
  assert.equal(options[0].value.time, '11:00');
  assert.equal(f.prepare('да').snapshot, null);
  f.answer({ text: 'да' });
  assertAction(f, openForm(f), day, '11:00');
});

test('yes to a sole nearest slot rechecks new occupancy instead of accepting a stale time', (t) => {
  const f = fixture(t);
  f.busy.push(appointment('busy', '10:00', 60));
  f.start({ date: day, time: '10:30' }, { timeWindow: windowFrom('09:00', '12:00') });
  f.answer({ text: 'ближайшее свободное время' });
  const stale = rows(f, 'slot')[0];
  assert.ok(stale);
  assert.equal(stale.value.time, '11:00');
  f.busy.push(appointment('new-nearest-conflict', stale.value.time, stale.value.duration));
  assert.equal(f.prepare('да').snapshot, null);
  f.answer({ text: 'да' });
  assert.equal(f.result.action, null);
  assert.notEqual(f.entry().data.time, stale.value.time);
  assert.equal(field(f.result, 'date'), day);
  assert.ok(rows(f, 'slot').every((row) => row.value.time !== stale.value.time));
});

test('busy at nine reports the whole earlier and later free ranges without selecting a start', (t) => {
  const f = fixture(t, { intervals: [['07:00', '18:00']], duration: 45 });
  f.busy.push(appointment('busy', '09:00', 120));
  f.start({ date: day, time: '09:00' });
  assert.equal(
    f.result.text,
    'В 09:00 занято. Свободно с 07:00 до 09:00, с 11:00 до 18:00. На какое время?',
  );
  assert.deepEqual(ranges(f), [
    ['07:00', '09:00'],
    ['11:00', '18:00'],
  ]);
  assert.equal(rows(f, 'slot').length, 0);
  assert.equal(field(f.result, 'time'), undefined);
  assert.equal(f.result.action, null);
  f.answer({ text: 'в 07:30' });
  assertAction(f, openForm(f), day, '07:30', 45);
});

test('range summaries exclude short gaps and observe personal time and online reservations', (t) => {
  const f = fixture(t, { intervals: [['07:00', '14:00']], duration: 45 });
  f.busy.push(appointment('busy', '09:00', 120));
  f.personal.push(appointment('personal', '07:30', 60));
  f.reserves.push({
    ...appointment('reserve', '12:00', 30),
    status: 'pending',
    expiresAt: Date.now() + 3600000,
  });
  f.start({ date: day, time: '09:00' });
  assert.deepEqual(ranges(f), [
    ['11:00', '12:00'],
    ['12:30', '14:00'],
  ]);
  assert.doesNotMatch(f.result.text, /07:00|07:30|08:30|весь рабочий день/iu);
  assertChosenDayReads(f);
});

test('yes to a sole free range cannot silently choose an exact appointment time', (t) => {
  const f = fixture(t, { intervals: [['07:00', '12:00']], duration: 45 });
  f.busy.push(appointment('busy', '07:00', 120));
  f.start({ date: day, time: '07:00' });
  assert.deepEqual(ranges(f), [['09:00', '12:00']]);
  const before = clone(f.entry().data);
  assert.equal(f.prepare('да').snapshot, null);
  f.answer({ text: 'да' });
  assert.equal(f.result.dialogue.phase, 'period');
  assert.match(f.result.text, /На какое время\?/u);
  assert.equal(f.result.action, null);
  assert.deepEqual(f.entry().data, before);
});

test('more than three ranges are announced as partial and remain reachable by voice', (t) => {
  const f = fixture(t, { intervals: [['07:00', '18:00']], duration: 45 });
  for (const [i, time] of ['08:00', '10:00', '12:00', '14:00'].entries())
    f.busy.push(appointment('busy-' + i, time, 60));
  f.start({ date: day, time: '08:00' });
  assert.deepEqual(ranges(f), [
    ['07:00', '08:00'],
    ['09:00', '10:00'],
    ['11:00', '12:00'],
  ]);
  assert.match(f.result.text, /Есть и другие промежутки/u);
  assert.ok(control(f, 'moreRanges'));
  assert.equal(f.prepare('ещё промежутки').snapshot, null);
  f.answer({ text: 'ещё промежутки' });
  assert.deepEqual(ranges(f), [
    ['13:00', '14:00'],
    ['15:00', '18:00'],
  ]);
  assert.equal(f.result.action, null);
  assert.equal(rows(f, 'slot').length, 0);
});

test('fresh conflicts are rechecked when another range page is requested', (t) => {
  const f = fixture(t, { intervals: [['07:00', '18:00']], duration: 45 });
  for (const [i, time] of ['08:00', '10:00', '12:00', '14:00'].entries())
    f.busy.push(appointment('busy-' + i, time, 60));
  f.start({ date: day, time: '08:00' });
  f.busy.push(appointment('new-late-busy', '15:00', 180));
  f.answer({ choice: control(f, 'moreRanges') });
  assert.deepEqual(ranges(f), [['13:00', '14:00']]);
  assert.doesNotMatch(f.result.text, /15:00|18:00/u);
});

test('explicit earliest requests retain the period and offer one verified earliest start', (t) => {
  const f = fixture(t, { intervals: [['07:00', '18:00']], duration: 45 });
  f.busy.push(appointment('busy', '09:00', 120));
  f.start({ date: day, time: '09:00' }, { timeWindow: windowFrom('08:00', '13:00') });
  f.answer({ text: 'первое свободное время' });
  assert.equal(f.result.dialogue.phase, 'slots');
  const options = rows(f, 'slot');
  assert.equal(options.length, 1);
  assert.equal(options[0].value.time, '08:00');
  assert.equal(f.result.action, null);
});

test('an empty working split never announces a shift too short for the selected service', (t) => {
  const f = fixture(t, {
    intervals: [
      ['07:00', '07:15'],
      ['09:00', '18:00'],
    ],
    duration: 45,
  });
  f.start({ date: day });
  assert.deepEqual(ranges(f), [['09:00', '18:00']]);
  assert.doesNotMatch(f.result.text, /07:00|07:15/u);
});

test('yes with several current slots cannot silently accept the first one', (t) => {
  const f = fixture(t);
  f.start({ date: day });
  chooseWholeRange(f);
  assert.ok(rows(f, 'slot').length > 1);
  const before = clone(f.entry().data);
  try {
    f.answer({ text: 'да' });
  } catch (error) {
    assert.equal(error.status, 400);
  }
  assert.equal(f.result.action, null);
  assert.equal(f.entry().data.time, null);
  assert.deepEqual(f.entry().data, before);
});

test('proved date remains when a model clarifies an alternative morning or evening period', (t) => {
  const f = fixture(t);
  f.start();
  const before = clone(f.entry().data);
  const prepared = f.prepare('завтра утром или вечером');
  assert.ok(prepared.snapshot);
  f.apply(prepared, {
    operation: 'clarify',
    fields: { client: null, staff: null, service: null, date: null, time: null, duration: null },
    choice: null,
    field: 'time',
  });
  assert.equal(field(f.result, 'date'), next);
  assert.equal(f.entry().data.time, null);
  assert.equal(f.entry().data.timeWindow, null);
  assert.equal(f.entry().data.timeWindowRequired, true);
  for (const key of ['patient', 'staff', 'service', 'duration'])
    assert.deepEqual(f.entry().data[key], before[key], key);
  assert.equal(f.result.action, null);
  f.answer({ text: 'утром' });
  assert.equal(field(f.result, 'date'), next);
  assert.equal(f.result.dialogue.phase, 'slots');
  assert.ok(rows(f, 'slot').length > 0);
  assert.ok(
    rows(f, 'slot').every(
      (row) => row.value.date === next && minutes(row.value.time) + row.value.duration <= 720,
    ),
  );
});

test('a required duration answer is asked before day overview or free-range searches', (t) => {
  const f = fixture(t);
  f.start({ date: day }, { requireDuration: true });
  assert.equal(f.result.dialogue.step, 'duration');
  assert.equal(f.result.dialogue.phase, undefined);
  assert.equal(rows(f, 'freeRange').length, 0);
  assert.equal(rows(f, 'slot').length, 0);
  assert.equal(f.reads.appointments.length, 0);
  assert.equal(f.reads.schedules.length, 0);
  assert.equal(f.result.action, null);
  f.answer({ text: 'полчаса' });
  assert.equal(f.result.dialogue.phase, 'period');
  assert.equal(field(f.result, 'date'), day);
  assert.equal(field(f.result, 'duration'), '30 мин');
  assert.equal(f.entry().data.patient.id, f.patients[0].id);
  assert.equal(f.entry().data.serviceChosen, true);
  assert.equal(f.entry().data.service.id, f.services[0].id);
  assert.match(f.result.text, /весь рабочий день свободен/iu);
});
