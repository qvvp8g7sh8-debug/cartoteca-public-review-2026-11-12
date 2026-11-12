const { readSteps } = require('./../read-steps.cjs');
const { windowLabel } = require('../language/time/booking-time-window.cjs');
const { servicePickerView } = require('./dialogue-service-picker.cjs');
const { exactServiceAnswer } = require('../language/services/service-exact-followup.cjs');
const { patientFullName } = require('../../../../shared/patient-names.cjs');
const { clientChoiceView, clientChoiceMetadata } = require('./client-choice-names.cjs');
const { matchesName } = require('../language/names/name-matching.cjs');
const { fieldAnswer, resolveFieldAnswer, isSelfReference } = require('./field-answer.cjs');
const {
  resolveClient,
  suggestClientMatches,
  suggestClientComponents,
  currentSuggestedClient,
} = require('../language/names/name-directory.cjs');
const { appointmentContext, resolveService } = require('../actions/availability-context.cjs');
const { clientComponentStamp } = require('../language/names/client-name-components.cjs');
const fields = ['client', 'staff', 'service', 'date', 'time', 'duration'];
const labels = {
  client: 'Клиент',
  staff: 'Специалист',
  service: 'Услуга',
  date: 'Дата',
  time: 'Время',
  duration: 'Длительность',
};
const short = (value) => String(value || '').slice(0, 180);
function clientLabel(patient) {
  const phone = String(patient.phone || '')
    .replace(/\D/g, '')
    .slice(-4);
  return (
    short(patientFullName(patient) || patient.designation || 'Клиент') +
    (phone ? ' · …' + phone : '')
  );
}
function setService(data, service) {
  data.service = service ? { id: service.id, label: short(service.name) } : null;
  data.serviceChosen = true;
  if (!['manual', 'required'].includes(data.durationSource)) {
    data.duration = service?.duration || null;
    data.durationSource = service ? 'service' : '';
  }
}
function clearField(data, field) {
  if (field === 'client') {
    data.patient = null;
    data.clientQuery = '';
    data.clientSuggestionsOnly = false;
    delete data.clientComponentAnchor;
  } else if (field === 'staff') {
    // Resolve the same service intention against the new performer's own catalog.
    const pendingService = data.service?.label || data.serviceQuery || '';
    const withoutCatalog = data.serviceChosen === true && !data.service;
    data.staff = null;
    data.staffQuery = '';
    data.useDefaultStaff = false;
    clearField(data, 'service');
    data.serviceQuery = pendingService;
    if (withoutCatalog) data.serviceChosen = true;
  } else if (field === 'service') {
    data.service = null;
    data.serviceChosen = false;
    data.serviceQuery = '';
    delete data.servicePicker;
    if (data.durationSource === 'service') {
      data.duration = null;
      data.durationSource = '';
    }
  } else {
    data[field] = null;
    if (field === 'date') {
      delete data.dateProposal;
      delete data.dateMonth;
      delete data.dateWeekday;
      delete data.dateRejection;
    }
    if (field === 'time') {
      data.timeWindow = null;
      data.timeWindowRequired = false;
    }
    if (field === 'duration' && data.durationSource !== 'required') data.durationSource = '';
  }
  if (['staff', 'service', 'date', 'time', 'duration'].includes(field)) {
    data.roomId = '';
    data.seekSlots = false;
    data.slotAfterTime = '';
    delete data.preferredTime;
    delete data.slotCriteria;
    delete data.shownSlots;
    delete data.currentSlots;
    delete data.rangeSummary;
    delete data.rangePage;
    delete data.nearestRequested;
  }
}
const references = readSteps(function* references(c, data) {
  const context = yield appointmentContext(c);
  if (data.patient) {
    let patient;
    if (data.patient.confirmedSuggestion === true)
      patient = yield currentSuggestedClient(c, data.patient.id);
    else {
      const result = yield resolveClient(c, data.clientQuery);
      patient = !result.overflow && result.matches.find((row) => row.id === data.patient.id);
    }
    if (
      patient &&
      data.patient.clientNameStamp &&
      clientChoiceMetadata(patient).clientNameStamp !== data.patient.clientNameStamp
    )
      patient = null;
    if (patient) data.patient.label = clientLabel(patient);
    else clearField(data, 'client');
  }
  if (data.staff) {
    const staff = context.members.find((row) => row.accountId === data.staff.id);
    if (!staff) clearField(data, 'staff');
    else data.staff.label = short(staff.displayName || 'Специалист');
  }
  if (data.service) {
    const service = context.services.find(
      (row) => row.id === data.service.id && row.staffId === data.staff?.id,
    );
    if (!service) {
      const query = data.service.label || data.serviceQuery;
      clearField(data, 'service');
      data.serviceQuery = query || '';
    } else {
      data.service.label = short(service.name);
      if (data.durationSource === 'service') data.duration = service.duration;
    }
  }
  return context;
});
const resolveSeed = readSteps(function* resolveSeed(c, data, context) {
  let clientLookup;
  if (!data.patient && data.clientQuery && !data.clientSuggestionsOnly) {
    const result = yield resolveFieldAnswer(
      'client',
      data.clientQuery,
      readSteps(function* (query) {
        const result = yield resolveClient(c, query);
        clientLookup = { query, result };
        return result;
      }),
    );
    data.clientQuery =
      result.overflow || result.matches.length ? result.query : fieldAnswer('client', result.query);
    if (!result.overflow && result.matches.length === 1)
      data.patient = { id: result.matches[0].id, label: clientLabel(result.matches[0]) };
  }
  if (!data.staff && (data.staffQuery || data.useDefaultStaff)) {
    const result = data.staffQuery
      ? yield resolveFieldAnswer('staff', data.staffQuery, (query) => ({
          matches: context.members.filter((member) =>
            isSelfReference(query)
              ? member.accountId === c.current.accountId
              : matchesName(member, query, true),
          ),
        }))
      : {
          query: '',
          matches: context.members.filter((member) => member.accountId === c.current.accountId),
        };
    const { matches } = result;
    if (data.staffQuery) data.staffQuery = result.query;
    const member =
      matches.length === 1
        ? matches[0]
        : !data.staffQuery && context.members.length === 1
          ? context.members[0]
          : null;
    if (member)
      data.staff = { id: member.accountId, label: short(member.displayName || 'Специалист') };
  }
  if (!data.serviceChosen && data.staff && data.serviceQuery && !data.servicePicker?.categoryId) {
    const services = context.services.filter((service) => service.staffId === data.staff.id);
    const exact = yield exactServiceAnswer(services, data.serviceQuery);
    const result = exact.matches.length
      ? exact
      : yield resolveFieldAnswer('service', data.serviceQuery, (query) => ({
          matches: resolveService(services, query),
        }));
    data.serviceQuery = result.query;
    if (exact.matches.length === 1) setService(data, exact.matches[0]);
  }
  return clientLookup;
});
function selectedFields(data) {
  const values = {
    client: data.patient?.label,
    staff: data.staff?.label,
    service: data.serviceChosen
      ? data.service?.label || 'Без услуги каталога — уточнить в форме'
      : '',
    date: data.date,
    time: data.time || (data.timeWindow ? windowLabel(data.timeWindow) : ''),
    duration: data.duration ? data.duration + ' мин' : '',
  };
  return fields
    .filter((key) => values[key])
    .map((key) => ({ key, label: labels[key], value: values[key] }));
}
const describe = readSteps(function* describe(c, data, context, focus, clientLookup) {
  if (!data.patient && (!focus || focus === 'client')) {
    let result = { matches: [], overflow: false };
    if (data.clientQuery && !data.clientSuggestionsOnly) {
      if (clientLookup?.query === data.clientQuery) {
        c.assertCurrent?.();
        result = clientLookup.result;
      } else result = yield resolveClient(c, data.clientQuery);
    }
    if (data.clientQuery && !result.overflow && !result.matches.length) {
      const components = yield suggestClientComponents(c, data.clientQuery);
      if (components.componentNameConflict) result = components;
      else {
        const suggestions = yield suggestClientMatches(c, data.clientQuery);
        result = suggestions.matches.length || suggestions.overflow ? suggestions : components;
      }
    }
    if (result.componentAnchor) data.clientComponentAnchor = result.componentAnchor;
    else delete data.clientComponentAnchor;
    const componentStamp = clientComponentStamp(result);
    const approximate = result.approximate === true;
    const view = clientChoiceView(result.matches, {
      approximate,
      overflow: result.overflow,
      hasQuery: Boolean(data.clientQuery),
      componentPrompt: result.componentPrompt,
    });
    return {
      step: 'client',
      phase: view.phase,
      prompt: result.componentConflict
        ? 'Имя и фамилия не совпали. Уточните полное имя или телефон.'
        : view.prompt,
      input: { type: 'text', field: 'client' },
      choices: !view.showChoices
        ? []
        : result.matches.slice(0, approximate ? 5 : 12).map((patient) => ({
            kind: 'client',
            value: patient.id,
            label: clientLabel(patient),
            ...clientChoiceMetadata(patient),
            ...(approximate ? { approximate: true } : {}),
            ...(componentStamp
              ? { componentClarification: true, clientComponentStamp: componentStamp }
              : {}),
          })),
    };
  }
  if (!data.staff && (!focus || focus === 'staff')) {
    const matching = data.staffQuery
      ? context.members.filter((member) => matchesName(member, data.staffQuery, true))
      : [];
    return {
      step: 'staff',
      prompt: 'Выберите доступного специалиста или уточните его имя.',
      input: { type: 'text', field: 'staff' },
      choices: (matching.length ? matching : context.members).slice(0, 12).map((member) => ({
        kind: 'staff',
        value: member.accountId,
        label: short(member.displayName || 'Специалист'),
      })),
    };
  }
  if (!data.serviceChosen && (!focus || focus === 'service'))
    return yield servicePickerView(c, data, context);
  if (data.date && data.durationSource === 'required' && (!focus || focus === 'duration'))
    return {
      step: 'duration',
      prompt: 'Укажите длительность в минутах, от 5 до 1440 с шагом 5.',
      input: { type: 'number', field: 'duration' },
      choices: [],
    };
  for (const [field, type, prompt] of [
    ['date', 'date', 'На какую дату подготовить запись?'],
    ['time', 'time', 'На какое время подготовить запись?'],
    ['duration', 'number', 'Укажите длительность в минутах, от 5 до 1440 с шагом 5.'],
  ])
    if (!data[field] && (!focus || focus === field))
      return { step: field, prompt, input: { type, field }, choices: [] };
  return {
    step: 'review',
    prompt: 'Проверьте данные. Подготовлю обычную форму; сохранение останется за вами.',
    input: null,
    choices: [{ kind: 'ready', label: 'Подготовить форму записи' }],
  };
});
module.exports = {
  fields,
  clientLabel,
  setService,
  clearField,
  references,
  resolveSeed,
  selectedFields,
  describe,
};
