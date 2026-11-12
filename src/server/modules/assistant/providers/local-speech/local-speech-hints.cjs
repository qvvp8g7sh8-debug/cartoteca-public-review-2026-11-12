const { readSteps } = require('./../../read-steps.cjs');
const { fail } = require('../../../../../shared/errors.cjs');
const { boundedText } = require('../../interpretation/intent-schema.cjs');
const { patientFullName } = require('../../../../../shared/patient-names.cjs');
const { appointmentContext } = require('../../actions/availability-context.cjs');
const { currentSuggestedClients } = require('../../language/names/name-directory.cjs');
const MAX_PROMPT = 4000,
  MAX_HINT = 1000,
  MAX_NAMES = 8;
const initialCommandHint =
  'Начало голосовой команды: Открой карту клиента. Открой карточку клиента. Запиши клиента. Перенеси запись клиента. Отмени запись клиента. ' +
  'Распознавай речь дословно. Это примеры команд, а не произнесённые данные: не дописывай клиента, имя, фамилию, телефон или другие неуслышанные слова.';
const templates = Object.freeze({
  client:
    'Клиент: имя, фамилия или последние четыре цифры телефона из списка. Подтверждение: да, ага, верно, нет, правильно.',
  staff: 'Специалист: имя или фамилия.',
  service: 'Услуга: полное или сокращённое название, категория, названные зоны и плюс.',
  date: 'Дата: сегодня, завтра, послезавтра, в понедельник, двадцатого числа.',
  time: 'Время: в девять утра, в четырнадцать тридцать, любое время, первый вариант.',
  availability: 'Свободное окно: первый вариант, второй вариант, третье окно.',
  duration: 'Длительность: пятнадцать минут, полчаса, сорок пять минут, один час.',
  review: 'Подтверждение: да, ага, верно, нет, измени дату, отмени подготовку.',
});
function cut(value, length) {
  let end = Math.min(value.length, length);
  if (end && /[\uD800-\uDBFF]/u.test(value[end - 1])) end--;
  return value.slice(0, end).trim();
}
const localSpeechHints = readSteps(function* localSpeechHints(c, dialogues, body, state, member) {
  const dictionary = boundedText(state.policy.dictionary, MAX_PROMPT, 'словарь распознавания');
  const provider = state.providers.stt.provider;
  if (!['local', 'timeweb'].includes(provider)) return dictionary;
  const hasId = body.dialogueId !== undefined,
    hasVersion = body.dialogueVersion !== undefined;
  if (!hasId && !hasVersion) {
    const base = cut(dictionary, MAX_PROMPT - initialCommandHint.length - 1);
    return initialCommandHint + (base ? '\n' + base : '');
  }
  if (
    !hasId ||
    !hasVersion ||
    typeof body.dialogueId !== 'string' ||
    !body.dialogueId ||
    body.dialogueId.length > 64 ||
    !Number.isSafeInteger(body.dialogueVersion) ||
    body.dialogueVersion < 0
  )
    throw fail(400, 'Укажите текущий диалог для распознавания.');
  c.assertCurrent();
  if (
    !c.current?.organizationId ||
    !c.current.accountId ||
    c.current.globalAdmin ||
    !['owner', 'salon_admin', 'cosmetologist'].includes(c.current.role)
  )
    throw fail(403, 'Нет доступа к словарю этой организации.');
  const identityOf = () =>
    JSON.stringify([
      c.current?.organizationId,
      c.current?.accountId,
      c.current?.role,
      c.current?.sessionId,
      c.current?.globalAdmin,
    ]);
  const identity = identityOf();
  const entry = dialogues.get(c, member, state, body.dialogueId);
  const fresh = () => {
    c.assertCurrent();
    if (
      dialogues.get(c, member, state, body.dialogueId) !== entry ||
      entry.version !== body.dialogueVersion ||
      entry.cancelled ||
      entry.complete ||
      identity !== identityOf()
    )
      throw fail(409, 'Диалог изменился. Повторите ответ в текущем окне.');
  };
  fresh();
  const step = entry.step;
  const template = templates[step] || 'Короткий ответ для текущего шага записи.';
  // Timeweb already receives the configured dictionary. Only fixed phrases are
  // appended here: never names, options, field values or clinical database reads.
  if (provider === 'timeweb') {
    const hint = template + ' Распознавай только произнесённые слова; не дополняй ответ примерами.';
    const base = cut(dictionary, MAX_PROMPT - hint.length - 1);
    return (base ? base + '\n' : '') + hint;
  }
  const needsCatalog = step === 'staff' || step === 'service';
  const staffId = step === 'service' ? entry.data.staff?.id : undefined;
  const context = needsCatalog ? yield appointmentContext(c) : null;
  const names = [];
  const add = (value) => {
    const name = String(value || '')
      .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim();
    if (!name || name.length > 180 || names.includes(name) || names.length >= MAX_NAMES) return;
    if (template.length + names.join(', ').length + name.length + 30 <= MAX_HINT) names.push(name);
  };
  if (needsCatalog || step === 'client') {
    const choices = [...entry.options.values()]
      .slice(0, MAX_NAMES)
      .filter((row) => row.kind === step);
    if (step === 'client' && choices.length) {
      const ids = [...new Set(choices.map((choice) => choice.value))];
      const patients = yield currentSuggestedClients(c, ids);
      const byId = new Map(patients.map((patient) => [patient.id, patient]));
      for (const id of ids) {
        const patient = byId.get(id);
        if (patient) add(patientFullName(patient));
      }
    } else if (step === 'staff') {
      for (const { value } of choices)
        add(context.members.find((row) => row.accountId === value)?.displayName);
    } else if (step === 'service') {
      for (const { value } of choices)
        add(context.services.find((row) => row.id === value && row.staffId === staffId)?.name);
    }
  }
  fresh();
  const hint = cut(
    template + (names.length ? ' Варианты: ' + names.join(', ') + '.' : ''),
    MAX_HINT,
  );
  const base = cut(dictionary, MAX_PROMPT - hint.length - 1);
  return (base ? base + '\n' : '') + hint;
});
module.exports = { localSpeechHints };
