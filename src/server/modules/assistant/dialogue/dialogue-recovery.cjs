const { createHash } = require('node:crypto');
const { surnameOnlyPrompt } = require('./client-surname-choice.cjs');
const key = '_clarificationRecovery';
const prompts = {
  client: 'Назовите полное имя или телефон клиента.',
  service: 'Назовите полное название услуги или выберите её на экране.',
};
const help =
  /^(?:(?:пожалуйста|давай|давайте)[, ]+)?(?:повтори|повторите|помоги|помогите|помощь|объясни|объясните|уточни|уточните|переспроси|переспросите|проверь|проверьте|проверим|уточним|что|как|почему|зачем|новая команда|начать сначала|начнем сначала|начни сначала|заново)(?=$|[\s,.!?;])/u;
const unsupported =
  /(?:^|[\s,;])(?:удал|отправ|оплат|сохран|созда|добав|выполн|запуст|включ|выключ|обнов|закр|переключ)[а-я]*(?=$|[\s,.!?;])/u;
function signature(data, view) {
  if (
    !Object.hasOwn(prompts, view?.step) ||
    !Array.isArray(view.choices) ||
    view.choices.length > 16
  )
    return null;
  if (view.choices.some((row) => row.kind !== view.step)) return null;
  const choices = view.choices
    .map((row) =>
      JSON.stringify([
        row.kind,
        row.value,
        row.label,
        row.approximate === true,
        row.clientNameStamp || '',
        row.approximateService === true,
        row.serviceStamp || '',
      ]),
    )
    .sort();
  const person = (value) =>
    value ? [value.id, value.label, value.confirmedSuggestion === true] : null;
  const window = data.timeWindow;
  const known = [
    person(data.patient),
    person(data.staff),
    person(data.service),
    data.serviceChosen === true,
    data.date || null,
    data.time || null,
    data.duration || null,
    data.durationSource || '',
    window
      ? Object.keys(window)
          .sort()
          .map((name) => [name, window[name]])
      : null,
    data.timeRequired === true,
    data.timeWindowRequired === true,
    data.roomId || '',
    data.closedDayConfirmation || '',
    data.clientSuggestionsOnly === true,
  ];
  return createHash('sha256')
    .update(JSON.stringify([view.step, known, choices]))
    .digest('hex');
}
function valid(state) {
  return (
    state &&
    Object.hasOwn(prompts, state.field) &&
    /^[a-f\d]{64}$/u.test(state.signature) &&
    Number.isSafeInteger(state.count) &&
    state.count >= (state.pending === true ? 0 : 1) &&
    state.count <= 3 &&
    (state.pending === undefined || state.pending === true)
  );
}
function ordinary(entry, turn) {
  if (
    turn.operation !== 'text' ||
    typeof turn.text !== 'string' ||
    !/[\p{L}\p{N}]/u.test(turn.text)
  )
    return false;
  const text = turn.text.trim().toLowerCase().replace(/ё/gu, 'е').replace(/\s+/gu, ' ');
  if (!text || text.length > 160 || help.test(text) || unsupported.test(text)) return false;
  if (['localHelp', 'clientPhoneClarify'].includes(turn.input.kind))
    return turn.clientAnswer === true;
  if (['patch', 'modelPatch'].includes(turn.input.kind))
    return turn.input.edits?.some((edit) => edit.field === entry.step) === true;
  return ['text', 'modelClarify'].includes(turn.input.kind);
}
function beginRecovery(entry, turn) {
  if (
    entry.availabilitySearch ||
    (entry.step === 'service' && entry.data.servicePicker?.categoryId) ||
    !Object.hasOwn(prompts, entry.step)
  ) {
    delete entry.data[key];
    return;
  }
  const current = signature(entry.data, {
    step: entry.step,
    choices: [...entry.options.values()],
  });
  const prior = entry.data[key];
  if (
    !current ||
    turn.operation === 'edit' ||
    ['edit', 'cancel', 'choice'].includes(turn.input.kind)
  ) {
    delete entry.data[key];
    return;
  }
  const same = valid(prior) && prior.field === entry.step && prior.signature === current;
  if (!same) delete entry.data[key];
  if (ordinary(entry, turn))
    entry.data[key] = {
      field: entry.step,
      signature: current,
      count: same ? prior.count : 0,
      pending: true,
    };
}
function recoverResponse(data, view, text) {
  const state = data[key];
  if (!state) return { view, text };
  if (!valid(state) || state.field !== view.step || signature(data, view) !== state.signature) {
    delete data[key];
    return { view, text };
  }
  const pending = state.pending === true;
  const count = Math.min(3, state.count + (pending ? 1 : 0));
  if (pending) data[key] = { field: state.field, signature: state.signature, count };
  if (count < 2) return { view, text };
  const manualInputRequired = count >= 3;
  const hasChoices = view.choices.some((row) => row.value !== null);
  const prompt = manualInputRequired
    ? state.field === 'client'
      ? hasChoices
        ? 'Не удалось уточнить клиента. Выберите его на экране.'
        : 'Не удалось уточнить клиента. Проверьте имя или телефон.'
      : hasChoices
        ? 'Не удалось уточнить услугу. Выберите её на экране.'
        : 'Не удалось уточнить услугу. Проверьте название.'
    : state.field === 'service' && !hasChoices
      ? 'Назовите полное название услуги.'
      : (state.field === 'client' &&
          surnameOnlyPrompt(view.choices.map((row) => row.clientName || {}))) ||
        prompts[state.field];
  const original = view.prompt;
  if (pending) text = prompt;
  else if (text) {
    const detail = text.endsWith(original) ? text.slice(0, -original.length).trim() : text;
    text = (detail && detail !== prompt ? detail + ' ' : '') + prompt;
  }
  return {
    view: {
      ...view,
      prompt,
      ...(manualInputRequired ? { manualInputRequired: true } : {}),
    },
    text,
  };
}
module.exports = { beginRecovery, recoverResponse };
