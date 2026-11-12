const { readSteps } = require('../read-steps.cjs');
const { fail } = require('../../../../shared/errors.cjs');
const { matchesName } = require('../language/names/name-matching.cjs');
const { resolveClient, clientSearchQuery } = require('../language/names/name-directory.cjs');
const { availabilityAction } = require('./availability-action.cjs');
const { commandCategory } = require('../interpretation/intent-schema.cjs');
const { helpText } = require('./help-response.cjs');
const { patientFullName } = require('../../../../shared/patient-names.cjs');
const { calendarDayText } = require('./calendar-read-request.cjs');
function staffFor(c, query) {
  return readSteps(function* () {
    if (!query)
      return c.current.role === 'cosmetologist' || c.current.role === 'owner'
        ? c.current.accountId
        : '';
    const context = c.assistantReads ? yield c.assistantReads.appointmentContext() : null;
    const matches = (
      context ? context.members : c.platform.workspaceMembers(c.current.organizationId)
    ).filter(
      (member) =>
        member.status === 'active' &&
        ['owner', 'cosmetologist'].includes(member.role) &&
        (c.current.role !== 'cosmetologist' || member.accountId === c.current.accountId) &&
        matchesName(member, query, true),
    );
    return matches.length === 1 ? matches[0].accountId : null;
  }).call(this);
}
function handoff(c, intent, state, clock, guidance = null) {
  return readSteps(function* () {
    const category = commandCategory(intent.intent);
    if (category && !state.policy.commands[category])
      throw fail(403, 'Это действие помощника выключено администратором.');
    if (intent.intent === 'help')
      return {
        text: helpText(c.current, state.policy.commands, guidance),
        action: null,
      };
    if (intent.intent === 'availability') return yield availabilityAction(c, intent, clock);
    const staffId = yield staffFor(c, intent.staffQuery);
    if (staffId === null)
      return {
        text: 'Повторите запрос о расписании целиком: укажите полное имя специалиста и нужную дату. Доступно только разрешённое вам расписание.',
        action: null,
      };
    if (intent.intent === 'calendar')
      return {
        text:
          !intent.mode || intent.mode === 'day'
            ? 'Открываю расписание на ' + calendarDayText(intent.date || clock.date) + '.'
            : 'Открываю расписание.',
        action: {
          type: 'calendar',
          date: intent.date || clock.date,
          mode: intent.mode || 'day',
          ...(staffId ? { staffId } : {}),
        },
      };
    if (!intent.query)
      return {
        text: 'Назовите имя клиента или уточните его в списке клиентов.',
        action: null,
      };
    // Bounded searches use only the existing ACL-aware directory; names are not sent to the model.
    const result = yield resolveClient(c, intent.query);
    const search = {
      type: 'clients',
      query: clientSearchQuery(result, intent.query),
    };
    if (intent.intent === 'clients')
      return {
        text: 'Открываю список клиентов.',
        action: search,
      };
    if (result.overflow || result.matches.length !== 1)
      return {
        text:
          intent.intent === 'clientCard'
            ? result.overflow || result.matches.length > 1
              ? 'Уточните полное имя или телефон клиента.'
              : 'Клиент не найден. Уточните имя или телефон.'
            : result.overflow || result.matches.length > 1
              ? 'Поиск неоднозначен. Выберите нужного клиента в списке; я не буду угадывать.'
              : 'Клиент не найден по точному имени и поддерживаемым формам. Уточните имя в списке клиентов.',
        action: intent.intent === 'clientCard' ? null : search,
      };
    const patient = result.matches[0];
    if (intent.intent === 'clientCard')
      return {
        text:
          'Открываю карточку: ' +
          (patientFullName(patient) || patient.designation || 'клиент').slice(0, 180) +
          '.',
        action: { type: 'clientCard', patientId: patient.id },
      };
    return {
      text: 'Подготовил форму записи.',
      action: {
        type: 'prepareAppointment',
        patientId: patient.id,
        ...(intent.date ? { date: intent.date } : {}),
        ...(intent.time ? { time: intent.time } : {}),
        ...(staffId ? { staffId } : {}),
        ...(intent.duration ? { duration: intent.duration } : {}),
      },
    };
  }).call(this);
}
module.exports = { handoff, staffFor };
