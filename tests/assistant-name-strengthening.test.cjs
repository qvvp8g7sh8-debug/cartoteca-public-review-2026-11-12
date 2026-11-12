const test = require('node:test');
const assert = require('node:assert/strict');
const {
  nameSuggestionPlan,
  rankNameSuggestions,
  SUGGESTION_LIMITS,
} = require('../src/server/modules/assistant/language/names/name-suggestions.cjs');
const {
  resolveClient,
  suggestClientMatches,
} = require('../src/server/modules/assistant/language/names/name-directory.cjs');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const person = (id, firstName, lastName, middleName = '') => ({
  id,
  firstName,
  lastName,
  middleName,
  name: [firstName, middleName, lastName].filter(Boolean).join(' '),
  phone: '',
  createdBy: 'owner',
  appointments: [],
});
const rank = (rows, raw) => rankNameSuggestions(rows, nameSuggestionPlan(raw)).map((row) => row.id);
const wanted = () => person('wanted', 'Гульнара', 'Мухамедянова', 'Петровна');

test('one adjacent letter swap uses one existing typo budget without admitting short names or two independent swaps', () => {
  assert.deepEqual(rank([person('surname', 'Анна', 'Левина')], 'Анна Левниа'), ['surname']);
  assert.deepEqual(rank([person('first', 'Аделина', 'Соколова')], 'Адлеина Соколова'), ['first']);
  assert.deepEqual(rank([person('short', 'Иван', 'Левина')], 'Ивна Левина'), []);
  assert.deepEqual(rank([person('twice', 'Анна', 'Левина')], 'Анна Елвниа'), []);
});

test('exact complete matches remain before a transposition suggestion and stored identities are never rewritten', () => {
  const rows = [person('near', 'Анна', 'Левина'), person('literal', 'Анна', 'Левниа')],
    before = JSON.stringify(rows);
  assert.deepEqual(rank(rows, 'Анна Левниа'), ['literal', 'near']);
  assert.equal(JSON.stringify(rows), before);
});

test('joined unfamiliar first names split only by the actual candidate declared forms and the entire surname in both orders', () => {
  const rows = [
    wanted(),
    person('other-given', 'Гузель', 'Мухамедянова'),
    person('other-surname', 'Гульнара', 'Хабибуллина'),
  ];
  for (const raw of [
    'Гульнарумухомидианову',
    'Мухомидиановугульнару',
    'Гульнарамухамедянова',
    'Гульнарумухомидианову Петровну',
  ])
    assert.deepEqual(rank(rows, raw), ['wanted'], raw);
  const unlisted = [
    person('custom', 'Аделина', 'Мухамедянова'),
    person('other', 'Алёна', 'Мухамедянова'),
  ];
  for (const raw of ['Аделинумухомидианову', 'Мухомидиановуаделину'])
    assert.deepEqual(rank(unlisted, raw), ['custom'], raw);
});

test('joined hypotheses never discard extra text reuse a name component or accept short partial foreign or negated identity evidence', () => {
  const rows = [wanted()];
  for (const raw of [
    'ГульноруМухомидианову',
    'ГузелюМухомидианову',
    'ГульнаруЧужинову',
    'Гульнарумуха',
    'Гульнарумухомидиановугость',
    'Гульнарумухомидианову посторонний',
    'Гульнарупетровну',
    'Гульнарумухомидианову Гульнару',
    'пригульнарумухомидианову',
    'Гульнарумухомидиановуили',
    'не Гульнарумухомидианову',
    'если Гульнарумухомидианову',
  ])
    assert.deepEqual(rank(rows, raw), [], raw);
  assert.deepEqual(rank([person('compound', 'Анна-Мария', 'Соколова')], 'Аннасоколова'), []);
});

test('an exact candidate first name remains mandatory for the strong phonetic surname path even when one first-name transposition fits plain distance', () => {
  const rows = [person('unlisted', 'Аделина', 'Мухамедянова')];
  assert.deepEqual(rank(rows, 'Аделину Мухомидианову'), ['unlisted']);
  for (const raw of [
    'Адлеину Мухомидианову',
    'Адлеинумухомидианову',
    'Мухомидиановуадлеину',
    'Мухомидианову',
  ])
    assert.deepEqual(rank(rows, raw), [], raw);
});

