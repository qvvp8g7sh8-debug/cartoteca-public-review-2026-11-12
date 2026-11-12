const { readSteps } = require('./../read-steps.cjs');
const { parseBookingTimeWindow } = require('../language/time/booking-time-window.cjs');
const { selectServicePicker } = require('./dialogue-service-picker.cjs');
const { suggestServices, serviceStamp } = require('../language/services/service-suggestions.cjs');
const { resolveService } = require('../actions/availability-context.cjs');
const { applyTimeWindow, resetSlotPage } = require('./dialogue-booking-time.cjs');
const { confirmationMatches } = require('../actions/appointments/schedule-override.cjs');
const { fail } = require('../../../../shared/errors.cjs');
const {
  resolveClient,
  suggestClientMatches,
  suggestClientComponents,
  currentSuggestedClient,
} = require('../language/names/name-directory.cjs');
const { verifyAvailability } = require('../actions/availability.cjs');
const { references, clientLabel, clearField, setService } = require('./dialogue-options.cjs');
const { requestSlots } = require('./dialogue-slots.cjs');
const { clientChoiceMetadata } = require('./client-choice-names.cjs');
const { clientComponentStamp } = require('../language/names/client-name-components.cjs');
const selectChoice = readSteps(function* selectChoice(c, data, choice) {
  const context = yield references(c, data);
  if (yield selectServicePicker(c, data, choice, context)) return true;
  if (choice.kind === 'closedDayContinue') {
    if (
      !confirmationMatches(c, choice.value, {
        date: data.date,
        staffId: data.staff?.id,
        time: data.time,
        duration: data.duration,
      })
    )
      throw fail(403, 'Продолжить запись вне графика может владелец или администратор.');
    data.closedDayConfirmation = choice.value;
  } else if (choice.kind === 'date') {
    data.date = choice.value;
    data.dateMonthContext = choice.value.slice(0, 7);
    delete data.dateProposal;
    delete data.dateMonth;
    data.roomId = '';
    if (!data.dateWeekday) data.timeRequired = false;
    delete data.dateWeekday;
    resetSlotPage(data);
  } else if (choice.kind === 'freeRange') {
    applyTimeWindow(data, choice.value);
  } else if (choice.kind === 'period') {
    const words = { morning: 'утром', day: 'днём', evening: 'вечером', any: 'любое время' };
    const parsed = parseBookingTimeWindow(words[choice.value] || '');
    if (parsed.status !== 'valid') throw fail(409, 'Выберите период ещё раз.');
    applyTimeWindow(data, parsed.window);
  } else if (choice.kind === 'client') {
    const approximate = choice.approximate === true;
    let result;
    if (approximate) {
      const exact = data.clientSuggestionsOnly
        ? { matches: [], overflow: false }
        : yield resolveClient(c, data.clientQuery);
      if (exact.overflow || exact.matches.length)
        throw fail(409, 'Список клиентов изменился. Уточните клиента ещё раз.');
      const components = yield suggestClientComponents(c, data.clientQuery);
      if (choice.componentClarification === true) {
        if (
          components.overflow ||
          !choice.clientComponentStamp ||
          choice.clientComponentStamp !== clientComponentStamp(components)
        )
          throw fail(409, 'Список клиентов изменился. Уточните клиента ещё раз.');
        if (!components.componentNameConflict) {
          const full = yield suggestClientMatches(c, data.clientQuery);
          if (full.overflow || full.matches.length)
            throw fail(409, 'Список клиентов изменился. Уточните клиента ещё раз.');
        }
        result = components;
      } else {
        if (components.componentNameConflict)
          throw fail(409, 'Список клиентов изменился. Уточните клиента ещё раз.');
        result = yield suggestClientMatches(c, data.clientQuery);
      }
    } else result = yield resolveClient(c, data.clientQuery);
    let patient =
      (approximate || !result.overflow) && result.matches.find((row) => row.id === choice.value);
    if (patient && approximate) patient = yield currentSuggestedClient(c, patient.id);
    if (
      !patient ||
      (approximate &&
        (!choice.clientNameStamp ||
          clientChoiceMetadata(patient).clientNameStamp !== choice.clientNameStamp))
    )
      throw fail(409, 'Список клиентов изменился. Уточните клиента ещё раз.');
    data.patient = {
      id: patient.id,
      label: clientLabel(patient),
      ...(approximate
        ? { confirmedSuggestion: true, clientNameStamp: choice.clientNameStamp }
        : {}),
    };
  } else if (choice.kind === 'staff') {
    const member = context.members.find((row) => row.accountId === choice.value);
    if (!member) throw fail(403, 'Специалист больше недоступен.');
    clearField(data, 'staff');
    data.staff = { id: member.accountId, label: member.displayName || 'Специалист' };
  } else if (choice.kind === 'service') {
    const service = context.services.find(
      (row) => row.id === choice.value && row.staffId === data.staff?.id,
    );
    if (!service) throw fail(409, 'Услуга изменилась. Выберите её снова.');
    if (choice.approximateService === true) {
      const catalog = context.services.filter((row) => row.staffId === data.staff?.id);
      const suggestions = suggestServices(catalog, data.serviceQuery);
      if (
        !service ||
        choice.serviceStamp !== serviceStamp(service) ||
        resolveService(catalog, data.serviceQuery).length ||
        suggestions.overflow ||
        !suggestions.matches.some((row) => row.id === service.id)
      )
        throw fail(409, 'Услуга изменилась. Выберите её снова.');
    }
    setService(data, service);
  } else if (choice.kind === 'slot') {
    const slot = yield verifyAvailability(c, choice.value);
    if (!slot) {
      requestSlots(data, choice.value.time, { ranges: true });
      return false;
    }
    const member = context.members.find((row) => row.accountId === slot.staffId);
    data.staff = { id: member.accountId, label: member.displayName || 'Специалист' };
    data.date = slot.date;
    data.time = slot.time;
    data.duration = slot.duration;
    data.durationSource = 'manual';
    data.roomId = slot.roomId || '';
    data.seekSlots = false;
    data.slotAfterTime = '';
    if (choice.value.serviceIds?.length === 1)
      setService(
        data,
        context.services.find(
          (row) => row.id === choice.value.serviceIds[0] && row.staffId === slot.staffId,
        ),
      );
    data.useDefaultStaff = false;
  }
  return true;
});
module.exports = { selectChoice };
