const test = require('node:test');
const assert = require('node:assert/strict');
const { assistantBoundariesFixture } = require('./helpers/assistant-boundaries-fixture.cjs');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const { defaults } = require('../src/server/modules/workspace/policy.cjs');
function model(f, intent, continuation) {
  const values = continuation ? [intent, continuation] : [intent];
  let calls = 0;
  f.ports.codex.run = async (call) => {
    call.guard();
    call.onOutbound();
    assert.ok(calls < values.length, 'Only the explicitly declared model turns are permitted');
    return { text: JSON.stringify(values[calls++]) };
  };
  return () => calls;
}
function manualForm(result, d, current, { date = day, time = '10:00', duration = 30 } = {}) {
  assert.equal(result.dialogue, null);
  assert.deepEqual(result.action, {
    type: 'prepareAppointment',
    patientId: d.patients[0].id,
    staffId: current.accountId,
    date,
    time,
    duration,
    roomId: 'main',
    serviceIds: [d.services[0].id],
  });
  assert.match(result.text, /^Подготовил запись: /u);
}
function clinical(f) {
  const d = dialogueFixture(),
    current = f.current('owner');
  d.members[0].accountId = current.accountId;
  d.services[0].staffId = current.accountId;
  d.patients[0].createdBy = current.accountId;
  return {
    d,
    current,
    c: {
      ...f.context(),
      platform: { ...d.c.platform, workspaceSettings: () => defaults(current.accountId) },
      tenantStore: d.c.tenantStore,
    },
  };
}
const complete = {
  intent: 'prepareAppointment',
  query: 'Анна Семёнова',
  serviceQuery: 'Чистка',
  date: day,
  time: '10:00',
};
test('an explicit invalid or conflicting duration keeps a draft and requires a real answer instead of model or service defaults', async (t) => {
  const f = await assistantBoundariesFixture(t),
    { d, c, current } = clinical(f);
  for (const text of [
    'Запиши Анну Семёнову на Чистка 5 января 2099 года в10:00 на семь минут.',
    'Запиши Анну Семёнову на Чистка 5 января 2099 года в10:00 на ноль минут.',
    'Запиши Анну Семёнову на Чистка 5 января 2099 года в10:00 на 30 минут и на 45 минут.',
    'Лучше запиши Анну Семёнову на Чистка 5 января 2099 года в10:00 на семь минут.',
    'Запиши Анну Семёнову на Чистка 5 января 2099 года в10:00 на семь минут, точнее услуга Чистка.',
  ]) {
    const calls = model(
      f,
      { ...complete, duration: 30 },
      {
        operation: 'patch',
        fields: { client: null, staff: null, service: null, date: null, time: null, duration: 30 },
        choice: null,
        field: null,
      },
    );
    const first = await f.api.turn(c, { text, policyVersion: f.revision() });
    assert.equal(first.intent, 'prepareAppointment');
    assert.equal(first.action, null);
    assert.equal(first.dialogue.step, 'duration');
    assert.equal(
      first.dialogue.fields.some((field) => field.key === 'duration'),
      false,
    );
    assert.equal(field(first, 'client'), 'Анна Семёнова · …2233');
    assert.equal(field(first, 'service'), 'Чистка');
    assert.equal(field(first, 'date'), day);
    assert.equal(field(first, 'time'), '10:00');
    noSave(f, d);
    const clarified = await f.api.turn(c, {
      policyVersion: f.revision(),
      dialogueId: first.dialogue.id,
      dialogueVersion: first.dialogue.version,
      text: 'тридцать минут',
    });
    manualForm(clarified, d, current, { duration: 30 });
    assert.equal(
      calls(),
      1,
      'The invalid initial duration is corrected locally without a second model call',
    );
    noSave(f, d);
  }
});
test('a valid explicit thirty-minute request is authoritative when a model omits, changes or faithfully repeats it', async (t) => {
  const f = await assistantBoundariesFixture(t),
    { d, c, current } = clinical(f);
  for (const duration of [undefined, 45, 30]) {
    model(f, { ...complete, ...(duration === undefined ? {} : { duration }) });
    const first = await f.api.turn(c, {
      text: 'Запиши Анну Семёнову на Чистка 5 января 2099 года в10:00 на тридцать минут.',
      policyVersion: f.revision(),
    });
    manualForm(first, d, current, { duration: 30 });
    noSave(f, d);
  }
});
test('unsupported model filters are rejected at the service boundary instead of widening navigation or booking', async (t) => {
  const f = await assistantBoundariesFixture(t);
  for (const intent of [
    { intent: 'calendar', date: day, query: 'Анна Семёнова' },
    { intent: 'prepareAppointment', query: 'Анна Семёнова', date: day, endDate: '2099-01-06' },
  ]) {
    model(f, intent);
    await assert.rejects(f.request('llm'), { status: 502 });
    assert.equal(Object.keys(f.readState().reservations).length, 0);
  }
});

