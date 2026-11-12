const test = require('node:test');
const assert = require('node:assert/strict');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const { nextDate } = require('../src/shared/work-schedule.cjs');
const { fail } = require('../src/shared/errors.cjs');
const fields = () => ({
  client: null,
  staff: null,
  service: null,
  date: null,
  time: null,
  duration: null,
});
const clarify = (field) => ({ operation: 'clarify', fields: fields(), choice: null, field });
const patch = (values) => ({
  operation: 'patch',
  fields: { ...fields(), ...values },
  choice: null,
  field: null,
});
const clientPrompt = 'Назовите полное имя или телефон клиента.';
const servicePrompt = 'Назовите полное название услуги или выберите её на экране.';
const recovery = (f) => f.entry().data._clarificationRecovery;
const known = (f) => {
  const data = f.entry().data;
  return {
    patient: data.patient?.id,
    staff: data.staff?.id,
    service: data.service?.id,
    serviceChosen: data.serviceChosen,
    date: data.date,
    time: data.time,
    timeWindow: data.timeWindow,
    duration: data.duration,
    durationSource: data.durationSource,
  };
};
const choices = (f) => [...f.entry().options.values()].map((row) => JSON.stringify(row)).sort();
function fixture(
  t,
  { step = 'client', ambiguous = false, role = 'owner', serviceQuery, serviceNames } = {},
) {
  const base = dialogueFixture({ ambiguous, role });
  if (role === 'cosmetologist') base.members[0].role = role;
  if (serviceNames)
    base.services.splice(
      0,
      base.services.length,
      ...serviceNames.map((name, index) => ({
        id: 'synthetic-service-' + index,
        name,
        duration: 30,
        staffId: 'owner',
      })),
    );
  const store = base.c.tenantStore('org');
  let writes = 0,
    result,
    lastBody;
  for (const key of ['save', 'write'])
    store[key] = () => {
      writes++;
      throw Error('Forbidden appointment save');
    };
  const start = () => {
    result = base.flow.start(
      base.c,
      {
        intent: 'prepareAppointment',
        query:
          step === 'client' ? (ambiguous ? 'Семёнова' : 'Неизвестнаяфамилия') : 'Анна Семёнова',
        serviceQuery: serviceQuery || (step === 'client' ? 'Чистка' : 'Неизвестнаяпроцедура'),
        date: day,
        time: '10:00',
        duration: 45,
      },
      base.state,
      base.member,
      base.clock,
      base.flow.beginCommand(base.c, base.member, base.state),
    );
    return result;
  };
  const body = (operation) => ({
    policyVersion: base.state.revision,
    dialogueId: result.dialogue.id,
    dialogueVersion: result.dialogue.version,
    ...operation,
  });
  const f = {
    ...base,
    start,
    entry: () => base.flow.get(base.c, base.member, base.state, result.dialogue.id),
    local(operation) {
      lastBody = body(operation);
      result = base.flow.continueDialogue(base.c, lastBody, base.state, base.member, base.clock);
      return result;
    },
    text: (text) => f.local({ text }),
    replay() {
      return base.flow.continueDialogue(base.c, lastBody, base.state, base.member, base.clock);
    },
    prepare(text) {
      const request = body({ text });
      const snapshot = base.flow.prepareModelTurn(
        base.c,
        request,
        base.state,
        base.member,
        base.clock,
      );
      assert.ok(snapshot);
      return { request, snapshot };
    },
    apply(prepared, proposal) {
      result = base.flow.applyModelTurn(
        base.c,
        prepared.request,
        base.state,
        base.member,
        base.clock,
        proposal,
        prepared.snapshot,
      );
      return result;
    },
    model(text, proposal) {
      return f.apply(f.prepare(text), proposal);
    },
    noSave() {
      assert.equal(writes, 0);
      assert.ok(base.patients.every((row) => row.appointments.length === 0));
    },
  };
  Object.defineProperty(f, 'result', { get: () => result });
  start();
  t.after(() => f.noSave());
  return f;
}

test('two ordinary unresolved client answers change only the question and retain every known slot', (t) => {
  const f = fixture(t),
    before = known(f),
    candidates = choices(f),
    initial = f.result.dialogue.prompt;
  f.text('Редкаяфамилия');
  assert.equal(f.result.dialogue.prompt, initial);
  f.text('Сложнаяфамилия');
  assert.equal(f.result.dialogue.prompt, clientPrompt);
  assert.equal(f.result.text, clientPrompt);
  assert.deepEqual(known(f), before);
  assert.deepEqual(choices(f), candidates);
  assert.equal(f.result.action, null);
});

