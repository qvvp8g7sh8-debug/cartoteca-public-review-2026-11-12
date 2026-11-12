const { readSteps } = require('./../read-steps.cjs');
const { patientNameParts } = require('../../../../shared/patient-names.cjs');
const { normalizeName } = require('../language/names/name-forms.cjs');
const { matchesName, nameTokens } = require('../language/names/name-matching.cjs');
const {
  currentSuggestedClient,
  currentSuggestedClients,
} = require('../language/names/name-directory.cjs');
const { parseClientPhoneAnswer } = require('../language/names/client-phone-answer.cjs');
const { repeatsClientComponent } = require('../language/names/client-name-components.cjs');
const { isAffirmativeAnswer } = require('./affirmative-answer.cjs');
const { isBookingCommandWord } = require('./booking-command-words.cjs');
const { fieldAnswer } = require('./field-answer.cjs');
const {
  parseSurnameOnlyAnswer,
  surnameOnlyMatches,
  surnameOnlyPrompt,
} = require('./client-surname-choice.cjs');
const componentControls =
  /^(?:отмена|отмени|отменить|стоп|назад|вернись|повтори|повторите|верно|подтверждаю|открой|открывай|подготовь|запиши|записать)$/u;
const componentOrdinals =
  /^(?:первый|первого|первую|один|одна|второй|второго|вторую|два|две|третий|третьего|третью|три|четвертый|четвертого|четвертую|четыре|пятый|пятого|пятую|пять|шестой|шестого|шестую|шесть|седьмой|седьмого|седьмую|семь|восьмой|восьмого|восьмую|восемь|девятый|девятого|девятую|девять|десятый|десятого|десятую|десять|одиннадцатый|одиннадцатого|одиннадцать|двенадцатый|двенадцатого|двенадцать|последний|предпоследний)$/u;
const phoneTail = (patient) =>
  String(patient.phone || '')
    .replace(/\D/gu, '')
    .slice(-4);
const distinct = (values) =>
  values.every(Boolean) && new Set(values.map(normalizeName)).size === values.length;
const shortPhonePrompt = (patients) =>
  patients.some((patient) => /^\d{4}$/u.test(phoneTail(patient)))
    ? 'Назовите последние четыре цифры телефона или полное имя.'
    : 'Уточните полное имя или выберите клиента на экране.';
