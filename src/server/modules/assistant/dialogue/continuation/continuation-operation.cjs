const { containsCardCommand } = require('../../interpretation/client-card-grammar.cjs');
const { contextualDayDate, bookingMonthDayProposal } = require('../bare-day-proposal.cjs');
const { normalizeClockPrefixes, bareClockSpans } = require('../../language/time/clock-context.cjs');
const { fail } = require('../../../../../shared/errors.cjs');
const { parseContinuation, continuationQuestion } = require('./continuation-contract.cjs');
const {
  initialTemporalConstraints,
} = require('../../language/time/initial-temporal-constraints.cjs');
const {
  bookingTemporalConstraints,
} = require('../../language/time/booking-temporal-constraints.cjs');
const { parseBookingTimeWindow } = require('../../language/time/booking-time-window.cjs');
const { intentRequestConstraints } = require('../../interpretation/intent-request-duration.cjs');
const { parseDateText, parseTimeText } = require('../../language/time/temporal.cjs');
const { parseDuration } = require('../../language/time/spoken-duration.cjs');
const { spokenNumber } = require('../../language/time/spoken-number.cjs');
const { relativeTemporalEvidence } = require('../../language/time/temporal-evidence.cjs');
const { expandClientSource } = require('../../language/names/client-source-span.cjs');
const { suggestionsOnlyQuery } = require('../../language/names/name-suggestions.cjs');
const {
  fold,
  excerpt,
  entityText,
  literalSpan,
} = require('../../interpretation/entity-provenance.cjs');
const { ordinalOperation } = require('../dialogue-repair-choice.cjs');
const { continuationSourceScope } = require('./continuation-source-scope.cjs');
const { pendingMonthAnswer } = require('../pending-month-answer.cjs');
const {
  entityRoleOmissions,
  explicitEntityRole,
  sameEntityValue,
} = require('./continuation-entity-completeness.cjs');
const { positiveReplacementSource } = require('./continuation-positive-replacement.cjs');
const fieldNames = ['client', 'staff', 'service', 'date', 'time', 'duration'];
const uncertain =
  /(?:^|[\s,;])(?:если|или|либо|примерно|около|между|кроме|исключая)(?=$|[\s,.!?;])/u;

