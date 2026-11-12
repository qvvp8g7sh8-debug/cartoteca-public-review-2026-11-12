const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const corpus = require("./fixtures/assistant-names-120.json");
const {
  nameSuggestionPlan,
  rankNameSuggestions,
  SUGGESTION_LIMITS,
} = require("../src/server/modules/assistant/language/names/name-suggestions.cjs");
const {
  resolveClient,
  suggestClientMatches,
} = require("../src/server/modules/assistant/language/names/name-directory.cjs");
const {
  dialogueFixture,
  day,
} = require("./helpers/assistant-dialogue-fixture.cjs");
const patient = (id, firstName, lastName, middleName = "") => ({
  id,
  firstName,
  lastName,
  middleName,
  name: [firstName, middleName, lastName].filter(Boolean).join(" "),
  phone: "",
  appointments: [],
  visits: [],
  createdBy: "staff-a",
});
const corpusRows = () =>
  corpus.clients.map((row, index) =>
    patient(
      "corpus-" + (index + 1),
      row.firstName,
      row.lastName,
      row.middleName,
    ),
  );
const ranked = (rows, query) =>
  rankNameSuggestions(rows, nameSuggestionPlan(query)).map((row) => row.id);
function memoryFixture(rows, role = "owner", accountId = "staff-a") {
  const actor = {
      role,
      accountId,
      organizationId: "synthetic-org",
      sessionId: "synthetic-session",
    },
    calls = { transactions: 0, decoded: 0 };
  const storage = {
    filename: "synthetic-spoken-" + randomUUID(),
    get: () => 1,
    encode: (value) => Buffer.from(JSON.stringify(value)),
    decode(value) {
      calls.decoded++;
      return JSON.parse(value.toString());
    },
    read() {
      assert.fail("No clinical/global storage read");
    },
    readPatient() {
      assert.fail("No clinical record read");
    },
    transaction(fn, mode) {
      assert.equal(mode, "DEFERRED");
      calls.transactions++;
      return fn();
    },
    indexes: {
      summaryRows(current, ids) {
        return rows
          .filter(
            (row) =>
              (!ids || ids.includes(row.id)) &&
              (current.role !== "cosmetologist" ||
                row.createdBy === current.accountId),
          )
          .map((row) => ({
            patient_id: row.id,
            value: Buffer.from(JSON.stringify(row)),
          }));
      },
    },
  };
  const c = {
    current: actor,
    assertCurrent() {},
    tenantStore(org) {
      assert.equal(org, actor.organizationId);
      return storage;
    },
    platform: { organizationTimeZone: () => "Europe/Moscow" },
  };
  return { c, calls };
}

test("strong spoken surname distortion resolves only the known given name within the synthetic120 corpus in both FIO orders", () => {
  const rows = corpusRows(),
    before = JSON.stringify(rows);
  for (const query of [
    "Артема Макартичана",
    "Макартичана Артема",
    "АртемаМакартичана",
  ]) {
    assert.deepEqual(ranked(rows, query), ["corpus-118"], query);
    const f = memoryFixture(rows);
    assert.equal(resolveClient(f.c, query).matches.length, 0);
    assert.deepEqual(
      suggestClientMatches(f.c, query).matches.map((row) => row.id),
      ["corpus-118"],
      query,
    );
    assert.ok(f.calls.transactions <= 2 * SUGGESTION_LIMITS.queries);
  }
  assert.equal(JSON.stringify(rows), before);
});

test("the phonetic path handles consonant clusters and voicing generically while retaining complete-name assignment", () => {
  const rows = [
    patient("armenian", "Артём", "Мкртчян"),
    patient("polish", "Николай", "Стржельчик"),
    patient("voiced", "Павел", "Бргздан"),
  ];
  for (const [query, id] of [
    ["Артема Макартичана", "armenian"],
    ["Колю Сатаражельчика", "polish"],
    ["Павла Параказдана", "voiced"],
  ])
    assert.deepEqual(ranked(rows, query), [id], query);
  assert.deepEqual(ranked(rows, "Артема Артема Макартичана"), []);
});

test("a phonetic surname alone, wrong or misspelled given name, short skeleton, and unrelated surname cannot broaden identity", () => {
  const row = patient("target", "Артём", "Мкртычян");
  for (const query of [
    "Макартичана",
    "Артура Макартичана",
    "Артен Макартичана",
    "Жанну Макартичана",
    "Артема Макарова",
    "не Артема Макартичана",
    "если Артема Макартичана",
    "запиши Артема Макартичана",
  ])
    assert.deepEqual(ranked([row], query), [], query);
  assert.deepEqual(
    ranked([patient("short", "Анна", "Крлин")], "Анну Каралину"),
    [],
  );
});