test('availability uses an explicit valid duration over omitted or mismatched model values and rejects an invalid duration before reads', async (t) => {
  const f = await assistantBoundariesFixture(t),
    { c } = clinical(f);
  for (const duration of [undefined, 45]) {
    model(f, {
      intent: 'availability',
      date: day,
      ...(duration === undefined ? {} : { duration }),
    });
    const result = await f.api.turn(c, {
      text: 'Найди свободное окно на тридцать минут.',
      policyVersion: f.revision(),
    });
    assert.equal(result.availability.duration, 30);
    assert.equal(result.slots, undefined, 'raw slot IDs remain server-side');
    assert.equal(result.dialogue.step, 'availability');
    assert.ok(result.dialogue.options.length > 0);
    for (const option of result.dialogue.options) {
      const times = / · (\d{2}):(\d{2})–(\d{2}):(\d{2}) · /u.exec(option.label);
      assert.ok(times, 'each actual option describes its exact interval');
      assert.equal(
        Number(times[3]) * 60 + Number(times[4]) - Number(times[1]) * 60 - Number(times[2]),
        30,
      );
    }
    const selected = await f.api.turn(c, {
      policyVersion: f.revision(),
      dialogueId: result.dialogue.id,
      dialogueVersion: result.dialogue.version,
      choice: result.dialogue.options[0].id,
    });
    assert.equal(
      selected.dialogue.fields.find((field) => field.key === 'duration').value,
      '30 мин',
    );
  }
  model(f, { intent: 'availability', date: day, duration: 30 });
  await assert.rejects(f.request('llm', 'owner', { text: 'Найди свободное окно на семь минут.' }), {
    status: 400,
  });
});

function field(result, key) {
  return result.dialogue.fields.find((item) => item.key === key)?.value;
}
function noSave(f, d) {
  assert.equal(d.patients[0].appointments.length, 0);
  assert.equal(Object.keys(f.readState().reservations).length, 0);
}
test('the service uses the original exact date and time when a model substitutes both', async (t) => {
  const f = await assistantBoundariesFixture(t),
    { d, c, current } = clinical(f);
  model(f, { ...complete, date: '2099-01-06', time: '16:00' });
  const result = await f.api.turn(c, {
    text: 'Запиши Анну Семёнову на Чистка 5 января 2099 года в 14:30.',
    policyVersion: f.revision(),
  });
  manualForm(result, d, current, { date: day, time: '14:30' });
  noSave(f, d);
});
test('a real clock correction keeps the corrected model value instead of reinstating the first clock', async (t) => {
  const f = await assistantBoundariesFixture(t),
    { d, c, current } = clinical(f);
  model(f, { ...complete, time: '15:00' });
  const result = await f.api.turn(c, {
    text: 'Запиши Анну Семёнову на Чистка 5 января 2099 года в 14:30, нет, лучше в 15:00.',
    policyVersion: f.revision(),
  });
  manualForm(result, d, current, { date: day, time: '15:00' });
  noSave(f, d);
});
test('an impossible date or invalid or ambiguous clock cannot be replaced by a plausible model value', async (t) => {
  const f = await assistantBoundariesFixture(t),
    { d, c } = clinical(f);
  for (const [text, step, missing] of [
    ['Запиши Анну Семёнову на Чистка 31 ноября 2099 года в 14:30.', 'date', 'date'],
    ['Запиши Анну Семёнову на Чистка 5 января 2099 года в 14:70.', 'time', 'time'],
    ['Запиши Анну Семёнову на Чистка 5 января 2099 года в три или в четыре.', 'time', 'time'],
  ]) {
    model(f, { ...complete, time: '14:30' });
    const result = await f.api.turn(c, { text, policyVersion: f.revision() });
    assert.equal(result.dialogue.step, step, text);
    assert.equal(field(result, missing), undefined, text);
    assert.equal(result.action, null);
    noSave(f, d);
  }
});
test('a supported initial clock bound offers actual bounded slots instead of choosing its boundary while calendar ranges remain unsupported', async (t) => {
  const f = await assistantBoundariesFixture(t),
    { d, c, current } = clinical(f);
  const calls = model(f, { ...complete, time: '14:30' });
  const result = await f.api.turn(c, {
    text: 'Запиши Анну Семёнову на Чистка 5 января 2099 года после 14:30.',
    policyVersion: f.revision(),
  });
  assert.equal(result.action, null);
  assert.equal(result.dialogue.step, 'time');
  assert.equal(result.dialogue.phase, 'slots');
  assert.ok(result.dialogue.options.length > 0 && result.dialogue.options.length <= 3);
  for (const row of result.dialogue.options) {
    const time = row.label.match(/ · (\d{2}:\d{2})–/u)?.[1];
    assert.ok(time && time > '14:30', 'A lower bound never becomes the appointment start');
  }
  const selected = result.dialogue.options[0],
    expected = selected.label.match(/ · (\d{2}:\d{2})–/u)[1];
  const form = await f.api.turn(c, {
    policyVersion: f.revision(),
    dialogueId: result.dialogue.id,
    dialogueVersion: result.dialogue.version,
    choice: selected.id,
  });
  manualForm(form, d, current, { time: expected });
  assert.equal(calls(), 1);
  noSave(f, d);
  model(f, { ...complete, time: '14:30' });
  await assert.rejects(
    f.api.turn(c, {
      text: 'Запиши Анну Семёнову с 5 января 2099 года по 6 января 2099 года.',
      policyVersion: f.revision(),
    }),
    (error) => {
      assert.equal(error.status, 400);
      assert.match(error.message, /конкретные дату и время/iu);
      return true;
    },
  );
  noSave(f, d);
});
test('a six-in-the-evening phrase supplies an eighteen-o-clock start and keeps the thirty-minute service duration', async (t) => {
  const f = await assistantBoundariesFixture(t),
    { d, c, current } = clinical(f);
  c.platform.workSchedules = {
    view: () => ({
      days: { [day]: { status: 'working', intervals: [['09:00', '20:00']] } },
      closures: {},
    }),
  };
  model(f, { ...complete, time: '14:30' });
  const result = await f.api.turn(c, {
    text: 'Запиши Анну Семёнову на Чистка 5 января 2099 года на шесть часов вечера.',
    policyVersion: f.revision(),
  });
  manualForm(result, d, current, { time: '18:00', duration: 30 });
  noSave(f, d);
});
