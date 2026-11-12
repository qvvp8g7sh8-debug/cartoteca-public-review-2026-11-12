const { fail } = require('../../../shared/errors.cjs');
const { assertTransport } = require('./buffered-request.cjs');
const { createAssistantStore } = require('./access/store.cjs');
const { createAssistantPolicy } = require('./access/policy.cjs');
const { createAssistantAdministration } = require('./access/administration.cjs');
const { createAssistantBudget } = require('./access/budget.cjs');
const { createAssistantTaskQuota } = require('./access/task-quota.cjs');
const { boundedText, keys } = require('./access/defaults.cjs');
const { callTimeweb } = require('./providers/timeweb/timeweb.cjs');
const { createSpeechService } = require('./speech/speech-service.cjs');
const { wavAudio } = require('./speech/audio.cjs');
const { validateLocalAudio } = require('./providers/local-speech/local-speech-audio.cjs');
const { modelPayload, demoIntent } = require('./interpretation/intents.cjs');
const { parseInitialModelResponse } = require('./interpretation/initial-model-response.cjs');
const { intentRequestConstraints } = require('./interpretation/intent-request-duration.cjs');
const { bookingTemporalConstraints } = require('./language/time/booking-temporal-constraints.cjs');
const { initialTemporalConstraints } = require('./language/time/initial-temporal-constraints.cjs');
const { handoff } = require('./actions/actions.cjs');
const { createAssistantDialogue } = require('./dialogue/dialogue-flow.cjs');
const { createDialogueStore } = require('./dialogue/dialogue-store.cjs');
const { readSteps } = require('./read-steps.cjs');
const { createPendingDialogueReads } = require('./dialogue/dialogue-pending-reads.cjs');
const { dialogueControl, draftOperation } = require('./dialogue/dialogue-control.cjs');
const { createClientCardFlow } = require('./actions/client-card-flow.cjs');
const {
  createAppointmentManagementFlow,
} = require('./actions/appointments/appointment-management-flow.cjs');
const {
  prepareManagementIntent,
  normalizeManagementRequest,
} = require('./actions/appointments/appointment-management-intent.cjs');
const {
  assertIntentAction,
  assertEarlyNegativeAction,
} = require('./interpretation/intent-action-grounding.cjs');
const { zonedClock } = require('../../../shared/time-zone.cjs');
const { createContinuationRuntime } = require('./dialogue/continuation/continuation-runtime.cjs');
const {
  managementCommandReply,
} = require('./actions/appointments/appointment-management-command.cjs');
const { localSpeechHints } = require('./providers/local-speech/local-speech-hints.cjs');
const { initialEntities } = require('./interpretation/entity-provenance.cjs');
const { createAppointmentExecution } = require('./actions/appointments/appointment-execution.cjs');
const { detectRequestedOperation } = require('./interpretation/requested-operation.cjs');
const {
  managementCommandTransition,
  needsTransitionClock,
} = require('./dialogue/dialogue-command-transition.cjs');
const { validateContinuation } = require('./dialogue/dialogue-input.cjs');
const { nearestSlotMode } = require('./actions/slot-request.cjs');
const { calendarReadIntent } = require('./actions/calendar-read-request.cjs');
const {
  availabilityReadIntent,
  availabilityReadParts,
} = require('./actions/availability-read-request.cjs');
const { clientReadIntent } = require('./actions/client-read-request.cjs');
const { appointmentCreateIntent } = require('./actions/appointment-create-request.cjs');
const {
  appointmentCreateServiceIntent,
} = require('./actions/appointment-create-service-request.cjs');
const { appointmentContext } = require('./actions/availability-context.cjs');
const { assistantGuidanceRequest } = require('./actions/assistant-guidance-request.cjs');
const { resolveClient } = require('./language/names/name-directory.cjs');
const { matchesName } = require('./language/names/name-matching.cjs');
const { normalizeIntent, validateCommandFields } = require('./interpretation/intent-schema.cjs');
const {
  beginAssistantTiming,
  assistantOutcome,
} = require('../../infrastructure/assistant-timing.cjs');
function usageCost(kind, rates, usage) {
  const input = usage?.prompt_tokens ?? usage?.input_tokens;
  const output = usage?.completion_tokens ?? usage?.output_tokens;
  if (
    !Number.isSafeInteger(input) ||
    input < 0 ||
    input > 10000000 ||
    !Number.isSafeInteger(output) ||
    output < 0 ||
    output > 1000000
  )
    return null;
  return (input * rates[kind + 'Input'] + output * rates[kind + 'Output']) / 1000000;
}
function createAssistant(
  context,
  {
    directory,
    fetchImpl,
    codex,
    localSpeech,
    dialogueCapacity = undefined,
    speechTicketCapacity = undefined,
    speechPermitCapacity = undefined,
    appointmentSavingEnabled = false,
    assertExecutorOwned = null,
    stateBackend = 'file',
  } = {},
) {
  const store = createAssistantStore({ ...context, directory, backend: stateBackend });
  const policy = createAssistantPolicy(context, store, { codex, localSpeech });
  const admin = createAssistantAdministration(context, store, policy);
  const budget = createAssistantBudget(context, store, policy);
  const memory = createDialogueStore({ capacity: dialogueCapacity });
  const pendingReads = createPendingDialogueReads({
    scope,
    fingerprint: memory.fingerprint,
    isStop(c, body) {
      const fresh = scope(c, body.policyVersion);
      const entry = memory.get(c, fresh.member, fresh.state, body.dialogueId);
      return dialogueControl(body.text, draftOperation(entry)) === 'stop';
    },
    verify(c, body, fresh) {
      const entry = memory.get(c, fresh.member, fresh.state, body.dialogueId);
      if (entry.cancelled || entry.lastHash !== memory.fingerprint(body))
        throw fail(409, 'Диалог изменился. Повторите ответ в текущем диалоге.');
    },
  });
  const turnCounts = {
    localCalendar: 0,
    localAvailability: 0,
    localClients: 0,
    localClientCard: 0,
    localPrepareAppointment: 0,
    localHelp: 0,
    model: 0,
  };
  const dialogues = createAssistantDialogue({ memory, appointmentSavingEnabled });
  const quota = createAssistantTaskQuota(context, dialogues, scope, { speechPermitCapacity });
  const speech = createSpeechService({
    scope,
    invoke,
    budget,
    fetchImpl,
    authorizeSpeech: quota.authorizeSpeech,
    taskEvidence: quota.evidence,
    ticketCapacity: speechTicketCapacity,
  });
  const clientCards = createClientCardFlow({ memory });
  const appointments = createAppointmentManagementFlow({ memory, appointmentSavingEnabled });
  const continuation = createContinuationRuntime({
    dialogues,
    scope,
    invoke,
    timeZone: context.organizationTimeZone,
  });
  const executions = createAppointmentExecution({
    dialogues,
    scope,
    currentScope(c) {
      c.assertCurrent();
      const current = policy.access(c.current);
      return scope(c, current.policyVersion);
    },
    enabled: appointmentSavingEnabled === true,
    assertExecutorOwned,
    recoverExecutionTime(c, entry, fresh, error, instant) {
      const flow = entry.data.target === 'appointmentManagement' ? appointments : dialogues;
      const clock = zonedClock(
        new Date(instant),
        context.organizationTimeZone(c.current.organizationId),
      );
      return flow.recoverExecutionTime(c, entry, fresh.state, fresh.member, clock, error);
    },
  });
  const savingEnabled = (state) =>
    appointmentSavingEnabled === true &&
    state.policy.commands.prepareAppointment &&
    state.providers.llm.provider !== 'demo';
  function access(current) {
    try {
      const { state, scope: result } = policy.inspectAccess(current);
      // Public disabled-feature reads do not stat the executor lock.
      if (result.enabled) assertExecutorOwned?.();
      if (!result.enabled && current?.accountId) {
        speech.clearAccount(current.accountId);
        quota.clearAccount(current.accountId);
        dialogues.clearAccount(current.accountId);
        continuation.clearAccount(current.accountId);
      }
      return { ...result, appointmentSavingEnabled: result.enabled && savingEnabled(state) };
    } catch {
      return {
        enabled: false,
        organizationId: current?.organizationId || null,
        policyVersion: 0,
        appointmentSavingEnabled: false,
      };
    }
  }
  function scope(c, version) {
    const end = beginAssistantTiming(c.assistantTiming, 'access', 'turn', 'none');
    let outcome = 'completed';
    try {
      assertTransport(c);
      c.assertCurrent();
      assertExecutorOwned?.();
      try {
        return policy.requireScope(c.current, version);
      } catch (error) {
        if (error.status) throw error;
        throw fail(503, 'Настройки помощника недоступны.');
      }
    } catch (error) {
      outcome = assistantOutcome(error);
      throw error;
    } finally {
      end(outcome);
    }
  }
  async function invoke(c, version, kind, state, payload, reservationRub, demo, accept = () => {}) {
    scope(c, version);
    const provider = state.providers[kind];
    if (provider.provider === 'timeweb' && !state.credentials.timeweb)
      throw fail(503, 'Провайдер не настроен. Обратитесь к администратору.');
    if (provider.provider === 'codex' && !policy.providerStatus().codex.available)
      throw fail(503, 'Локальное подключение Codex недоступно. Выберите настроенного провайдера.');
    if (provider.provider === 'local' && !policy.providerStatus().local[kind]?.available)
      throw fail(
        503,
        'Локальная речь недоступна. Проверьте установку и разрешённый локальный режим.',
      );
    const timeweb = provider.provider === 'timeweb';
    const timing = c.assistantTiming;
    const admissionEnd = beginAssistantTiming(timing, 'admission', kind, provider.provider);
    let reservation;
    try {
      reservation = budget.reserve(
        c.current,
        version,
        kind,
        timeweb ? reservationRub : 0,
        quota.evidence(c),
      );
      if (reservation && typeof reservation.then === 'function') reservation = await reservation;
      admissionEnd();
    } catch (error) {
      admissionEnd(assistantOutcome(error));
      throw error;
    }
    let outbound = false,
      settled = false;
    const guard = () => scope(c, version);
    let preparationEnd, providerEnd, settlementEnd;
    try {
      scope(c, version);
      preparationEnd = beginAssistantTiming(timing, 'provider-prepare', kind, provider.provider);
      providerEnd = beginAssistantTiming(timing, 'provider-complete', kind, provider.provider);
      const options = {
        provider,
        payload,
        timeoutMs: state.policy.limits.requestTimeoutMs,
        guard,
        assistantTiming: timing,
        onOutbound: () => {
          guard();
          preparationEnd();
          const end = beginAssistantTiming(timing, 'outbound-mark', kind, provider.provider);
          let mark;
          try {
            mark = budget.markOutbound(reservation);
          } catch (error) {
            end(assistantOutcome(error));
            throw error;
          }
          const finish = readSteps(function* () {
            try {
              guard();
              yield accept();
              guard();
              quota.outbound(c.assistantTask);
              outbound = true;
              end();
            } catch (error) {
              end(assistantOutcome(error));
              throw error;
            }
          });
          if (mark && typeof mark.then === 'function')
            return mark.then(finish, (error) => {
              end(assistantOutcome(error));
              throw error;
            });
          return finish();
        },
      };
      let result;
      if (provider.provider === 'demo') {
        guard();
        await accept();
        result = demo();
      } else if (provider.provider === 'codex') result = await codex.run(options);
      else if (provider.provider === 'local') result = await localSpeech.run({ ...options, kind });
      else
        result = await callTimeweb({
          ...options,
          kind,
          key: state.credentials.timeweb,
          fetchImpl,
          signal: c.transportAbortSignal,
        });
      preparationEnd();
      providerEnd();
      const cost = timeweb ? usageCost(kind, state.rates, result.usage) : 0;
      settlementEnd = beginAssistantTiming(timing, 'settlement', kind, provider.provider);
      let settlement = budget.settle(reservation, cost);
      if (settlement && typeof settlement.then === 'function') settlement = await settlement;
      settlementEnd();
      settled = true;
      guard();
      await accept();
      return {
        ...result,
        demo: provider.provider === 'demo',
        usage: {
          estimatedRub: reservation.paid
            ? settlement.chargedMicrorub / 1000000
            : (cost ?? reservation.amount),
          ...(reservation.paid
            ? { billing: reservation.packageCovered ? 'package' : 'organization-balance' }
            : {}),
          estimated: true,
          kind,
          ...(!reservation.paid && provider.provider === 'codex'
            ? { billing: 'codex-subscription' }
            : {}),
          ...(!reservation.paid && provider.provider === 'local' ? { billing: 'local' } : {}),
        },
      };
    } catch (error) {
      preparationEnd?.(assistantOutcome(error));
      providerEnd?.(assistantOutcome(error));
      settlementEnd?.(assistantOutcome(error));
      if (!settled) {
        const end = beginAssistantTiming(timing, 'settlement', kind, provider.provider);
        try {
          const settlement = budget.settle(reservation, timeweb && outbound ? null : 0);
          if (settlement && typeof settlement.then === 'function') await settlement;
          end();
        } catch (failure) {
          end(assistantOutcome(failure));
          throw failure;
        }
      }
      throw error;
    }
  }
  async function turn(c, body, availabilityOnly = false) {
    keys(body, [
      'text',
      'policyVersion',
      'dialogueId',
      'dialogueVersion',
      'choice',
      'edit',
      'cancel',
      'newCommand',
      'taskRequestId',
      'speech',
    ]);
    if (body.speech !== undefined) {
      keys(body.speech, ['format', 'stream', 'mode']);
      if (
        body.speech.format !== 'pcm' ||
        body.speech.stream !== true ||
        body.speech.mode !== 'answerable'
      )
        throw fail(400, 'Выберите поддерживаемый режим озвучивания ответа.');
    }
    const fresh = scope(c, body.policyVersion);
    const result = await quota.response(
      c,
      body.policyVersion,
      (owned) => {
        return owned.assistantReads || context.assistantReads
          ? pendingReads.run(owned, body, (shared) =>
              memory.runIsolated(() =>
                runTurn(readContext(shared), body, fresh.state, fresh.member, availabilityOnly),
              ),
            )
          : runTurn(owned, body, fresh.state, fresh.member, availabilityOnly);
      },
      fresh.scope.billing?.paid === true,
    );
    // A descriptor is optional presentation metadata, outside semantic replay
    // and the read phase. Its failure cannot undo an already accepted turn.
    return speech.prepareTurnSpeech(c, body, result);
  }
  function readContext(c) {
    if (!c.assistantReads && !context.assistantReads) return c;
    const prepared = {
      ...c,
      assertAssistantReadCurrent() {
        assertTransport(c);
        memory.assertIsolated();
      },
    };
    if (!prepared.assistantReads) prepared.assistantReads = context.assistantReads.bind(prepared);
    return prepared;
  }
  async function runTurn(c, body, state, member, availabilityOnly) {
    if (body.newCommand !== undefined && body.newCommand !== true)
      throw fail(400, 'Новая команда должна быть выбрана явно.');
    if (body.dialogueId !== undefined && body.newCommand !== true) {
      if (typeof body.dialogueId !== 'string' || body.dialogueId.length > 64)
        throw fail(400, 'Укажите текущий диалог.');
      let entry;
      try {
        entry = dialogues.get(c, member, state, body.dialogueId);
      } catch (error) {
        if (body.cancel !== true) throw error;
      }
      const taskRequestId = quota.continuation(c, body, entry);
      c = quota.resume(c, taskRequestId);
      const target = entry?.data.target;
      const checkTransition =
        target === 'appointmentManagement' || needsTransitionClock(entry, body.text);
      const clock =
        body.cancel === true || (!checkTransition && target !== 'clientCard')
          ? null
          : zonedClock(
              new Date(),
              c.assistantReads
                ? await c.assistantReads.timeZone()
                : context.organizationTimeZone(c.current.organizationId),
            );
      if (
        entry &&
        checkTransition &&
        !(await managementCommandReply(c, entry, body.text, clock)) &&
        managementCommandTransition(entry, body.text, clock)
      ) {
        validateContinuation(body);
        if (body.dialogueVersion !== entry.version)
          throw fail(409, 'Диалог уже изменился. Повторите команду в текущем диалоге.');
        memory.discardIsolated();
        return turn(c, {
          text: body.text,
          policyVersion: body.policyVersion,
          newCommand: true,
          taskRequestId: body.taskRequestId,
        });
      }
      const result = await (entry?.data.target === 'appointmentManagement'
        ? appointments.continueDialogue(c, body, state, member, clock)
        : entry?.data.target === 'clientCard'
          ? clientCards.continueDialogue(c, body, state, member, clock)
          : continuation.run(c, body, state, member));
      scope(c, body.policyVersion);
      return quota.finishContinuation(c, taskRequestId, {
        ...result,
        policyVersion: state.revision,
        demo: state.providers.llm.provider === 'demo',
      });
    }
    if (['dialogueVersion', 'choice', 'edit', 'cancel'].some((key) => body[key] !== undefined))
      throw fail(400, 'Ответ должен относиться к текущему диалогу.');
    const text = boundedText(body.text, state.policy.limits.maxTextChars, 'команда').trim();
    if (!text) throw fail(400, 'Произнесите или введите команду.');
    assertEarlyNegativeAction(text);
    const task = quota.begin(c, body, text);
    if (task) c = { ...c, assistantTask: task };
    let ticket, interpretationEnd, domainEnd;
    try {
      ticket = dialogues.prepareCommand(c, member, state);
      const previousCheck = c.assertAssistantReadCurrent;
      c = {
        ...c,
        assertAssistantReadCurrent() {
          previousCheck?.();
          memory.assertCandidate(ticket);
        },
      };
      // Bind to the command-specific guard, not the pre-command context.
      if (context.assistantReads) c.assistantReads = context.assistantReads.bind(c);
      const guidance = assistantGuidanceRequest(text);
      const timeZone = guidance
        ? null
        : c.assistantReads
          ? await c.assistantReads.timeZone()
          : context.organizationTimeZone(c.current.organizationId);
      let clock = guidance ? null : zonedClock(new Date(), timeZone);
      interpretationEnd = beginAssistantTiming(c.assistantTiming, 'interpretation', 'turn', 'none');
      const calendar = guidance ? null : calendarReadIntent(text, clock);
      const proveIdentity = async (query) => {
        const fresh = scope(c, body.policyVersion);
        if (!fresh.state.policy.commands.prepareAppointment)
          throw fail(403, 'Подготовка записи помощником отключена.');
        const found = await resolveClient(c, query);
        scope(c, body.policyVersion);
        return !found.overflow && found.matches.some((patient) => matchesName(patient, query));
      };
      const local = guidance
        ? { intent: 'help' }
        : calendar?.intent === 'calendar'
          ? calendar
          : availabilityReadIntent(text, clock) ||
            clientReadIntent(text) ||
            (await appointmentCreateIntent(text, clock, proveIdentity)) ||
            (await appointmentCreateServiceIntent(text, clock, proveIdentity, async () => {
              const fresh = scope(c, body.policyVersion);
              if (!fresh.state.policy.commands.prepareAppointment)
                throw fail(403, 'Подготовка записи помощником отключена.');
              const eligible = await appointmentContext(c);
              scope(c, body.policyVersion);
              return eligible.services;
            }));
      if (availabilityOnly && local?.intent !== 'availability')
        throw fail(400, 'Не удалось определить день и длительность поиска.');
      const acceptCommand = () => {
        dialogues.acceptCommand(ticket);
        continuation.clearAccount(c.current.accountId);
      };
      let result, parsedIntent;
      if (local) {
        // Only a fully covered command may skip the provider. Admission,
        // command ownership, action ACL and package task accounting stay shared.
        scope(c, body.policyVersion);
        const command = { ...local };
        delete command.dateMonth;
        parsedIntent = validateCommandFields(normalizeIntent(command));
        acceptCommand();
        const counter =
          local.intent === 'help'
            ? 'localHelp'
            : local.intent === 'calendar'
              ? 'localCalendar'
              : local.intent === 'availability'
                ? 'localAvailability'
                : local.intent === 'prepareAppointment'
                  ? 'localPrepareAppointment'
                  : local.intent === 'clients'
                    ? 'localClients'
                    : 'localClientCard';
        turnCounts[counter]++;
        result = { demo: state.providers.llm.provider === 'demo' };
        interpretationEnd();
      } else {
        interpretationEnd();
        turnCounts.model++;
        const prepared = modelPayload(text, state, timeZone);
        clock = prepared.clock;
        const { payload } = prepared;
        // Byte-based reservation deliberately ignores optimistic cache discounts.
        const inputUpper = Buffer.byteLength(JSON.stringify(payload), 'utf8') + 1024;
        const reserved =
          (inputUpper * state.rates.llmInput +
            state.policy.limits.maxOutputTokens * state.rates.llmOutput) /
          1000000;
        result = await invoke(
          c,
          body.policyVersion,
          'llm',
          state,
          payload,
          reserved,
          () => ({ text: JSON.stringify(demoIntent(text, clock)) }),
          acceptCommand,
        );
        interpretationEnd = beginAssistantTiming(
          c.assistantTiming,
          'interpretation',
          'llm',
          state.providers.llm.provider,
        );
        const parsedModelIntent = normalizeManagementRequest(
          parseInitialModelResponse(result.text),
          text,
          clock,
        );
        parsedIntent = calendarReadIntent(text, clock) || parsedModelIntent;
        interpretationEnd();
      }
      domainEnd = beginAssistantTiming(c.assistantTiming, 'domain', 'turn', 'none');
      assertIntentAction(text, parsedIntent.intent);
      const managesAppointment = [
        'moveAppointment',
        'cancelAppointment',
        'editAppointment',
      ].includes(parsedIntent.intent);
      const management = managesAppointment
        ? prepareManagementIntent(parsedIntent, text, clock)
        : null;
      const initialConstraints = management
        ? management.constraints
        : parsedIntent.intent === 'prepareAppointment'
          ? {
              ...bookingTemporalConstraints(parsedIntent, text, clock, { clarifyWeekday: true }),
              ...(local?.dateMonth ? { date: null, dateMonth: local.dateMonth } : {}),
              nearestRequested: nearestSlotMode(text),
            }
          : {
              ...intentRequestConstraints(parsedIntent, text),
              ...initialTemporalConstraints(parsedIntent, text, clock),
            };
      const intent = management
        ? management.intent
        : parsedIntent.intent === 'prepareAppointment'
          ? initialEntities(parsedIntent, text, initialConstraints)
          : parsedIntent;
      const constrainedIntent =
        intent.intent === 'availability' ? { ...intent, ...initialConstraints } : intent;
      const fresh = scope(c, body.policyVersion);
      dialogues.assertCommand(ticket);
      const readAction = () =>
        managesAppointment
          ? appointments.start(
              c,
              intent,
              fresh.state,
              fresh.member,
              clock,
              ticket,
              initialConstraints,
            )
          : intent.intent === 'prepareAppointment'
            ? dialogues.start(c, intent, fresh.state, fresh.member, clock, ticket, {
                ...initialConstraints,
                openWhenComplete: true,
                createRequested:
                  savingEnabled(fresh.state) &&
                  detectRequestedOperation(text).intent === 'prepareAppointment',
              })
            : intent.intent === 'clientCard'
              ? clientCards.start(c, intent, fresh.state, fresh.member, clock, ticket, text)
              : handoff(c, constrainedIntent, fresh.state, clock, guidance);
      // All candidate and selected-card reads for one action share a fresh RR
      // snapshot. Provider calls and task accounting stay outside that snapshot.
      const needsSnapshot =
        managesAppointment ||
        ['prepareAppointment', 'clientCard', 'availability'].includes(intent.intent) ||
        (intent.intent === 'clients' && Boolean(intent.query)) ||
        (intent.intent === 'calendar' && Boolean(intent.staffQuery));
      const resultAction = await (needsSnapshot && c.assistantReads?.snapshot
        ? c.assistantReads.snapshot(readAction)
        : readAction());
      const action =
        intent.intent === 'availability'
          ? dialogues.startAvailability(
              c,
              resultAction,
              fresh.state,
              fresh.member,
              clock,
              ticket,
              constrainedIntent,
            )
          : resultAction;
      scope(c, body.policyVersion);
      dialogues.assertCommand(ticket);
      const response = quota.complete(task, c, {
        ...action,
        intent: intent.intent,
        policyVersion: fresh.state.revision,
        demo: result.demo,
        ...(result.usage ? { usage: result.usage } : {}),
      });
      domainEnd();
      return response;
    } catch (error) {
      interpretationEnd?.(assistantOutcome(error));
      domainEnd?.(assistantOutcome(error));
      quota.failed(task);
      throw error;
    } finally {
      if (ticket) dialogues.abandonCommand(ticket);
    }
  }
  async function transcribe(c, body) {
    keys(body, [
      'audioBase64',
      'mimeType',
      'policyVersion',
      'demoText',
      'availabilityTurn',
      'dialogueId',
      'dialogueVersion',
      'taskRequestId',
    ]);
    const fresh = scope(c, body.policyVersion);
    const { state } = fresh;
    const availabilityMode = body.availabilityTurn;
    if (
      availabilityMode !== undefined &&
      (!['plain', 'pcm'].includes(availabilityMode) ||
        body.dialogueId !== undefined ||
        body.dialogueVersion !== undefined)
    )
      throw fail(400, 'Укажите поддерживаемый режим первой голосовой команды.');
    quota.transcribe(c, body, fresh);
    if (fresh.scope.billing?.paid) c = { ...c, assistantTaskRequestId: body.taskRequestId };
    if (state.providers.stt.provider === 'demo') {
      const text = boundedText(
        body.demoText || '',
        state.policy.limits.maxTextChars,
        'демокоманда',
      ).trim();
      if (!text)
        throw fail(
          400,
          'Демонстрационный режим не распознаёт звук. Введите команду текстом или подключите провайдер распознавания.',
        );
      const result = await invoke(c, body.policyVersion, 'stt', state, {}, 0, () => ({ text }));
      return { text: result.text, policyVersion: state.revision, demo: true, usage: result.usage };
    }
    const audio = wavAudio(body, state.policy.limits.maxAudioSeconds);
    let member = fresh.member;
    if (state.providers.stt.provider === 'local') {
      validateLocalAudio(audio);
      c = readContext(c);
      // The local hint may read permitted client names. Recheck before those reads.
      member = scope(c, body.policyVersion).member;
    }
    // Remote hints use fixed vocabulary only. Admission and outbound still recheck scope.
    audio.prompt = await localSpeechHints(c, dialogues, body, state, member);
    // STT has no supported max-output control. Keep a conservative reservation
    // and retain it if provider usage is absent; this is an estimated budget.
    const reserved =
      ((Math.ceil(audio.seconds * 100) + Buffer.byteLength(audio.prompt)) * state.rates.sttInput +
        4096 * state.rates.sttOutput) /
      1000000;
    const result = await invoke(c, body.policyVersion, 'stt', state, audio, reserved, () => ({}));
    const text = boundedText(
      result.text,
      state.policy.limits.maxTextChars,
      'распознанная команда',
    ).trim();
    scope(c, body.policyVersion);
    let availabilityReply;
    if (availabilityMode && availabilityReadParts(text)) {
      assertTransport(c);
      availabilityReply = await turn(
        c,
        {
          text,
          policyVersion: body.policyVersion,
          ...(body.taskRequestId ? { taskRequestId: body.taskRequestId } : {}),
          ...(availabilityMode === 'pcm'
            ? { speech: { format: 'pcm', stream: true, mode: 'answerable' } }
            : {}),
        },
        true,
      );
    }
    return {
      text,
      policyVersion: state.revision,
      demo: false,
      usage: result.usage,
      ...(availabilityReply ? { availabilityReply } : {}),
      ...(state.providers.stt.provider === 'local' ? { local: true } : {}),
    };
  }

  return {
    billingSnapshot() {
      const state = store.readPolicy ? store.readPolicy() : store.read();
      return {
        revision: state.revision,
        mode: state.policy.mode,
        rates: { ...state.rates },
        providers: Object.fromEntries(
          Object.entries(state.providers).map(([kind, value]) => [
            kind,
            { provider: value.provider, model: value.model },
          ]),
        ),
      };
    },
    access,
    admin,
    runtimeStats: () => ({
      turns: { ...turnCounts },
      ...memory.stats(),
      speechTickets: speech.stats(),
      speechPermits: quota.stats(),
    }),
    turn,
    execute: (c, body) => quota.execute(c, body, executions.execute),
    transcribe,
    speak: speech.speak,
    speakAudio: speech.speakAudio,
    speakPcm: speech.speakPcm,
    clearSession(sessionId) {
      speech.clearSession(sessionId);
      quota.clearSession(sessionId);
      dialogues.clearSession(sessionId);
      continuation.clearSession(sessionId);
    },
    clearAccount(accountId) {
      speech.clearAccount(accountId);
      quota.clearAccount(accountId);
      dialogues.clearAccount(accountId);
      continuation.clearAccount(accountId);
    },
    currentScope(c) {
      c.assertCurrent();
      return access(c.current);
    },
  };
}
module.exports = { createAssistant, usageCost };
