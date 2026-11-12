const test = require("node:test");
const assert = require("node:assert/strict");
const {
  dialogueFixture,
  day,
} = require("./helpers/assistant-dialogue-fixture.cjs");
const { nextDate } = require("../src/shared/work-schedule.cjs");
const {
  startsAt,
} = require("../src/server/modules/notifications/appointments.cjs");
const emptyFields = {
  client: null,
  staff: null,
  service: null,
  date: null,
  time: null,
  duration: null,
};
const full = {
  query: "Анну Семенову",
  serviceQuery: "Чистка",
  date: day,
  time: "10:00",
};
function setup(
  t,
  intent = full,
  { role = "owner", ambiguous = false, initialize } = {},
) {
  const f = dialogueFixture({ role, ambiguous });
  if (role === "cosmetologist") f.members[0].role = role;
  if (initialize) initialize(f);
  const store = f.c.tenantStore("org");
  let writes = 0;
  for (const key of ["save", "write"])
    store[key] = () => {
      writes++;
      throw Error("Forbidden write");
    };
  let result = f.flow.start(
    f.c,
    { intent: "prepareAppointment", ...intent },
    f.state,
    f.member,
    f.clock,
    f.flow.beginCommand(f.c, f.member, f.state),
    { openWhenComplete: true },
  );
  let activeId = result.dialogue?.id;
  const request = (operation) => ({
    dialogueId: result.dialogue.id,
    dialogueVersion: result.dialogue.version,
    ...operation,
  });
  const use = (reply) => {
    result = reply;
    if (reply.dialogue) activeId = reply.dialogue.id;
    return reply;
  };
  t.after(() => {
    assert.equal(writes, 0);
    assert.ok(f.patients.every((row) => row.appointments.length === 0));
  });
  return {
    f,
    get result() {
      return result;
    },
    entry: () => f.flow.get(f.c, f.member, f.state, activeId),
    answer(operation) {
      return use(
        f.flow.continueDialogue(
          f.c,
          request(operation),
          f.state,
          f.member,
          f.clock,
        ),
      );
    },
    model(raw, fields = {}, { operation = "patch", field = null } = {}) {
      const body = request({ text: raw });
      const snapshot = f.flow.prepareModelTurn(
        f.c,
        body,
        f.state,
        f.member,
        f.clock,
      );
      assert.ok(snapshot);
      return use(
        f.flow.applyModelTurn(
          f.c,
          body,
          f.state,
          f.member,
          f.clock,
          {
            operation,
            fields: { ...emptyFields, ...fields },
            field,
            choice: null,
          },
          snapshot,
        ),
      );
    },
  };
}
function prepared(s, reply = s.result, time = "10:00") {
  assert.equal(reply.dialogue, null);
  assert.equal(reply.action?.type, "prepareAppointment");
  assert.equal(reply.action.patientId, s.f.patients[0].id);
  assert.equal(reply.action.time, time);
  const performer =
    s.f.c.current.role === "salon_admin" ||
    reply.action.staffId !== s.f.c.current.accountId
      ? "; специалист " +
        s.f.members.find((row) => row.accountId === reply.action.staffId)
          .displayName
      : "";
  assert.equal(
    reply.text,
    "Подготовил запись: Анна Семёнова, сегодня в " + time + performer + ".",
  );
  assert.doesNotMatch(reply.text, /сохран|записал|кнопк|проверь|форма|112233/u);
  assert.ok(s.f.patients.every((row) => row.appointments.length === 0));
}