test('joined ambiguity stays confirmation-only within unchanged directory budgets and a current chosen ID controls the unsaved manual form', () => {
  const f = dialogueFixture();
  f.patients.splice(0, f.patients.length, wanted(), { ...wanted(), id: 'second' });
  assert.equal(resolveClient(f.c, 'Гульнарумухомидианову').matches.length, 0);
  const suggestions = suggestClientMatches(f.c, 'Гульнарумухомидианову');
  assert.equal(suggestions.approximate, true);
  assert.deepEqual(
    new Set(suggestions.matches.map((row) => row.id)),
    new Set(['wanted', 'second']),
  );
  assert.deepEqual(
    [
      SUGGESTION_LIMITS.queries,
      SUGGESTION_LIMITS.perQuery,
      SUGGESTION_LIMITS.candidates,
      SUGGESTION_LIMITS.results,
    ],
    [8, 50, 200, 5],
  );
  const initial = f.start({
    query: 'Гульнарумухомидианову',
    serviceQuery: 'Чистка',
    date: day,
    time: '10:00',
  });
  assert.equal(initial.dialogue.step, 'client');
  assert.equal(initial.dialogue.options.length, 2);
  assert.equal(initial.action, null);
  const declined = f.answer({ text: 'да' }).result;
  assert.equal(declined.dialogue.step, 'client');
  assert.equal(declined.action, null);
  const selected = declined.dialogue.options[1];
  const chosen = f.flow
    .get(f.c, f.member, f.state, declined.dialogue.id)
    .options.get(selected.id).value;
  const next = f.answer({ choice: selected.id }).result;
  assert.equal(next.dialogue.step, 'review');
  const ready = f.answer({ text: 'открой форму' }).result;
  assert.equal(ready.action.patientId, chosen);
  assert.ok(f.patients.every((row) => row.appointments.length === 0));
});

test('candidate-aware joined suggestions preserve employee ACL and fresh confirmation rejects a revoked selected candidate', () => {
  const f = dialogueFixture({ role: 'cosmetologist' });
  f.members[0].role = 'cosmetologist';
  f.patients.splice(0, f.patients.length, wanted(), {
    ...wanted(),
    id: 'foreign',
    createdBy: 'other-staff',
  });
  assert.deepEqual(
    suggestClientMatches(f.c, 'Гульнарумухомидианову').matches.map((row) => row.id),
    ['wanted'],
  );
  const first = f.start({
    query: 'Гульнарумухомидианову',
    serviceQuery: 'Чистка',
    date: day,
    time: '10:00',
  });
  assert.equal(first.action, null);
  assert.equal(first.dialogue.options.length, 1);
  const opaque = first.dialogue.options[0].id;
  f.patients[0].createdBy = 'other-staff';
  f.changed();
  assert.throws(() => f.answer({ choice: opaque }), { status: 409 });
  assert.ok(f.patients.every((row) => row.appointments.length === 0));
});

test('bounded OSA counts one adjacent letter transpose but never composes unrestricted swaps or enlarges numeric and length limits', () => {
  const {
    boundedNameDistance: distance,
  } = require('../src/server/modules/assistant/language/names/name-distance.cjs');
  assert.equal(distance('левина', 'левниа', 1), 1);
  assert.equal(distance('левина', 'левниа', 0), Infinity);
  assert.equal(distance('елвниа', 'левина', 1), Infinity);
  assert.equal(distance('елвниа', 'левина', 2), 2);
  assert.equal(distance('ca', 'abc', 2), Infinity);
  assert.equal(distance('ca', 'abc', 3), 3);
  assert.equal(distance('a-b', 'ab-', 1), Infinity);
  assert.equal(distance('12', '21', 1), Infinity);
  for (const [a, b, limit] of [
    ['a'.repeat(49), 'a'.repeat(49), 0],
    ['abc', 'abc', 4],
    [null, 'abc', 1],
  ])
    assert.equal(distance(a, b, limit), Infinity);
});