function ordinalEvidence(entry, text, number) {
  if (uncertain.test(text) || /(?:^|\s)(?:не|нет)(?=$|[\s,])/u.test(text)) return false;
  try {
    const whole = ordinalOperation(entry, text);
    if (whole?.kind === 'choice') return whole.choice === [...entry.options.keys()][number - 1];
  } catch (error) {
    if (error.status !== 400) throw error;
  }
  const choices = [...entry.options.keys()],
    selected = new Set();
  for (const token of text.match(/[\p{L}\d]+/gu) || []) {
    if (
      /^\d+$/u.test(token) &&
      !/^(?:\d{1,2})$/u.test(text) &&
      !/(?:вариант|окно|номер)/u.test(text)
    )
      continue;
    try {
      const parsed = ordinalOperation(entry, token);
      if (parsed?.kind === 'choice') selected.add(parsed.choice);
    } catch (error) {
      if (error.status !== 400) throw error;
    }
  }
  return selected.size === 1 && selected.has(choices[number - 1]);
}
function continuationOperation(proposal, snapshot, entry, clock) {
  const value = parseContinuation(proposal),
    raw = snapshot.text,
    text = fold(raw);
  const ask = (field = entry.step, constraints = {}) => ({
    kind: 'modelClarify',
    field,
    constraints,
  });
  // A question supplies no booking values merely by mentioning a date or clock.
  // Exact current catalog answers and local controls have already been resolved.
  if (
    /^(?:(?:в|во|на|к|ко|о|об|у|для|с|со)\s+)?(?:кто|что|где|куда|откуда|когда|почему|зачем|как|сколько|какой|какая|какое|какие|какую|какого|какому|каким|каких|какими)(?=$|[\s,.!?;])/u.test(
      text,
    )
  )
    return { ...ask(), requiresClarification: true };
  if (
    value.operation !== 'cancel' &&
    /(?:^|[\s,;])(?:отмени(?:ть|те)?|передумал[а]?|останови(?:те|ть)?)(?=$|[\s,.!?])/u.test(text)
  )
    return ask();
  if (
    /(?:^|[\s,;])(?:удал|отправ|оплат|сохран|созда|создай|добав|выполн|запуст|включ|выключ|обнов|закр|переключ)[а-я]*(?=$|[\s,.!?])/u.test(
      text,
    ) ||
    /(?:^|\s)(?:если|при условии|в случае)(?=$|\s)/u.test(text) ||
    containsCardCommand(text) ||
    /(?:^|\s)(?:покажи|открой|найди|посмотри)\s+(?:мне\s+)?(?:клиентов|календарь|расписание)(?=$|[\s,.!?])/u.test(
      text,
    )
  )
    return ask();
  const sourceScope = continuationSourceScope(raw);
  const replacement =
    value.operation === 'patch' ? positiveReplacementSource(sourceScope.text, value.fields) : null;
  if (replacement) sourceScope.text = replacement;
  for (const field of sourceScope.protectedFields)
    if (value.fields[field] !== null) return ask(field);
  const interpretationText = fold(sourceScope.text);
  let constraints;
  try {
    let searchConstraints;
    if (entry.availabilitySearch) {
      const timeAnswer =
        entry.step === 'time' || /(?:^|\s)(?:время|начало)(?:\s+приема)?(?=$|[\s:=])/u.test(text);
      const lengthContext = !timeAnswer || entry.step === 'duration';
      const length = intentRequestConstraints({ intent: 'prepareAppointment' }, raw, {
        timeContext: timeAnswer,
        durationContext: lengthContext,
      });
      let clockText = normalizeClockPrefixes(text);
      if (lengthContext && (length.duration !== undefined || length.requireDuration)) {
        const spans = bareClockSpans(clockText, { timeContext: true }).filter((span) =>
          /час(?:а|ов)?$/u.test(clockText.slice(span.start, span.end)),
        );
        for (const span of spans.reverse())
          clockText =
            clockText.slice(0, span.start) +
            ' '.repeat(span.end - span.start) +
            clockText.slice(span.end);
      }
      searchConstraints = {
        ...length,
        ...initialTemporalConstraints({ intent: 'prepareAppointment' }, clockText, clock),
      };
    }
    constraints = {
      ...(searchConstraints ||
        bookingTemporalConstraints(
          {
            intent: 'prepareAppointment',
            serviceQuery: value.fields.service,
            query: value.fields.client,
            staffQuery: value.fields.staff,
          },
          sourceScope.text,
          clock,
          {
            timeContext: entry.step === 'time',
            durationContext: entry.step === 'duration',
            clarifyWeekday: !entry.availabilitySearch,
          },
        )),
      ...relativeTemporalEvidence(raw, entry.data, clock),
    };
  } catch (error) {
    if (error.status !== 400) throw error;
    const field = /(?:дат|день|завтра|октябр|ноябр|декабр)/u.test(text) ? 'date' : 'time';
    return ask(field, { [field]: null });
  }
  const pendingMonth = pendingMonthAnswer(entry, sourceScope.text, clock);
  if (pendingMonth) {
    if (constraints.date && constraints.date !== pendingMonth.date)
      return ask('date', { date: null });
    constraints.date = null;
    constraints.dateProposal = pendingMonth;
    delete constraints.dateWeekday;
  }
  const selectedMonth = entry.data.dateMonth || entry.data.dateProposal?.month;
  if (constraints.dateProposal && !constraints.dateProposal.month && selectedMonth) {
    const proposal = bookingMonthDayProposal(constraints.dateProposal.day, selectedMonth, clock);
    if (proposal) constraints.dateProposal = proposal;
    else {
      delete constraints.dateProposal;
      constraints.dateMonth = selectedMonth;
    }
  }
  if (constraints.dateProposal && !constraints.dateProposal.month) {
    const date = contextualDayDate(constraints.dateProposal, entry.data, clock);
    if (date) {
      constraints.date = date;
      delete constraints.dateProposal;
    } else if (entry.data.dateMonthContext) constraints.dateProposal.date = null;
  }
  if (entry.step === 'duration') {
    const exact = parseDuration(raw);
    if (exact) constraints.duration = exact;
    else
      Object.assign(
        constraints,
        intentRequestConstraints(
          { intent: 'prepareAppointment' },
          'на ' + (constraints.timeWindow ? parseBookingTimeWindow(raw).maskedText : raw),
        ),
      );
  }
  if (entry.step === 'date' && constraints.date === undefined) {
    const exact = parseDateText(raw, clock);
    if (exact) constraints.date = exact;
  }
  if (entry.step === 'time' && constraints.time === undefined && !constraints.timeWindow) {
    const exact = parseTimeText(raw),
      count = spokenNumber(text, 24);
    if (exact) constraints.time = exact;
    else {
      Object.assign(
        constraints,
        initialTemporalConstraints({ intent: 'prepareAppointment' }, 'в ' + raw, clock),
      );
      if (/^\d{1,2}$/u.test(text) || count !== null) constraints.time = null;
    }
  }
  for (const field of sourceScope.protectedFields)
    if (
      Object.hasOwn(constraints, field) ||
      (field === 'date' && constraints.dateProposal) ||
      (field === 'time' && (constraints.timeWindow || constraints.timeWindowRequired)) ||
      (field === 'duration' && constraints.requireDuration)
    )
      return ask(field);
  const windowProof = entry.availabilitySearch
      ? { status: 'none' }
      : parseBookingTimeWindow(sourceScope.text),
    guardedText =
      windowProof.status === 'valid' ? fold(windowProof.maskedText) : interpretationText;
  const ambiguousField = constraints.requireDuration
    ? 'duration'
    : constraints.date === null
      ? 'date'
      : constraints.timeWindowRequired || (constraints.time === null && !constraints.timeWindow)
        ? 'time'
        : null;
  const { omitted: omittedRoles, ambiguous: ambiguousRoles } = entityRoleOmissions(
    sourceScope.text,
    value.fields,
    sourceScope.protectedFields,
    entry.data,
  );
  if (omittedRoles.length) {
    for (const field of omittedRoles) constraints[field] = null;
    if (value.operation !== 'patch') return ask(omittedRoles[0], constraints);
  }
  if (uncertain.test(guardedText)) {
    const proposedField = fieldNames.find((field) => value.fields[field] !== null);
    return ask(omittedRoles[0] || ambiguousField || proposedField || entry.step, constraints);
  }
  if (value.operation !== 'patch' && ambiguousField) return ask(ambiguousField, constraints);
  if (value.operation === 'patch') {
    if (suggestionsOnlyQuery(raw) && entry.step !== 'client') return ask('client', constraints);
    // A server-proven «не раньше/не позже» constrains time, not the client,
    // service or staff named in another part of the same utterance. All other
    // negations remain in the source and keep the conservative entity guard.
    const patchText = windowProof.status === 'valid' ? guardedText : interpretationText;
    const negative = /(?:^|[\s,;])(?:не|нет)(?=$|[\s,;])/u.test(patchText);
    const finalClause = patchText
      .split(/(?:^|[\s,;])(?:а|но|лучше|точнее)(?=$|[\s,;])/u)
      .at(-1)
      .trim();
    const proven = Object.fromEntries(
      ['client', 'staff', 'service'].map((field) => [
        field,
        value.fields[field] === null
          ? null
          : entityText(sourceScope.text, value.fields[field], field),
      ]),
    );
    if (value.fields.client !== null)
      proven.client = suggestionsOnlyQuery(raw)
        ? raw
        : literalSpan(
            sourceScope.text,
            expandClientSource(
              windowProof.status === 'valid' ? windowProof.maskedText : sourceScope.text,
              proven.client || value.fields.client,
              { serviceQuery: proven.service, staffQuery: proven.staff },
            ),
          );
    const ungroundedFields = new Set(),
      repeatedFields = new Set();
    for (const field of ['client', 'staff', 'service']) {
      const selected = entry.data[field === 'client' ? 'patient' : field];
      if (value.fields[field] !== null && selected) {
        if (sameEntityValue(proven[field], field, entry.data)) repeatedFields.add(field);
        else if (
          field !== entry.step &&
          !explicitEntityRole(sourceScope.text, field, value.fields) &&
          !(
            replacement &&
            field === 'client' &&
            explicitEntityRole(sourceScope.text, 'service', value.fields)
          )
        ) {
          ungroundedFields.add(field);
          value.fields[field] = null;
        }
      }
      if (value.fields[field] !== null) {
        if (!proven[field]) throw fail(400, continuationQuestion(field));
        value.fields[field] = proven[field];
      }
      if (
        negative &&
        value.fields[field] !== null &&
        !suggestionsOnlyQuery(raw) &&
        (finalClause === patchText ||
          !excerpt(finalClause, value.fields[field]) ||
          /(?:^|\s)не(?=$|\s)/u.test(finalClause))
      )
        return ask(field, constraints);
      if (
        value.fields[field] !== null &&
        (!excerpt(sourceScope.text, value.fields[field]) ||
          (field === 'client' && suggestionsOnlyQuery(raw) && fold(value.fields[field]) !== text))
      )
        throw fail(400, continuationQuestion(field));
    }
    // A proven clock cannot be reused as an invented appointment length by the model.
    // Real explicit/invalid lengths are retained by duration/requireDuration constraints above.
    if (
      constraints.duration === undefined &&
      !constraints.requireDuration &&
      /^([01]\d|2[0-3]):[0-5]\d$/u.test(constraints.time || '')
    )
      value.fields.duration = null;
    for (const field of ['date', 'time', 'duration']) {
      const proposed = value.fields[field],
        forced = constraints[field];
      if (
        proposed !== null &&
        forced === undefined &&
        !(field === 'duration' && constraints.requireDuration)
      )
        throw fail(400, continuationQuestion(field));
      if (proposed !== null && forced !== undefined && forced !== null && proposed !== forced)
        throw fail(400, continuationQuestion(field));
    }
    const edits = fieldNames.flatMap((field) => {
      if (
        repeatedFields.has(field) ||
        (field === 'duration' && constraints.requireDuration) ||
        constraints[field] === null
      )
        return [];
      const item = constraints[field] !== undefined ? constraints[field] : value.fields[field];
      return item === null || item === undefined ? [] : [{ field, text: String(item) }];
    });
    if (ungroundedFields.size || ambiguousRoles.length)
      return { ...ask(entry.step, constraints), edits, requiresClarification: true };
    return edits.length || constraints.timeWindow
      ? { kind: 'modelPatch', edits, constraints }
      : ask(omittedRoles[0] || ambiguousField || entry.step, constraints);
  }
  if (
    !['slots', 'clarify'].includes(value.operation) &&
    (['date', 'time', 'duration'].some((field) => constraints[field] !== undefined) ||
      constraints.timeWindow)
  )
    return ask(Object.keys(constraints).find((field) => fieldNames.includes(field)));
  if (value.operation === 'choice') {
    if (!ordinalEvidence(entry, text, value.choice)) return ask();
    const choice = [...entry.options.keys()][value.choice - 1];
    if (!choice) throw fail(409, 'Этот вариант устарел. Используйте текущие варианты.');
    return { kind: 'choice', choice };
  }
  if (value.operation === 'ready') {
    if (
      uncertain.test(text) ||
      /(?:^|\s)(?:не|нет)(?=$|\s)/u.test(text) ||
      !/(?:откр|подготов|подтвержд|верно|правильно|запиши)/u.test(text) ||
      !text
        .replace(/[.,!?;:…«»"']/gu, ' ')
        .split(/\s+/u)
        .every((word) =>
          [
            'тогда',
            'можно',
            'уже',
            'теперь',
            'пожалуйста',
            'давай',
            'давайте',
            'можешь',
            'открой',
            'открыть',
            'открывай',
            'открывайте',
            'подготовь',
            'подготовить',
            'форму',
            'запись',
            'готовую',
            'обычную',
            'все',
            'верно',
            'правильно',
            'подтверждаю',
            'данные',
            'да',
            'запиши',
            'записать',
            'и',
            'мне',
            'это',
            'для',
            'ручного',
            'сохранения',
            'приема',
          ].includes(word),
        )
    )
      return ask();
    const ready =
      entry.step === 'review' && [...entry.options].find(([, row]) => row.kind === 'ready');
    return ready ? { kind: 'choice', choice: ready[0] } : ask();
  }
  if (value.operation === 'cancel')
    return /отмен|передум|останов|не\s+(?:надо|записывай)/u.test(text) && !/не\s+отмен/u.test(text)
      ? { kind: 'cancel' }
      : ask();
  if (value.operation === 'repeat')
    return /повтор|еще\s+раз|не\s+(?:расслышал|услышал)/u.test(text) &&
      !/(?:поменяй|измени|исправь|запиши|открой)/u.test(text)
      ? { kind: 'localHelp', text: entry.response.dialogue.prompt }
      : ask();
  if (value.operation === 'slots') {
    if (
      uncertain.test(guardedText) ||
      (!constraints.timeWindow &&
        !/(?:время|окн|подбер|подбери|подбор|свободн|ближайш)/u.test(text))
    )
      return ask('time');
    const edits = ['date', 'time', 'duration'].flatMap((field) =>
      constraints[field] === undefined || constraints[field] === null
        ? []
        : [{ field, text: String(constraints[field]) }],
    );
    return {
      kind: 'modelPatch',
      edits,
      constraints,
      seekSlots: true,
      ...(/(?:любое|без\s+ограничения)\s+врем/u.test(text) ? { anyTime: true } : {}),
    };
  }
  return constraints.timeWindow
    ? {
        kind: 'modelPatch',
        edits: ['date', 'time', 'duration'].flatMap((field) =>
          constraints[field] === undefined || constraints[field] === null
            ? []
            : [{ field, text: String(constraints[field]) }],
        ),
        constraints,
        seekSlots: true,
      }
    : {
        ...ask(
          value.field !== entry.step &&
            entry.data[value.field === 'client' ? 'patient' : value.field]
            ? entry.step
            : value.field,
          constraints,
        ),
        ...(ambiguousRoles.length ? { requiresClarification: true } : {}),
      };
}

module.exports = { continuationOperation };