test("whole unambiguous command executes the checked preview immediately and briefly confirms the canonical result for all three roles", async (t) => {
  for (const role of ["owner", "salon_admin", "cosmetologist"])
    await t.test(role, (t) => prepared(setup(t, full, { role })));
});
test("the last spoken local clock completes the same command without an extra ready or open-form turn", (t) => {
  const s = setup(t, { ...full, time: null });
  assert.equal(s.result.dialogue.step, "time");
  prepared(s, s.answer({ text: "в 11:30" }), "11:30");
});
test("the final model-proposed source-proven service completes the preview without review", (t) => {
  const s = setup(t, { ...full, serviceQuery: null });
  assert.equal(s.result.dialogue.step, "service");
  prepared(s, s.model("Теперь нужна услуга Чистка", { service: "Чистка" }));
});
test("approximate client still requires explicit acceptance and the result uses the canonical name rather than the recognized typo", (t) => {
  const s = setup(t, { ...full, query: "Анна Семёнофа" });
  assert.equal(s.result.action, null);
  assert.equal(s.result.dialogue.phase, "clientChoice");
  prepared(s, s.answer({ text: "да-да" }));
});
test("two real matches still require an exact current choice and keep the rest of the command", (t) => {
  const s = setup(t, { ...full, query: "Семёнова" }, { ambiguous: true });
  assert.equal(s.result.dialogue.options.length, 2);
  assert.equal(s.result.action, null);
  const fields = structuredClone(s.result.dialogue.fields);
  const clarification = s.answer({ text: "да" });
  assert.equal(clarification.dialogue.step, "client");
  assert.equal(clarification.dialogue.options.length, 2);
  assert.deepEqual(clarification.dialogue.fields, fields);
  assert.equal(s.entry().data.patient, null);
  assert.equal(s.result.action, null);
  prepared(s, s.answer({ choice: s.result.dialogue.options[0].id }));
});
test("approximate catalog service cannot execute until its explicit yes", (t) => {
  const s = setup(t, { ...full, serviceQuery: "Чисткка" });
  assert.equal(s.result.dialogue.step, "service");
  assert.equal(s.result.action, null);
  assert.match(s.result.text, /Вы имеете в виду/u);
  prepared(s, s.answer({ text: "да" }));
});
test("closed day still needs exactly the explicit authorized consent before completing the preview", (t) => {
  const s = setup(t, full, {
    initialize(f) {
      f.c.platform.workSchedules.view = () => ({ days: {}, closures: {} });
    },
  });
  assert.equal(s.result.dialogue.phase, "closedDay");
  assert.equal(s.result.action, null);
  prepared(s, s.answer({ text: "да-да" }));
});
test("a busy requested clock offers fresh ranges and waits for an explicit clock before completing a preview", (t) => {
  const s = setup(t, full, {
    initialize(f) {
      f.busy.push({
        date: day,
        time: "10:00",
        duration: 30,
        staffId: "owner",
        roomId: "main",
      });
    },
  });
  assert.equal(s.result.action, null);
  assert.equal(s.result.dialogue.phase, "period");
  const labels = ["с 09:00 до 10:00", "с 10:30 до 18:00"];
  assert.deepEqual(s.result.dialogue.options.map(row => row.label), labels);
  assert.match(s.result.text, /занято/u);
  const fields = structuredClone(s.result.dialogue.fields);
  const clarification = s.answer({ text: "да" });
  assert.equal(clarification.action, null);
  assert.equal(clarification.dialogue.phase, "period");
  assert.deepEqual(clarification.dialogue.options.map(row => row.label), labels);
  assert.deepEqual(clarification.dialogue.fields, fields);
  assert.equal(s.entry().data.time, null);
  assert.equal(s.entry().data.date, day);
  assert.equal(s.entry().data.service.id, "clean");
  prepared(s, s.answer({ text: "в 09:30" }), "09:30");
});
test("elapsed time remains a short question while known date, service and client survive", (t) => {
  t.mock.method(Date, "now", () =>
    startsAt({ date: day, time: "10:30" }, "Europe/Moscow"),
  );
  const s = setup(t, full, {
    initialize(f) {
      f.clock.hour = 10;
      f.clock.minute = 30;
    },
  });
  assert.equal(s.result.action, null);
  assert.match(s.result.text, /^Это время уже прошло\./u);
  assert.equal(s.entry().data.date, day);
  assert.equal(s.entry().data.patient.id, s.f.patients[0].id);
  assert.equal(s.entry().data.service.id, "clean");
});
test("explicit uncertainty is still a clarification even when other named data are sufficient", (t) => {
  const s = setup(t, { ...full, query: "Неизвестный Клиент" });
  const reply = s.model(
    "Я не уверен, уточни специалиста",
    {},
    { operation: "clarify", field: "staff" },
  );
  assert.equal(reply.dialogue.step, "staff");
  assert.equal(reply.action, null);
});
test("a calendar availability search stays read-only and does not opt into automatic booking completion", (t) => {
  const s = setup(t, { query: "Неизвестный Клиент" });
  const slot = {
    staffId: "owner",
    staffName: "Тестовый Специалист",
    date: day,
    time: "11:00",
    endTime: "11:30",
    duration: 30,
    roomId: "main",
  };
  const reply = s.f.flow.startAvailability(
    s.f.c,
    { text: "Есть свободное время.", slots: [slot] },
    s.f.state,
    s.f.member,
    s.f.clock,
    s.f.flow.beginCommand(s.f.c, s.f.member, s.f.state),
    { intent: "availability", date: day },
  );
  assert.equal(reply.action, null);
  assert.equal(reply.dialogue.step, "availability");
  assert.equal(
    s.f.flow.get(s.f.c, s.f.member, s.f.state, reply.dialogue.id).data
      .openWhenComplete,
    undefined,
  );
});
test("preview confirmation identifies tomorrow and later dates without copying raw words or contact suffixes", (t) => {
  for (const offset of [1, 2, 20]) {
    let date = day;
    for (let i = 0; i < offset; i++) date = nextDate(date);
    const s = setup(
      t,
      { ...full, date },
      {
        initialize(f) {
          f.c.platform.workSchedules.view = () => ({
            days: {
              [date]: { status: "working", intervals: [["09:00", "18:00"]] },
            },
            closures: {},
          });
        },
      },
    );
    assert.equal(s.result.action?.date, date);
    assert.equal(
      s.result.text,
      "Подготовил запись: Анна Семёнова, " +
        (offset === 1 ? "завтра" : offset === 2 ? "7 января" : "25 января") +
        " в 10:00.",
    );
    assert.doesNotMatch(s.result.text, /…|2233|ручн|кнопк/u);
  }
});

