const test = require('node:test');
const assert = require('node:assert/strict');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
function fixture(t, { role = 'owner', empty = false } = {}) {
  const f = dialogueFixture({ role });
  if (role === 'cosmetologist') f.members[0].role = role;
  f.services.splice(
    0,
    f.services.length,
    ...(empty ? [] : [{ id: 's', name: 'Миндальный пилинг', duration: 30, staffId: 'owner' }]),
  );
  f.changed();
  const store = f.c.tenantStore('org');
  let writes = 0;
  for (const key of ['save', 'write'])
    store[key] = () => {
      writes++;
      throw Error('Forbidden appointment save');
    };
  f.start({
    query: 'Анна Семёнова',
    serviceQuery: 'миндалный пилинг',
    date: day,
    time: '10:00',
    duration: 45,
  });
  let last = f.answer({ text: 'повтори' });
  const entry = () => f.flow.get(f.c, f.member, f.state, last.result.dialogue.id);
  const replay = () => f.flow.continueDialogue(f.c, last.body, f.state, f.member, f.clock);
  const text = (value) => {
    last = f.answer({ text: value });
    return last.result;
  };
  t.after(() => {
    assert.equal(writes, 0);
    assert.ok(f.patients.every((row) => row.appointments.length === 0));
  });
  return {
    f,
    entry,
    replay,
    text,
    get result() {
      return last.result;
    },
  };
}
const known = (entry) => ({
  patient: entry.data.patient.id,
  staff: entry.data.staff.id,
  date: entry.data.date,
  time: entry.data.time,
  duration: entry.data.duration,
  durationSource: entry.data.durationSource,
});
function assertOldChoiceRejected(s, result, oldId) {
  assert.throws(
    () =>
      s.f.flow.continueDialogue(
        s.f.c,
        {
          policyVersion: s.f.state.revision,
          dialogueId: result.dialogue.id,
          dialogueVersion: result.dialogue.version,
          choice: oldId,
        },
        s.f.state,
        s.f.member,
        s.f.clock,
      ),
    { status: 409 },
  );
}

test('unchanged pending-service replay preserves version, opaque IDs and private recovery for every booking role', async (t) => {
  for (const role of ['owner', 'salon_admin', 'cosmetologist'])
    await t.test(role, (t) => {
      const s = fixture(t, { role });
      const before = structuredClone(s.result);
      const data = structuredClone(s.entry().data);
      assert.deepEqual(s.replay(), before);
      assert.deepEqual(s.replay(), before);
      assert.deepEqual(s.entry().data, data);
    });
});

for (const change of ['rename', 'duration', 'removal'])
  test('same frozen request refreshes ' + change + ' of a pending approximate service', (t) => {
    const s = fixture(t),
      before = known(s.entry()),
      version = s.result.dialogue.version,
      oldId = s.result.dialogue.options[0].id;
    if (change === 'rename') s.f.services[0].name = 'Совсем другая процедура';
    else if (change === 'duration') s.f.services[0].duration = 60;
    else s.f.services.splice(0);
    s.f.changed();
    const result = s.replay();
    assert.equal(result.dialogue.version, version + 1);
    assert.equal(result.dialogue.step, 'service');
    assert.equal(result.action, null);
    assert.deepEqual(known(s.entry()), before);
    if (change === 'duration') assert.match(result.dialogue.options[0].label, /60 мин/);
    else {
      assert.equal(result.dialogue.options.length, 0);
      assert.doesNotMatch(result.dialogue.prompt, /Миндальный/);
    }
    assertOldChoiceRejected(s, result, oldId);
    assert.deepEqual(s.replay(), result);
  });

for (const strict of [false, true])
  test(
    'zero-option replay discovers a new ' +
      (strict ? 'strict' : 'approximate') +
      ' catalog service without selecting it',
    (t) => {
      const s = fixture(t, { empty: true }),
        before = known(s.entry()),
        version = s.result.dialogue.version;
      assert.equal(s.result.dialogue.options.length, 0);
      s.f.services.push({
        id: 'new',
        name: strict ? 'Миндалный пилинг' : 'Миндальный пилинг',
        duration: 30,
        staffId: 'owner',
      });
      s.f.changed();
      const result = s.replay();
      assert.equal(result.dialogue.version, version + 1);
      assert.equal(result.dialogue.options.length, 1);
      assert.match(result.dialogue.options[0].label, strict ? /Миндалный/ : /Миндальный/);
      assert.equal(s.entry().data.serviceChosen, false);
      assert.equal(s.entry().data.service, null);
      assert.deepEqual(known(s.entry()), before);
      assert.equal(result.action, null);
      assert.deepEqual(s.replay(), result);
    },
  );

test('service replay neither spends recovery again nor retains recovery tied to an obsolete candidate stamp', (t) => {
  const s = fixture(t);
  s.text('миндалный пилинг');
  s.text('миндалный пилинг');
  const data = structuredClone(s.entry().data),
    before = structuredClone(s.result);
  assert.equal(data._clarificationRecovery.count, 2);
  assert.deepEqual(s.replay(), before);
  assert.deepEqual(s.entry().data, data);
  s.f.services[0].duration = 60;
  s.f.changed();
  const result = s.replay();
  assert.equal(result.dialogue.version, before.dialogue.version + 1);
  assert.match(result.dialogue.options[0].label, /60 мин/);
  assert.equal(s.entry().data._clarificationRecovery, undefined);
  assert.equal(JSON.stringify(result).includes('_clarificationRecovery'), false);
  assert.deepEqual(s.replay(), result);
});
