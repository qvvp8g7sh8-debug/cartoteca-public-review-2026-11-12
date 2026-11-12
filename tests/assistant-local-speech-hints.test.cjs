const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const {
  localSpeechHints,
} = require('../src/server/modules/assistant/providers/local-speech/local-speech-hints.cjs');
function fixture({ role = 'owner', clients = 2 } = {}) {
  const f = dialogueFixture({ role });
  f.state.providers = { stt: { provider: 'local' } };
  f.state.policy.dictionary = 'Общий словарь без клиентов.';
  const firstNames = [
    'Анна',
    'Ольга',
    'Мария',
    'Ирина',
    'Полина',
    'Галина',
    'Елена',
    'Наталья',
    'Софья',
    'Татьяна',
    'Вера',
    'Людмила',
  ];
  const original = f.patients[0];
  f.patients.splice(
    0,
    f.patients.length,
    ...Array.from({ length: clients }, (_, index) => ({
      ...original,
      id: randomUUID(),
      firstName: firstNames[index],
      lastName: 'Семёнова',
      name: firstNames[index] + ' Семёнова',
      notes: 'CLINICAL-SENTINEL-' + index,
      phone: '+7999000000' + index,
      appointments: [],
    })),
  );
  f.changed();
  f.start({ query: 'Семёнова', serviceQuery: 'Чистка', date: day, time: '10:00', duration: 45 });
  return f;
}
const body = (f) => ({
  dialogueId: f.result.dialogue.id,
  dialogueVersion: f.result.dialogue.version,
});
const hints = (f, request = body(f)) => localSpeechHints(f.c, f.flow, request, f.state, f.member);
test('local client and fixed-step hints do not load the appointment catalog', () => {
  const f = fixture();
  const storage = f.c.tenantStore('org');
  const readServices = storage.readServices;
  let catalogReads = 0;
  storage.readServices = () => {
    catalogReads++;
    return readServices();
  };
  const entry = f.flow.get(f.c, f.member, f.state, f.result.dialogue.id);
  const reads = [];
  for (const step of ['client', 'date', 'time', 'duration', 'review']) {
    entry.step = step;
    hints(f);
    reads.push(catalogReads);
    catalogReads = 0;
  }
  assert.deepEqual(reads, [0, 0, 0, 0, 0]);
});
test('local service hints read the eligible catalog without looking up the selected client again', () => {
  const f = fixture({ clients: 1 });
  f.start({ query: 'Анна Семёнова' });
  assert.equal(f.result.dialogue.step, 'service');
  const storage = f.c.tenantStore('org');
  const summaryRows = storage.indexes.summaryRows;
  let clientReads = 0;
  storage.indexes.summaryRows = (...args) => {
    clientReads++;
    return summaryRows(...args);
  };
  f.changed();
  const prompt = hints(f);
  assert.match(prompt, /Чистка/u);
  assert.doesNotMatch(prompt, /Анна Семёнова/u);
  assert.equal(clientReads, 0);
});
test('local hints use at most eight fresh permitted summary names without IDs, phones, cards or mutations', () => {
  const f = fixture({ clients: 12 }),
    storage = f.c.tenantStore('org');
  const selected = [],
    original = storage.indexes.summaryRows;
  storage.indexes.summaryRows = (current, ids) => {
    if (ids) selected.push([...ids]);
    return original(current).filter((row) => !ids || ids.includes(row.patient_id));
  };
  storage.read = storage.readPatient = () => assert.fail('Hints may not read clinical records');
  const entry = f.flow.get(f.c, f.member, f.state, f.result.dialogue.id);
  const before = JSON.stringify({ data: entry.data, options: [...entry.options], state: f.state });
  const prompt = hints(f);
  const offered = new Set([...entry.options.values()].slice(0, 8).map((choice) => choice.value));
  assert.deepEqual(selected.map((ids) => ids.length), [8]);
  assert.deepEqual(selected[0], [...offered]);
  assert.match(prompt, /Анна Семёнова/u);
  assert.doesNotMatch(prompt, /CLINICAL-SENTINEL|7999000000/u);
  for (const patient of f.patients)
    if (!offered.has(patient.id)) assert.ok(!prompt.includes(patient.name));
  for (const patient of f.patients) assert.ok(!prompt.includes(patient.id));
  assert.equal(
    JSON.stringify({ data: entry.data, options: [...entry.options], state: f.state }),
    before,
  );
});
test('local hints exclude a private choice after a fresh employee ACL revocation', () => {
  const f = fixture({ role: 'cosmetologist' });
  f.patients[0].createdBy = 'foreign';
  f.changed();
  const prompt = hints(f);
  assert.doesNotMatch(prompt, /Анна Семёнова/u);
  assert.match(prompt, /Ольга Семёнова/u);
});
test('local dialogue metadata must be complete, current and bound to the same session and role', () => {
  for (const request of [
    { dialogueId: 'x' },
    { dialogueVersion: 0 },
    { dialogueId: 'x'.repeat(65), dialogueVersion: 0 },
    { dialogueId: 'x', dialogueVersion: -1 },
  ]) {
    const f = fixture();
    assert.throws(() => hints(f, request), { status: 400 });
  }
  for (const change of ['version', 'cancelled', 'complete', 'session', 'role']) {
    const f = fixture(),
      request = body(f);
    const entry = f.flow.get(f.c, f.member, f.state, request.dialogueId);
    if (change === 'version') request.dialogueVersion++;
    else if (change === 'session') f.c.current.sessionId = randomUUID();
    else if (change === 'role') f.c.current.role = 'salon_admin';
    else entry[change] = true;
    assert.throws(() => hints(f, request), { status: 409 }, change);
  }
});
test('Timeweb hints use only fixed server-step vocabulary without reading names or clinical data', () => {
  const f = fixture();
  f.state.providers.stt.provider = 'timeweb';
  const dictionary = f.state.policy.dictionary;
  const request = body(f),
    entry = f.flow.get(f.c, f.member, f.state, request.dialogueId);
  f.c.tenantStore = () => assert.fail('Remote hints must not read clinical storage');
  f.c.assistantReads = new Proxy({}, { get: () => assert.fail('Remote hints must not read SQL') });
  for (const key of ['data', 'options'])
    Object.defineProperty(entry, key, {
      get: () => assert.fail('Remote hints must not read ' + key),
    });
  const prompt = hints(f, request);
  assert.match(prompt, /Клиент: имя, фамилия/u);
  assert.ok(prompt.startsWith(dictionary));
  assert.doesNotMatch(prompt, /Семёнова|Анна|7999000|CLINICAL|Открой карту/u);
  entry.step = 'time';
  assert.match(hints(f, request), /Время: в девять утра/u);
  entry.step = 'date';
  assert.match(hints(f, request), /Дата: сегодня, завтра/u);
  entry.step = 'review';
  assert.match(hints(f, request), /Подтверждение:/u);
  assert.equal(f.state.policy.dictionary, dictionary);
  assert.throws(() => hints(f, { ...request, dialogueVersion: request.dialogueVersion + 1 }), {
    status: 409,
  });
  f.c.current.sessionId = randomUUID();
  assert.throws(() => hints(f, request), { status: 409 });
  f.state.providers.stt.provider = 'local';
  const initial = hints(f, {});
  assert.match(initial, /Открой карту клиента\. Открой карточку клиента\./u);
  assert.ok(initial.endsWith(dictionary));
});
test('Timeweb continuation hint is bounded and rejects incomplete metadata or revoked authority', () => {
  const f = fixture();
  f.state.providers.stt.provider = 'timeweb';
  f.state.policy.dictionary = 'а'.repeat(4000);
  assert.ok(hints(f).length <= 4000);
  assert.throws(() => hints(f, { dialogueId: 'x' }), { status: 400 });
  f.c.assertCurrent = () => {
    throw Object.assign(Error('Synthetic revoke'), { status: 403 });
  };
  assert.throws(() => hints(f), { status: 403 });
});
test('local prompt and private names stay bounded when the shared dictionary already occupies four thousand characters', () => {
  const f = fixture();
  f.state.policy.dictionary = 'а'.repeat(4000);
  const prompt = hints(f),
    localPart = prompt.slice(prompt.lastIndexOf('\n') + 1);
  assert.ok(prompt.length <= 4000);
  assert.ok(localPart.length <= 1000);
  assert.match(localPart, /Клиент|Семёнова/u);
  assert.equal(f.state.policy.dictionary.length, 4000);
});
test('date, service and review hints follow current server steps and omit unrelated identities', () => {
  const f = fixture({ clients: 1 });
  f.start({ query: 'Анна Семёнова' });
  assert.equal(f.result.dialogue.step, 'service');
  assert.match(hints(f), /Чистка/u);
  assert.doesNotMatch(hints(f), /Анна Семёнова|7999000/u);
  f.answer({ text: 'Чистка' });
  assert.equal(f.result.dialogue.step, 'date');
  assert.match(hints(f), /Дата: сегодня, завтра/u);
  f.answer({ text: day });
  f.answer({ text: '10:00' });
  assert.equal(f.result.dialogue.step, 'review');
  assert.match(hints(f), /Подтверждение: да, ага, верно/u);
  assert.doesNotMatch(hints(f), /открой форму|точное название или номер/u);
  assert.doesNotMatch(hints(f), /Анна Семёнова|7999000/u);
});
test('global administration and revoked scopes cannot obtain private local speech names', () => {
  const f = fixture();
  f.c.current.globalAdmin = true;
  assert.throws(() => hints(f), { status: 403 });
  f.c.current.globalAdmin = false;
  f.c.assertCurrent = () => {
    throw Object.assign(Error('Synthetic revoke'), { status: 403 });
  };
  assert.throws(() => hints(f), { status: 403 });
});
