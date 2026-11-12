const test = require('node:test');
const assert = require('node:assert/strict');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const { resolveClient } = require('../src/server/modules/assistant/language/names/name-directory.cjs');
const { directoryPage } = require('../src/server/modules/cabinet/directory.cjs');
const { createDialogueStore } = require('../src/server/modules/assistant/dialogue/dialogue-store.cjs');
const { createClientCardFlow } = require('../src/server/modules/assistant/actions/client-card-flow.cjs');
function person(id, firstName = 'Алексей', lastName = 'Иванов', middleName = '') {
  return { id, firstName, lastName, middleName,
    name: [firstName, middleName, lastName].filter(Boolean).join(' '),
    phone: '', createdBy: 'owner', appointments: [] };
}
function fixture({ count = 50, copies = 1, role = 'owner', first = 'Алексей', last = 'Иванов', middle = '', lastRow = false } = {}) {
  const f = dialogueFixture({ role });
  if (role === 'cosmetologist') f.members[0].role = role;
  if (role === 'salon_admin') f.c.current.accountId = 'synthetic-salon-admin';
  const given = ['Анна', 'Мария', 'Дмитрий', 'Вера', 'Елена', 'Павел'];
  const surnames = ['Петров', 'Соколов', 'Морозов', 'Кузнецов', 'Орлов', 'Фролов'];
  const targets = Array.from({ length: copies }, (_, i) => ({
    ...person('target-' + i, first, last, middle), phone: '+7999' + String(i).padStart(7, '0'),
  }));
  const fillers = Array.from({ length: count }, (_, i) => [
    person('same-given-' + i, first, surnames[i % surnames.length]),
    person('same-surname-' + i, given[i % given.length], last),
  ]).flat();
  f.patients.splice(0, f.patients.length, ...(lastRow ? [...fillers, ...targets] : [...targets, ...fillers]));
  f.changed();
  const storage = f.c.tenantStore('org'), summaryRows = storage.indexes.summaryRows;
  let reads = 0;
  storage.indexes.summaryRows = (...args) => { reads++; return summaryRows(...args); };
  return Object.assign(f, { storage, targets, reads: () => reads,
    clinical: () => JSON.stringify([f.patients, f.services, f.busy]) });
}
function booking(f, query = 'Алексей Иванов') {
  return f.flow.start(f.c, { intent: 'prepareAppointment', query, serviceQuery: 'Чистка',
    date: day, time: '12:00' }, f.state, f.member, f.clock,
  f.flow.beginCommand(f.c, f.member, f.state), { openWhenComplete: true });
}
function answer(f, reply, operation) {
  return f.flow.continueDialogue(f.c, { dialogueId: reply.dialogue.id,
    dialogueVersion: reply.dialogue.version, ...operation }, f.state, f.member, f.clock);
}
function ready(reply, id = 'target-0') {
  assert.equal(reply.dialogue, null);
  assert.equal(reply.action?.type, 'prepareAppointment');
  assert.equal(reply.action.patientId, id);
  assert.equal(reply.action.staffId, 'owner');
  assert.equal(reply.action.date, day);
  assert.equal(reply.action.time, '12:00');
  assert.equal(reply.action.duration, 30);
  assert.deepEqual(reply.action.serviceIds, ['clean']);
}
for (const query of ['Алексей Иванов', 'Иванов Алексей', 'Алексея Иванова', 'Иванову Алексею']) {
  test('whole-name correlation resolves a unique common FIO without changing strict identity: ' + query, () => {
    const f = fixture(), before = f.clinical(), result = resolveClient(f.c, query);
    assert.equal(result.overflow, false);
    assert.deepEqual(result.matches.map(row => row.id), ['target-0']);
    assert.ok(f.reads() > 0 && f.reads() <= 8, 'Candidate reads stay bounded');
    assert.equal(f.clinical(), before);
  });
}
for (const query of ['Алексей Петрович Иванов', 'Иванова Алексея Петровича', 'Алексею Иванову Петровичу']) {
  test('a third complete source component remains a mandatory constraint: ' + query, () => {
    const f = fixture({ middle: 'Петрович' }), before = f.clinical();
    assert.deepEqual(resolveClient(f.c, query).matches.map(row => row.id), ['target-0']);
    assert.deepEqual(resolveClient(f.c, 'Алексей Сергеевич Иванов').matches, []);
    assert.equal(f.clinical(), before);
  });
}
for (const query of ['Алёна Ковалёва', 'Алена Ковалева', 'Ковалёву Алёну']) {
  test('correlation preserves existing complete е/ё and case aliases: ' + query, () => {
    const f = fixture({ first: 'Алёна', last: 'Ковалёва' }), before = f.clinical();
    const result = resolveClient(f.c, query);
    assert.equal(result.overflow, false);
    assert.deepEqual(result.matches.map(row => row.id), ['target-0']);
    assert.equal(f.targets[0].firstName, 'Алёна');
    assert.equal(f.targets[0].lastName, 'Ковалёва');
    assert.equal(f.clinical(), before);
  });
}
for (const count of [49, 50, 75]) {
  test('component-only crowding cannot hide a unique complete FIO at cohort size ' + count, () => {
    const f = fixture({ count, lastRow: true }), before = f.clinical();
    ready(booking(f));
    assert.equal(f.clinical(), before, 'Preparing the form is not a clinical save');
  });
}
for (const role of ['owner', 'salon_admin', 'cosmetologist']) {
  test(role + ' keeps complete booking fields and its own staff scope after correlated retrieval', () => {
    const f = fixture({ role }), before = f.clinical();
    ready(booking(f));
    assert.equal(f.clinical(), before);
  });
}
test('card opening shares strict correlated retrieval and keeps its read-only action target', () => {
  const f = fixture(), before = f.clinical(), memory = createDialogueStore();
  f.state.policy.commands.clients = true;
  const flow = createClientCardFlow({ memory });
  const reply = flow.start(f.c, { intent: 'clientCard', query: 'Алексея Иванова' },
    f.state, f.member, f.clock, memory.beginCommand(f.c, f.member, f.state),
    'Открой карточку Алексея Иванова');
  assert.equal(reply.dialogue, null);
  assert.deepEqual(reply.action, { type: 'clientCard', patientId: 'target-0' });
  assert.equal(f.clinical(), before);
});
test('two exact common-name cards remain ambiguous until a current explicit identity choice', () => {
  const f = fixture({ copies: 2 }), before = f.clinical(), reply = booking(f);
  assert.equal(reply.action, null);
  assert.equal(reply.dialogue.step, 'client');
  assert.equal(reply.dialogue.options.length, 2);
  const entry = f.flow.get(f.c, f.member, f.state, reply.dialogue.id);
  assert.deepEqual(new Set([...entry.options.values()].map(row => row.value)), new Set(['target-0', 'target-1']));
  const fields = new Map(reply.dialogue.fields.map(row => [row.key, row.value]));
  assert.equal(fields.get('date'), day);
  assert.equal(fields.get('time'), '12:00');
  assert.equal(fields.get('service'), 'Чистка');
  const choice = [...entry.options].find(([, row]) => row.value === 'target-1')[0];
  ready(answer(f, reply, { choice }), 'target-1');
  assert.equal(f.clinical(), before);
});
for (const copies of [50, 51]) {
  test('the correlated complete-name candidate cap is not truncated or weakened at ' + copies, () => {
    const f = fixture({ copies }), before = f.clinical(), result = resolveClient(f.c, 'Алексей Иванов');
    assert.equal(result.overflow, copies > 50);
    assert.equal(result.matches.length, copies <= 50 ? copies : 0);
    assert.equal(f.clinical(), before);
  });
}
test('public directory matching and its page limit are unchanged by private correlation', () => {
  const f = fixture(), before = f.clinical();
  const url = new URL('http://synthetic.invalid/?q=' + encodeURIComponent('Иванов') + '&limit=50');
  const page = directoryPage(f.storage, f.c.current, url);
  assert.equal(page.matched, 51);
  assert.equal(page.directory.length, 50);
  assert.ok(page.nextCursor);
  assert.deepEqual(resolveClient(f.c, 'Алексей Иванов').matches.map(row => row.id), ['target-0']);
  assert.equal(f.clinical(), before);
});
test('an inaccessible exact target is not leaked or selected from a staff-scoped directory', () => {
  const f = fixture({ role: 'cosmetologist' });
  f.targets[0].createdBy = 'other-staff';
  f.changed();
  const before = f.clinical();
  assert.ok(resolveClient(f.c, 'Алексей Иванов').matches.every(row => row.id !== 'target-0'));
  const reply = booking(f);
  assert.equal(reply.action, null);
  assert.equal(f.clinical(), before);
  f.targets[0].createdBy = 'owner';
  f.changed();
  assert.deepEqual(resolveClient(f.c, 'Алексей Иванов').matches.map(row => row.id), ['target-0']);
});
test('current membership is required before returning correlated candidate rows', () => {
  const f = fixture();
  f.c.assertCurrent = () => { throw Object.assign(Error('Synthetic revoked membership'), { status: 403 }); };
  assert.throws(() => resolveClient(f.c, 'Алексей Иванов'), error => error.status === 403);
  assert.equal(f.reads(), 0);
});
test('a global administrator cannot acquire clinical identities through the private lookup', () => {
  const f = fixture();
  f.c.current.globalAdmin = true;
  assert.throws(() => resolveClient(f.c, 'Алексей Иванов'), error => error.status === 403);
  assert.equal(f.reads(), 0);
});
test('membership lost while authoritative rows are read is checked again before returning', () => {
  const f = fixture(), summary = f.storage.indexes.summaryRows;
  let revoked = false;
  f.c.assertCurrent = () => { if (revoked) throw Object.assign(Error('Synthetic revoked membership'), { status: 403 }); };
  f.storage.indexes.summaryRows = (...args) => { const rows = summary(...args); revoked = true; return rows; };
  assert.throws(() => resolveClient(f.c, 'Алексей Иванов'), error => error.status === 403);
});
test('a changed account/role identity cannot be returned under the original candidate scope', () => {
  const f = fixture(), summary = f.storage.indexes.summaryRows;
  f.storage.indexes.summaryRows = (...args) => {
    const rows = summary(...args);
    f.c.current = { ...f.c.current, accountId: 'different-account' };
    return rows;
  };
  assert.throws(() => resolveClient(f.c, 'Алексей Иванов'), error => [403, 409].includes(error.status));
});
test('an observed cabinet revision change during row acquisition cannot deliver a mixed snapshot', () => {
  const f = fixture(), summary = f.storage.indexes.summaryRows;
  f.storage.indexes.summaryRows = (...args) => { const rows = summary(...args); f.changed(); return rows; };
  assert.throws(() => resolveClient(f.c, 'Алексей Иванов'), error => error.status === 409);
});
test('a warm correlated directory drops renamed identities and sees the replacement at the last row', () => {
  const f = fixture({ lastRow: true });
  assert.deepEqual(resolveClient(f.c, 'Алексей Иванов').matches.map(row => row.id), ['target-0']);
  f.targets[0].firstName = 'Павел'; f.targets[0].name = 'Павел Иванов';
  f.changed();
  assert.deepEqual(resolveClient(f.c, 'Алексей Иванов').matches, []);
  f.patients.push(person('replacement'));
  f.changed();
  assert.deepEqual(resolveClient(f.c, 'Алексей Иванов').matches.map(row => row.id), ['replacement']);
});
test('reopening the same path with a new connection/key identity cannot reuse old decoded matches', () => {
  const f = fixture();
  assert.deepEqual(resolveClient(f.c, 'Алексей Иванов').matches.map(row => row.id), ['target-0']);
  f.targets[0].id = 'fresh-connection-target';
  const reopened = { ...f.storage, encode: value => Buffer.from(JSON.stringify(value)) };
  f.c.tenantStore = () => reopened;
  assert.deepEqual(resolveClient(f.c, 'Алексей Иванов').matches.map(row => row.id), ['fresh-connection-target']);
});
test('a stale identity choice remains invalid after its correlated target is renamed', () => {
  const f = fixture({ copies: 2 }), reply = booking(f);
  assert.equal(reply.dialogue.options.length, 2);
  const entry = f.flow.get(f.c, f.member, f.state, reply.dialogue.id);
  const choice = [...entry.options].find(([, row]) => row.value === 'target-0')[0];
  f.targets[0].firstName = 'Павел'; f.targets[0].name = 'Павел Иванов';
  f.changed();
  const before = f.clinical();
  assert.throws(() => answer(f, reply, { choice }), error => error.status === 409);
  assert.equal(f.clinical(), before);
});
test('partial, duplicate-token, misspelled and conflicting complete components never become strict identities', () => {
  const f = fixture(), before = f.clinical();
  for (const query of ['Алексей Ива', 'Алексей Алексей', 'Алексев Иванов', 'Алексей Сергеевич Иванов'])
    assert.deepEqual(resolveClient(f.c, query).matches, [], query);
  assert.equal(f.clinical(), before);
});


test('bounded family packing retains a literal prefix for every original case and ё query', () => {
  const { correlatedNamePlan } = require('../src/server/modules/assistant/language/names/name-correlated-directory.cjs');
  const { searchPlan, LIMITS } = require('../src/server/modules/assistant/language/names/name-matching.cjs');
  for (const query of ['Алексей Иванов', 'Алексея Иванова', 'Алёна Ковалёва',
    'Ковалёву Алёну', 'Алексей Петрович Иванов', 'Иванову Алексею Петровичу']) {
    const plan = correlatedNamePlan(query);
    assert.ok(plan, query);
    assert.ok(plan.queries.length <= LIMITS.queries);
    assert.equal(plan.families.length, plan.words.length);
    for (const [index, word] of plan.words.entries()) {
      const original = searchPlan(word);
      assert.equal(original.overflow, false);
      for (const alias of original.queries)
        assert.ok(plan.families[index].some(prefix => alias.startsWith(prefix)), query + ': ' + alias);
    }
  }
});
