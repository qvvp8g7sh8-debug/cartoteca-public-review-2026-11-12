const { createAssistantSpeechText } = require('./spoken-fields.cjs');
const { genericSpeechQuestion } = require('./generic-responses.cjs');
const actions = createAssistantSpeechText();
function includesSpokenPhrase(parts, value) {
  const key = (text) =>
    String(text)
      .normalize('NFKC')
      .toLowerCase()
      .replace(/ё/gu, 'е')
      .replace(/[^\p{L}\p{N}:]+/gu, ' ')
      .trim();
  const phrase = key(value);
  return Boolean(
    phrase && parts.some((part) => (' ' + key(part) + ' ').includes(' ' + phrase + ' ')),
  );
}
function spokenReply(reply, answerable = true) {
  if (reply?.dialogue?.information === true) return String(reply.dialogue.prompt || '').trim();
  if (reply?.dialogue?.manualInputRequired === true)
    return String(reply.text || reply.dialogue.prompt || '').trim();
  if (reply?.dialogue?.phase === 'cancelConfirmation')
    return String(reply.dialogue.prompt || '').trim();
  const generic = genericSpeechQuestion(reply);
  if (generic !== null) return generic;
  // Client identity is already a short, explicit server question; do not enumerate it twice.
  if (reply?.dialogue?.step === 'client') {
    const prompt = String(reply.dialogue.prompt || reply.text || '').trim();
    // Older callers may omit the phase. Ask one identity question instead
    // of reading the prompt, the same option and another yes/no instruction.
    const options = reply.dialogue.options;
    if (
      options?.length === 1 &&
      /(?:наш[её]л похожего клиента|это нужный человек|выберите клиента)/iu.test(prompt)
    ) {
      const name = String(options[0]?.label || '')
        .replace(/ · …\d{4}$/u, '')
        .trim();
      if (name) return name + ', верно?';
    }
    return prompt;
  }
  if (reply?.dialogue?.phase === 'serviceChoice') {
    const d = reply.dialogue;
    if (
      d.step === 'service' &&
      ['groups', 'services'].includes(d.serviceList) &&
      Array.isArray(d.options)
    ) {
      const names = d.options
        .slice(0, 5)
        .map((row) =>
          actions.assistantSpokenOption(row.label, d.serviceList === 'services' ? 'service' : ''),
        )
        .filter(Boolean);
      return [
        d.serviceGroupTitle ? 'Группа «' + d.serviceGroupTitle + '».' : '',
        d.prompt,
        ...names,
        d.controls?.some((row) => row.label === 'Показать ещё')
          ? 'Можно сказать «покажи ещё».'
          : '',
      ]
        .filter(Boolean)
        .join('\n');
    }
    return String(d.prompt || '').trim();
  }
  const dialogue = reply?.dialogue,
    text = String(reply?.text || '').trim(),
    prompt = String(dialogue?.prompt || '').trim(),
    serviceQuestion = dialogue?.step === 'service',
    ordinaryServicePrompt =
      prompt === 'Выберите услугу специалиста или введите её точное название.';
  if (serviceQuestion && ordinaryServicePrompt && (!text || text === prompt))
    return 'Какую услугу?';
  const detail =
    serviceQuestion && ordinaryServicePrompt && text.endsWith(prompt)
      ? text.slice(0, -prompt.length).trim()
      : text;
  const parts = serviceQuestion
    ? [detail, answerable ? 'Назовите услугу.' : 'Выберите услугу на экране или введите название.']
    : [text || prompt];
  if (!serviceQuestion && text && prompt && !includesSpokenPhrase([text], prompt))
    parts.push(prompt);
  if (dialogue?.step === 'review' && Array.isArray(dialogue.fields))
    for (const field of dialogue.fields.slice(0, 8)) {
      const label = String(field?.label || '').trim(),
        value = actions.assistantSpokenField(field);
      if (label && value) parts.push(label + ': ' + value);
    }
  const manyClients = dialogue?.step === 'client' && dialogue.options?.length > 3;
  if (manyClients)
    parts.push(
      'Есть несколько совпадений. Назовите фамилию, отчество или телефон клиента. Все варианты показаны на экране.',
    );
  const nearestQuestion =
    dialogue?.phase === 'slots' &&
    dialogue.options?.length === 1 &&
    prompt.includes('Ближайшее свободное время');
  if (
    !serviceQuestion &&
    !manyClients &&
    !nearestQuestion &&
    !['date', 'period', 'closedDay'].includes(dialogue?.phase) &&
    dialogue?.options?.length
  ) {
    const options = dialogue.options.slice(0, 3),
      questionParts = parts.slice();
    let narrated = false;
    for (const option of options) {
      const label = actions.assistantSpokenOption(option.label, dialogue.step);
      // Compare the complete label with the question, never individual names,
      // words or numbers. Similar choices must remain distinct on screen.
      if (label && !includesSpokenPhrase(questionParts, label)) {
        parts.push(label);
        narrated = true;
      }
    }
    if (dialogue.phase !== 'slots' && narrated)
      parts.push(
        answerable
          ? dialogue.step === 'review'
            ? 'Скажите «открой форму», чтобы проверить запись перед сохранением.'
            : dialogue.step === 'client' && options.length === 1
              ? 'Скажите «да», если это нужный клиент, или «нет», чтобы уточнить имя или телефон.'
              : 'Какой подходит?'
          : dialogue.step === 'review'
            ? 'Для подготовки формы нажмите «Подготовить форму записи». Сохранение выполняется вручную.'
            : 'Выберите вариант на экране или введите ответ.',
      );
  }
  if (!dialogue && Array.isArray(reply?.readOnlySlots) && reply.readOnlySlots.length) {
    parts.push('Просмотр свободных окон. Запись не подготовлена');
    for (const slot of reply.readOnlySlots.slice(0, 3)) {
      const label = slot.date + ' · ' + slot.time + '–' + slot.endTime + ' · ' + slot.staffName;
      parts.push('Свободно: ' + actions.assistantSpokenOption(label, 'availability'));
    }
  }
  return parts
    .filter(Boolean)
    .map((part, index, all) =>
      index < all.length - 1 && !/[.!?…][»”"']?$/u.test(part) ? part + '.' : part,
    )
    .join('\n');
}
function speechChunks(text, maxReplyChars = 600) {
  const limit = Math.max(100, Math.min(1000, Math.floor(Number(maxReplyChars) || 600)));
  const chunks = [];
  let pending = '';
  const flush = () => {
    if (pending) chunks.push(pending);
    pending = '';
  };
  const append = (part) => {
    if (pending && pending.length + part.length + 1 > limit) flush();
    pending += (pending ? ' ' : '') + part;
  };
  for (const section of String(text)
    .split(/\n+/u)
    .map((value) => value.trim())
    .filter(Boolean)) {
    if (section.length <= limit) {
      append(section);
      continue;
    }
    flush();
    for (let word of section.split(/\s+/u)) {
      while (word.length > limit) {
        flush();
        let end = limit;
        const last = word.charCodeAt(end - 1),
          next = word.charCodeAt(end);
        if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
        chunks.push(word.slice(0, end));
        word = word.slice(end);
      }
      append(word);
    }
    flush();
  }
  flush();
  return chunks;
}

function handoffText(reply) {
  if (reply.saved === true) return String(reply.text || '').trim();
  const type = reply.action?.type;
  if (
    [
      'prepareAppointment',
      'createAppointment',
      'cancelAppointment',
      'moveAppointment',
      'appointmentPreview',
    ].includes(type)
  )
    return String(reply.text || 'Открыл форму записи. Запись не сохранена.').trim();
  return type === 'calendar'
    ? 'Открыл расписание.'
    : type === 'clientCard'
      ? 'Открыл карточку клиента.'
      : type === 'clients'
        ? 'Открыл список клиентов.'
        : '';
}
module.exports = { spokenReply, speechChunks, handoffText };
