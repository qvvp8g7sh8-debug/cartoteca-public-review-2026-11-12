const {
  createAppointmentExecution,
} = require('../../src/server/modules/assistant/actions/appointments/appointment-execution.cjs');
const { randomUUID } = require('node:crypto');
const { fail } = require('../../src/shared/errors.cjs');
const { nextDate } = require('../../src/shared/work-schedule.cjs');
const { createScheduleBooking } = require('../../src/server/modules/schedules/booking.cjs');
const {
  createAppointmentManagementFlow,
} = require('../../src/server/modules/assistant/actions/appointments/appointment-management-flow.cjs');
const { cancellationFixture } = require('./assistant-cancellation-fixture.cjs');
const { day } = require('./assistant-dialogue-fixture.cjs');
const tomorrow = nextDate(day);
function moveExecutionFixture(
  t,
  {
    enabled = true,
    role = 'owner',
    query = 'Анна Семёнова',
    failWritten = false,
    targetDate = tomorrow,
    targetTime = '12:30',
    closed = false,
    intervals = [['09:00', '18:00']],
    sourceDuration = 30,
    historical = false,
    beforeStart,
    clockDate,
  } = {},
) {
  // Reuse the real encrypted cabinet/common mutation/marker hooks; cancellation's
  // deliberately failing schedule stub is replaced before the move is prepared.
  const f = cancellationFixture(t, { enabled, role, query, failWritten });
  if (clockDate) f.clock.date = clockDate;
  const days = {
    [day]: { status: 'working', intervals: [['09:00', '18:00']] },
    [targetDate || tomorrow]: {
      status: closed ? 'closed' : 'working',
      intervals: closed ? [] : intervals,
    },
  };
  const personal = [],
    reservations = [],
    scheduleChecks = [],
    scheduleAssertions = [];
  let scheduleRevision = 1;
  const workspace = f.c.platform.workspaceSettings();
  workspace.enabled = true;
  workspace.staffRules = [{ staffId: 'owner', preventOverlap: true }];
  workspace.rooms[0].preventOverlap = true;
  const booking = createScheduleBooking(
    {
      key: Buffer.alloc(32, 7),
      fail,
      organizationTimeZone: () => f.c.platform.organizationTimeZone(f.c.current.organizationId),
    },
    {
      day: (_org, staffId, date) => (staffId === 'organization' ? undefined : days[date]),
      profile: () => ({ revision: scheduleRevision }),
      authorize(actor, staffId) {
        if (actor.role === 'cosmetologist' && staffId !== actor.accountId)
          throw fail(403, 'Synthetic foreign employee');
      },
    },
  );
  f.c.platform.workSchedules = {
    view: () => ({ days, closures: {} }),
    check: (_token, appointment) => {
      scheduleChecks.push(structuredClone(appointment));
      return booking.check(f.c.current, appointment);
    },
    assertChanges: (actor, before, next, acknowledgement, identities) => {
      scheduleAssertions.push({
        acknowledgement,
        before: structuredClone(before),
        next: structuredClone(next),
      });
      return booking.assertChanges(actor, before, next, acknowledgement, identities);
    },
  };
  f.c.platform.personalEvents = { occupancy: () => personal, assertAppointments() {} };
  f.c.platform.bookingRequests = { reserves: () => reservations };
  function mutate(callback) {
    const next = f.storage.read();
    callback(next);
    f.storage.write(next);
  }
  if (sourceDuration !== 30 || historical)
    mutate((next) => {
      const source = next.patients[0].appointments[0];
      source.duration = sourceDuration;
      if (historical) {
        source.service = 'Историческая процедура';
        source.serviceItems = [
          {
            id: 'archived',
            name: source.service,
            category: 'other',
            duration: sourceDuration,
            price: 777,
          },
        ];
      }
    });
  const addBooking = (values) =>
    mutate((next) => {
      next.patients[0].appointments.push({
        ...structuredClone(next.patients[0].appointments[0]),
        id: randomUUID(),
        date: targetDate || tomorrow,
        time: '12:30',
        ...values,
      });
    });
  const management = createAppointmentManagementFlow({
    memory: f.flow,
    appointmentSavingEnabled: enabled,
  });
  const options = { ...f.options, now: () => Date.parse(f.clock.date + 'T05:00:00Z') };
  const api = createAppointmentExecution(options);
  const shared = {
    ...f,
    api,
    options,
    days,
    personal,
    reservations,
    workspace,
    scheduleChecks,
    scheduleAssertions,
    mutate,
    addBooking,
    management,
    bumpSchedule: () => ++scheduleRevision,
  };
  if (beforeStart) beforeStart(shared);
  let result;
  const start = (values = {}, constraints = {}) => {
    result = management.start(
      f.c,
      {
        intent: 'moveAppointment',
        query,
        ...(targetDate ? { date: targetDate } : {}),
        ...(targetTime ? { time: targetTime } : {}),
        ...values,
      },
      f.state,
      f.member,
      f.clock,
      f.flow.beginCommand(f.c, f.member, f.state),
      constraints,
    );
    return result;
  };
  const answer = (operation) => {
    const body = {
      dialogueId: result.dialogue.id,
      dialogueVersion: result.dialogue.version,
      ...operation,
    };
    result = management.continueDialogue(f.c, body, f.state, f.member, f.clock);
    return { result, body };
  };
  start();
  return {
    ...shared,
    start,
    answer,
    get result() {
      return result;
    },
    body: () => ({ executionId: result.action.executionId, policyVersion: f.state.revision }),
    rows: () => f.storage.readSelected([f.patients[0].id]).patients[0].appointments,
    entry: () =>
      f.flow.get(f.c, f.member, f.state, result.action?.executionId || result.dialogue.id),
  };
}
module.exports = { moveExecutionFixture, day, tomorrow };