test("ordinary exact and edit matches rank ahead of the stronger spoken fallback and literal names are not rewritten", () => {
  const rows = [
      patient("spoken", "Артём", "Мкртычян"),
      patient("literal", "Артём", "Макартичана"),
    ],
    before = JSON.stringify(rows);
  assert.deepEqual(ranked(rows, "Артема Макартичана"), ["literal", "spoken"]);
  const f = memoryFixture(rows);
  assert.deepEqual(
    resolveClient(f.c, "Артема Макартичана").matches.map((row) => row.id),
    ["literal"],
  );
  assert.equal(JSON.stringify(rows), before);
});

test("bounded surname anchors recover candidates even when the matching given-name page overflows", () => {
  const rows = [
    patient("target", "Артём", "Мкртычян"),
    ...Array.from({ length: 51 }, (_, i) =>
      patient(
        "other-" + i,
        "Артём",
        "Тестовая" + String.fromCharCode(1040 + (i % 32)),
      ),
    ),
  ];
  const f = memoryFixture(rows),
    result = suggestClientMatches(f.c, "Артема Макартичана");
  assert.deepEqual(
    result.matches.map((row) => row.id),
    ["target"],
  );
  assert.equal(result.overflow, true);
  assert.ok(f.calls.transactions <= SUGGESTION_LIMITS.queries);
});

test("phonetic lookup respects every role and an employee never sees a colleague candidate", () => {
  for (const role of ["owner", "salon_admin", "cosmetologist"]) {
    const rows = corpusRows(),
      f = memoryFixture(rows, role);
    assert.deepEqual(
      suggestClientMatches(f.c, "Артема Макартичана").matches.map(
        (row) => row.id,
      ),
      ["corpus-118"],
      role,
    );
  }
  const rows = [patient("hidden", "Артём", "Мкртычян")];
  rows[0].createdBy = "foreign";
  assert.deepEqual(
    suggestClientMatches(
      memoryFixture(rows, "cosmetologist").c,
      "Артема Макартичана",
    ).matches,
    [],
  );
});

function dialogue(count = 1, role = "owner") {
  const f = dialogueFixture({ role });
  if (role === "cosmetologist") f.members[0].role = role;
  f.patients.splice(
    0,
    f.patients.length,
    ...Array.from({ length: count }, (_, i) => ({
      ...patient("spoken-" + i, "Артём", i % 2 ? "Мкртчян" : "Мкртычян"),
      createdBy: "owner",
    })),
  );
  f.changed();
  f.start({
    query: "Артема Макартичана",
    serviceQuery: "Чистка",
    date: day,
    time: "12:30",
    duration: 30,
  });
  return f;
}
const entry = (f) => f.flow.get(f.c, f.member, f.state, f.result.dialogue.id);

test("one spoken candidate requires explicit confirmation in each role before a manual form and preserves the original draft", () => {
  for (const role of ["owner", "salon_admin", "cosmetologist"]) {
    const f = dialogue(1, role);
    assert.equal(f.result.dialogue.step, "client");
    assert.equal(f.result.dialogue.options.length, 1);
    assert.equal(f.result.action, null);
    assert.equal(entry(f).data.patient, null);
    assert.equal(entry(f).data.clientQuery, "Артема Макартичана");
    const result = f.answer({ text: "да" }).result;
    assert.equal(result.dialogue.step, "review");
    assert.equal(entry(f).data.patient.confirmedSuggestion, true);
    const ready = f.answer({ text: "открой форму" }).result;
    assert.equal(ready.action.patientId, "spoken-0");
    assert.equal(ready.action.time, "12:30");
    assert.equal(ready.action.date, day);
    assert.equal(ready.action.duration, 30);
    assert.ok(f.patients.every((row) => row.appointments.length === 0));
  }
});

test("multiple spoken candidates do not choose the first on yes and more than five remain explicitly incomplete", () => {
  const f = dialogue(2);
  assert.equal(f.result.dialogue.options.length, 2);
  f.answer({ text: "да" });
  assert.equal(entry(f).data.patient, null);
  assert.equal(f.result.action, null);
  const second = f.result.dialogue.options[1].id,
    target = entry(f).options.get(second).value;
  f.answer({ choice: second });
  assert.equal(entry(f).data.patient.id, target);
  const many = dialogue(7),
    result = suggestClientMatches(many.c, "Артема Макартичана");
  assert.equal(result.matches.length, 5);
  assert.equal(result.overflow, true);
  assert.ok(f.patients.every((row) => row.appointments.length === 0));
});

test("a revoked spoken candidate and its replayed choice cannot bypass the existing fresh ACL check", () => {
  const f = dialogue(1, "cosmetologist"),
    choice = f.result.dialogue.options[0]?.id;
  assert.ok(choice);
  f.patients[0].createdBy = "foreign";
  f.changed();
  assert.deepEqual(suggestClientMatches(f.c, "Артема Макартичана").matches, []);
  assert.throws(() => f.answer({ choice }), { status: 409 });
  assert.equal(entry(f).data.patient, null);
  assert.ok(f.patients.every((row) => row.appointments.length === 0));
});