test('candidate-derived boundaries stop at eight whole hypotheses and never split an unstructured or oversize person query', () => {
  const {
    candidateJoinedNames,
    MAX_JOINED_HYPOTHESES,
  } = require('../src/server/modules/assistant/language/names/candidate-joined-name.cjs');
  const { descriptor } = require('../src/server/modules/assistant/language/names/name-matching.cjs');
  const row = person('bounded', 'Ли Лили Лилили Лилилили', 'Лилилилилили');
  const one = candidateJoinedNames(row, [['ли'.repeat(10)]], descriptor(row));
  assert.ok(one.length > 0 && one.length <= MAX_JOINED_HYPOTHESES);
  assert.ok(one.every((h) => h.words.length <= 4 && h.words[h.lastAt].length >= 5));
  assert.deepEqual(
    candidateJoinedNames(row, [['ли'.repeat(10)], ['ли'.repeat(11)]], descriptor(row)),
    [],
  );
  assert.deepEqual(
    candidateJoinedNames(
      { name: 'Гульнара Мухамедянова' },
      [['гульнарумухомидианову']],
      descriptor({ name: 'Гульнара Мухамедянова' }),
    ),
    [],
  );
  assert.deepEqual(
    candidateJoinedNames(
      wanted(),
      [['гульнарумухомидианову', 'петровну', 'гульнару', 'петровну']],
      descriptor(wanted()),
    ),
    [],
  );
  assert.deepEqual(
    candidateJoinedNames(wanted(), [['гульнару' + 'м'.repeat(48)]], descriptor(wanted())),
    [],
  );
});

test('real indexed retrieval covers both halves of an unfamiliar joined FIO in either order without widening matching or employee ACL', (t) => {
  const fs = require('node:fs'),
    os = require('node:os'),
    path = require('node:path'),
    { randomUUID } = require('node:crypto');
  const { createStorage } = require('../storage.cjs');
  const parent = fs.realpathSync(os.tmpdir()),
    directory = fs.mkdtempSync(path.join(parent, 'cartoteca-name-coverage-')),
    storage = createStorage(directory);
  t.after(() => {
    storage.close();
    assert.equal(path.dirname(directory), parent);
    assert.ok(path.basename(directory).startsWith('cartoteca-name-coverage-'));
    assert.equal(fs.realpathSync(directory), directory);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const gulnara = { ...person('gulnara', 'Гульнара', 'Мухамедьянова', 'Рашидовна'), visits: [] },
    adelina = { ...person('adelina', 'Аделина', 'Мухамедьянова', 'Рашидовна'), visits: [] },
    hidden = { ...gulnara, id: 'hidden', createdBy: 'other-staff' };
  storage.write({ revision: 0, services: [], patients: [gulnara, adelina, hidden] });
  const context = (role) => ({
    current: {
      role,
      accountId: 'owner',
      organizationId: 'synthetic-coverage-org',
      sessionId: randomUUID(),
    },
    assertCurrent() {},
    tenantStore() {
      return storage;
    },
    platform: { organizationTimeZone: () => 'Europe/Moscow' },
  });
  const rows = [gulnara, adelina, hidden],
    before = JSON.stringify(storage.read());
  for (const [raw, id] of [
    ['Гульнарумухомидианову', 'gulnara'],
    ['Мухомидиановугульнару', 'gulnara'],
    ['Аделинумухомидианову', 'adelina'],
    ['Мухомидиановуаделину', 'adelina'],
  ]) {
    const plan = nameSuggestionPlan(raw);
    assert.ok(plan.queries.length <= 8);
    assert.equal(resolveClient(context('owner'), raw).matches.length, 0);
    for (const role of ['owner', 'salon_admin', 'cosmetologist']) {
      const result = suggestClientMatches(context(role), raw);
      assert.equal(result.approximate, true);
      assert.deepEqual(
        new Set(result.matches.map((row) => row.id)),
        new Set(id === 'gulnara' && role !== 'cosmetologist' ? ['gulnara', 'hidden'] : [id]),
        role + ' ' + raw,
      );
    }
    assert.ok(
      plan.queries.some((query) =>
        (id === 'gulnara' ? gulnara : adelina).name.toLowerCase().includes(query),
      ),
      'At least one actual literal directory anchor must reach ' + raw,
    );
  }
  assert.equal(JSON.stringify(storage.read()), before);
  for (const raw of [
    'Мухомидиановугульнору',
    'Мухомидиановуадлеину',
    'Мухомидиановугульнарупосторонний',
  ])
    assert.deepEqual(suggestClientMatches(context('owner'), raw).matches, [], raw);
});