function clientChoiceMetadata(patient) {
  const parts = patientNameParts(patient);
  const clientName = parts.structured
    ? { firstName: parts.first, middleName: parts.middle, lastName: parts.last }
    : { name: parts.full };
  const tail = phoneTail(patient);
  return {
    clientName,
    clientPhoneTail: tail,
    clientNameStamp: JSON.stringify([normalizeName(parts.full), tail]),
  };
}
function clientChoiceView(
  candidates,
  { approximate = false, overflow = false, hasQuery = false, componentPrompt } = {},
) {
  const phase = 'clientChoice';
  if (!candidates.length)
    return {
      phase,
      prompt: overflow
        ? 'Уточните полное имя или телефон клиента.'
        : hasQuery
          ? 'Клиент не найден. Уточните имя или телефон.'
          : 'Как зовут клиента?',
      showChoices: false,
    };
  if (overflow && !approximate)
    return {
      phase,
      prompt: 'Слишком много совпадений. Уточните полное имя или телефон клиента.',
      showChoices: false,
    };
  // Questions may use only the identities actually offered by the caller.
  candidates = candidates.slice(0, approximate ? 5 : 12);
  const surnamePrompt = surnameOnlyPrompt(candidates);
  if (surnamePrompt || componentPrompt)
    return { phase, prompt: surnamePrompt || componentPrompt, showChoices: true };
  const parts = candidates.map(patientNameParts);
  if (parts.length === 1)
    return {
      phase,
      prompt: (parts[0].full || 'Нужный клиент') + ', верно?',
      showChoices: true,
    };
  const sameFirst = parts.every(
    (row) => normalizeName(row.first) === normalizeName(parts[0].first),
  );
  const sameLast = parts.every((row) => normalizeName(row.last) === normalizeName(parts[0].last));
  const crossedNameRoles = parts.some((row, index) =>
    parts.some(
      (other, otherIndex) =>
        index !== otherIndex &&
        row.first &&
        row.last &&
        normalizeName(row.first) !== normalizeName(row.last) &&
        normalizeName(row.first) === normalizeName(other.last) &&
        normalizeName(row.last) === normalizeName(other.first),
    ),
  );
  if (candidates.length > 3) {
    const middleNames = parts.map((row) => row.middle);
    const prompt = crossedNameRoles
      ? distinct(middleNames)
        ? 'Какое отчество?'
        : shortPhonePrompt(candidates)
      : sameFirst && sameLast && distinct(middleNames)
        ? 'Какое отчество?'
        : distinct(parts.map((row) => row.first))
          ? 'Какое имя?'
          : distinct(parts.map((row) => row.last))
            ? 'Какая фамилия?'
            : sameLast &&
                distinct(parts.map((row) => [row.first, row.middle].filter(Boolean).join(' ')))
              ? 'Назовите имя и отчество.'
              : distinct(parts.map((row) => row.full))
                ? 'Уточните полное имя.'
                : shortPhonePrompt(candidates);
    return { phase, prompt, showChoices: true };
  }
  let names;
  if (crossedNameRoles) {
    const patronymics = parts.map((row) => row.middle);
    if (!distinct(patronymics))
      return { phase, prompt: shortPhonePrompt(candidates), showChoices: true };
    names = patronymics;
  } else if (sameFirst && distinct(parts.map((row) => row.last)))
    names = parts.map((row) => row.last);
  else if (distinct(parts.map((row) => row.first))) names = parts.map((row) => row.first);
  else if (
    sameLast &&
    distinct(parts.map((row) => [row.first, row.middle].filter(Boolean).join(' ')))
  )
    names = parts.map((row) => [row.first, row.middle].filter(Boolean).join(' '));
  else names = parts.map((row) => row.full || 'Клиент');
  if (!distinct(names)) {
    names = parts.map((row, index) => {
      const duplicate =
        parts.filter((other) => normalizeName(other.full) === normalizeName(row.full)).length > 1;
      const tail = phoneTail(candidates[index]);
      return row.full + (duplicate && tail ? ' — телефон заканчивается на ' + tail : '');
    });
    if (!distinct(names))
      return {
        phase,
        prompt: shortPhonePrompt(candidates),
        showChoices: true,
      };
  }
  const prompt =
    names.length === 2
      ? names.join(' или ')
      : names.slice(0, -1).join(', ') + ' или ' + names.at(-1);
  return { phase, prompt: prompt + '?', showChoices: true };
}
const currentChoicePatients = readSteps(function* currentChoicePatients(c, choices) {
  const patients = new Map(
    (yield currentSuggestedClients(
      c,
      choices.map(([, choice]) => choice.value),
    )).map((patient) => [patient.id, patient]),
  );
  return choices.some(
    ([, choice]) =>
      !patients.has(choice.value) ||
      clientChoiceMetadata(patients.get(choice.value)).clientNameStamp !== choice.clientNameStamp,
  )
    ? null
    : patients;
});
const phoneSuffixChoice = readSteps(function* phoneSuffixChoice(c, choices, digits) {
  const ask = (message = 'Сначала назовите имя клиента.') => ({
    kind: 'clientPhoneClarify',
    message,
  });
  if (!choices.length) return ask();
  const patients = yield currentChoicePatients(c, choices);
  if (!patients) return ask('Список клиентов изменился. Уточните имя ещё раз.');
  const matching = choices.filter(([, choice]) =>
    String(patients.get(choice.value).phone || '')
      .replace(/\D/gu, '')
      .endsWith(digits),
  );
  if (matching.length === 1) return { kind: 'choice', choice: matching[0][0] };
  if (matching.length > 1) {
    const question = clientChoiceView(
      matching.map(([, choice]) => patients.get(choice.value)),
    ).prompt;
    const fullPhones = matching.map(([, choice]) => {
      const answer = parseClientPhoneAnswer(String(patients.get(choice.value).phone || ''));
      return answer?.kind === 'full' ? answer.text.replace(/\D/gu, '') : '';
    });
    return ask(
      'Окончания совпали — ' +
        (/телефон/u.test(question)
          ? distinct(fullPhones)
            ? 'назовите полный номер телефона.'
            : 'выберите клиента на экране.'
          : question),
    );
  }
  return ask('В списке нет такого окончания — назовите имя или последние четыре цифры.');
});
const surnameOnlyChoice = readSteps(function* surnameOnlyChoice(c, choices, surname, text) {
  const names = choices.map(([, choice]) => choice.clientName);
  const matching = surnameOnlyMatches(names, surname);
  const help = (message) => ({ kind: 'localHelp', text: message });
  if (
    matching.length > 1 ||
    names.some((name) => normalizeName(patientNameParts(name).full) === text)
  )
    return help('Уточните номер варианта или выберите клиента на экране.');
  if (!matching.length) return help('В текущем списке нет подходящей карточки без имени.');

  const patients = yield currentChoicePatients(c, choices);
  const [id, choice] = choices[names.indexOf(matching[0])];
  const fresh = patients && surnameOnlyMatches([...patients.values()], surname);
  if (fresh?.length !== 1 || fresh[0].id !== choice.value)
    return help('Список клиентов изменился. Уточните имя ещё раз.');
  return { kind: 'choice', choice: id };
});
// Only a complete, explicitly labelled pair can join separate source spans.
// Its components are checked against the current visible choice, not guessed.
function labelledClientName(raw) {
  let text = String(raw)
    .trim()
    .replace(/[.!?…]+$/u, '')
    .trim();
  text = text.replace(/^(?:имя|фамилию|фамилия)\s+я\s+перепутал[аи]?\s*[.!?]\s*/iu, '');
  text = text.replace(/[,.]\s*остальное\s+оставь\s+как\s+было$/iu, '').trim();
  const word = "([\\p{L}]+(?:[-'’][\\p{L}]+)*)";
  const first = new RegExp(
    '^(?:имя|нужен|нужна|клиент|клиентка)(?:\\s*[:=–—]\\s*|\\s+)' + word + '$',
    'iu',
  );
  const last = new RegExp('^фамилия(?:\\s*[:=–—]\\s*|\\s+)' + word + '$', 'iu');
  const parts = text.split(/\s*[,;.]\s*/u);
  if (parts.length !== 2) return null;
  const given = parts.map((part) => first.exec(part)).filter(Boolean);
  const surname = parts.map((part) => last.exec(part)).filter(Boolean);
  if (given.length !== 1 || surname.length !== 1) return null;
  if ([given[0][1], surname[0][1]].some((value) => value.length > 48)) return null;
  return { first: given[0][1], last: surname[0][1] };
}
function matchesLabelledClient(patient, answer) {
  const parts = patientNameParts(patient);
  return (
    normalizeName(parts.first) === normalizeName(answer.first) &&
    normalizeName(parts.last) === normalizeName(answer.last)
  );
}
const clientChoiceOperation = readSteps(function* clientChoiceOperation(c, entry, raw) {
  if (
    entry?.step !== 'client' ||
    typeof raw !== 'string' ||
    raw.length > 160 ||
    !(entry.options instanceof Map) ||
    entry.options.size > 12
  )
    return null;
  const phone = parseClientPhoneAnswer(raw);
  if (phone?.kind === 'full') return { kind: 'text', text: phone.text };
  const choices = [...entry.options];
  if (
    choices.some(
      ([, choice]) => choice.kind !== 'client' || !choice.clientName || !choice.clientNameStamp,
    )
  )
    return null;
  if (phone?.kind === 'suffix7' || phone?.kind === 'suffix4')
    return yield phoneSuffixChoice(c, choices, phone.digits);
  const labelledName = labelledClientName(raw);
  const text = normalizeName(labelledName ? labelledName.first + ' ' + labelledName.last : raw)
    .replace(/[.!?…]+$/u, '')
    .trim();
  if (/(?:^|\s)(?:не|нет|или|либо|если|кроме|вместо|и|а)(?=$|\s)/u.test(text)) return null;
  const surname = labelledName ? null : parseSurnameOnlyAnswer(text);
  if (surname !== null) return yield surnameOnlyChoice(c, choices, surname, text);
  const componentHelp = () => ({
    kind: 'localHelp',
    text: entry.response?.dialogue?.prompt || 'Уточните полное имя или телефон клиента.',
  });
  const confirmsClient = isAffirmativeAnswer(raw) || /^(?:верно|это\s+(?:он|она))$/u.test(text);
  if (!choices.length) {
    if (
      entry.data?.clientComponentAnchor &&
      (confirmsClient ||
        (nameTokens(fieldAnswer('client', text)).length === 1 &&
          !componentOrdinals.test(text) &&
          !componentControls.test(text) &&
          !isBookingCommandWord(text)))
    )
      return componentHelp();
    return null;
  }
  if (confirmsClient && choices.length > 1) return componentHelp();
  const componentChoices = choices.every(([, choice]) => choice.componentClarification === true);
  const answer = componentChoices ? fieldAnswer('client', text) : text;
  if (componentChoices) {
    if (confirmsClient || (choices.length > 1 && /^(?:подтверждаю|все верно)$/u.test(text)))
      return choices.length > 1 ? componentHelp() : null;
    if (repeatsClientComponent(entry.data?.clientComponentAnchor, choices[0][1], answer))
      return componentHelp();
  }
  let matching;
  {
    const tokens = nameTokens(answer);
    if (!tokens.length || tokens.length > 4) return null;
    matching = choices.filter(
      ([, choice]) =>
        matchesName(choice.clientName, answer) &&
        (!labelledName || matchesLabelledClient(choice.clientName, labelledName)),
    );
  }
  if (matching.length > 1) {
    const surnamePrompt = surnameOnlyPrompt(choices.map(([, choice]) => choice.clientName));
    if (!surnamePrompt && componentChoices) return componentHelp();
    return {
      kind: 'localHelp',
      text: surnamePrompt || 'Уточните полное имя или телефон клиента.',
    };
  }
  if (matching.length !== 1) {
    if (
      componentChoices &&
      nameTokens(answer).length === 1 &&
      !componentOrdinals.test(text) &&
      !componentControls.test(text) &&
      !isBookingCommandWord(text)
    )
      return componentHelp();
    return null;
  }
  const [id, choice] = matching[0];
  const fresh = yield currentSuggestedClient(c, choice.value);
  if (!fresh || clientChoiceMetadata(fresh).clientNameStamp !== choice.clientNameStamp)
    return {
      kind: 'localHelp',
      text: 'Список клиентов изменился. Уточните имя ещё раз.',
    };
  if (!matchesName(fresh, answer) || (labelledName && !matchesLabelledClient(fresh, labelledName)))
    return null;
  return { kind: 'choice', choice: id };
});
module.exports = {
  clientChoiceMetadata,
  clientChoiceView,
  clientChoiceOperation,
};
