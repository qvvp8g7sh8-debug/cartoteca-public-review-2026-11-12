const { readSteps } = require('../../read-steps.cjs');
const { fail } = require('../../../../../shared/errors.cjs');
const { minutes } = require('../../../../../shared/work-schedule.cjs');
const { createDialogueStore } = require('../../dialogue/dialogue-store.cjs');
const { dialogueControl, draftOperation } = require('../../dialogue/dialogue-control.cjs');
const { informationTurn } = require('../../dialogue/dialogue-control-turn.cjs');
const { clientLabel } = require('../../dialogue/dialogue-options.cjs');
const { resolveClient } = require('../../language/names/name-directory.cjs');
const { matchesName } = require('../../language/names/name-matching.cjs');
const { createClientCardFlow } = require('../client-card-flow.cjs');
const { validateContinuation } = require('../../dialogue/dialogue-input.cjs');
const {
  managementAppointments,
  managementSource,
  sourceIdentity,
} = require('./appointment-management-references.cjs');
const {
  appointmentLabel,
  managementResponse,
  managementResult,
} = require('./appointment-management-view.cjs');
const {
  findAppointmentMoveAvailability,
  verifyAppointmentMoveAvailability,
} = require('../availability.cjs');
const { rejectedTimeText } = require('../../dialogue/dialogue-time-rejection.cjs');
const { managementTextOperation } = require('./appointment-management-input.cjs');
const { unconditionalNegativeAction } = require('../../interpretation/intent-action-grounding.cjs');
const { startsAt } = require('../../../notifications/appointments.cjs');
const { refreshManagementReceipt } = require('./appointment-management-replay.cjs');
const { managementClientContext } = require('./appointment-management-scope.cjs');
const {
  cancellationConfirmation,
  confirmCancellation,
} = require('./appointment-cancellation-snapshot.cjs');
const { isConfirmationAnswer } = require('../../dialogue/affirmative-answer.cjs');
const { bindMovePreparation } = require('./appointment-move-snapshot.cjs');
const {
  invalidBookingTime,
  nearestGridSlot,
  timeStepPrompt,
} = require('./appointment-time-input.cjs');
const { managementDateView } = require('./appointment-management-date.cjs');
const { validProposal } = require('../../dialogue/bare-day-proposal.cjs');
const { initializeManagementTarget } = require('./appointment-management-temporal.cjs');
const { MAX_RANGES } = require('../free-range-view.cjs');
const { filterSourceAppointments, sourcePrompt } = require('./appointment-source-selection.cjs');
const {
  sourceCorrection,
  resetSource,
  setSourceDay,
  clearSourceDate,
  clearSourceTime,
  clearTargetWindow,
  targetFitsWindow,
} = require('./appointment-management-repair.cjs');
const { renewCancellation } = require('./appointment-cancellation-recovery.cjs');
const { cancellationSourceCorrection } = require('./appointment-cancellation-correction.cjs');
const {
  managementCorrectionRemainder,
  hasManagementCorrectionPrefix,
  rejectedSourceOnlyCorrection,
} = require('./appointment-management-replacement.cjs');
const {
  applyTargetPatch,
  resetTargetSearch,
  editTargetDate,
  editTargetTime,
  prepareSourceReselection,
  applyTargetConstraints,
  applyRelativeTarget,
} = require('./appointment-management-target-state.cjs');
const {
  managementClientCorrection,
  explicitClientCorrection,
  bareManagementClientCorrection,
} = require('./appointment-management-client.cjs');
const { applySourceConstraints } = require('./appointment-management-source-state.cjs');
const { managementCommandReply } = require('./appointment-management-command.cjs');
const {
  managementRangeView,
  managementNearestView,
} = require('./appointment-management-availability.cjs');
const {
  dayKey,
  exactScheduleKey,
  confirmationMatches,
  outsideWorkingHours,
} = require('./schedule-override.cjs');
const operations = {
  moveAppointment: 'move',
  cancelAppointment: 'cancel',
  editAppointment: 'edit',
};
function createAppointmentManagementFlow({
  memory = createDialogueStore(),
  appointmentSavingEnabled = false,
} = {}) {
  const startingConstraints = new WeakMap();
  function allowed(c, state) {
    c.assertCurrent();
    if (!state.policy.commands.prepareAppointment)
      throw fail(403, 'Изменение записей помощником выключено администратором.');
  }
  function information(c, entry, control, body, state, clock, replay = false) {
    return readSteps(function* () {
      return yield informationTurn(entry, control, {
        refresh(fresh) {
          return readSteps(function* () {
            const identity = fresh.data.management?.source;
            if (identity)
              fresh.data.patient.label = clientLabel((yield managementSource(c, identity)).patient);
            const reply = yield present(c, fresh, clock, true);
            c.assertCurrent();
            return reply;
          }).call(this);
        },
        clock,
        limit: state.policy.limits?.maxReplyChars,
        hash: memory.fingerprint(body),
        replay,
      });
    }).call(this);
  }
  function initialize(entry, proof = {}) {
    if (entry.data.management) return;
    const intent = entry.data.initialIntent;
    const operation = operations[intent.intent];
    if (!operation) throw fail(400, 'Уточните действие с существующей записью.');
    entry.data.management = {
      operation,
      executionEnabled: proof.executionEnabled === true,
      initialDate: proof.date !== undefined ? proof.date : intent.date,
      initialTime: proof.time !== undefined ? proof.time : intent.time,
      dateRequired: proof.date === null,
      timeRequired:
        proof.time === null || (operation === 'move' && proof.time === undefined && !intent.time),
      dateProposal: proof.dateProposal,
      dateRejection: proof.dateRejection,
      relativeTarget: proof.relativeTarget,
      initialWindow: proof.timeWindow,
      timeWindowRequired: proof.timeWindowRequired === true,
      rangeSummary: proof.seekSlots === true && !proof.nearestRequested,
      keepTime: proof.keepTime === true,
      nearestRequested: ['nearest', 'earliest'].includes(proof.nearestRequested)
        ? proof.nearestRequested
        : null,
      source: null,
      sourceDate: operation === 'cancel' ? intent.date : undefined,
      sourceTime: operation === 'cancel' ? intent.time : undefined,
      staffQuery: intent.staffQuery || '',
      ...(intent.serviceQuery ? { sourceServiceQuery: intent.serviceQuery } : {}),
    };
    if (operation !== 'move') {
      const m = entry.data.management;
      m.initialDate = m.initialTime = null;
      delete m.relativeTarget;
      delete m.keepTime;
      applySourceConstraints(m, {
        ...(intent.date ? { date: intent.date } : {}),
        ...(intent.time ? { time: intent.time } : {}),
        ...proof,
      });
      delete m.dateProposal;
    }
  }
  function chooseSources(c, entry, clock, forceChoice = false, snapshot) {
    return readSteps(function* () {
      const m = entry.data.management;
      const refs = snapshot || (yield managementAppointments(c, entry.data.patient.id));
      const choices = filterSourceAppointments(refs.appointments, m, refs.context);
      m.sourceYearRequired = Boolean(
        m.sourceDay &&
        new Set(choices.map((row) => row.date.slice(0, 4))).size > 1 &&
        new Set(choices.map((row) => row.date.slice(5, 7))).size === 1,
      );
      if (m.sourceYearRequired) m.sourceMonth = Number(choices[0].date.slice(5, 7));
      if (m.sourceDateRequired)
        return managementResponse(entry, {
          step: 'appointment',
          phase: 'appointmentChoice',
          prompt: 'На какую дату запись?',
        });
      if (m.sourceTimeRequired)
        return managementResponse(entry, {
          step: 'appointment',
          phase: 'appointmentChoice',
          prompt: 'Во сколько запись?',
        });
      if (m.operation === 'cancel' && (m.dateRequired || m.timeRequired))
        return managementResponse(entry, {
          step: 'appointment',
          phase: 'appointmentChoice',
          prompt: m.dateRequired ? 'На какую дату запись?' : 'Во сколько запись?',
        });
      if (!choices.length) {
        entry.complete = true;
        return { text: 'Подходящих будущих записей нет.', dialogue: null, action: null };
      }
      m.sourceChoices = choices.slice(0, 12).map((row) => sourceIdentity(refs.patient.id, row));
      if (choices.length > 1 || forceChoice)
        return managementResponse(entry, {
          step: 'appointment',
          phase: 'appointmentChoice',
          prompt: sourcePrompt(choices, m),
          choices: choices.slice(0, 12).map((row) => ({
            kind: 'appointmentSource',
            sourceDate: row.date,
            value: sourceIdentity(refs.patient.id, row),
            label: appointmentLabel(row, clock),
          })),
        });
      m.source = sourceIdentity(refs.patient.id, choices[0]);
      if (m.operation !== 'cancel') {
        initializeManagementTarget(m, choices[0], clock);
      }
      return yield present(c, entry, clock);
    }).call(this);
  }
  function targetResponse(entry, source, step, prompt, choices = [], phase) {
    return managementResponse(
      entry,
      { step, prompt, choices, ...(phase ? { phase } : {}) },
      source,
    );
  }
  const gridResponse = readSteps(function* gridResponse(c, entry, source, requested) {
    const m = entry.data.management;
    m.requestedTime = Number.isFinite(minutes(requested)) ? requested : null;
    m.targetTime = null;
    m.timeRequired = false;
    const slot = yield nearestGridSlot(requested, (time) => {
      if (
        (m.targetDate === source.appointment.date && time === source.appointment.time) ||
        !targetFitsWindow({ ...m, targetTime: time }, source.duration)
      )
        return null;
      return verifyAppointmentMoveAvailability(
        c,
        { date: m.targetDate, time, staffId: source.staffId, duration: source.duration },
        m.source,
      );
    });
    return targetResponse(
      entry,
      source,
      'time',
      timeStepPrompt(requested, slot, true),
      slot
        ? [
            {
              kind: 'managementTarget',
              value: { date: slot.date, time: slot.time },
              label: slot.time + '–' + slot.endTime,
            },
          ]
        : [],
      slot ? 'slots' : undefined,
    );
  });
  function rangeResponse(c, entry, source, reason = '') {
    return readSteps(function* () {
      return managementResponse(entry, yield managementRangeView(c, entry, source, reason), source);
    }).call(this);
  }
  function nearestResponse(c, entry, source, reason = '') {
    return readSteps(function* () {
      entry.data.management.rangeSummary = false;
      return managementResponse(
        entry,
        yield managementNearestView(c, entry, source, reason),
        source,
      );
    }).call(this);
  }
  function present(c, entry, clock, pendingReplay = false) {
    return readSteps(function* () {
      initialize(entry);
      const m = entry.data.management;
      if (!m.source) return yield chooseSources(c, entry, clock, pendingReplay);
      const source = yield managementSource(c, m.source);
      if (m.operation === 'cancel')
        return m.cancelConfirmed
          ? managementResult(c, entry, source, clock)
          : yield cancellationConfirmation(c, entry, source, clock);
      if (m.operation === 'edit' && !m.hasTarget && !m.dateRequired && !m.timeRequired)
        return managementResult(c, entry, source, clock);
      const dateView = managementDateView(entry, clock);
      if (dateView) return managementResponse(entry, dateView, source);
      if (!m.targetDate)
        return targetResponse(
          entry,
          source,
          'date',
          (m.dateRejection === 'past' ? 'Эта дата уже прошла. ' : '') + 'На какую дату перенести?',
        );
      if (m.targetDate < clock.date) {
        m.targetDate = null;
        return targetResponse(
          entry,
          source,
          'date',
          'Эта дата уже прошла. На какую дату перенести?',
        );
      }
      if (m.timeWindowRequired)
        return targetResponse(entry, source, 'time', 'В какой период перенести?');
      if (!m.targetTime)
        return m.nearestRequested
          ? yield nearestResponse(c, entry, source)
          : m.rangeSummary
            ? yield rangeResponse(c, entry, source)
            : targetResponse(
                entry,
                source,
                'time',
                (m.relativeHelp ? m.relativeHelp + ' ' : '') + 'На какое время перенести?',
              );
      if (
        m.operation === 'move' &&
        m.targetDate === source.appointment.date &&
        m.targetTime === source.appointment.time
      ) {
        m.targetDate = null;
        m.dateRequired = true;
        resetTargetSearch(m);
        return targetResponse(
          entry,
          source,
          'date',
          'Дата и время не изменились. На какую дату перенести?',
        );
      }
      if (invalidBookingTime({ time: m.targetTime }))
        return yield gridResponse(c, entry, source, m.targetTime);
      if (!targetFitsWindow(m, source.duration)) {
        m.requestedTime = m.targetTime;
        m.targetTime = null;
        m.rangeSummary = true;
        return yield rangeResponse(c, entry, source, 'Приём не помещается в выбранный период.');
      }
      if (
        startsAt(
          { date: m.targetDate, time: m.targetTime },
          c.assistantReads
            ? yield c.assistantReads.timeZone()
            : c.platform.organizationTimeZone(c.current.organizationId),
        ) < Date.now()
      ) {
        m.requestedTime = m.targetTime;
        m.targetTime = null;
        return targetResponse(
          entry,
          source,
          'time',
          'Это время уже прошло. На какое время перенести?',
        );
      }
      const common = { duration: source.duration, staffId: source.staffId };
      const info = (yield findAppointmentMoveAvailability(
        c,
        {
          ...common,
          staffIds: [source.staffId],
          from: m.targetDate,
          to: m.targetDate,
          strategy: 'day',
        },
        m.source,
      )).availability.dayInfo;
      const tuple = { ...common, date: m.targetDate, time: m.targetTime };
      const key = info.status === 'working' ? exactScheduleKey(tuple) : dayKey(tuple);
      const confirmed = confirmationMatches(c, m.closedConfirmation, tuple);
      if (outsideWorkingHours(info, tuple) && !confirmed)
        return targetResponse(
          entry,
          source,
          'time',
          ['owner', 'salon_admin'].includes(c.current.role)
            ? info.status === 'working'
              ? 'Вне рабочего графика. Перенести?'
              : 'День не открыт. Всё равно перенести?'
            : info.status === 'working'
              ? 'Вне рабочего графика. Выберите другое время.'
              : 'День не открыт. Выберите другую дату.',
          ['owner', 'salon_admin'].includes(c.current.role)
            ? [{ kind: 'managementClosedDay', value: key, label: 'Да, продолжить' }]
            : [],
          'closedDay',
        );
      const slot = yield verifyAppointmentMoveAvailability(
        c,
        {
          ...common,
          date: m.targetDate,
          time: m.targetTime,
          ...(confirmed ? { allowClosedDay: true } : {}),
        },
        m.source,
      );
      if (slot) {
        if (!pendingReplay) {
          if (m.operation === 'move' && m.executionEnabled === true)
            yield bindMovePreparation(c, entry, source, slot, clock);
          return managementResult(c, entry, source, clock, slot);
        }
        m.requestedTime = slot.time;
        m.targetTime = null;
        return targetResponse(
          entry,
          source,
          'time',
          'Свободно в ' + slot.time + '. Подойдёт?',
          [
            {
              kind: 'managementTarget',
              value: { date: slot.date, time: slot.time },
              label: slot.time + '–' + slot.endTime,
            },
          ],
          'slots',
        );
      }
      const reason = rejectedTimeText(
        { date: m.targetDate, time: m.targetTime, duration: source.duration },
        info,
        {
          timeZone: c.assistantReads
            ? yield c.assistantReads.timeZone()
            : c.platform.organizationTimeZone(c.current.organizationId),
          closedConfirmed: confirmed,
        },
      );
      const requested = m.targetTime;
      m.requestedTime = requested;
      m.targetTime = null;
      m.rangeSummary = true;
      m.rangeOffset = 0;
      m.rangeReason = reason;
      return m.nearestRequested
        ? yield nearestResponse(c, entry, source, reason)
        : yield rangeResponse(c, entry, source, reason);
    }).call(this);
  }
  const resolver = createClientCardFlow({
    memory,
    target: 'appointmentManagement',
    candidateContext: managementClientContext,
    emptyPrompt: (data) =>
      'Подходящих будущих записей не нашёл. У кого ' +
      (data.initialIntent.intent === 'cancelAppointment' ? 'отменить' : 'изменить') +
      ' запись?',
    allow: allowed,
    onResolved(c, entry, patient, clock) {
      return readSteps(function* () {
        initialize(entry, startingConstraints.get(c));
        return yield present(c, entry, clock);
      }).call(this);
    },
  });
  function start(c, intent, state, member, clock, ticket, constraints = {}) {
    return readSteps(function* () {
      allowed(c, state);
      const previous = startingConstraints.get(c);
      const constraintsForRequest = {
        ...constraints,
        executionEnabled:
          appointmentSavingEnabled === true && state.providers?.llm?.provider !== 'demo',
      };
      startingConstraints.set(c, constraintsForRequest);
      try {
        const reply = yield resolver.start(c, intent, state, member, clock, ticket);
        if (reply.dialogue)
          initialize(memory.get(c, member, state, reply.dialogue.id), constraintsForRequest);
        return reply;
      } finally {
        if (previous) startingConstraints.set(c, previous);
        else startingConstraints.delete(c);
      }
    }).call(this);
  }
  function applyChoice(c, entry, choice, clock) {
    return readSteps(function* () {
      const m = entry.data.management;
      if (!choice) throw fail(409, 'Выберите актуальную запись или время.');
      if (choice.kind === 'managementMoreRanges') {
        m.rangeOffset = (m.rangeOffset || 0) + MAX_RANGES;
        return yield rangeResponse(c, entry, yield managementSource(c, m.source));
      }
      if (choice.kind === 'managementOtherDate') {
        editTargetDate(m);
        return yield present(c, entry, clock);
      }
      if (choice.kind === 'managementRange') {
        yield managementSource(c, m.source);
        resetTargetSearch(m);
        m.targetWindow = structuredClone(choice.value);
        m.targetWindowDate = m.targetDate;
        m.targetTime = null;
        m.timeRequired = true;
        m.rangeSummary = false;
        return targetResponse(
          entry,
          yield managementSource(c, m.source),
          'time',
          choice.label[0].toUpperCase() + choice.label.slice(1) + '. На какое время перенести?',
        );
      }
      if (choice.kind === 'managementCancelConfirm') {
        yield confirmCancellation(c, entry, choice);
        return managementResult(c, entry, yield managementSource(c, m.source), clock);
      }
      if (choice.kind === 'managementDateMonth') {
        const proposal = m.dateProposal;
        if (
          !validProposal(proposal) ||
          choice.value !== proposal.date ||
          choice.day !== proposal.day ||
          choice.value < clock.date
        )
          throw fail(409, 'Предложенная дата изменилась. Уточните дату переноса.');
        yield managementSource(c, m.source);
        resetTargetSearch(m);
        m.targetDate = choice.value;
        clearTargetWindow(m);
        if (m.initialWindow) {
          m.targetWindow = structuredClone(m.initialWindow);
          m.targetWindowDate = choice.value;
        }
        m.dateRequired = false;
        m.dateMonthContext = choice.value.slice(0, 7);
        delete m.dateProposal;
        m.hasTarget = true;
      } else if (choice.kind === 'appointmentSource') {
        yield managementSource(c, choice.value);
        m.source = choice.value;
        if (m.operation !== 'cancel') {
          const source = (yield managementSource(c, m.source)).appointment;
          initializeManagementTarget(m, source, clock);
        }
      } else if (choice.kind === 'managementClosedDay') {
        const source = yield managementSource(c, m.source);
        if (
          !confirmationMatches(c, choice.value, {
            date: m.targetDate,
            time: m.targetTime,
            duration: source.duration,
            staffId: source.staffId,
          })
        )
          throw fail(403, 'Это подтверждение больше недоступно.');
        m.closedConfirmation = choice.value;
      } else if (choice.kind === 'managementTarget') {
        m.targetDate = choice.value.date;
        m.targetTime = choice.value.time;
        m.hasTarget = true;
      } else throw fail(409, 'Ответ относится к другой команде.');
      return yield present(c, entry, clock);
    }).call(this);
  }
  function textTurn(c, entry, raw, clock) {
    return readSteps(function* () {
      const remainder = managementCorrectionRemainder(raw);
      if (remainder !== null) raw = 'Нет, ' + remainder;
      const m = entry.data.management;
      const contextDate =
        m.operation === 'move' ? m.targetDate || m.dateMonthContext : m.sourceDate;
      let clientCorrection = managementClientCorrection(
        raw,
        clock,
        contextDate,
        entry.data.patient?.clientName,
      );
      if (!clientCorrection && !sourceCorrection(entry, raw)) {
        const bare = bareManagementClientCorrection(raw, clock, contextDate);
        if (bare) {
          const found = yield resolveClient(yield managementClientContext(c), bare.query);
          const refs = yield managementAppointments(c, entry.data.patient.id);
          const serviceMatch =
            filterSourceAppointments(
              refs.appointments,
              { sourceServiceQuery: bare.query },
              refs.context,
            ).length > 0;
          if ((found.matches.length || found.overflow) && serviceMatch) {
            if (m.operation === 'move') prepareSourceReselection(m);
            else resetSource(m);
            delete m.sourceChoices;
            return managementResponse(entry, {
              step: 'appointment',
              phase: 'appointmentChoice',
              prompt: 'Клиента или услугу изменить?',
            });
          }
          // An unrecognised name must never leave the former consent executable.
          if (!serviceMatch) clientCorrection = bare;
        }
      }
      if (clientCorrection || explicitClientCorrection(raw, clock, contextDate)) {
        if (m.operation === 'move') prepareSourceReselection(m);
        else resetSource(m);
        m.staffQuery = '';
        delete m.sourceChoices;
        if (m.operation !== 'move') applySourceConstraints(m, clientCorrection?.constraints);
        else if (clientCorrection?.constraints)
          applyTargetConstraints(m, clientCorrection.constraints);
        return yield resolver.reselect(c, entry, clock, clientCorrection?.query || '');
      }
      const repeated = yield managementCommandReply(c, entry, raw, clock);
      if (repeated) {
        if (repeated.sourceRequest) {
          const { intent, constraints } = repeated.sourceRequest;
          if (m.operation !== 'move')
            return yield sourceFilterTurn(
              c,
              entry,
              {
                kind: 'sourceFilters',
                query: intent.serviceQuery,
                staffQuery: intent.staffQuery,
                constraints,
                edits: ['date', 'time']
                  .filter((field) => constraints[field])
                  .map((field) => ({ field, text: constraints[field] })),
              },
              clock,
              true,
            );
          prepareSourceReselection(m);
          if (intent.serviceQuery) m.sourceServiceQuery = intent.serviceQuery;
          if (intent.staffQuery) m.staffQuery = intent.staffQuery;
          applyTargetConstraints(m, constraints);
          return yield chooseSources(c, entry, clock);
        }
        if (!repeated.text) return entry.response;
        raw =
          m.operation === 'cancel' ? 'Нет, ' + repeated.text : 'Перенеси запись ' + repeated.text;
      }
      if (entry.response?.dialogue?.phase === 'cancelConfirmation') {
        const correction = sourceCorrection(entry, raw);
        if (correction) {
          let selected = null;
          if (correction.value) {
            try {
              selected = yield managementSource(c, correction.value);
            } catch (error) {
              if (error.status !== 409) throw error;
            }
          }
          resetSource(m);
          if (selected) {
            m.source = correction.value;
            entry.data.patient.label = clientLabel(selected.patient);
            return yield present(c, entry, clock);
          }
          return yield chooseSources(c, entry, clock, true);
        }
        const selectedSource = yield managementSource(c, m.source);
        const filter = cancellationSourceCorrection(entry, raw, clock, selectedSource);
        if (filter) return yield sourceFilterTurn(c, entry, filter, clock, true);
        if (hasManagementCorrectionPrefix(raw)) {
          if (rejectedSourceOnlyCorrection(raw, selectedSource)) {
            const refs = yield managementAppointments(c, entry.data.patient.id);
            const choices = filterSourceAppointments(refs.appointments, m, refs.context).slice(
              0,
              12,
            );
            delete m.cancelConfirmation;
            delete m.cancelConfirmed;
            m.sourceChoices = choices.map((row) => sourceIdentity(refs.patient.id, row));
            return managementResponse(
              entry,
              {
                step: 'appointment',
                phase: 'appointmentChoice',
                prompt: 'Уточните запись для отмены.',
                choices: choices.map((row) => ({
                  kind: 'appointmentSource',
                  sourceDate: row.date,
                  value: sourceIdentity(refs.patient.id, row),
                  label: appointmentLabel(row, clock),
                })),
              },
              selectedSource,
            );
          }
          resetSource(m);
          delete m.sourceChoices;
          return yield chooseSources(c, entry, clock, true);
        }
        if (
          /^(?:нет|не надо|не отменяй|не отменять|оставь|оставить|стоп|отмена|cancel)[.!?…]*$/iu.test(
            String(raw).trim(),
          )
        )
          return cancel(entry);
        const choices = [...entry.options.values()];
        return isConfirmationAnswer(raw, 'cancel') &&
          choices.length === 1 &&
          choices[0].kind === 'managementCancelConfirm'
          ? yield applyChoice(c, entry, choices[0], clock)
          : entry.response;
      }
      if (m.source && m.operation !== 'cancel') {
        const correction = sourceCorrection(entry, raw);
        if (correction) {
          if (correction.value) yield managementSource(c, correction.value);
          prepareSourceReselection(m);
          if (correction.value)
            return yield applyChoice(
              c,
              entry,
              { kind: 'appointmentSource', value: correction.value },
              clock,
            );
          return yield chooseSources(c, entry, clock, true);
        }
        const filter = cancellationSourceCorrection(
          entry,
          raw,
          clock,
          yield managementSource(c, m.source),
        );
        if (
          filter &&
          (filter.kind === 'sourceService' ||
            filter.kind === 'sourceStaff' ||
            (filter.kind === 'sourceFilters' && (filter.query || filter.staffQuery)))
        ) {
          prepareSourceReselection(m);
          return yield sourceFilterTurn(c, entry, filter, clock);
        }
      }
      const input = managementTextOperation(
        entry,
        raw,
        clock,
        m.source ? yield managementSource(c, m.source) : null,
      );
      if (input.kind === 'cancel') return cancel(entry);
      if (input.kind === 'sourceTarget') {
        const selected = entry.options.get(input.choice);
        if (selected?.kind !== 'appointmentSource')
          throw fail(409, 'Список записей изменился. Выберите запись заново.');
        yield managementSource(c, selected.value);
        if (input.target?.kind === 'targetConstraints')
          applyTargetConstraints(m, input.target.constraints);
        else if (input.target) applyTargetPatch(m, input.target);
        if (input.relative) {
          applyRelativeTarget(m, input.relative);
        }
        return yield applyChoice(c, entry, selected, clock);
      }
      if (input.kind === 'targetEditDate') {
        editTargetDate(m);
        return yield present(c, entry, clock);
      }
      if (input.kind === 'targetEditTime') {
        editTargetTime(m);
        return targetResponse(
          entry,
          yield managementSource(c, m.source),
          'time',
          'На какое время перенести?',
        );
      }
      if (input.kind === 'targetPatch') {
        applyTargetPatch(m, input);
        return m.source
          ? yield present(c, entry, clock)
          : yield chooseSources(c, entry, clock, true);
      }
      if (input.kind === 'targetConstraints') {
        applyTargetConstraints(m, input.constraints);
        return m.source
          ? yield present(c, entry, clock)
          : yield chooseSources(c, entry, clock, true);
      }
      if (input.kind === 'targetRelative') {
        applyRelativeTarget(m, input);
        return yield chooseSources(c, entry, clock, true);
      }
      if (input.kind === 'managementHelp') {
        if (input.direction) m.pendingShift = input.direction;
        return targetResponse(
          entry,
          m.source ? yield managementSource(c, m.source) : null,
          input.direction ? 'time' : entry.step,
          input.text,
        );
      }
      if (input.kind === 'dateMonthPropose') {
        resetTargetSearch(m);
        clearTargetWindow(m);
        delete m.initialWindow;
        m.dateProposal = structuredClone(input.proposal);
        m.targetDate = null;
        m.dateRequired = true;
        if (input.changedTime) {
          m.targetTime = input.time;
          m.timeRequired = !input.time;
          m.timeWindowRequired = false;
        }
        return yield present(c, entry, clock);
      }
      if (input.kind === 'dateMonthReject') {
        if (validProposal(m.dateProposal)) m.dateProposal.date = null;
        return yield present(c, entry, clock);
      }
      if (input.kind === 'localHelp') {
        const source = m.source ? yield managementSource(c, m.source) : null;
        if (input.field === 'time')
          return targetResponse(entry, source, 'time', input.text + ' На какое время перенести?');
        const view = managementDateView(entry, clock);
        if (view) return managementResponse(entry, view, source);
        m.targetDate = null;
        m.dateRequired = true;
        return targetResponse(entry, source, 'date', input.text || 'На какую дату перенести?');
      }
      if (input.kind === 'acceptCurrent') {
        const choices = [...entry.options.values()];
        return choices.length === 1 &&
          [
            'managementClosedDay',
            'managementTarget',
            'appointmentSource',
            'managementCancelConfirm',
            'managementDateMonth',
          ].includes(choices[0].kind)
          ? yield applyChoice(c, entry, choices[0], clock)
          : entry.response;
      }
      if (input.kind === 'choice')
        return yield applyChoice(c, entry, entry.options.get(input.choice), clock);
      if (
        [
          'sourceDay',
          'sourceMonth',
          'sourceService',
          'sourceStaff',
          'sourceFilter',
          'sourceFilters',
          'sourceEditDate',
          'sourceEditTime',
        ].includes(input.kind)
      )
        return yield sourceFilterTurn(c, entry, input, clock);
      if (input.kind === 'managementRejectTime') {
        const rejectedRanges = [...entry.options.values()].some(
          (row) => row.kind === 'managementRange',
        );
        const moreRanges = [...entry.controls.values()].some(
          (row) => row.kind === 'managementMoreRanges',
        );
        const offered = [...entry.options.values()]
          .filter((row) => row.kind === 'managementTarget')
          .map((row) => row.value.time);
        if (m.targetTime) offered.push(m.targetTime);
        const previous = m.rejectedTargetDate === m.targetDate ? m.rejectedTargetTimes || [] : [];
        m.rejectedTargetTimes = [...new Set([...previous, ...offered])].slice(-12);
        m.rejectedTargetDate = m.targetDate;
        m.targetTime = null;
        m.timeRequired = true;
        m.nearestRequested = null;
        m.rangeSummary = !rejectedRanges || moreRanges;
        m.rangeOffset = rejectedRanges && moreRanges ? (m.rangeOffset || 0) + MAX_RANGES : 0;
        delete m.pendingShift;
        delete m.relativeHelp;
        delete m.closedConfirmation;
        delete m.movePreparation;
        delete m.rangeReason;
        if (rejectedRanges && !moreRanges)
          return targetResponse(
            entry,
            yield managementSource(c, m.source),
            'time',
            'На какое время перенести? Можно выбрать другую дату.',
          );
        return yield present(c, entry, clock);
      }
      if (input.kind === 'rangeSearch') {
        resetTargetSearch(m);
        m.targetTime = null;
        m.timeRequired = true;
        m.timeWindowRequired = false;
        m.nearestRequested = input.nearest;
        m.rangeSummary = !input.nearest;
        m.rangeOffset = 0;
        return yield present(c, entry, clock);
      }
      if (input.kind !== 'target') return entry.response;
      if (input.seekSlots) {
        applyTargetPatch(m, {
          edits: input.changedDate ? [{ field: 'date', text: input.date }] : [],
          seekSlots: true,
          nearest: input.nearest,
        });
        return yield present(c, entry, clock);
      }
      const pendingWindow = !m.targetDate && (m.targetWindow || m.initialWindow);
      resetTargetSearch(m);
      delete m.pendingShift;
      if (input.changedDate || !m.dateRequired) m.targetDate = input.date;
      if (input.changedTime || !m.timeRequired) m.targetTime = input.time;
      if (input.changedDate) {
        clearTargetWindow(m);
        delete m.initialWindow;
        m.dateRequired = false;
        delete m.dateProposal;
        if (/^\d{4}-\d{2}-\d{2}$/u.test(input.date || ''))
          m.dateMonthContext = input.date.slice(0, 7);
        m.rangeSummary = false;
        m.rangeOffset = 0;
        if (pendingWindow && !input.changedTime) {
          m.initialWindow = structuredClone(pendingWindow);
          m.targetWindow = structuredClone(pendingWindow);
          m.targetWindowDate = input.date;
          m.rangeSummary = !m.targetTime;
        }
      }
      if (input.changedTime) {
        clearTargetWindow(m);
        delete m.initialWindow;
        m.timeRequired = false;
        m.timeWindowRequired = false;
        m.requestedTime = input.time;
        m.rangeSummary = false;
        delete m.relativeHelp;
      }
      m.hasTarget = true;
      return yield present(c, entry, clock);
    }).call(this);
  }
  function sourceFilterTurn(c, entry, input, clock, correcting = false) {
    return readSteps(function* () {
      const m = entry.data.management;
      const before = structuredClone(m);
      if (correcting) {
        m.source = null;
        delete m.cancelConfirmation;
        delete m.cancelConfirmed;
      }
      if (input.kind === 'sourceEditDate') {
        clearSourceDate(m);
        return yield chooseSources(c, entry, clock, true);
      }
      if (input.kind === 'sourceEditTime') {
        clearSourceTime(m);
        return yield chooseSources(c, entry, clock, true);
      }
      if (input.kind === 'sourceDay') {
        setSourceDay(m, input.day);
        delete m.sourceDateRequired;
      } else if (input.kind === 'sourceMonth') {
        if (m.sourceDate) {
          m.sourceDay = Number(m.sourceDate.slice(8));
          delete m.sourceDate;
        }
        m.sourceMonth = input.month;
        m.sourceYear = input.year;
      } else if (input.kind === 'sourceService') m.sourceServiceQuery = input.query;
      else if (input.kind === 'sourceStaff') m.staffQuery = input.query;
      else {
        if (input.kind === 'sourceFilters' && input.query) m.sourceServiceQuery = input.query;
        if (input.kind === 'sourceFilters' && input.staffQuery) m.staffQuery = input.staffQuery;
        for (const edit of input.edits) {
          if (edit.field === 'time') clearSourceTime(m);
          m[edit.field === 'date' ? 'sourceDate' : 'sourceTime'] = edit.text;
          if (edit.field === 'time') delete m.sourceTimeRequired;
          if (edit.field === 'date') {
            delete m.sourceDateRequired;
            delete m.sourceDay;
            delete m.sourceMonth;
            delete m.sourceYear;
          }
          if (m.operation !== 'move') m[edit.field + 'Required'] = false;
        }
      }
      if (input.constraints) applySourceConstraints(m, input.constraints);
      const refs = yield managementAppointments(c, entry.data.patient.id);
      if (!filterSourceAppointments(refs.appointments, m, refs.context).length) {
        entry.data.management = before;
        if (correcting) {
          before.source = null;
          delete before.cancelConfirmation;
          delete before.cancelConfirmed;
        }
        const reply = yield chooseSources(c, entry, clock, true, refs);
        if (reply.dialogue)
          reply.text = reply.dialogue.prompt =
            'Подходящей записи не нашёл. Назовите услугу или дату записи.';
        return reply;
      }
      if (m.operation !== 'move' && input.kind === 'sourceDay') m.dateRequired = false;
      return yield chooseSources(c, entry, clock, false, refs);
    }).call(this);
  }
  function cancel(entry, text = 'Подготовка изменения отменена.') {
    memory.invalidatePending(entry.accountId);
    entry.cancelled = true;
    return { text, dialogue: null, action: null };
  }
  function continueDialogue(c, body, state, member, clock) {
    return readSteps(function* () {
      allowed(c, state);
      const operation = validateContinuation(body);
      const entry = memory.get(c, member, state, body.dialogueId);
      if (entry.data.target !== 'appointmentManagement')
        throw fail(409, 'Ответ относится к другой команде.');
      const withdrawalIntent =
        operation === 'text'
          ? unconditionalNegativeAction(body.text, (query) => {
              const patient = entry.data.patient;
              const people = [
                patient?.clientName || (patient?.label ? { name: patient.label } : null),
                ...[...entry.options.values()].slice(0, 12).map((choice) => choice.clientName),
              ];
              return people.some((person) => person && matchesName(person, query));
            })
          : null;
      const withdrawn =
        Boolean(withdrawalIntent) &&
        withdrawalIntent ===
          { cancel: 'cancelAppointment', move: 'moveAppointment' }[
            entry.data.management?.operation
          ];
      if (entry.step === 'client' && !withdrawn)
        return yield resolver.continueDialogue(c, body, state, member, clock);
      const hash = memory.fingerprint(body);
      const control =
        operation === 'text' ? dialogueControl(body.text, draftOperation(entry)) : null;
      if (entry.executionSaved && entry.lastHash === hash)
        return structuredClone(entry.executionSaved);
      if (
        entry.lastHash === hash &&
        control &&
        control !== 'stop' &&
        !entry.complete &&
        !entry.cancelled
      )
        return yield information(c, entry, control, body, state, clock, true);
      if (entry.lastHash === hash) {
        try {
          return entry.cancelled
            ? entry.response
            : yield refreshManagementReceipt(c, entry, clock, present);
        } catch (error) {
          const recovery = yield recoverCancellation(c, entry, state, member, clock, error);
          if (recovery) return recovery;
          throw error;
        }
      }
      if (entry.complete || entry.cancelled || entry.version !== body.dialogueVersion)
        throw fail(409, 'Диалог уже изменился. Повторите ответ в текущем диалоге.');
      if (entry.turns >= 40) throw fail(429, 'Слишком много уточнений. Начните новую команду.');
      if (
        entry.data.management.source &&
        operation !== 'cancel' &&
        control !== 'stop' &&
        !withdrawn
      )
        yield managementSource(c, entry.data.management.source);
      const saved = { ...entry, data: entry.data };
      entry.data = structuredClone(entry.data);
      try {
        if (control && control !== 'stop')
          return yield information(c, entry, control, body, state, clock);
        entry.version++;
        entry.turns++;
        entry.response = withdrawn
          ? cancel(entry, 'Подготовка остановлена. Запись не изменена.')
          : control === 'stop'
            ? cancel(entry, 'Подготовка остановлена. Запись не изменена.')
            : operation === 'cancel'
              ? cancel(entry)
              : operation === 'choice'
                ? yield applyChoice(
                    c,
                    entry,
                    entry.options.get(body.choice) || entry.controls.get(body.choice),
                    clock,
                  )
                : operation === 'text'
                  ? yield textTurn(c, entry, body.text, clock)
                  : (() => {
                      throw fail(400, 'Назовите новую дату или время.');
                    })();
        if (entry.response.dialogue) entry.response.dialogue.version = entry.version;
        entry.lastHash = hash;
        return entry.response;
      } catch (error) {
        Object.assign(entry, saved);
        const recovery = yield recoverCancellation(c, entry, state, member, clock, error);
        if (recovery) return recovery;
        throw error;
      }
    }).call(this);
  }
  function recoverCancellation(c, entry, state, member, clock, error) {
    return readSteps(function* () {
      if (error?.code !== 'ASSISTANT_CANCEL_CONFIRMATION_STALE') return null;
      allowed(c, state);
      if (memory.get(c, member, state, entry.id) !== entry) return null;
      if (entry.turns >= 40) throw fail(429, 'Слишком много уточнений. Начните новую команду.');
      return yield renewCancellation(c, entry, clock, error);
    }).call(this);
  }
  function recoverExecutionTime(c, entry, state, member, clock, error) {
    return readSteps(function* () {
      if (error?.code === 'ASSISTANT_CANCEL_CONFIRMATION_STALE')
        return yield recoverCancellation(c, entry, state, member, clock, error);
      allowed(c, state);
      c.assertCurrent();
      const m = entry.data.management;
      if (
        memory.get(c, member, state, entry.id) !== entry ||
        !entry.complete ||
        entry.cancelled ||
        entry.executionSaved ||
        m?.operation !== 'move' ||
        (error.code === 'APPOINTMENT_TIME_STEP' && !invalidBookingTime({ time: m.targetTime }))
      )
        return null;
      if (entry.turns >= 40) throw fail(429, 'Слишком много уточнений. Начните новую команду.');
      const previous = { ...entry };
      entry.data = structuredClone(entry.data);
      try {
        const current = entry.data.management;
        const source = yield managementSource(c, current.source);
        current.requestedTime = current.targetTime;
        current.targetTime = null;
        current.timeRequired = false;
        delete current.movePreparation;
        entry.complete = false;
        entry.version++;
        entry.turns++;
        entry.lastHash = null;
        entry.response =
          error.code === 'APPOINTMENT_TIME_STEP'
            ? yield gridResponse(c, entry, source, current.requestedTime)
            : targetResponse(
                entry,
                source,
                'time',
                'Это время уже недоступно. На какое время перенести?',
              );
        return entry.response;
      } catch (failure) {
        Object.assign(entry, previous);
        throw failure;
      }
    }).call(this);
  }
  return { start, continueDialogue, recoverExecutionTime };
}
module.exports = { createAppointmentManagementFlow };