test('two ordinary unresolved service answers keep the current catalog choices and manual duration', (t) => {
  const f = fixture(t, { step: 'service' }),
    before = known(f),
    candidates = choices(f);
  f.text('Особаяпроцедура');
  f.text('Другаяпроцедура');
  assert.equal(f.result.dialogue.prompt, 'Назовите полное название услуги.');
  assert.equal(f.result.text, 'Назовите полное название услуги.');
  assert.equal(f.result.dialogue.options.length, 0);
  assert.deepEqual(known(f), before);
  assert.deepEqual(choices(f), candidates);
  assert.equal(f.result.action, null);
});

test('ordinary ambiguous client replies count even when the local resolver asks for more identity details', (t) => {
  const f = fixture(t, { ambiguous: true }),
    before = known(f),
    candidates = choices(f);
  f.text('Семёнова');
  f.text('Семёнова');
  assert.equal(f.result.dialogue.prompt, clientPrompt);
  assert.equal(f.result.text, clientPrompt);
  assert.equal(f.result.dialogue.options.length, 2);
  assert.deepEqual(known(f), before);
  assert.deepEqual(choices(f), candidates);
});

test('the private recovery count is bounded and absent from both public reply and model context', (t) => {
  const f = fixture(t);
  for (let index = 0; index < 6; index++) f.model('Сложноеимя', clarify('client'));
  assert.equal(recovery(f).count, 3);
  assert.equal(f.result.dialogue.manualInputRequired, true);
  assert.match(recovery(f).signature, /^[a-f\d]{64}$/u);
  assert.equal(recovery(f).pending, undefined);
  assert.equal(JSON.stringify(f.result).includes('_clarificationRecovery'), false);
  assert.equal(
    JSON.stringify(f.prepare('Новаяфамилия').snapshot.context).includes('_clarificationRecovery'),
    false,
  );
});

test('fresh opaque option IDs do not reset recovery and a repeated request keeps version and choices stable', (t) => {
  const f = fixture(t, { ambiguous: true });
  f.text('Семёнова');
  const firstIds = f.result.dialogue.options.map((row) => row.id);
  f.text('Семёнова');
  assert.notDeepEqual(
    f.result.dialogue.options.map((row) => row.id),
    firstIds,
  );
  assert.equal(f.result.dialogue.prompt, clientPrompt);
  const before = structuredClone(f.result),
    data = structuredClone(f.entry().data);
  assert.deepEqual(f.replay(), before);
  assert.deepEqual(f.entry().data, data);
  assert.deepEqual(f.replay(), before);
});

test('repeat and explicit help do not spend the semantic retry budget or hide the remaining draft', (t) => {
  const f = fixture(t),
    before = known(f);
  f.text('Редкаяфамилия');
  assert.equal(recovery(f).count, 1);
  f.text('повтори');
  f.model('помоги', clarify('client'));
  assert.equal(recovery(f).count, 1);
  f.text('Сложнаяфамилия');
  assert.equal(f.result.dialogue.prompt, clientPrompt);
  f.text('повтори');
  assert.equal(f.result.dialogue.prompt, clientPrompt);
  assert.equal((f.result.text.match(/Назовите полное имя/gu) || []).length, 1);
  assert.deepEqual(known(f), before);
});

test('explicit edit and a new command reset the counter rather than carrying old failures into a new question', (t) => {
  const f = fixture(t);
  f.text('Редкаяфамилия');
  assert.equal(recovery(f).count, 1);
  f.local({ edit: 'client' });
  assert.equal(recovery(f), undefined);
  f.text('Сложнаяфамилия');
  assert.equal(recovery(f).count, 1);
  f.start();
  assert.equal(recovery(f), undefined);
});

test('changing the actual client candidate set resets progress even if the selected fields stay the same', (t) => {
  const f = fixture(t, { ambiguous: true }),
    before = known(f);
  f.text('Семёнова');
  assert.equal(recovery(f).count, 1);
  f.patients.push({
    ...f.patients[0],
    id: 'synthetic-third-client',
    firstName: 'Мария',
    name: 'Мария Семёнова',
    phone: '+79991115566',
    appointments: [],
  });
  f.changed();
  f.text('Семёнова');
  assert.equal(recovery(f), undefined);
  assert.equal(f.result.dialogue.options.length, 3);
  assert.deepEqual(known(f), before);
  f.text('Семёнова');
  assert.equal(recovery(f).count, 1);
});

