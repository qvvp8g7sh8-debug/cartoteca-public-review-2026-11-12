const { readSteps } = require('./../read-steps.cjs');
const { genericSpeechQuestion } = require('../speech/generic-responses.cjs');
const { monthDateView, validProposal, dayTurnConstraints } = require('./bare-day-proposal.cjs');
const { weekdayDateView } = require('./weekday-date-choice.cjs');
const { randomUUID } = require('node:crypto');
const { fail } = require('../../../../shared/errors.cjs');
const { createDialogueStore } = require('./dialogue-store.cjs');
const { dialogueControl } = require('./dialogue-control.cjs');
const { informationTurn } = require('./dialogue-control-turn.cjs');
const { minutes } = require('../../../../shared/work-schedule.cjs');
const { windowBounds } = require('../language/time/booking-time-window.cjs');
const { nearestSlotMode } = require('../actions/slot-request.cjs');
const { verifyAvailability } = require('../actions/availability.cjs');
const {
  acceptText,
  validateContinuation,
  clientSuggestionOperation,
  fastContinuationOperation,
  isFastContinuation,
} = require('./dialogue-input.cjs');
const {
  continuationQuestion,
  safeContinuationContext,
} = require('./continuation/continuation-contract.cjs');
const { continuationOperation } = require('./continuation/continuation-operation.cjs');
const { clientChoiceOperation } = require('./client-choice-names.cjs');
const { rawClarificationView } = require('./dialogue-clarification-target.cjs');
const { rejectedTimeText } = require('./dialogue-time-rejection.cjs');
const { previewConfirmation } = require('../actions/appointments/preview-confirmation.cjs');
const { beginRecovery, recoverResponse } = require('./dialogue-recovery.cjs');
const { applyServiceGroup } = require('./dialogue-service-group.cjs');
const { pickerModel, groupModelCandidates } = require('./dialogue-service-picker.cjs');
const { suggestionsOnlyQuery } = require('../language/names/name-suggestions.cjs');
const { speechOperation } = require('./dialogue-speech.cjs');
const { repairOperation } = require('./dialogue-repair-parse.cjs');
const {
  choiceTemporalComposition,
  choiceOrdinalComposition,
} = require('./choice-temporal-composition.cjs');
const {
  invalidBookingTime,
  nearestGridSlot,
  timeStepView,
} = require('../actions/appointments/appointment-time-input.cjs');
const { applyRepair, repairFocus } = require('./dialogue-repair-apply.cjs');
const { applySearchRepair } = require('./dialogue-search-repair.cjs');
const { selectChoice } = require('./dialogue-choices.cjs');
const { requestSlots, captureSearch, refreshSearch } = require('./dialogue-slots.cjs');
const {
  bookingTimeView,
  applyTimeWindow,
  bookingControl,
  inspectBookingDay,
  closedDayView,
  allowsClosedDay,
} = require('./dialogue-booking-time.cjs');
const { readOnlyAvailabilityText } = require('../actions/readonly-availability.cjs');
const {
  fields,
  clearField,
  references,
  resolveSeed,
  selectedFields,
  describe,
} = require('./dialogue-options.cjs');
function createAssistantDialogue(options = {}) {
  const memory = options.memory || createDialogueStore(options);
  const modelTurns = new WeakMap();
  function allowed(state) {
    if (!state.policy.commands.prepareAppointment)
      throw fail(403, 'Подготовка записи помощником выключена администратором.');
  }
  const information = readSteps(function* information(
    c,
    entry,
    control,
    body,
    state,
    clock,
    replay = false,
  ) {
    return yield informationTurn(entry, control, {
      refresh: readSteps(function* (fresh) {
        // Repeating a question refreshes the catalog without selecting a new
        // identity that appeared after the user's previous answer.
        const reply = yield present(c, fresh, clock, undefined, undefined, {
          resolvePending: false,
        });
        c.assertCurrent();
        return reply;
      }),
      clock,
      limit: state.policy.limits?.maxReplyChars,
      hash: memory.fingerprint(body),
      replay,
    });
  });
  function seed(intent = {}, constraints = {}) {
    const exact = constraints?.duration;
    const valid = Number.isSafeInteger(exact) && exact >= 5 && exact <= 1440 && exact % 5 === 0;
    const required = constraints?.requireDuration === true || (exact !== undefined && !valid);
    const duration = required ? null : valid ? exact : intent.duration || null;
    return {
      clientQuery: intent.query || '',
      clientSuggestionsOnly: suggestionsOnlyQuery(intent.query || ''),
      staffQuery: intent.staffQuery || '',
      serviceQuery: intent.serviceQuery || '',
      patient: null,
      staff: null,
      service: null,
      serviceChosen: false,
      useDefaultStaff: true,
      date: constraints?.date !== undefined ? constraints.date : intent.date || null,
      ...(constraints.date === null && constraints.dateRejection === 'past'
        ? { dateRejection: 'past' }
        : {}),
      ...(validProposal(constraints.dateProposal)
        ? { dateProposal: structuredClone(constraints.dateProposal) }
        : {}),
      ...(constraints.date === null && constraints.dateWeekday
        ? { dateWeekday: constraints.dateWeekday }
        : {}),
      ...(constraints.date ? { dateMonthContext: constraints.date.slice(0, 7) } : {}),
      ...(constraints.date === null && constraints.dateMonth
        ? { dateMonth: structuredClone(constraints.dateMonth) }
        : {}),
      time: constraints?.time !== undefined ? constraints.time : intent.time || null,
      timeRequired: constraints?.time === null && !constraints.timeWindow,
      timeWindow: constraints.timeWindow || null,
      timeWindowRequired: constraints.timeWindowRequired === true,
      duration,
      durationSource: required ? 'required' : duration ? 'manual' : '',
      roomId: '',
      nearestRequested: ['nearest', 'earliest'].includes(constraints.nearestRequested)
        ? constraints.nearestRequested
        : null,
      ...(constraints?.openWhenComplete === true ? { openWhenComplete: true } : {}),
      ...(constraints?.createRequested === true ? { createRequested: true } : {}),
    };
  }
  function response(entry, view, text) {
    ({ view, text } = recoverResponse(entry.data, view, text));
    entry.step = view.step;
    entry.options = new Map();
    const choices = view.choices.map((choice) => {
      const id = randomUUID();
      entry.options.set(id, choice);
      return {
        id,
        label: choice.label,
        ...(view.serviceConfirmation && choice.confirmService ? { suggested: true } : {}),
      };
    });
    entry.controls = new Map();
    const controls = (view.controls || []).map((choice) => {
      const id = randomUUID();
      entry.controls.set(id, choice);
      return { id, label: choice.label };
    });
    return {
      text: text || view.prompt,
      action: null,
      dialogue: {
        id: entry.id,
        version: entry.version,
        step: view.step,
        prompt: view.prompt,
        ...(!view.manualInputRequired && ['groups', 'services'].includes(view.serviceList)
          ? { serviceList: view.serviceList }
          : {}),
        ...(view.serviceGroupTitle ? { serviceGroupTitle: view.serviceGroupTitle } : {}),
        ...(view.serviceConfirmation ? { serviceConfirmation: true } : {}),
        ...(genericSpeechQuestion({ text: text || view.prompt, dialogue: view }) !== null
          ? { speechQuestion: view.speechQuestion }
          : {}),
        options: choices,
        ...(view.phase ? { phase: view.phase } : {}),
        ...(view.manualInputRequired === true ? { manualInputRequired: true } : {}),
        ...(controls.length ? { controls } : {}),
        fields: selectedFields(entry.data),
        canEdit:
          view.step === 'availability'
            ? []
            : fields.filter((field) => selectedFields(entry.data).some((row) => row.key === field)),
        input: view.input,
        expiresAt: entry.expiresAt,
      },
    };
  }
  function applyContinuationConstraints(data, constraints = {}) {
    for (const field of ['client', 'staff', 'service', 'date', 'time'])
      if (constraints[field] === null) {
        clearField(data, field);
        if (field === 'time') data.timeRequired = true;
      }
    if (Object.hasOwn(constraints, 'timeWindow')) {
      if (constraints.timeWindow) {
        applyTimeWindow(data, constraints.timeWindow);
        if (constraints.time) data.time = constraints.time;
      } else data.timeWindow = null;
      if (constraints.timeWindowRequired) data.timeWindowRequired = true;
    }
    if (validProposal(constraints.dateProposal))
      data.dateProposal = structuredClone(constraints.dateProposal);
    if (constraints.date === null && constraints.dateMonth)
      data.dateMonth = structuredClone(constraints.dateMonth);
    if (constraints.date === null && constraints.dateWeekday)
      data.dateWeekday = constraints.dateWeekday;
    if (constraints.date === null && constraints.dateRejection === 'past')
      data.dateRejection = 'past';
    if (constraints.requireDuration) {
      clearField(data, 'duration');
      data.durationSource = 'required';
    }
  }
  const present = readSteps(function* present(
    c,
    entry,
    clock,
    text,
    clientPrompt,
    { resolvePending = true } = {},
  ) {
    if (entry.step === 'availability' && entry.availabilitySearch) {
      const view = yield refreshSearch(c, entry.availabilitySearch, clock);
      return response(entry, view, text ? text + ' ' + view.prompt : undefined);
    }
    const context = yield references(c, entry.data);
    const clientLookup =
      !clientPrompt && resolvePending ? yield resolveSeed(c, entry.data, context) : undefined;
    if (entry.data.time) entry.data.timeRequired = false;
    if (entry.data.date && entry.data.date < clock.date) {
      clearField(entry.data, 'date');
      text = 'Дата уже прошла. Укажите новую дату.';
    }
    if (entry.data.dateWeekday) {
      const view = weekdayDateView(entry.data.dateWeekday, clock);
      if (view) return response(entry, view);
      delete entry.data.dateWeekday;
    }
    const monthDate = monthDateView(entry.data, clock);
    if (monthDate) {
      const namedMonth = entry.data.dateMonth || entry.data.dateProposal?.month;
      return response(
        entry,
        monthDate,
        namedMonth && text && text !== monthDate.prompt ? text + ' ' + monthDate.prompt : undefined,
      );
    }
    if (clientPrompt)
      return response(entry, {
        ...(yield describe(c, { ...entry.data, patient: null }, context)),
        prompt: clientPrompt,
      });
    let view = yield describe(c, entry.data, context, repairFocus(entry.data), clientLookup);
    if (['time', 'review'].includes(view.step) && invalidBookingTime(entry.data)) {
      const requested = entry.data.time;
      entry.data.time = null;
      entry.data.timeRequired = false;
      entry.data.roomId = '';
      entry.data.slotAfterTime = Number.isFinite(minutes(requested)) ? requested : '';
      const slot = yield nearestGridSlot(requested, (time) =>
        exactSlot(c, { ...entry.data, time, closedDayConfirmation: null }),
      );
      return response(entry, timeStepView(requested, slot));
    }
    if (entry.data.timeRequired && view.step === 'time')
      view = {
        ...view,
        prompt:
          'Назовите конкретное время начала, например «в 14:30». Для подбора без ограничения скажите «любое время». Остальные данные записи сохранены.',
      };
    const dayInfo = yield inspectBookingDay(c, entry.data);
    const closed = yield closedDayView(c, entry.data, dayInfo);
    if (closed) return response(entry, closed);
    if (view.step === 'review' && !(yield exactSlot(c, entry.data))) {
      const requested = entry.data.time;
      text = yield timeFailureText(c, entry.data, dayInfo);
      requestSlots(entry.data, requested, { ranges: true });
      view = yield describe(c, entry.data, context);
    }
    view = yield bookingTimeView(c, entry.data, clock, view, dayInfo);
    return response(entry, view, text ? text + ' ' + view.prompt : undefined);
  });
  const start = readSteps(function* start(
    c,
    intent,
    state,
    member,
    clock,
    ticket,
    constraints = {},
  ) {
    allowed(state);
    const entry = memory.create(c, member, state, ticket, seed(intent, constraints));
    entry.response = yield present(c, entry, clock);
    if (entry.data.openWhenComplete && entry.response.dialogue?.step === 'review')
      entry.response = yield finish(c, entry, clock);
    return entry.response;
  });
  function startAvailability(c, result, state, member, clock, ticket, intent) {
    if (!result.slots?.length) return result;
    if (!state.policy.commands.prepareAppointment) {
      return {
        ...result,
        slots: undefined,
        text: readOnlyAvailabilityText(result),
        readOnlySlots: result.slots
          .slice(0, 12)
          .map(({ date, time, endTime, duration, staffName }) => ({
            date,
            time,
            endTime,
            duration,
            staffName,
          })),
      };
    }
    const entry = memory.create(c, member, state, ticket, seed());
    entry.availabilitySearch = captureSearch(result, intent);
    entry.response = {
      ...result,
      slots: undefined,
      ...response(entry, {
        step: 'availability',
        prompt: result.text,
        input: null,
        choices: result.slots.slice(0, 12).map((slot) => ({
          kind: 'slot',
          value: slot,
          label: slot.date + ' · ' + slot.time + '–' + slot.endTime + ' · ' + slot.staffName,
        })),
      }),
    };
    return entry.response;
  }
  const exactSlot = readSteps(function* exactSlot(c, data) {
    if (!data.staff || !data.date || !data.time || !data.duration) return null;
    if (data.timeWindow) {
      const bounds = windowBounds(data.timeWindow);
      if (
        !bounds ||
        minutes(data.time) < minutes(bounds.time) ||
        minutes(data.time) + data.duration > minutes(bounds.endTime, true)
      )
        return null;
    }
    return yield verifyAvailability(c, {
      date: data.date,
      time: data.time,
      duration: data.duration,
      staffId: data.staff.id,
      serviceIds: data.service ? [data.service.id] : [],
      ...(data.roomId ? { roomId: data.roomId } : {}),
      ...(allowsClosedDay(c, data) ? { allowClosedDay: true } : {}),
    });
  });
  const timeFailureText = readSteps(function* (c, data, dayInfo) {
    return rejectedTimeText(data, dayInfo, {
      timeZone: c.assistantReads
        ? yield c.assistantReads.timeZone()
        : c.platform.organizationTimeZone(c.current.organizationId),
      closedConfirmed: allowsClosedDay(c, data),
    });
  });
  const finish = readSteps(function* finish(c, entry, clock) {
    if (entry.executionSaved) {
      c.assertCurrent();
      return structuredClone(entry.executionSaved);
    }
    const context = yield references(c, entry.data);
    const view = yield describe(c, entry.data, context);
    if (invalidBookingTime(entry.data)) {
      entry.complete = false;
      return yield present(c, entry, clock);
    }
    if (view.step !== 'review') {
      entry.complete = false;
      return yield present(
        c,
        entry,
        clock,
        'Доступные данные изменились. Уточните запись ещё раз.',
      );
    }
    const slot = yield exactSlot(c, entry.data);
    if (!slot) {
      const text = yield timeFailureText(c, entry.data, yield inspectBookingDay(c, entry.data));
      requestSlots(entry.data, entry.data.time, { ranges: true });
      entry.complete = false;
      return yield present(c, entry, clock, text);
    }
    c.assertCurrent();
    entry.complete = true;
    const create =
      options.appointmentSavingEnabled === true &&
      entry.data.createRequested === true &&
      Boolean(entry.data.service?.id);
    return {
      text: create ? 'Записываю.' : previewConfirmation(entry.data, slot, clock, c.current),
      dialogue: null,
      action: {
        type: create ? 'createAppointment' : 'prepareAppointment',
        ...(create ? { executionId: entry.id } : {}),
        patientId: entry.data.patient.id,
        staffId: slot.staffId,
        date: slot.date,
        time: slot.time,
        duration: slot.duration,
        ...(slot.roomId ? { roomId: slot.roomId } : {}),
        ...(entry.data.service ? { serviceIds: [entry.data.service.id] } : {}),
      },
    };
  });
  const recoverExecutionTime = readSteps(
    function* recoverExecutionTime(c, entry, state, member, clock, error) {
      allowed(state);
      c.assertCurrent();
      if (
        memory.get(c, member, state, entry.id) !== entry ||
        !entry.complete ||
        entry.cancelled ||
        entry.executionSaved ||
        entry.data.target ||
        (error.code === 'APPOINTMENT_TIME_STEP' && !invalidBookingTime(entry.data))
      )
        return null;
      if (entry.turns >= 40) throw fail(429, 'Слишком много уточнений. Начните новую команду.');
      const previous = { ...entry };
      entry.data = structuredClone(entry.data);
      try {
        const requested = entry.data.time;
        const grid = invalidBookingTime(entry.data);
        const reason = grid
          ? null
          : yield timeFailureText(c, entry.data, yield inspectBookingDay(c, entry.data));
        entry.complete = false;
        entry.version++;
        entry.turns++;
        entry.lastHash = null;
        if (grid) {
          entry.response = yield present(c, entry, clock);
        } else {
          requestSlots(entry.data, requested, { ranges: true });
          entry.response = yield present(c, entry, clock, reason);
        }
        return entry.response;
      } catch (failure) {
        Object.assign(entry, previous);
        throw failure;
      }
    },
  );
  const selectedModelContext = readSteps(function* selectedModelContext(c, entry, selection) {
    const fresh = {
      ...entry,
      data: structuredClone(entry.data),
      options: new Map(),
      controls: new Map(),
    };
    const choice = entry.options.get(selection.choice);
    if (!choice || !(yield selectChoice(c, fresh.data, choice)))
      throw fail(409, 'Выбор изменился. Уточните его ещё раз.');
    const context = yield references(c, fresh.data);
    const clientLookup = yield resolveSeed(c, fresh.data, context);
    fresh.step = (yield describe(
      c,
      fresh.data,
      context,
      repairFocus(fresh.data),
      clientLookup,
    )).step;
    return fresh;
  });
  const prepareModelTurn = readSteps(
    function* prepareModelTurn(c, body, state, member, clock, local) {
      const operation = validateContinuation(body);
      if (operation !== 'text') return null;
      c.assertCurrent();
      allowed(state);
      const entry = memory.get(c, member, state, body.dialogueId);
      if (entry.lastHash === memory.fingerprint(body)) return null;
      if (entry.cancelled || entry.complete || body.dialogueVersion !== entry.version)
        throw fail(
          409,
          'Диалог уже изменился. Повторите последний ответ или начните новую команду.',
        );
      if (entry.turns >= 40) throw fail(429, 'Слишком много уточнений. Начните новую команду.');
      if (choiceTemporalComposition(entry, body.text, clock)) return null;
      const clientInput = yield clientChoiceOperation(c, entry, body.text);
      // The dispatcher can consume this answer inside the same read phase.
      // Its ordinary identity, version and final choice checks still run.
      if (local) Object.assign(local, { entry, body, clientInput });
      if (clientInput || (yield isFastContinuation(body.text, entry, clock, c, local))) return null;
      const repair = repairOperation(entry, body.text, clock, { futureMonth: true });
      if (repair && ['edit', 'rejectTime', 'patch', 'shiftTime', 'shiftDate'].includes(repair.kind))
        return null;
      const selection = choiceOrdinalComposition(entry, body.text);
      const contextEntry = selection ? yield selectedModelContext(c, entry, selection) : entry;
      let serviceCandidates;
      if (!selection && entry.step === 'service' && entry.data.servicePicker?.categoryId) {
        const data = {
          ...entry.data,
          servicePicker: { ...entry.data.servicePicker, answer: body.text, suggestedName: '' },
        };
        const group = yield pickerModel(c, data, yield references(c, data));
        if (group.candidate) return null;
        if (group.categoryId) serviceCandidates = groupModelCandidates(group);
      }
      const snapshot = {
        token: randomUUID(),
        text: body.text,
        context: {
          ...safeContinuationContext(contextEntry, c.current.role, clock),
          ...(selection ? { selectionApplied: { field: entry.step } } : {}),
          ...(serviceCandidates?.length ? { serviceCandidates } : {}),
        },
      };
      modelTurns.set(snapshot, {
        id: entry.id,
        version: entry.version,
        hash: memory.fingerprint(body),
        text: body.text,
        context: JSON.stringify(snapshot.context),
        data: JSON.stringify(entry.data),
        choices: JSON.stringify([...entry.options]),
        controls: JSON.stringify([...(entry.controls || [])]),
        ...(selection ? { selection } : {}),
      });
      return snapshot;
    },
  );
  const assertModelTurn = readSteps(function* assertModelTurn(c, body, state, member, snapshot) {
    c.assertCurrent();
    allowed(state);
    const captured = modelTurns.get(snapshot);
    const entry = memory.get(c, member, state, body.dialogueId);
    if (
      !captured ||
      captured.id !== entry.id ||
      captured.version !== entry.version ||
      captured.text !== body.text ||
      snapshot.text !== body.text ||
      captured.context !== JSON.stringify(snapshot.context) ||
      captured.hash !== memory.fingerprint(body) ||
      body.dialogueVersion !== entry.version ||
      entry.cancelled ||
      entry.complete ||
      captured.data !== JSON.stringify(entry.data) ||
      captured.choices !== JSON.stringify([...entry.options]) ||
      captured.controls !== JSON.stringify([...(entry.controls || [])])
    )
      throw fail(409, 'Диалог изменился во время ответа помощника. Повторите нужное уточнение.');
    const fresh = structuredClone(entry.data);
    yield references(c, fresh);
    if (JSON.stringify(fresh) !== captured.data)
      throw fail(409, 'Доступные данные изменились. Повторите уточнение записи.');
    return entry;
  });
  // A rejected model wire reply never becomes an operation. Repeat only the
  // already-owned clarification after the same fresh snapshot and ACL checks.
  const recoverModelTurn = readSteps(function* recoverModelTurn(c, body, state, member, snapshot) {
    const entry = yield assertModelTurn(c, body, state, member, snapshot);
    if (entry.turns >= 40) throw fail(429, 'Слишком много уточнений. Начните новую команду.');
    const current = entry.response;
    if (
      current?.action !== null ||
      !current.dialogue ||
      current.dialogue.id !== entry.id ||
      current.dialogue.version !== entry.version
    )
      throw fail(409, 'Диалог изменился. Повторите нужное уточнение.');
    const reply = structuredClone(current);
    reply.text = 'Повторите, пожалуйста. ' + current.dialogue.prompt;
    reply.action = null;
    reply.dialogue.version = entry.version + 1;
    entry.version++;
    entry.turns++;
    entry.lastHash = memory.fingerprint(body);
    entry.response = reply;
    return reply;
  });
  const applyModelTurn = readSteps(
    function* applyModelTurn(c, body, state, member, clock, proposal, snapshot) {
      const entry = yield assertModelTurn(c, body, state, member, snapshot);
      const selection = modelTurns.get(snapshot)?.selection;
      const interpretationEntry = selection
        ? yield selectedModelContext(c, entry, selection)
        : entry;
      let input;
      const serviceCandidates = snapshot.context.serviceCandidates;
      if (
        serviceCandidates?.length &&
        ((proposal.operation === 'clarify' && proposal.field === 'service') ||
          (proposal.operation === 'patch' &&
            proposal.fields.service &&
            Object.values(proposal.fields).filter((value) => value !== null).length === 1))
      ) {
        const name = proposal.fields.service;
        return yield continueDialogue(c, body, state, member, clock, {
          kind: 'text',
          text: body.text,
          ...(serviceCandidates.includes(name) ? { suggestedName: name } : {}),
        });
      }
      try {
        input = continuationOperation(
          proposal,
          selection ? { ...snapshot, text: selection.remainder } : snapshot,
          interpretationEntry,
          clock,
        );
        if (selection && input.requiresClarification) {
          input = {
            kind: 'localHelp',
            text: continuationQuestion(entry.step),
            requiresClarification: true,
          };
        } else if (
          selection &&
          (input.kind === 'modelPatch' ||
            (input.kind === 'modelClarify' && Object.keys(input.constraints || {}).length))
        )
          input.selectedChoice = selection.choice;
      } catch (error) {
        if (error.status !== 400) throw error;
        input = { kind: 'localHelp', text: error.message };
      }
      if (input.kind === 'modelPatch') {
        let known;
        try {
          known = repairOperation(entry, body.text, clock, { futureMonth: true });
        } catch (error) {
          if (error.status !== 400) throw error;
        }
        if (known && ['shiftTime', 'shiftDate'].includes(known.kind)) {
          const preview = {
            data: structuredClone(entry.data),
            availabilitySearch: structuredClone(entry.availabilitySearch),
          };
          const checked = entry.availabilitySearch
            ? applySearchRepair(preview, known, clock)
            : applyRepair(preview, known, clock);
          const field = known.kind === 'shiftTime' ? 'time' : 'date';
          const proposed = input.edits.find((row) => row.field === field)?.text;
          const expected = preview.availabilitySearch
            ? (preview.availabilitySearch.intent || preview.availabilitySearch.values)[field] ||
              (field === 'date' ? preview.availabilitySearch.values?.from : null)
            : preview.data[field];
          if (
            (checked.message && !entry.availabilitySearch) ||
            !proposed ||
            expected !== proposed ||
            input.edits.some((row) => row.field !== field)
          )
            input = {
              kind: 'modelClarify',
              field,
              constraints: {},
              message: checked.message,
            };
        }
      }
      return yield continueDialogue(c, body, state, member, clock, input);
    },
  );
  const continueDialogue = readSteps(
    function* continueDialogue(c, body, state, member, clock, modelInput, local) {
      const operation = validateContinuation(body);
      let entry;
      try {
        entry = memory.get(c, member, state, body.dialogueId);
      } catch (error) {
        if (body.cancel !== true) throw error;
      }
      if (body.cancel === true) {
        if (entry) memory.remove(entry.id);
        return {
          text: 'Подготовка записи отменена.',
          draftCancelled: true,
          action: null,
          dialogue: null,
        };
      }
      allowed(state);
      const hash = memory.fingerprint(body);
      const control =
        operation === 'text' && !modelInput ? dialogueControl(body.text, 'create') : null;
      if (entry.cancelled) {
        if (entry.lastHash === hash) return entry.response;
        throw fail(409, 'Подготовка уже отменена. Начните новую команду.');
      }
      if (entry.lastHash === hash) {
        if (control && control !== 'stop' && !entry.complete)
          return yield information(c, entry, control, body, state, clock, true);
        if (entry.complete) {
          entry.response = yield finish(c, entry, clock);
          return entry.response;
        }
        const pendingClientOptions =
          entry.step === 'client' &&
          !entry.data.patient &&
          entry.options.size > 0 &&
          [...entry.options.values()].every((choice) => choice.kind === 'client');
        const pendingServiceOptions =
          entry.step === 'service' && !entry.data.serviceChosen && Boolean(entry.data.serviceQuery);
        const previous = JSON.stringify(entry.data);
        const context = yield references(c, entry.data);
        if (pendingClientOptions || pendingServiceOptions) {
          const view = recoverResponse(
            entry.data,
            yield describe(c, entry.data, context, repairFocus(entry.data)),
          ).view;
          if (
            previous !== JSON.stringify(entry.data) ||
            entry.response.dialogue.prompt !== view.prompt ||
            JSON.stringify([...entry.options.values()]) !== JSON.stringify(view.choices)
          ) {
            entry.version++;
            entry.response = response(
              entry,
              view,
              'Данные изменились. Проверьте уточнения ещё раз. ' + view.prompt,
            );
          }
          return entry.response;
        }
        if (previous !== JSON.stringify(entry.data)) {
          entry.version++;
          entry.response = yield present(
            c,
            entry,
            clock,
            'Данные изменились. Проверьте уточнения ещё раз.',
          );
        }
        return entry.response;
      }
      if (body.dialogueVersion !== entry.version || entry.complete)
        throw fail(
          409,
          'Диалог уже изменился. Повторите последний ответ или начните новую команду.',
        );
      if (entry.turns >= 40) {
        memory.remove(entry.id);
        throw fail(429, 'Слишком много уточнений. Начните новую команду.');
      }
      const saved = {
        data: entry.data,
        version: entry.version,
        turns: entry.turns,
        options: entry.options,
        controls: entry.controls,
        step: entry.step,
        complete: entry.complete,
        response: entry.response,
        availabilitySearch: entry.availabilitySearch,
      };
      entry.data = structuredClone(entry.data);
      try {
        if (control && control !== 'stop')
          return yield information(c, entry, control, body, state, clock);
        let ready = false,
          accepted = false,
          message;
        const clientInput =
          operation === 'text' && !modelInput
            ? local?.entry === entry && local.body === body
              ? local.clientInput
              : yield clientChoiceOperation(c, entry, body.text)
            : null;
        const input =
          modelInput ||
          (control === 'stop' ? { kind: 'cancel', draftOnly: true } : null) ||
          (operation === 'text'
            ? clientInput ||
              choiceTemporalComposition(entry, body.text, clock) ||
              (local?.entry === entry && local.body === body ? local.bookingInput : null) ||
              (yield fastContinuationOperation(entry, body.text, clock, c)) ||
              clientSuggestionOperation(entry, body.text) ||
              repairOperation(entry, body.text, clock, { futureMonth: true }) ||
              speechOperation(entry, body.text)
            : { kind: operation, field: body.edit, choice: body.choice });
        const dayProof =
          operation === 'text' && !input.requiresClarification
            ? dayTurnConstraints(entry, body.text, clock)
            : null;
        beginRecovery(entry, {
          operation,
          input,
          text: body.text,
          clientAnswer: input === clientInput,
        });
        if (input.kind === 'cancel') {
          memory.invalidatePending(entry.accountId);
          entry.cancelled = true;
          entry.data = {};
          entry.options = new Map();
          entry.controls = new Map();
          entry.availabilitySearch = null;
          entry.lastHash = hash;
          entry.response = {
            text: input.draftOnly
              ? 'Подготовка записи остановлена.'
              : 'Подготовка записи отменена.',
            draftCancelled: true,
            action: null,
            dialogue: null,
          };
          return entry.response;
        }
        if (input.kind === 'modelPatch' || input.kind === 'modelClarify') {
          if (input.selectedChoice) {
            const choice = entry.options.get(input.selectedChoice);
            if (!choice || !(yield selectChoice(c, entry.data, choice)))
              throw fail(409, 'Выбор изменился. Уточните его ещё раз.');
          }
          if (input.kind === 'modelPatch') {
            const patch = { kind: 'patch', edits: input.edits };
            const applied = !input.edits.length
              ? {}
              : entry.availabilitySearch
                ? applySearchRepair(entry, patch, clock)
                : applyRepair(entry, patch, clock);
            message = applied.message;
            accepted = input.edits.length > 0 && !message;
            if (input.seekSlots && !message && !entry.availabilitySearch) {
              if (input.anyTime) entry.data.timeRequired = false;
              requestSlots(
                entry.data,
                input.anyTime ? '' : entry.data.time || entry.data.slotAfterTime || '',
                { nearest: nearestSlotMode(body.text) },
              );
            }
          } else {
            message = input.message || continuationQuestion(input.field);
            const proven =
              input.edits ||
              ['date', 'time', 'duration'].flatMap((field) =>
                input.constraints?.[field] !== null && input.constraints?.[field] !== undefined
                  ? [{ field, text: String(input.constraints[field]) }]
                  : [],
              );
            if (proven.length) {
              const applied = applyRepair(entry, { kind: 'patch', edits: proven }, clock);
              if (applied.message) message = applied.message;
            }
          }
          applyContinuationConstraints(entry.data, input.constraints);
        } else if (input.kind === 'choicePatch') {
          if (yield selectChoice(c, entry.data, entry.options.get(input.choice))) {
            const applied = input.edits.length
              ? applyRepair(entry, { kind: 'patch', edits: input.edits }, clock)
              : {};
            message = applied.message;
            accepted = !message;
            applyContinuationConstraints(entry.data, input.constraints);
          } else message = 'Этот вариант уже недоступен. Уточните выбор.';
        } else if (input.kind === 'dateMonthSelect') {
          clearField(entry.data, 'date');
          entry.data.dateMonth = input.month;
          accepted = true;
        } else if (input.kind === 'dateMonthPropose') {
          clearField(entry.data, 'date');
          entry.data.dateProposal = structuredClone(input.proposal);
          message = input.message;
          accepted = true;
        } else if (input.kind === 'dateMonthReject') {
          entry.data.dateProposal.date = null;
          accepted = true;
        } else if (input.kind === 'clientPhoneClarify') {
          message = input.message;
        } else if (input.kind === 'timeWindow') {
          applyTimeWindow(entry.data, input.window);
          accepted = true;
        } else if (input.kind === 'bookingControl') {
          bookingControl(entry.data, { kind: input.control });
          accepted = true;
        } else if (input.kind === 'serviceGroup') {
          yield applyServiceGroup(c, entry.data, input, yield references(c, entry.data));
        } else if (input.kind === 'localHelp') {
          if (entry.step === 'client' && suggestionsOnlyQuery(body.text))
            acceptText(entry.data, 'client', body.text, clock);
          else message = input.text;
        } else if (['patch', 'shiftTime', 'shiftDate', 'rejectTime'].includes(input.kind)) {
          const applied =
            entry.step === 'availability' && entry.availabilitySearch
              ? applySearchRepair(entry, input, clock)
              : applyRepair(entry, input, clock);
          message = applied.message;
          accepted = !message;
        } else if (input.kind === 'edit') {
          if (entry.step === 'availability' && entry.availabilitySearch)
            message = applySearchRepair(entry, input, clock).message;
          else {
            clearField(entry.data, input.field);
            entry.data.repairField = input.field;
            if (input.text) {
              acceptText(entry.data, input.field, input.text, clock);
              accepted = true;
            } else if (
              input.field === 'staff' &&
              (yield references(c, entry.data)).members.length === 1
            )
              entry.data.useDefaultStaff = true;
          }
        } else if (input.kind === 'slots') {
          if (!entry.availabilitySearch && (!entry.data.staff || !entry.data.date))
            throw fail(400, 'Сначала назовите специалиста и дату записи.');
          if (!entry.availabilitySearch) {
            if (input.anyTime === true) entry.data.timeRequired = false;
            requestSlots(
              entry.data,
              input.anyTime === true ? '' : entry.data.time || entry.data.slotAfterTime || '',
              { nearest: nearestSlotMode(body.text) },
            );
          }
        } else if (input.kind === 'text') {
          acceptText(entry.data, entry.step, input.text, clock);
          if (input.suggestedName && entry.data.servicePicker?.categoryId)
            entry.data.servicePicker.suggestedName = input.suggestedName;
          accepted = true;
        } else {
          const choice = entry.options.get(input.choice) || entry.controls?.get(input.choice);
          if (!choice)
            throw fail(409, 'Этот вариант устарел. Используйте текущие варианты диалога.');
          ready = choice.kind === 'ready';
          if (choice.kind === 'dateMonth') {
            const proposal = entry.data.dateProposal;
            if (
              !validProposal(proposal) ||
              choice.value !== proposal.date ||
              choice.day !== proposal.day ||
              choice.value < clock.date
            )
              throw fail(409, 'Дата изменилась. Уточните её ещё раз.');
            clearField(entry.data, 'date');
            acceptText(entry.data, 'date', choice.value, clock);
            accepted = true;
          } else if (!ready && bookingControl(entry.data, choice)) accepted = true;
          else if (!ready) {
            if (!(yield selectChoice(c, entry.data, choice)))
              message = 'Это окно уже недоступно. Предлагаю актуальные варианты.';
            else {
              accepted = true;
              if (choice.kind === 'slot') entry.availabilitySearch = null;
            }
          }
        }
        // A model fallback may lose its constraints while explaining another field.
        // Retain the independently proven day, never the model's guessed month.
        if (dayProof) {
          clearField(entry.data, 'date');
          if (dayProof.date) acceptText(entry.data, 'date', dayProof.date, clock);
          else {
            entry.data.dateProposal = structuredClone(dayProof.dateProposal);
            ready = false;
            message = undefined;
          }
          accepted = true;
        }
        entry.turns++;
        entry.version++;
        // Only an explicit user question can refocus a filled field; a model suggestion cannot.
        const clarification =
          input.kind === 'modelClarify' ? rawClarificationView(body.text) : null;
        entry.response = clarification
          ? response(entry, clarification)
          : ready
            ? yield finish(c, entry, clock)
            : yield present(
                c,
                entry,
                clock,
                ['modelClarify', 'clientPhoneClarify'].includes(input.kind) ? undefined : message,
                input.kind === 'clientPhoneClarify' ? input.message : undefined,
              );
        if (
          accepted &&
          !input.requiresClarification &&
          entry.data.openWhenComplete &&
          entry.response.dialogue?.step === 'review'
        )
          entry.response = yield finish(c, entry, clock);
        entry.lastHash = hash;
        return entry.response;
      } catch (error) {
        Object.assign(entry, saved);
        throw error;
      }
    },
  );
  return {
    ...memory,
    start,
    startAvailability,
    continueDialogue,
    prepareModelTurn,
    assertModelTurn,
    recoverModelTurn,
    recoverExecutionTime,
    applyModelTurn,
  };
}
module.exports = { createAssistantDialogue };