test("a preview for another authorized performer identifies that performer in its short confirmation", (t) => {
  const s = setup(
    t,
    { ...full, staffQuery: "Вера Орлова" },
    {
      initialize(f) {
        f.members.push({
          accountId: "second",
          displayName: "Вера Орлова",
          role: "cosmetologist",
          status: "active",
        });
        f.services.push({
          id: "second-clean",
          name: "Чистка",
          staffId: "second",
          duration: 30,
        });
        const workspace = f.c.platform.workspaceSettings();
        workspace.rooms[0].staffIds.push("second");
        f.c.platform.workspaceSettings = () => workspace;
      },
    },
  );
  assert.equal(s.result.dialogue, null);
  assert.equal(s.result.action.staffId, "second");
  assert.equal(
    s.result.text,
    "Подготовил запись: Анна Семёнова, сегодня в 10:00; специалист Вера Орлова.",
  );
});
test("next-year dates are spoken with month words and an explicit year", (t) => {
  const date = "2100-01-05";
  const s = setup(
    t,
    { ...full, date },
    {
      initialize(f) {
        f.c.platform.workSchedules.view = () => ({
          days: {
            [date]: { status: "working", intervals: [["09:00", "18:00"]] },
          },
          closures: {},
        });
      },
    },
  );
  assert.equal(
    s.result.text,
    "Подготовил запись: Анна Семёнова, 5 января 2100 года в 10:00.",
  );
});
test("successful read-only actions return brief feedback and keep their original navigation contracts", (t) => {
  const { handoff } = require("../src/server/modules/assistant/actions/actions.cjs");
  const s = setup(t, { query: "Неизвестный Клиент" });
  const state = {
    policy: {
      commands: { calendar: true, clients: true, prepareAppointment: true },
    },
  };
  const calendar = handoff(
    s.f.c,
    { intent: "calendar", date: day, mode: "week" },
    state,
    s.f.clock,
  );
  assert.equal(calendar.text, "Открываю расписание.");
  assert.deepEqual(calendar.action, {
    type: "calendar",
    date: day,
    mode: "week",
    staffId: "owner",
  });
  const card = handoff(
    s.f.c,
    { intent: "clientCard", query: "Анну Семенову" },
    state,
    s.f.clock,
  );
  assert.equal(card.text, "Открываю карточку: Анна Семёнова.");
  assert.deepEqual(card.action, {
    type: "clientCard",
    patientId: s.f.patients[0].id,
  });
  const clients = handoff(
    s.f.c,
    { intent: "clients", query: "Семёнова" },
    state,
    s.f.clock,
  );
  assert.equal(clients.text, "Открываю список клиентов.");
  assert.equal(clients.action.type, "clients");
  assert.equal(clients.action.query, "Анна Семёнова");
});
