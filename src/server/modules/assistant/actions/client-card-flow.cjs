const { readSteps } = require('./../read-steps.cjs');
const {
  clientCardCommand,
  unsupportedCardObject,
} = require('../interpretation/client-card-grammar.cjs');
const { randomUUID } = require('node:crypto');
const { zonedClock } = require('../../../../shared/time-zone.cjs');
const { fail } = require('../../../../shared/errors.cjs');
const { createDialogueStore } = require('../dialogue/dialogue-store.cjs');
const {
  resolveClient,
  suggestClientMatches,
  suggestClientComponents,
  currentSuggestedClient,
} = require('../language/names/name-directory.cjs');
const {
  clientChoiceView,
  clientChoiceMetadata,
  clientChoiceOperation,
} = require('../dialogue/client-choice-names.cjs');
const { clientLabel } = require('../dialogue/dialogue-options.cjs');
const {
  validateContinuation,
  clientSuggestionOperation,
} = require('../dialogue/dialogue-input.cjs');
const { speechOperation } = require('../dialogue/dialogue-speech.cjs');
const { beginRecovery, recoverResponse } = require('../dialogue/dialogue-recovery.cjs');
const { resolveFieldAnswer, fieldAnswer } = require('../dialogue/field-answer.cjs');
const { suggestionsOnlyQuery } = require('../language/names/name-suggestions.cjs');
const { entityText } = require('../interpretation/entity-provenance.cjs');
const { expandClientSource } = require('../language/names/client-source-span.cjs');
const { nameTokens } = require('../language/names/name-matching.cjs');
const {
  currentClientComponentAnchor,
  repeatsClientComponent,
  clientComponentStamp,
} = require('../language/names/client-name-components.cjs');
const { isAffirmativeAnswer } = require('../dialogue/affirmative-answer.cjs');
const { dialogueControl, draftOperation } = require('../dialogue/dialogue-control.cjs');
const { informationTurn } = require('../dialogue/dialogue-control-turn.cjs');
const {
  clientCorrectionQuery,
  isClientCorrectionQuery,
} = require('../dialogue/client-correction.cjs');
function cardSourceQuery(raw, proposed) {
  if (unsupportedCardObject(raw)) return '';
  const source = (clientCardCommand(raw, { requireObject: false })?.query ?? String(raw || ''))
    .trim()
    .replace(/[,\s]+пожалуйста[.!?…]*$/iu, '')
    .trim();
  if (
    /(?:^|[^\p{L}\p{N}])(?:не|нет|или|либо|если|кроме|исключая|вместо|отмен[а-я]*|отправ[а-я]*|удал[а-я]*|сохран[а-я]*|оплат[а-я]*|созда[а-я]*|добав[а-я]*|запуст[а-я]*|выполн[а-я]*|включ[а-я]*|выключ[а-я]*)(?=$|[^\p{L}\p{N}])/iu.test(
      source,
    )
  )
    return '';
  // A complete literal identity is stronger source evidence than a locator
  // rewritten or omitted by the model. This never grants a directory match:
  // every raw component still passes the normal exact/ambiguity/ACL resolver.
  const whole = source.replace(/[.!?…]+$/u, '').trim();
  if (
    nameTokens(whole).length &&
    isClientCorrectionQuery(whole) &&
    expandClientSource(source, whole) === whole
  )
    return whole;
  const literal = entityText(source, proposed, 'client');
  return expandClientSource(source, literal || proposed);
}
function createClientCardFlow({
  memory = createDialogueStore(),
  target = 'clientCard',
  allow,
  onResolved,
  candidateContext,
  emptyPrompt,
} = {}) {
  function allowed(c, state) {
    c.assertCurrent();
    if (allow) {
      if (allow(c, state) === false) throw fail(403, 'Эта команда помощника недоступна.');
    } else if (!state.policy.commands.clients)
      throw fail(403, 'Поиск клиентов помощником выключен администратором.');
  }
  const candidates = readSteps(function* (c) {
    return candidateContext ? yield candidateContext(c) : c;
  });
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
        const required = fresh.data.clientChoiceRequired;
        const next = yield view(c, fresh.data, true);
        if (required === undefined) delete fresh.data.clientChoiceRequired;
        else fresh.data.clientChoiceRequired = required;
        const reply = response(fresh, next);
        c.assertCurrent();
        return reply;
      }),
      clock,
      limit: state.policy.limits?.maxReplyChars,
      hash: memory.fingerprint(body),
      replay,
    });
  });
  const view = readSteps(function* view(c, data, requireChoice = false) {
    c = yield candidates(c);
    if (requireChoice) data.clientChoiceRequired = true;
    let found =
      data.clientQuery && !data.clientSuggestionsOnly
        ? yield resolveFieldAnswer('client', data.clientQuery, (query) => resolveClient(c, query))
        : { matches: [], overflow: false };
    if (found.query) data.clientQuery = found.query;
    if (
      !found.overflow &&
      found.matches.length === 1 &&
      !data.clientPhonePrompt &&
      !data.clientChoiceRequired
    ) {
      const patient = found.matches[0];
      data.patient = {
        id: patient.id,
        label: clientLabel(patient),
        ...clientChoiceMetadata(patient),
      };
      return null;
    }
    if (data.clientQuery && !found.overflow && !found.matches.length) {
      const components = yield suggestClientComponents(c, data.clientQuery);
      if (components.componentNameConflict) found = components;
      else {
        const full = yield suggestClientMatches(c, data.clientQuery);
        found = full.matches.length || full.overflow ? full : components;
      }
    }
    const componentAnchor =
      found.componentAnchor ||
      (!found.overflow && currentClientComponentAnchor(found.matches, data.clientQuery));
    if (componentAnchor) data.clientComponentAnchor = componentAnchor;
    else delete data.clientComponentAnchor;
    const componentStamp = clientComponentStamp(found);
    const exactConfirmation =
      !found.approximate &&
      found.matches.length === 1 &&
      data.clientChoiceRequired &&
      !data.clientPhonePrompt;
    const wording = clientChoiceView(found.matches, {
      approximate: found.approximate === true,
      overflow: found.overflow,
      hasQuery: Boolean(data.clientQuery),
      componentPrompt: found.componentPrompt,
    });
    if (emptyPrompt && data.clientQuery && !found.matches.length && !found.overflow)
      wording.prompt = emptyPrompt(data);
    return {
      step: 'client',
      phase: 'clientChoice',
      prompt:
        data.clientPhonePrompt ||
        (found.componentConflict
          ? 'Имя и фамилия не совпали. Уточните полное имя или телефон.'
          : wording.prompt),
      input: { type: 'text', field: 'client' },
      choices: !wording.showChoices
        ? []
        : found.matches.slice(0, found.approximate ? 5 : 12).map((patient) => ({
            kind: 'client',
            value: patient.id,
            label: clientLabel(patient),
            ...clientChoiceMetadata(patient),
            ...(found.approximate || exactConfirmation ? { approximate: true } : {}),
            ...(exactConfirmation ? { exactConfirmation: true } : {}),
            ...(componentStamp
              ? { componentClarification: true, clientComponentStamp: componentStamp }
              : {}),
          })),
    };
  });
  const finish = readSteps(function* finish(c, entry, clock) {
    const patient = yield currentSuggestedClient(yield candidates(c), entry.data.patient?.id);
    if (
      !patient ||
      clientChoiceMetadata(patient).clientNameStamp !== entry.data.patient.clientNameStamp
    )
      throw fail(409, 'Карточка изменилась или недоступна. Уточните клиента ещё раз.');
    if (onResolved) return yield onResolved(c, entry, patient, clock);
    entry.complete = true;
    return {
      text: 'Открываю карточку клиента.',
      dialogue: null,
      action: { type: 'clientCard', patientId: patient.id },
    };
  });
  function response(entry, nextView, message) {
    const recovered = recoverResponse(entry.data, nextView, message);
    nextView = recovered.view;
    entry.step = 'client';
    entry.options = new Map();
    const options = nextView.choices.map((choice) => {
      const id = randomUUID();
      entry.options.set(id, choice);
      return { id, label: choice.label };
    });
    return {
      text: recovered.text || nextView.prompt,
      action: null,
      dialogue: {
        id: entry.id,
        version: entry.version,
        step: 'client',
        phase: 'clientChoice',
        prompt: nextView.prompt,
        options,
        fields: [],
        canEdit: [],
        input: { type: 'text', field: 'client' },
        expiresAt: entry.expiresAt,
        ...(nextView.manualInputRequired ? { manualInputRequired: true } : {}),
      },
    };
  }
  const present = readSteps(function* present(c, entry, clock, message) {
    const nextView = yield view(c, entry.data);
    return nextView ? response(entry, nextView, message) : yield finish(c, entry, clock);
  });
  const start = readSteps(function* start(c, intent, state, member, clock, ticket, raw) {
    allowed(c, state);
    const query = raw === undefined ? intent.query || '' : cardSourceQuery(raw, intent.query);
    const entry = memory.create(c, member, state, ticket, {
      initialIntent: structuredClone(intent),
      target,
      clientQuery: query,
      clientSuggestionsOnly: suggestionsOnlyQuery(query),
      patient: null,
    });
    entry.response = yield present(c, entry, clock);
    return entry.response;
  });
  const choose = readSteps(function* choose(c, entry, id) {
    c = yield candidates(c);
    const choice = entry.options.get(id);
    if (!choice || choice.kind !== 'client')
      throw fail(409, 'Этот клиент больше не входит в текущий выбор.');
    const fresh = yield currentSuggestedClient(c, choice.value);
    if (!fresh || clientChoiceMetadata(fresh).clientNameStamp !== choice.clientNameStamp)
      throw fail(409, 'Список клиентов изменился. Уточните клиента ещё раз.');
    const exact = entry.data.clientSuggestionsOnly
      ? { matches: [], overflow: false }
      : yield resolveClient(c, entry.data.clientQuery);
    const components =
      !exact.overflow && !exact.matches.length
        ? yield suggestClientComponents(c, entry.data.clientQuery)
        : null;
    const fullSuggestions =
      !exact.overflow && !exact.matches.length && !components?.componentNameConflict
        ? yield suggestClientMatches(c, entry.data.clientQuery)
        : null;
    const current =
      choice.componentClarification === true
        ? !exact.overflow &&
          !exact.matches.length &&
          !components?.overflow &&
          (components?.componentNameConflict ||
            (!fullSuggestions?.overflow && !fullSuggestions?.matches.length))
          ? components
          : { matches: [], overflow: true }
        : choice.approximate === true &&
            !choice.exactConfirmation &&
            !exact.overflow &&
            !exact.matches.length &&
            !components?.componentNameConflict
          ? fullSuggestions
          : exact;
    if (
      !current ||
      current.overflow ||
      (choice.componentClarification === true &&
        (!choice.clientComponentStamp ||
          choice.clientComponentStamp !== clientComponentStamp(current))) ||
      (choice.approximate === true && !choice.exactConfirmation && exact.matches.length) ||
      !current.matches.some((row) => row.id === choice.value)
    )
      throw fail(409, 'Список клиентов изменился. Уточните клиента ещё раз.');
    entry.data.patient = {
      id: fresh.id,
      label: clientLabel(fresh),
      ...clientChoiceMetadata(fresh),
    };
  });
  const continueDialogue = readSteps(function* continueDialogue(c, body, state, member, clock) {
    allowed(c, state);
    if (clock === undefined && body.cancel !== true)
      clock = zonedClock(
        new Date(),
        c.assistantReads
          ? yield c.assistantReads.timeZone()
          : c.platform.organizationTimeZone(c.current.organizationId),
      );
    const operation = validateContinuation(body);
    const entry = memory.get(c, member, state, body.dialogueId);
    if (entry.data.target !== target) throw fail(409, 'Ответ относится к другой команде.');
    const hash = memory.fingerprint(body);
    const control = operation === 'text' ? dialogueControl(body.text, draftOperation(entry)) : null;
    if (entry.lastHash === hash) {
      if (control && control !== 'stop' && !entry.complete && !entry.cancelled)
        return yield information(c, entry, control, body, state, clock, true);
      if (entry.cancelled) return entry.response;
      if (entry.complete) return (entry.response = yield finish(c, entry, clock));
      const data = structuredClone(entry.data);
      const nextView = yield view(c, data, true);
      if (!nextView) {
        entry.data = data;
        entry.version++;
        return (entry.response = yield finish(c, entry, clock));
      }
      const recovered = recoverResponse(data, nextView).view;
      if (
        JSON.stringify([...entry.options.values()]) !== JSON.stringify(recovered.choices) ||
        entry.response.dialogue.prompt !== recovered.prompt
      ) {
        entry.data = data;
        entry.version++;
        entry.response = response(entry, recovered);
      }
      return entry.response;
    }
    if (entry.complete || entry.cancelled || body.dialogueVersion !== entry.version)
      throw fail(409, 'Диалог уже изменился. Повторите ответ в текущем диалоге.');
    if (entry.turns >= 40) throw fail(429, 'Слишком много уточнений. Начните новую команду.');
    const saved = { ...entry, data: entry.data };
    entry.data = structuredClone(entry.data);
    try {
      if (control && control !== 'stop')
        return yield information(c, entry, control, body, state, clock);
      const correction =
        operation === 'text'
          ? clientCorrectionQuery(body.text, { allowBareCorrection: true }) ||
            (clientCardCommand(body.text) ? { query: cardSourceQuery(body.text, '') } : null)
          : null;
      let clientInput =
        operation === 'text' && !correction && control !== 'stop'
          ? yield clientChoiceOperation(c, entry, body.text)
          : null;
      if (
        clientInput?.kind === 'choice' &&
        repeatsClientComponent(
          entry.data.clientComponentAnchor,
          entry.options.get(clientInput.choice),
          body.text,
        )
      )
        clientInput = { kind: 'localHelp' };
      let input =
        control === 'stop'
          ? { kind: 'cancel', draftOnly: true }
          : operation === 'text'
            ? (correction ? { kind: 'edit', field: 'client', text: correction.query } : null) ||
              clientInput ||
              clientSuggestionOperation(entry, body.text)
            : { kind: operation, field: body.edit, choice: body.choice };
      if (!input && isAffirmativeAnswer(body.text))
        input = { kind: 'localHelp', text: entry.response.dialogue.prompt };
      if (!input) input = speechOperation(entry, body.text);
      if (input.kind === 'edit' && input.field !== 'client')
        throw fail(400, 'Сейчас уточняем только клиента для открытия карточки.');
      beginRecovery(entry, {
        operation,
        input,
        text: body.text,
        clientAnswer: input === clientInput,
      });
      if (input.kind !== 'clientPhoneClarify') delete entry.data.clientPhonePrompt;
      let message;
      if (input.kind === 'cancel') {
        memory.invalidatePending(entry.accountId);
        entry.cancelled = true;
        entry.response = {
          text:
            target === 'appointmentManagement'
              ? 'Подготовка остановлена. Запись не изменена.'
              : input.draftOnly
                ? 'Открытие карточки остановлено.'
                : 'Открытие карточки отменено.',
          action: null,
          dialogue: null,
        };
      } else {
        if (input.kind === 'choice') yield choose(c, entry, input.choice);
        else if (input.kind === 'edit') {
          entry.data.patient = null;
          entry.data.clientQuery = input.text ? fieldAnswer('client', input.text) : '';
          entry.data.clientSuggestionsOnly = suggestionsOnlyQuery(entry.data.clientQuery);
          delete entry.data.clientChoiceRequired;
          delete entry.data.clientComponentAnchor;
        } else if (input.kind === 'text') {
          if (!entry.data.clientComponentAnchor || nameTokens(input.text).length !== 1) {
            entry.data.patient = null;
            entry.data.clientQuery = fieldAnswer('client', input.text);
            entry.data.clientSuggestionsOnly = suggestionsOnlyQuery(entry.data.clientQuery);
            delete entry.data.clientChoiceRequired;
            delete entry.data.clientComponentAnchor;
          }
        } else if (input.kind === 'clientPhoneClarify') {
          message = input.message;
          entry.data.clientPhonePrompt = message;
        } else if (!entry.data.clientComponentAnchor)
          message = input.text || 'Уточните имя или телефон клиента.';
        if (!['choice', 'text', 'edit'].includes(input.kind))
          entry.data.clientChoiceRequired = true;
        entry.version++;
        entry.turns++;
        entry.response = entry.data.patient
          ? yield finish(c, entry, clock)
          : yield present(c, entry, clock, message);
      }
      entry.lastHash = hash;
      return entry.response;
    } catch (error) {
      Object.assign(entry, saved);
      throw error;
    }
  });
  const reselect = readSteps(function* reselect(c, entry, clock, query = '') {
    // The caller owns versioning and rollback; reuse the same scoped resolver,
    // stamps and ambiguity rules instead of starting an unrelated command.
    for (const key of [
      'clientChoiceRequired',
      'clientComponentAnchor',
      'clientPhonePrompt',
      '_clarificationRecovery',
    ])
      delete entry.data[key];
    entry.data.patient = null;
    entry.data.clientQuery = query;
    entry.data.clientSuggestionsOnly = suggestionsOnlyQuery(query);
    entry.options = new Map();
    entry.controls = new Map();
    return yield present(c, entry, clock);
  });
  return { start, continueDialogue, reselect };
}
module.exports = { createClientCardFlow, cardSourceQuery };
