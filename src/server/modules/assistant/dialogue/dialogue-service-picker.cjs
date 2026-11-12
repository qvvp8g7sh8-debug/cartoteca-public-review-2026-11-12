const { createHash } = require('node:crypto');
const { readSteps } = require('../read-steps.cjs');
const { fail } = require('../../../../shared/errors.cjs');
const { resolveService } = require('../actions/availability-context.cjs');
const { exactServiceAnswer } = require('../language/services/service-exact-followup.cjs');
const { suggestServices, serviceStamp } = require('../language/services/service-suggestions.cjs');
const PAGE_SIZE = 24;
const GROUP_SEARCH_THRESHOLD = 5;
const short = (value) => String(value || '').slice(0, 180);
const normalized = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .replace(/[.!?…]+$/u, '')
    .replace(/\s+/gu, ' ')
    .trim();

const catalogGroups = readSteps(function* (c) {
  const value = c.assistantReads
    ? yield c.assistantReads.serviceGroups()
    : typeof c.platform.serviceGroups === 'function'
      ? c.platform.serviceGroups(c.current.organizationId)
      : { groups: [{ id: 'other', title: 'Другое' }] };
  return value.groups;
});
const pickerModel = readSteps(function* (c, data, context) {
  const services = context.services.filter((row) => row.staffId === data.staff?.id);
  const query = data.serviceQuery || '';
  const exact = query ? exactServiceAnswer(services, query) : { matches: [] };
  const pool = exact.matches.length
    ? exact.matches
    : query
      ? resolveService(services, query)
      : services;
  const catalog = yield catalogGroups(c);
  const known = new Set(catalog.map((group) => group.id));
  const categoryOf = (service) => (known.has(service.category) ? service.category : 'other');
  const used = new Set(pool.map(categoryOf));
  const groups = catalog.filter((group) => used.has(group.id));
  const stamp = createHash('sha256')
    .update(
      JSON.stringify([
        data.staff?.id,
        query,
        groups.map(({ id, title }) => [id, title]),
        services.map((service) => [serviceStamp(service), categoryOf(service)]),
      ]),
    )
    .digest('hex');
  const saved = data.servicePicker;
  const state =
    saved?.staffId === data.staff?.id && saved.query === query && saved.stamp === stamp
      ? saved
      : { staffId: data.staff?.id, query, stamp, categoryId: '', offset: 0 };
  const reason = ['unknownGroup', 'ambiguousGroup'].includes(state.reason) ? state.reason : '';
  const grouped =
    (groups.length > 1 && (!query || pool.length > GROUP_SEARCH_THRESHOLD)) ||
    Boolean(reason && groups.length);
  const categoryId = groups.some((group) => group.id === state.categoryId) ? state.categoryId : '';
  const categories = grouped && !categoryId;
  const rows = categories
    ? groups
    : categoryId
      ? services.filter((service) => categoryOf(service) === categoryId)
      : pool;
  const answer = categoryId ? state.answer : '';
  const named =
    answer && state.suggestedName ? rows.filter((row) => row.name === state.suggestedName) : [];
  const exactAnswer = answer ? exactServiceAnswer(rows, answer).matches : [];
  const candidate =
    exactAnswer.length > 1
      ? null
      : exactAnswer[0] ||
        (answer && suggestServices(rows, answer).best) ||
        (named.length === 1 ? named[0] : null);
  const candidateIndex = candidate ? rows.indexOf(candidate) : -1;
  const offset =
    Number.isSafeInteger(state.offset) && state.offset >= 0 && state.offset < rows.length
      ? Math.floor(state.offset / PAGE_SIZE) * PAGE_SIZE
      : 0;
  return {
    services,
    query,
    pool,
    groups,
    stamp,
    categoryId,
    categories,
    rows,
    offset: candidateIndex >= 0 ? Math.floor(candidateIndex / PAGE_SIZE) * PAGE_SIZE : offset,
    candidate,
    answer,
    reason,
    groupTitle: categoryId ? groups.find((group) => group.id === categoryId).title : '',
  };
});
const servicePickerView = readSteps(function* (c, data, context, model) {
  if (model === undefined) model = yield pickerModel(c, data, context);
  const {
    services,
    query,
    pool,
    stamp,
    categoryId,
    categories,
    rows,
    offset,
    reason,
    groupTitle,
    candidate,
    answer,
  } = model;
  if (query && !pool.length) {
    const suggested = suggestServices(services, query);
    const names = suggested.matches.map((row) => '«' + row.name + '»');
    return {
      step: 'service',
      phase: 'serviceChoice',
      ...(suggested.overflow || !names.length ? { speechQuestion: 'service.exact' } : {}),
      prompt:
        suggested.overflow || !names.length
          ? 'Назовите точное название услуги.'
          : names.length === 1
            ? 'Вы имеете в виду ' + names[0] + '?'
            : names.slice(0, -1).join(', ') + ' или ' + names.at(-1) + '?',
      input: { type: 'text', field: 'service' },
      choices: suggested.overflow
        ? []
        : suggested.matches.map((service) => ({
            kind: 'service',
            value: service.id,
            label: short(service.name) + ' · ' + service.duration + ' мин',
            approximateService: true,
            serviceName: service.name,
            serviceStamp: serviceStamp(service),
          })),
      controls: [
        { kind: 'serviceBrowse', value: null, label: 'Все услуги', servicePickerStamp: stamp },
      ],
    };
  }
  const confirmService = Boolean(
    query &&
    !categoryId &&
    !categories &&
    pool.length === 1 &&
    !exactServiceAnswer(services, query).matches.length,
  );
  const choices = rows.slice(offset, offset + PAGE_SIZE).map((row) =>
    categories
      ? {
          kind: 'serviceCategory',
          value: row.id,
          label: short(row.title),
          servicePickerStamp: stamp,
        }
      : {
          kind: 'service',
          value: row.id,
          label: short(row.name) + ' · ' + row.duration + ' мин',
          servicePickerStamp: stamp,
          ...(confirmService || row === candidate ? { confirmService: true } : {}),
        },
  );
  const controls = [];
  if (offset + PAGE_SIZE < rows.length)
    controls.push({
      kind: 'serviceMore',
      value: offset + PAGE_SIZE,
      label: 'Показать ещё',
      servicePickerStamp: stamp,
    });
  else if (offset > 0)
    controls.push({
      kind: 'serviceMore',
      value: 0,
      label: 'К началу списка',
      servicePickerStamp: stamp,
    });
  if (categoryId)
    controls.push({
      kind: 'serviceCategories',
      value: null,
      label: 'Категории',
      servicePickerStamp: stamp,
    });
  if (query)
    controls.push({
      kind: 'serviceBrowse',
      value: null,
      label: 'Все услуги',
      servicePickerStamp: stamp,
    });
  if (candidate)
    controls.push({
      kind: 'serviceReject',
      value: null,
      label: 'Нет, другая услуга',
      servicePickerStamp: stamp,
    });
  return {
    step: 'service',
    phase: 'serviceChoice',
    ...(candidate ? { serviceConfirmation: true } : {}),
    ...(!confirmService && !groupTitle && !reason
      ? { speechQuestion: categories ? 'service.category' : 'service.ask' }
      : {}),
    ...((groupTitle || reason) && !answer
      ? { serviceList: categories ? 'groups' : 'services' }
      : {}),
    ...(groupTitle ? { serviceGroupTitle: short(groupTitle) } : {}),
    prompt:
      reason === 'unknownGroup'
        ? groupsPrompt(model.groups.length, false)
        : reason === 'ambiguousGroup'
          ? groupsPrompt(model.groups.length, true)
          : categories
            ? 'Выберите категорию или услугу.'
            : candidate
              ? 'Вы имеете в виду «' + short(candidate.name) + '»?'
              : answer
                ? 'Не удалось выделить одну услугу. Выберите её в списке или назовите отличительный признак.'
                : confirmService
                  ? short(pool[0].name) + ', верно?'
                  : 'Выберите услугу.',
    input: { type: 'text', field: 'service' },
    choices,
    controls,
  };
});
function groupsPrompt(count, ambiguous) {
  if (!count) return 'У выбранного специалиста нет доступных услуг. Уточните специалиста.';
  return ambiguous
    ? 'Есть несколько групп с таким названием. Выберите нужную группу в списке.'
    : 'Не удалось определить группу. Назовите или выберите доступную группу.';
}
const selectServicePicker = readSteps(function* (c, data, choice, context) {
  if (
    ![
      'serviceCategory',
      'serviceMore',
      'serviceCategories',
      'serviceBrowse',
      'serviceReject',
    ].includes(choice.kind) &&
    !(choice.kind === 'service' && choice.servicePickerStamp)
  )
    return false;
  const model = yield pickerModel(c, data, context);
  const view = yield servicePickerView(c, data, context, model);
  const offered = [...view.choices, ...(view.controls || [])].some(
    (row) =>
      row.kind === choice.kind &&
      row.value === choice.value &&
      row.servicePickerStamp === choice.servicePickerStamp,
  );
  if (!offered) throw fail(409, 'Список услуг изменился. Выберите услугу ещё раз.');
  if (choice.kind === 'service') return false;
  const state = {
    staffId: data.staff?.id,
    query: model.query,
    stamp: model.stamp,
    categoryId: model.categoryId,
    offset: model.offset,
  };
  if (choice.kind === 'serviceCategory') {
    state.categoryId = choice.value;
    state.offset = 0;
  } else if (choice.kind === 'serviceMore') state.offset = choice.value;
  else if (choice.kind === 'serviceCategories') {
    state.categoryId = '';
    state.offset = 0;
  } else if (choice.kind === 'serviceBrowse') {
    data.serviceQuery = '';
    delete data.servicePicker;
    return true;
  }
  data.servicePicker = state;
  return true;
});
function servicePickerOperation(entry, value) {
  if (entry?.step !== 'service' || typeof value !== 'string' || value.length > 160) return null;
  const text = normalized(value);
  const choices = [...(entry.options || []), ...(entry.controls || [])];
  const operation = (pair) => (pair ? { kind: 'choice', choice: pair[0] } : null);
  if (/^(?:нет|неверно|не та|не то|это не она)$/u.test(text))
    return operation(choices.find(([, row]) => row.kind === 'serviceReject'));
  if (/^(?:категории|другие категории|другая категория|назад к категориям)$/u.test(text))
    return operation(choices.find(([, row]) => row.kind === 'serviceCategories'));
  if (/^(?:сначала|к началу(?: списка)?|покажи сначала)$/u.test(text))
    return operation(choices.find(([, row]) => row.kind === 'serviceMore' && row.value === 0));
  if (
    /^(?:покажи(?:те)?\s+|показать\s+)?(?:еще|другие)(?:\s+(?:услуги|категории|варианты))?$/u.test(
      text,
    )
  ) {
    const more = choices.find(([, row]) => row.kind === 'serviceMore' && row.value > 0);
    const other = choices.find(([, row]) =>
      ['serviceCategories', 'serviceBrowse'].includes(row.kind),
    );
    return (
      operation(more || other) || {
        kind: 'localHelp',
        text: 'Других услуг нет. Назовите нужную услугу.',
      }
    );
  }
  if (/^(?:все услуги|покажи все услуги)$/u.test(text))
    return operation(choices.find(([, row]) => row.kind === 'serviceBrowse'));
  if (/^(?:без услуги(?: каталога)?|без каталога|(?:услугу )?уточню в форме)$/u.test(text))
    return { kind: 'localHelp', text: 'Назовите услугу.' };
  const categories = choices.filter(([, row]) => row.kind === 'serviceCategory');
  const exact = categories.filter(([, row]) => normalized(row.label) === text);
  const categoryText = text.replace(
    /^(?:категория|группа|выбираю категорию|выбери категорию)\s+/u,
    '',
  );
  const matching = exact.length
    ? exact
    : categories.filter(([, row]) => normalized(row.label) === categoryText);
  return matching.length === 1
    ? operation(matching[0])
    : matching.length > 1
      ? { kind: 'localHelp', text: 'Уточните категорию услуги.' }
      : null;
}
function groupModelCandidates({ rows, offset }) {
  const names = new Set();
  let bytes = 0;
  const ordered = [...rows.slice(offset), ...rows.slice(0, offset)];
  for (const { name } of ordered) {
    if (name.length > 160 || names.has(name)) continue;
    const size = Buffer.byteLength(JSON.stringify(name), 'utf8') + 1;
    if (bytes + size > 5000 || names.size >= 96) break;
    names.add(name);
    bytes += size;
  }
  return [...names];
}
module.exports = {
  servicePickerView,
  selectServicePicker,
  servicePickerOperation,
  pickerModel,
  groupModelCandidates,
};