test('a real date correction resets no-progress without dropping the chosen service or manual duration', (t) => {
  const f = fixture(t),
    before = known(f);
  f.text('Редкаяфамилия');
  f.text('на завтра');
  assert.equal(recovery(f), undefined);
  assert.equal(f.entry().data.date, nextDate(day));
  assert.equal(f.entry().data.service.id, before.service);
  assert.equal(f.entry().data.duration, before.duration);
  f.text('Сложнаяфамилия');
  assert.equal(recovery(f).count, 1);
});

test('empty input, raw-proof rejection and ACL failure neither advance recovery nor corrupt rollback', (t) => {
  const f = fixture(t);
  f.text('Редкаяфамилия');
  const before = structuredClone(f.entry().data),
    version = f.result.dialogue.version;
  assert.throws(() => f.text(''), { status: 400 });
  assert.equal(f.result.dialogue.version, version);
  assert.deepEqual(f.entry().data, before);
  f.model('Обычнаяфамилия', patch({ client: 'Выдуманнаяфамилия' }));
  assert.deepEqual(f.entry().data, before);
  const unchanged = structuredClone(f.entry().data),
    currentVersion = f.result.dialogue.version;
  const assertCurrent = f.c.assertCurrent;
  f.c.assertCurrent = () => {
    throw fail(403, 'Synthetic revoked access');
  };
  assert.throws(() => f.text('Инаяфамилия'), { status: 403 });
  assert.equal(f.result.dialogue.version, currentVersion);
  assert.deepEqual(f.entry().data, unchanged);
  f.c.assertCurrent = assertCurrent;
});

test('late model answers cannot overwrite a newer recovery state', (t) => {
  const f = fixture(t);
  f.model('Редкаяфамилия', clarify('client'));
  const pending = f.prepare('Сложнаяфамилия');
  f.text('Инаяфамилия');
  const before = structuredClone(f.entry().data),
    version = f.result.dialogue.version;
  assert.throws(() => f.apply(pending, clarify('client')), { status: 409 });
  assert.deepEqual(f.entry().data, before);
  assert.equal(f.result.dialogue.version, version);
});

test('all booking roles can resolve current candidates after recovery and prepare only the ordinary form', async (t) => {
  for (const role of ['owner', 'salon_admin', 'cosmetologist'])
    await t.test(role, (t) => {
      const f = fixture(t, { ambiguous: true, role }),
        before = known(f);
      f.text('Семёнова');
      f.text('Семёнова');
      assert.equal(f.result.dialogue.prompt, clientPrompt);
      const chosen = [...f.entry().options].find(([, row]) => row.value === f.patients[0].id);
      assert.ok(chosen);
      f.local({ choice: chosen[0] });
      assert.equal(recovery(f), undefined);
      assert.equal(f.result.dialogue.step, 'review');
      f.text('открой форму');
      assert.equal(f.result.action.type, 'prepareAppointment');
      assert.equal(f.result.action.patientId, f.patients[0].id);
      assert.equal(f.result.action.date, before.date);
      assert.equal(f.result.action.time, before.time);
      assert.equal(f.result.action.duration, 45);
      f.noSave();
    });
});

test('recovery offers screen selection only when actual service candidates are available', (t) => {
  const f = fixture(t, {
    step: 'service',
    serviceQuery: 'Чистка',
    serviceNames: ['Чистка лица', 'Чистка спины'],
  });
  const before = known(f),
    candidates = choices(f);
  const catalog = [...f.entry().options.values()].filter((row) => row.value !== null);
  assert.equal(catalog.length, 2);
  assert.deepEqual(catalog.map((row) => row.value).sort(), f.services.map((row) => row.id).sort());
  f.model('Нужна такаяпроцедура', clarify('service'));
  f.model('Похожаяпроцедура', clarify('service'));
  assert.equal(f.result.dialogue.prompt, servicePrompt);
  assert.equal(f.result.text, servicePrompt);
  assert.deepEqual(choices(f), candidates);
  assert.deepEqual(known(f), before);
});

test('unsupported secondary actions do not consume semantic recovery while a real service alternative does', (t) => {
  const f = fixture(t, { step: 'service' }),
    before = known(f);
  f.text('Редкаяпроцедура');
  assert.equal(recovery(f).count, 1);
  f.model('Выбери Чистка и отправь клиенту сообщение', patch({ service: 'Чистка' }));
  assert.equal(recovery(f).count, 1);
  assert.deepEqual(known(f), before);
  f.model('Нужна Чистка или массаж', patch({ service: 'Чистка' }));
  assert.equal(recovery(f).count, 2);
  assert.deepEqual(known(f), before);
  assert.equal(f.result.action, null);
});
