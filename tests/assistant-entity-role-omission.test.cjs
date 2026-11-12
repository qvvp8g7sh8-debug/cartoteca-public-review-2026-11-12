const test = require('node:test');
const assert = require('node:assert/strict');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const role = require('../src/server/modules/assistant/dialogue/continuation/continuation-entity-completeness.cjs');
const {
  continuationExample,
} = require('../src/server/modules/assistant/dialogue/continuation/continuation-contract.cjs');
const empty = { client: null, staff: null, service: null, date: null, time: null, duration: null };
const inspect = (...args) =>
  role.entityRoleOmissions
    ? role.entityRoleOmissions(...args)
    : { omitted: role.omittedEntityRoles(...args), ambiguous: [] };
const data = {
  patient: { id: 'p', label: 'Никита Соколов' },
  clientQuery: 'Никита Соколов',
  staff: { id: 's', label: 'Нина Ветрова' },
  staffQuery: 'Нина Ветрова',
  service: { id: 'v', label: 'Люменконтур' },
  serviceQuery: 'Люменконтур',
};
for (const [field, noun, known, other] of [
  ['client', 'клиента', 'Никита Соколов', 'Ольги'],
  ['staff', 'специалиста', 'Нина Ветрова', 'Павла'],
  ['service', 'услуги', 'Люменконтур', 'Векторин'],
]) {
  test('nonassignment modifier cannot silently omit the selected ' + field, () => {
    const text =
      field === 'service'
        ? `На сегодня; речь про услугу ${other}`
        : `На сегодня для ${noun} ${other}`;
    const result = inspect(text, empty, new Set(), data);
    assert.deepEqual(result.omitted, []);
    assert.deepEqual(result.ambiguous, [field]);
    assert.deepEqual(role.omittedEntityRoles(text, empty, new Set(), data), []);
  });
  test('an explicit omitted assignment remains unresolved for ' + field, () => {
    const label = field === 'service' ? 'услуга' : noun;
    const result = inspect(`${label} ${other}`, empty, new Set(), data);
    assert.deepEqual(result.omitted, [field]);
    assert.deepEqual(result.ambiguous, []);
    const same = inspect(`${label} ${known}`, empty, new Set(), data);
    assert.deepEqual(same.omitted, []);
    assert.deepEqual(same.ambiguous, []);
  });
}

test('questions about roles do not authorize omissions or edits', () => {
  for (const text of ['Какого клиента?', 'Какого специалиста?', 'Какую услугу?']) {
    const result = inspect(text, empty, new Set(), data);
    assert.deepEqual(result, { omitted: [], ambiguous: [] });
  }
});

function stateful() {
  const f = dialogueFixture();
  const initial = f.start({
    query: 'Анна Семёнова',
    serviceQuery: 'Чистка',
    time: '11:00',
    duration: 30,
  });
  assert.equal(initial.dialogue.step, 'date');
  const entry = () => f.flow.get(f.c, f.member, f.state, initial.dialogue.id);
  const apply = (text, proposal) => {
    const body = { dialogueId: initial.dialogue.id, dialogueVersion: entry().version, text };
    const snapshot = f.flow.prepareModelTurn(f.c, body, f.state, f.member, f.clock);
    assert.ok(
      snapshot,
      'a nonlocal mixed answer must be interpreted without losing its current owner',
    );
    return f.flow.applyModelTurn(
      f.c,
      body,
      f.state,
      f.member,
      f.clock,
      continuationExample(proposal),
      snapshot,
    );
  };
  return { f, entry, apply };
}
for (const [field, modifier] of [
  ['client', 'для клиента Ольги'],
  ['staff', 'для специалиста Павла'],
  ['service', 'для услуги Векторин'],
]) {
  test(
    'actual dialogue preserves known ' + field + ' and grounded date while asking about a modifier',
    () => {
      const { f, entry, apply } = stateful();
      const before = structuredClone(entry().data),
        patients = JSON.stringify(f.patients);
      const result = apply('На сегодня ' + modifier, { operation: 'patch', fields: { date: day } });
      assert.equal(entry().data.patient.id, before.patient.id);
      assert.equal(entry().data.staff.id, before.staff.id);
      assert.equal(entry().data.service.id, before.service.id);
      assert.equal(entry().data.date, day, 'independently grounded temporal edit is retained');
      assert.equal(result.action, null, 'ambiguous modifier must not auto-finish');
      assert.ok(result.dialogue);
      assert.equal(JSON.stringify(f.patients), patients);
    },
  );
}

test('actual explicit omitted client assignment does not reuse the old selected person', () => {
  const { entry, apply } = stateful();
  const result = apply('Клиента Ольги на сегодня', { operation: 'patch', fields: { date: day } });
  assert.equal(entry().data.patient, null);
  assert.equal(result.action, null);
  assert.equal(result.dialogue.step, 'client');
});

test('actual questions about a known role leave all selected values unchanged', () => {
  const { entry, apply } = stateful();
  const before = structuredClone(entry().data);
  const result = apply('Какого клиента?', { operation: 'clarify', field: 'client' });
  assert.deepEqual(entry().data, before);
  assert.equal(result.action, null);
  assert.ok(result.dialogue);
});
